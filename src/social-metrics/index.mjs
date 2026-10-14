import { randomUUID } from 'node:crypto';
import { workspace } from '../editorial/shared.mjs';
import { createMetaMetricsAdapter, scopeCode, safeError, REMOTE_POST_LIMIT } from './meta.mjs';
import { API_VERSION, MetricsError, codes, emptyMetrics, safeMetrics, safePermalink, platformLabels, plus } from './model.mjs';

const KEY = r => [r.tenant_id,r.workspace_id,r.channel_id];
const sourceSQL=`SELECT c.*,ch.version AS channel_version,ch.label,ch.archived_at AS channel_archived,w.archived_at AS workspace_archived,t.status AS tenant_status,
 m.status AS member_status,m.role AS member_role,u.status AS user_status,u.email_verified_at,
 s.enabled,s.enabled_by,s.version AS settings_version,s.cadence_minutes,
 om.status AS owner_status,om.role AS owner_role,ou.status AS owner_user_status,ou.email_verified_at AS owner_verified
 FROM social_connections c
 JOIN channels ch ON ch.tenant_id=c.tenant_id AND ch.workspace_id=c.workspace_id AND ch.id=c.channel_id
 JOIN workspaces w ON w.tenant_id=c.tenant_id AND w.id=c.workspace_id JOIN tenants t ON t.id=c.tenant_id
 JOIN memberships m ON m.tenant_id=c.tenant_id AND m.user_id=c.connected_by JOIN users u ON u.id=m.user_id
 LEFT JOIN social_metrics_settings s ON s.tenant_id=c.tenant_id AND s.workspace_id=c.workspace_id
 LEFT JOIN memberships om ON om.tenant_id=s.tenant_id AND om.user_id=s.enabled_by LEFT JOIN users ou ON ou.id=om.user_id`;
function sourceCode(r,at){
 if(!r||r.status!=='active'||r.expires_at<=at)return 'METRICS_DISCONNECTED';
 if(r.channel_archived||r.workspace_archived||r.tenant_status!=='active'||r.member_status!=='active'||!['owner','admin'].includes(r.member_role)||r.user_status!=='active'||!r.email_verified_at)return 'METRICS_AUTHORITY_LOST';
 if(r.enabled&&(r.owner_status!=='active'||r.owner_role!=='owner'||r.owner_user_status!=='active'||!r.owner_verified))return 'METRICS_AUTHORITY_LOST';
 let permissions;try{permissions=JSON.parse(r.permissions);}catch{return 'METRICS_SCOPE_MISSING';}
 return scopeCode({platform:r.platform,permissions,businessManagerGrant:r.access_basis==='business_manager'});
}
function testOptions(ctx,options){
 const raw=options.socialMetrics??{};
 if(ctx.config.mode!=='test'&&Object.keys(raw).length)throw new Error('METRICS_TEST_OPTIONS_FORBIDDEN');
 const integer=(key,defaultValue,min,max)=>{const n=raw[key]??defaultValue;if(!Number.isInteger(n)||n<min||n>max)throw new Error('METRICS_CONFIG_INVALID');return n;};
 if(raw.fetchImpl!==undefined&&typeof raw.fetchImpl!=='function'||raw.enabled!==undefined&&typeof raw.enabled!=='boolean')throw new Error('METRICS_CONFIG_INVALID');
 // Tests must inject transport to enable work. Global process env can never cause live network in tests.
 const enabled=ctx.config.mode==='test'?raw.enabled===true&&typeof raw.fetchImpl==='function':process.env.SOCIAL_SAAS_METRICS_ENABLED==='true';
 return {enabled,fetchImpl:raw.fetchImpl??globalThis.fetch,timeoutMs:integer('timeoutMs',10000,10,30000),pollMs:integer('pollMs',60000,10,300000),budgetMs:integer('budgetMs',60000,10,120000),maxPosts:integer('maxPosts',20,1,25),maxAccounts:integer('maxAccounts',4,1,10),autoStart:raw.autoStart!==false};
}
export function initializeSocialMetrics(ctx,options={}){
 const config=testOptions(ctx,options),{db,transaction,now}=ctx;
 const adapter=createMetaMetricsAdapter({fetchImpl:config.fetchImpl,timeoutMs:config.timeoutMs,now});
 let timer=null,inFlight=null,controller=null,running=false;
 const readSource=(tid,wid,cid)=>db.prepare(sourceSQL+' WHERE c.tenant_id=? AND c.workspace_id=? AND c.channel_id=?').get(tid,wid,cid);
 const fail=(status,code)=>{throw ctx.errors.http(status,code,codes[code]||'Não foi possível alterar a coleta.');};
 function settings(tid,wid){const s=db.prepare('SELECT enabled,cadence_minutes,version FROM social_metrics_settings WHERE tenant_id=? AND workspace_id=?').get(tid,wid);return {enabled:s?.enabled===1,cadenceMinutes:s?.cadence_minutes??15,version:s?.version??1};}
 function configure(req){return transaction(()=>{
  const w=workspace(ctx,req,'manage');ctx.auth.requireRecentAuth(req);
  if(req.tenant.role!=='owner')fail(403,'FORBIDDEN');if(w.archived_at||req.tenant.status!=='active')fail(409,'METRICS_AUTHORITY_LOST');
  const {enabled,cadenceMinutes=settings(req.params.tid,req.params.wid).cadenceMinutes,expectedVersion}=req.body??{};
  if(typeof enabled!=='boolean'||!Number.isInteger(cadenceMinutes)||cadenceMinutes<15||cadenceMinutes>1440||!Number.isInteger(expectedVersion)||expectedVersion<1)fail(422,'METRICS_CONFIG_INVALID');
  const tid=req.params.tid,wid=req.params.wid,current=settings(tid,wid);if(expectedVersion!==current.version)fail(409,'METRICS_SETTINGS_CONFLICT');
  db.prepare(`INSERT INTO social_metrics_settings(tenant_id,workspace_id,enabled,cadence_minutes,enabled_by,version,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,workspace_id) DO UPDATE SET enabled=excluded.enabled,cadence_minutes=excluded.cadence_minutes,enabled_by=excluded.enabled_by,version=excluded.version,updated_at=excluded.updated_at`).run(tid,wid,Number(enabled),cadenceMinutes,req.user.id,current.version+1,now());
  // Fence in-flight responses immediately. Owner controls do not themselves perform a provider request.
  db.prepare('UPDATE social_metrics_sync SET lease_token=NULL,lease_until=NULL,next_run_at=? WHERE tenant_id=? AND workspace_id=?').run(now(),tid,wid);
  ctx.audit({tenantId:tid,actorId:req.user.id,action:'social.metrics_configured',targetType:'workspace',targetId:wid,safeChanges:{enabled,cadenceMinutes,version:current.version+1},requestId:req.id});
  return settings(tid,wid);
 });}
 function summary(tid,wid){
  const at=now(),brand=db.prepare('SELECT w.name,w.color,w.archived_at,t.status FROM workspaces w JOIN tenants t ON t.id=w.tenant_id WHERE w.tenant_id=? AND w.id=?').get(tid,wid);
  if(!brand)fail(404,'NOT_FOUND');
  const s=settings(tid,wid),notices=new Map();const note=code=>{if(code&&codes[code])notices.set(code,{code,message:codes[code]});};
  note('METRICS_RECENT_COVERAGE');
  if(!config.enabled)note('METRICS_DISABLED');else if(!s.enabled)note('METRICS_PAUSED');
  const channels=db.prepare("SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND archived_at IS NULL AND platform IN ('instagram','facebook','linkedin') ORDER BY created_at,id").all(tid,wid);
  const accounts=channels.map(ch=>{
   const r=readSource(tid,wid,ch.id),sync=db.prepare('SELECT * FROM social_metrics_sync WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(tid,wid,ch.id);
   let code=ch.platform==='linkedin'?'METRICS_LINKEDIN_UNSUPPORTED':sourceCode(r,at);
   if(brand.archived_at||brand.status!=='active')code='METRICS_AUTHORITY_LOST';
   const authorized=!code,matching=authorized&&sync?.authorization_version===r.authorization_version;
   const snapshot=authorized?db.prepare('SELECT * FROM social_metrics_accounts WHERE tenant_id=? AND workspace_id=? AND channel_id=? AND authorization_version=?').get(tid,wid,ch.id,r.authorization_version):null;
   if(!code&&matching&&['disconnected','scope_missing'].includes(sync.status))code=sync.code;
   const hide=Boolean(code),stale=Boolean(snapshot)&&(Date.parse(at)-Date.parse(snapshot.observed_at)>s.cadenceMinutes*120000||!config.enabled||!s.enabled||matching&&['error','unsupported'].includes(sync.status));
   let status=hide?(ch.platform==='linkedin'?'unsupported':code==='METRICS_SCOPE_MISSING'?'scope_missing':'disconnected'):!config.enabled?'disabled':!s.enabled?'paused':matching&&['error','unsupported'].includes(sync.status)?sync.status:stale?'stale':snapshot?'partial':matching&&sync.status==='syncing'?'syncing':'pending';
   code??=matching&&sync.code?sync.code:stale?'METRICS_STALE':!snapshot?'METRICS_PENDING':null;
   note(code);
   let metrics=hide?emptyMetrics('account',code,status):snapshot?safeMetrics(snapshot.metrics_json,'account'):emptyMetrics('account','METRICS_PENDING','pending');
   if(stale)metrics=metrics.map(m=>m.value===null?m:{...m,state:'stale',code:'METRICS_STALE'});
   const publications=db.prepare(`SELECT j.id,j.remote_id,j.platform,j.published_at,p.observed_at,p.last_attempt_at,p.status,p.code,p.permalink,p.metrics_json,p.authorization_version FROM publication_jobs j LEFT JOIN social_metrics_posts p ON p.tenant_id=j.tenant_id AND p.workspace_id=j.workspace_id AND p.publication_id=j.id WHERE j.tenant_id=? AND j.workspace_id=? AND j.channel_id=? AND j.status='published' ORDER BY j.published_at DESC,j.id DESC LIMIT 100`).all(tid,wid,ch.id);
   const discovery=!hide?db.prepare('SELECT * FROM social_metrics_discovery WHERE tenant_id=? AND workspace_id=? AND channel_id=? AND authorization_version=?').get(tid,wid,ch.id,r.authorization_version):null;
   const remoteRows=!hide?db.prepare('SELECT * FROM social_metrics_remote_posts WHERE tenant_id=? AND workspace_id=? AND channel_id=? AND authorization_version=? AND account_id=? ORDER BY published_at DESC,remote_id LIMIT 25').all(tid,wid,ch.id,r.authorization_version,r.account_id):[];
   const remoteMap=new Map(remoteRows.map(p=>[p.remote_id,p]));
   const localIds=new Set(publications.map(p=>p.remote_id));
   const remoteStale=Boolean(discovery)&&(discovery.status!=='partial'||!config.enabled||!s.enabled||Date.parse(at)-Date.parse(discovery.observed_at)>s.cadenceMinutes*120000);
   const posts=publications.map(stored=>{
    const remote=remoteMap.get(stored.remote_id);
    const preferRemote=remote&&(!stored.observed_at||remote.observed_at>=stored.observed_at);
    const p=preferRemote?{...stored,observed_at:remote.observed_at,last_attempt_at:remote.observed_at,status:remoteStale?'error':'partial',code:remoteStale?'METRICS_STALE':null,permalink:remote.permalink,metrics_json:remote.metrics_json,authorization_version:remote.authorization_version}:stored;
    const available=!hide&&p.authorization_version===r?.authorization_version;
    const expired=available&&p.observed_at&&Date.parse(at)-Date.parse(p.observed_at)>s.cadenceMinutes*120000;
    const outside=Date.parse(p.published_at)<Date.parse(at)-90*86400000;
    let pm=available?safeMetrics(p.metrics_json,'post'):emptyMetrics('post',hide?code:outside?'METRICS_HISTORY_WINDOW':'METRICS_PENDING',hide?'disconnected':outside?'unsupported':'pending');
    if(expired||available&&p.status==='error')pm=pm.map(m=>m.value===null?m:{...m,state:'stale',code:'METRICS_STALE'});
    return {id:p.id,platform:p.platform,publishedAt:p.published_at,permalink:available?safePermalink(p.permalink,p.platform):null,status:hide?status:available?(expired?'stale':p.status):outside?'unsupported':'pending',code:hide?code:available?p.code:outside?'METRICS_HISTORY_WINDOW':'METRICS_PENDING',observedAt:available?p.observed_at:null,lastSyncedAt:available?p.observed_at:null,lastAttemptAt:available?p.last_attempt_at:null,metrics:pm};
   });
   for(const remote of remoteRows){
    if(localIds.has(remote.remote_id))continue;
    const stalePost=remoteStale||Date.parse(at)-Date.parse(remote.observed_at)>s.cadenceMinutes*120000;
    let pm=safeMetrics(remote.metrics_json,'post');if(stalePost)pm=pm.map(m=>m.value===null?m:{...m,state:'stale',code:'METRICS_STALE'});
    posts.push({id:`remote:${remote.remote_id}`,platform:ch.platform,publishedAt:remote.published_at,permalink:safePermalink(remote.permalink,ch.platform),status:stalePost?'stale':'partial',code:stalePost?'METRICS_STALE':null,observedAt:remote.observed_at,lastSyncedAt:remote.observed_at,lastAttemptAt:discovery?.last_attempt_at??remote.observed_at,metrics:pm});
   }
   posts.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)||a.id.localeCompare(b.id));
   const coverage={scope:'recent_account_posts_and_agendepost',limit:REMOTE_POST_LIMIT,pages:1,fullHistory:false,returnedCount:discovery?.observed_at?discovery.returned_count:null,hasMore:discovery?.has_more===null||!discovery?null:discovery.has_more===1,observedAt:discovery?.observed_at??null,lastAttemptAt:discovery?.last_attempt_at??null,status:hide?status:discovery?.status??'pending'};
   return {id:ch.id,channelId:ch.id,platform:ch.platform,platformLabel:platformLabels[ch.platform],label:ch.label,displayName:r?.destination_label??ch.label,connectionStatus:ch.platform==='linkedin'?'unsupported':r?.status==='active'&&r.expires_at>at?'connected':r?'disconnected':'not_connected',status,code,observedAt:hide?null:snapshot?.observed_at??null,lastSyncedAt:hide?null:snapshot?.observed_at??null,lastAttemptAt:matching?sync.last_attempt_at:null,nextRefreshAt:config.enabled&&s.enabled&&authorized?(sync?.next_run_at??null):null,metrics,posts:posts.slice(0,100),coverage};
  });
  const stamps=accounts.map(a=>a.observedAt).filter(Boolean).sort(),attempts=accounts.map(a=>a.lastAttemptAt).filter(Boolean).sort(),next=accounts.map(a=>a.nextRefreshAt).filter(Boolean).sort();
  const stale=accounts.some(a=>['stale','error'].includes(a.status)||a.metrics.some(m=>m.state==='stale')||a.posts.some(p=>p.status==='stale'||p.metrics.some(m=>m.state==='stale')));
  return {brand:{name:brand.name,color:brand.color},generatedAt:at,lastSyncedAt:stamps.at(-1)??null,stale,collection:{enabled:config.enabled&&s.enabled,status:!config.enabled?'disabled':!s.enabled?'paused':accounts.some(a=>a.status==='syncing')?'syncing':stale?'stale':stamps.length?'partial':'pending',lastAttemptAt:attempts.at(-1)??null,nextRunAt:next[0]??null},accounts,notices:[...notices.values()],settings:s};
 }
 function claim(visited){return transaction(()=>{
  if(!config.enabled)return null;const at=now();
  // An active owner explicitly enabled each brand. Rechecking uses current DB authority, not a copied token.
  const rows=db.prepare(sourceSQL+" WHERE s.enabled=1 AND c.status='active' AND c.expires_at>? AND ch.archived_at IS NULL AND w.archived_at IS NULL AND t.status='active' ORDER BY c.created_at,c.id").all(at);
  for(const r of rows){if(sourceCode(r,at))continue;
   const old=db.prepare('SELECT * FROM social_metrics_sync WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(...KEY(r));
   if(!old||old.authorization_version!==r.authorization_version||old.channel_version!==r.channel_version||old.settings_version!==r.settings_version){
    db.prepare(`INSERT INTO social_metrics_sync(tenant_id,workspace_id,channel_id,authorization_version,channel_version,settings_version,status,next_run_at) VALUES(?,?,?,?,?,?,'pending',?) ON CONFLICT(tenant_id,workspace_id,channel_id) DO UPDATE SET authorization_version=excluded.authorization_version,channel_version=excluded.channel_version,settings_version=excluded.settings_version,status='pending',code=NULL,next_run_at=excluded.next_run_at,failure_count=0,lease_token=NULL,lease_until=NULL`).run(...KEY(r),r.authorization_version,r.channel_version,r.settings_version,at);
   }
  }
  const due=db.prepare(`SELECT * FROM social_metrics_sync WHERE next_run_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_run_at,tenant_id,workspace_id,channel_id`).all(at,at);
  for(const candidate of due){if(visited.has(JSON.stringify(KEY(candidate))))continue;const r=readSource(...KEY(candidate));if(!r||!r.enabled||sourceCode(r,at))continue;
   const lease=randomUUID(),leaseUntil=plus(at,config.budgetMs+30000);
   const result=db.prepare("UPDATE social_metrics_sync SET status='syncing',lease_token=?,lease_until=?,last_attempt_at=? WHERE tenant_id=? AND workspace_id=? AND channel_id=? AND (lease_until IS NULL OR lease_until<=?)").run(lease,leaseUntil,at,...KEY(r),at);
   if(result.changes===1)return {...candidate,...r,lease_token:lease,lease_until:leaseUntil};
  }return null;
 });}
 function current(job,signal){
  if(signal.aborted)throw new MetricsError('METRICS_STOPPED');
  const r=readSource(...KEY(job)),c=db.prepare('SELECT lease_token,lease_until FROM social_metrics_sync WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(...KEY(job));
  if(!config.enabled||!r?.enabled||!c||c.lease_token!==job.lease_token||c.lease_until<=now()||r.authorization_version!==job.authorization_version||r.channel_version!==job.channel_version||r.settings_version!==job.settings_version)throw new MetricsError('METRICS_CONNECTION_CHANGED');
  const code=sourceCode(r,now());if(code)throw new MetricsError(code);
  // Only worker execution invokes this private credential resolver. summary/configure never do.
  const binding=ctx.services.socialConnections?.resolveBinding({tenantId:r.tenant_id,workspaceId:r.workspace_id,channelId:r.channel_id,platform:r.platform});
  if(!binding||binding.connectionVersion!==r.authorization_version||binding.accountId!==r.account_id||binding.linkedPageId!==r.page_id||binding.tenantId!==r.tenant_id||binding.workspaceId!==r.workspace_id||binding.channelId!==r.channel_id||binding.platform!==r.platform)throw new MetricsError('METRICS_DISCONNECTED');
  const scope=scopeCode(binding);if(scope)throw new MetricsError(scope);return binding;
 }
 function persistPost(job,post,result,error,signal){transaction(()=>{
  current(job,signal);const at=now();
  // Published records are rechecked before writing. No current draft content is ever queried.
  const exists=db.prepare("SELECT 1 FROM publication_jobs WHERE tenant_id=? AND workspace_id=? AND id=? AND channel_id=? AND status='published' AND remote_id=?").get(job.tenant_id,job.workspace_id,post.id,job.channel_id,post.remote_id);if(!exists)throw new MetricsError('METRICS_CONNECTION_CHANGED');
  const previous=db.prepare('SELECT * FROM social_metrics_posts WHERE tenant_id=? AND workspace_id=? AND publication_id=? AND authorization_version=?').get(job.tenant_id,job.workspace_id,post.id,job.authorization_version);
  const status=error?(error.code==='METRICS_UNSUPPORTED'?'unsupported':error.code==='METRICS_SCOPE_MISSING'?'scope_missing':error.code==='METRICS_DISCONNECTED'?'disconnected':'error'):'partial';
  db.prepare(`INSERT INTO social_metrics_posts(tenant_id,workspace_id,publication_id,channel_id,authorization_version,observed_at,last_attempt_at,status,code,permalink,metrics_json) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,workspace_id,publication_id) DO UPDATE SET channel_id=excluded.channel_id,authorization_version=excluded.authorization_version,observed_at=excluded.observed_at,last_attempt_at=excluded.last_attempt_at,status=excluded.status,code=excluded.code,permalink=excluded.permalink,metrics_json=excluded.metrics_json`).run(job.tenant_id,job.workspace_id,post.id,job.channel_id,job.authorization_version,result?.observedAt??previous?.observed_at??null,at,status,error?.code??null,result?.permalink??previous?.permalink??null,JSON.stringify(result?safeMetrics(result.metrics,'post'):previous?safeMetrics(previous.metrics_json,'post'):emptyMetrics('post',error?.code??'METRICS_PENDING','error')));
 });}
 function persistDiscovery(job,result,error,signal){transaction(()=>{
  current(job,signal);const at=now();
  const previous=db.prepare('SELECT * FROM social_metrics_discovery WHERE tenant_id=? AND workspace_id=? AND channel_id=? AND authorization_version=?').get(...KEY(job),job.authorization_version);
  if(result){
   // A successful bounded list replaces the previous bounded window; absence is not recorded as a deletion event.
   db.prepare('DELETE FROM social_metrics_remote_posts WHERE tenant_id=? AND workspace_id=? AND channel_id=?').run(...KEY(job));
   const insert=db.prepare('INSERT INTO social_metrics_remote_posts(tenant_id,workspace_id,channel_id,remote_id,account_id,authorization_version,published_at,observed_at,permalink,metrics_json) VALUES(?,?,?,?,?,?,?,?,?,?)');
   for(const post of result.posts)insert.run(...KEY(job),post.remoteId,job.account_id,job.authorization_version,post.publishedAt,post.observedAt,safePermalink(post.permalink,job.platform),JSON.stringify(safeMetrics(post.metrics,'post')));
  }
  const status=error?(error.code==='METRICS_UNSUPPORTED'?'unsupported':error.code==='METRICS_SCOPE_MISSING'?'scope_missing':error.code==='METRICS_DISCONNECTED'?'disconnected':'error'):'partial';
  db.prepare(`INSERT INTO social_metrics_discovery(tenant_id,workspace_id,channel_id,authorization_version,observed_at,last_attempt_at,status,code,returned_count,has_more) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,workspace_id,channel_id) DO UPDATE SET authorization_version=excluded.authorization_version,observed_at=excluded.observed_at,last_attempt_at=excluded.last_attempt_at,status=excluded.status,code=excluded.code,returned_count=excluded.returned_count,has_more=excluded.has_more`).run(...KEY(job),job.authorization_version,result?.observedAt??previous?.observed_at??null,at,status,error?.code??null,result?.posts.length??previous?.returned_count??0,result?Number(result.hasMore):previous?.has_more??null);
 });}
 async function collect(job,signal){
  const input={signal,assertCurrent:()=>current(job,signal)};
  let lastError=null;
  try{
   const result=await adapter.account(input);
   transaction(()=>{current(job,signal);db.prepare(`INSERT INTO social_metrics_accounts(tenant_id,workspace_id,channel_id,authorization_version,observed_at,metrics_json) VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,workspace_id,channel_id) DO UPDATE SET authorization_version=excluded.authorization_version,observed_at=excluded.observed_at,metrics_json=excluded.metrics_json`).run(...KEY(job),job.authorization_version,result.observedAt,JSON.stringify(safeMetrics(result.metrics,'account')));});
   let discovered=null;
   try{discovered=await adapter.recentPosts(input);persistDiscovery(job,discovered,null,signal);}catch(error){const safe=safeError(error);if(['METRICS_CONNECTION_CHANGED','METRICS_STOPPED','METRICS_AUTHORITY_LOST'].includes(safe.code))throw safe;persistDiscovery(job,null,safe,signal);lastError=safe;if(['METRICS_RATE_LIMIT','METRICS_DISCONNECTED','METRICS_SCOPE_MISSING','METRICS_TIMEOUT','METRICS_PROVIDER_ERROR'].includes(safe.code))throw safe;}
   const discoveredById=new Map(discovered?.posts.map(p=>[p.remoteId,p])??[]);
   const posts=db.prepare(`SELECT j.* FROM publication_jobs j LEFT JOIN social_metrics_posts p ON p.tenant_id=j.tenant_id AND p.workspace_id=j.workspace_id AND p.publication_id=j.id WHERE j.tenant_id=? AND j.workspace_id=? AND j.channel_id=? AND j.status='published' AND j.published_at>=? AND (p.last_attempt_at IS NULL OR p.last_attempt_at<=?) ORDER BY COALESCE(p.last_attempt_at,''),j.published_at DESC,j.id LIMIT ?`).all(...KEY(job),plus(now(),-90*86400000),plus(now(),-job.cadence_minutes*60000),config.maxPosts);
   for(const post of posts){
    try{persistPost(job,post,discoveredById.get(post.remote_id)??await adapter.post(input,post),null,signal);}catch(error){const safe=safeError(error);if(['METRICS_CONNECTION_CHANGED','METRICS_STOPPED','METRICS_AUTHORITY_LOST'].includes(safe.code))throw safe;persistPost(job,post,null,safe,signal);lastError=safe;if(['METRICS_RATE_LIMIT','METRICS_DISCONNECTED','METRICS_SCOPE_MISSING','METRICS_TIMEOUT','METRICS_PROVIDER_ERROR'].includes(safe.code))break;}
   }
  }catch(error){lastError=safeError(error);}
  // Compare-and-set lease prevents revoked/rebound or disabled work from completing a stale result.
  transaction(()=>{
   const fresh=readSource(...KEY(job));if(!fresh||fresh.authorization_version!==job.authorization_version||fresh.channel_version!==job.channel_version||fresh.settings_version!==job.settings_version||!fresh.enabled||sourceCode(fresh,now()))return;
   const attempts=lastError?Math.min(20,(job.failure_count??0)+1):0;
   const delay=lastError?Math.min(86400000,Math.max(job.cadence_minutes*60000*2**Math.min(attempts-1,6),lastError.retryAfterMs||0)):job.cadence_minutes*60000;
   const status=lastError?(lastError.code==='METRICS_DISCONNECTED'?'disconnected':lastError.code==='METRICS_SCOPE_MISSING'?'scope_missing':lastError.code==='METRICS_UNSUPPORTED'?'unsupported':'error'):'partial';
   db.prepare('UPDATE social_metrics_sync SET status=?,code=?,last_success_at=CASE WHEN ? IS NULL THEN ? ELSE last_success_at END,next_run_at=?,failure_count=?,lease_token=NULL,lease_until=NULL WHERE tenant_id=? AND workspace_id=? AND channel_id=? AND lease_token=?').run(status,lastError?.code??null,lastError?.code??null,now(),plus(now(),delay),attempts,...KEY(job),job.lease_token);
  });
 }
 async function work(){
  let count=0;const visited=new Set();while(count<config.maxAccounts&&!controller.signal.aborted){const job=claim(visited);if(!job)break;visited.add(JSON.stringify(KEY(job)));
   const budget=new AbortController(),timeout=setTimeout(()=>budget.abort(),config.budgetMs),signal=AbortSignal.any([controller.signal,budget.signal]);
   try{await collect(job,signal);}finally{clearTimeout(timeout);}count++;
  }return {processed:count,enabled:config.enabled};
 }
 function tick(){
  if(inFlight)return inFlight;if(!config.enabled)return Promise.resolve({processed:0,enabled:false});
  controller=new AbortController();inFlight=work().finally(()=>{inFlight=null;controller=null;});return inFlight;
 }
 function start(){if(running||!config.enabled)return {running};running=true;if(config.autoStart){timer=setInterval(()=>{tick().catch(()=>{});},config.pollMs);timer.unref?.();tick().catch(()=>{});}return {running};}
 async function stop(){running=false;if(timer){clearInterval(timer);timer=null;}controller?.abort();if(inFlight)await inFlight;return {running:false};}
 const service={summary,settings,configure,start,stop,tick,get running(){return running;},get enabled(){return config.enabled;},apiVersion:API_VERSION};
 ctx.services.socialMetrics=service;ctx.caps.socialMetrics=config.enabled;return service;
}
