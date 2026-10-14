import { id, plus, safeCode, safeStages, normalizeState } from './shared.mjs';

/** Durable local dispatcher. Never claims hosted availability or exactly-once remote APIs. */
export function createPublicationWorker(ctx, service, options={}) {
 const {db}=ctx, workerId=id(), leaseMs=150000, timeoutMs=120000;
 let running=false,timer=null,heartbeatTimer=null,active=null,busy=false;
 const controllers=new Set(),flights=new Set();
 const key=row=>[row.tenant_id,row.workspace_id,row.id];
 const find=row=>service.rowJob(...key(row));
 const stateOf=row=>{try{return row.provider_state?normalizeState(JSON.parse(row.provider_state)):null;}catch{return null;}};
 const safeToResume=row=>safeStages.includes(stateOf(row)?.stage);
 function heartbeat(){
  if(!running)return false;
  const now=ctx.now();db.prepare('INSERT INTO publication_workers(id,started_at,heartbeat_at,stopped_at) VALUES(?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,stopped_at=NULL').run(workerId,now,now);return true;
 }
 function audit(row,action,code){ctx.audit({tenantId:row.tenant_id,actorId:row.actor_id,action,targetType:'publication',targetId:row.id,outcome:['published','retry'].includes(action.split('.').at(-1))?'success':'failure',safeChanges:{revision:row.revision,channelId:row.channel_id,...(code?{code}:{})}});}
 function recover(){return ctx.transaction(()=>{
  const now=ctx.now(),rows=db.prepare("SELECT * FROM publication_jobs WHERE status IN ('leased','sending') AND lease_until<=? ORDER BY lease_until LIMIT 100").all(now);
  for(const row of rows){
   let status='scheduled',code=null;
   if(row.status==='sending'){
    if(safeToResume(row)){status=row.attempt_count<row.max_attempts&&row.expires_at>now?'retry_wait':'failed';code=status==='failed'?'RETRIES_EXHAUSTED':'WORKER_INTERRUPTED_BEFORE_PUBLISH';}
    else{status='needs_attention';code='WORKER_INTERRUPTED';}
    db.prepare("UPDATE publication_attempts SET outcome=?,error_code=?,finished_at=? WHERE tenant_id=? AND workspace_id=? AND job_id=? AND lease_token=? AND outcome='sending'").run(status==='retry_wait'?'recovered_safe':status==='failed'?'failed':'ambiguous',code,now,...key(row),row.lease_token);
   }
   db.prepare('UPDATE publication_jobs SET status=?,error_code=?,next_attempt_at=?,version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND lease_token=? AND lease_until<=?').run(status,code,now,now,...key(row),row.lease_token,now);
   audit(row,'publication.recovered',code);
  }
  return rows.length;
 });}
 function claim(){
  if(!running||!service.adapter.enabled)return null;
  return ctx.transaction(()=>{
   const now=ctx.now();
   // A missed window is a final visible failure rather than an unexpectedly late post.
   const expired=db.prepare("SELECT * FROM publication_jobs WHERE status IN ('scheduled','retry_wait') AND expires_at<=? LIMIT 100").all(now);
   for(const row of expired){db.prepare("UPDATE publication_jobs SET status='failed',error_code='PUBLICATION_EXPIRED',version=version+1,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?").run(now,...key(row));audit(row,'publication.failed','PUBLICATION_EXPIRED');}
   const row=db.prepare("SELECT * FROM publication_jobs WHERE status IN ('scheduled','retry_wait') AND scheduled_at<=? AND next_attempt_at<=? AND expires_at>? ORDER BY next_attempt_at,created_at,id LIMIT 1").get(now,now,now);
   if(!row)return null;
   const token=id();
   const changed=db.prepare("UPDATE publication_jobs SET status='leased',lease_token=?,lease_owner=?,lease_until=?,version=version+1,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND status IN ('scheduled','retry_wait') AND version=?").run(token,workerId,plus(now,leaseMs),now,...key(row),row.version);
   return changed.changes===1?find(row):null;
  });
 }
 function guard(row,status='sending'){
  const current=find(row);
  if(!running||!current||current.status!==status||current.lease_token!==row.lease_token||current.lease_owner!==workerId||current.lease_until<=ctx.now())throw new Error('PUBLICATION_LEASE_LOST');
  return current;
 }
 const validationInput=row=>({tenantId:row.tenant_id,workspaceId:row.workspace_id,postId:row.post_id,channelId:row.channel_id,platform:row.platform,revision:row.revision,actorId:row.actor_id,connectionVersion:row.connection_version});
 async function dispatchInternal(leased){
  if(!leased)return null;
  let begun;
  ctx.transaction(()=>{
   let row;try{row=guard(leased,'leased');}catch{return;}
   let payload;
   try{payload=service.prepared(validationInput(row),{checkConnectionVersion:true});}
   catch(error){const code=safeCode(error.code,'AUTHORIZATION_REVOKED');db.prepare("UPDATE publication_jobs SET status='blocked',error_code=?,version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND lease_token=?").run(code,ctx.now(),...key(row),row.lease_token);audit(row,'publication.blocked',code);return;}
   if(row.attempt_count>=row.max_attempts){db.prepare("UPDATE publication_jobs SET status='failed',error_code='RETRIES_EXHAUSTED',version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?").run(ctx.now(),...key(row));return;}
   const attemptId=id(),now=ctx.now();
   db.prepare("UPDATE publication_jobs SET status='sending',attempt_count=attempt_count+1,version=version+1,lease_until=?,error_code=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND lease_token=?").run(plus(now,leaseMs),now,...key(row),row.lease_token);
   db.prepare("INSERT INTO publication_attempts(tenant_id,workspace_id,id,job_id,attempt_number,lease_token,outcome,started_at) VALUES(?,?,?,?,?,?,'sending',?)").run(row.tenant_id,row.workspace_id,attemptId,row.id,row.attempt_count+1,row.lease_token,now);
   begun={row:find(row),payload,attemptId};
  });
  if(!begun)return null;
  const {row,payload,attemptId}=begun,abort=new AbortController();controllers.add(abort);
  let timeout,abortListener,checkpointDeniedCode=null;
  const aborted=new Promise(resolve=>{abortListener=()=>resolve({outcome:'interrupted',code:'WORKER_INTERRUPTED'});abort.signal.addEventListener('abort',abortListener,{once:true});});
  timeout=setTimeout(()=>abort.abort(),timeoutMs);timeout.unref?.();
  const saveProviderState=async state=>{
   const normalized=normalizeState(state);
   return ctx.transaction(()=>{
    const current=guard(row),previous=stateOf(current);
    if(abort.signal.aborted)throw new Error('PUBLICATION_ABORTED');
    if(previous?.stage==='publishing'&&normalized.stage!=='publishing')throw new Error('PUBLICATION_STATE_REGRESSION');
    if(previous?.containerId&&previous.containerId!==normalized.containerId)throw new Error('PUBLICATION_CONTAINER_CHANGED');
    if(normalized.stage==='publishing'){
     if(current.expires_at<=ctx.now()){checkpointDeniedCode='PUBLICATION_EXPIRED';throw new Error('PUBLICATION_EXPIRED');}
     try{service.prepared(validationInput(current),{checkConnectionVersion:true});}catch(error){checkpointDeniedCode=safeCode(error.code,'AUTHORIZATION_REVOKED');throw error;}
    }
    db.prepare("UPDATE publication_jobs SET provider_state=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND lease_token=? AND status='sending'").run(JSON.stringify(normalized),ctx.now(),...key(current),current.lease_token);
   });
  };
  let result;
  try{
   result=await Promise.race([Promise.resolve().then(()=>service.adapter.publish({...payload,jobId:row.id,attemptId,providerState:stateOf(row),saveProviderState,signal:abort.signal})),aborted]);
  }catch{result={outcome:'interrupted',code:'PROVIDER_AMBIGUOUS'};}
  finally{clearTimeout(timeout);abort.signal.removeEventListener('abort',abortListener);controllers.delete(abort);}
  return ctx.transaction(()=>{
   const current=find(row);
   // A stale process cannot overwrite cancellation/recovery or another process's lease.
   if(!current||current.status!=='sending'||current.lease_token!==row.lease_token||current.lease_owner!==workerId)return null;
   if(current.lease_until<=ctx.now()){recover();return null;}
   const now=ctx.now(),state=stateOf(current);let status,code=null,remoteId=null,publishedAt=null,nextAttempt=now,attemptOutcome,providerState=current.provider_state;
   if(checkpointDeniedCode&&state?.stage!=='publishing'){
    status=checkpointDeniedCode==='PUBLICATION_EXPIRED'?'failed':'blocked';code=checkpointDeniedCode;attemptOutcome='failed';
   }else if(result?.outcome==='published'&&typeof result.remoteId==='string'&&/^[\w.-]{1,200}$/.test(result.remoteId)){
    status='published';remoteId=result.remoteId;publishedAt=now;attemptOutcome='published';
   }else if(result?.outcome==='retry'&&result.safeToRetry===true){
    status=current.attempt_count<current.max_attempts&&current.expires_at>now?'retry_wait':'failed';attemptOutcome=status==='retry_wait'?'retry':'failed';
    code=status==='failed'?'RETRIES_EXHAUSTED':safeCode(result.code,'PROVIDER_FAILED');
    const delay=Math.max(1000,Math.min(3600000,Number.isFinite(result.retryAfterMs)?result.retryAfterMs:Math.min(15*60000,30000*2**(current.attempt_count-1))));nextAttempt=plus(now,delay);
    if(state?.stage==='publishing')providerState=JSON.stringify({...state,stage:'ready'});
   }else if(result?.outcome==='failed'){
    status='failed';attemptOutcome='failed';code=safeCode(result.code,'PROVIDER_FAILED');
   }else if(result?.outcome==='interrupted'&&safeToResume(current)){
    status=current.attempt_count<current.max_attempts&&current.expires_at>now?'retry_wait':'failed';attemptOutcome=status==='retry_wait'?'recovered_safe':'failed';code=status==='retry_wait'?'WORKER_INTERRUPTED_BEFORE_PUBLISH':'RETRIES_EXHAUSTED';nextAttempt=plus(now,60000);
   }else{
    status='needs_attention';attemptOutcome='ambiguous';code=safeCode(result?.code,'PROVIDER_AMBIGUOUS');
   }
   db.prepare('UPDATE publication_jobs SET status=?,error_code=?,remote_id=?,published_at=?,provider_state=?,next_attempt_at=?,version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND lease_token=? AND status=\'sending\'').run(status,code,remoteId,publishedAt,providerState,nextAttempt,now,...key(current),current.lease_token);
   db.prepare("UPDATE publication_attempts SET outcome=?,error_code=?,finished_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND outcome='sending'").run(attemptOutcome,code,now,current.tenant_id,current.workspace_id,attemptId);
   audit(current,`publication.${attemptOutcome}`,code);
   return find(current);
  });
 }
 function dispatch(leased){const promise=dispatchInternal(leased);flights.add(promise);promise.finally(()=>flights.delete(promise)).catch(()=>{});return promise;}
 async function tick({limit=10}={}){
  if(!running||busy)return 0;busy=true;
  try{heartbeat();recover();let count=0;for(;count<Math.max(1,Math.min(100,limit))&&running;count++){const job=claim();if(!job)break;active=dispatch(job);await active;active=null;}return count;}
  finally{busy=false;active=null;}
 }
 function start({timer:useTimer=true}={}){
  if(running||!service.adapter.enabled)return;
  running=true;heartbeat();recover();
  if(useTimer){timer=setInterval(()=>{void tick().catch(()=>{void stop().catch(()=>{});});},1000);heartbeatTimer=setInterval(()=>{try{heartbeat();}catch{}},5000);timer.unref?.();heartbeatTimer.unref?.();}
 }
 async function stop(){
  clearInterval(timer);clearInterval(heartbeatTimer);timer=null;heartbeatTimer=null;
  running=false;ctx.caps.socialPublishing=false;for(const controller of controllers)controller.abort();await Promise.allSettled([...flights]);
  db.prepare('UPDATE publication_workers SET stopped_at=? WHERE id=?').run(ctx.now(),workerId);
  // Unsent leases owned by this process are released immediately during graceful shutdown.
  db.prepare("UPDATE publication_jobs SET status='scheduled',version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE status='leased' AND lease_owner=?").run(ctx.now(),workerId);
 }
 return {id:workerId,get running(){return running;},start,stop,heartbeat,recover,claim,dispatch,tick};
}
