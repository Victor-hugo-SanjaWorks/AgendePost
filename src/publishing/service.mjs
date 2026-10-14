import { createHash } from 'node:crypto';
import { id, plus, message, safeCode, publicationDTO } from './shared.mjs';
import { validateSchedule } from '../editorial/shared.mjs';

export function createPublishingService(ctx, adapter) {
 const {db}=ctx;
 const fail=(status,code)=>{throw ctx.errors.http(status,code,message(code));};
 const rowJob=(tid,wid,jid)=>db.prepare('SELECT * FROM publication_jobs WHERE tenant_id=? AND workspace_id=? AND id=?').get(tid,wid,jid);
 function authorize(actorId,tenantId,workspaceId,roles=['owner','admin','editor']) {
  const row=db.prepare(`SELECT m.*,u.status AS user_status,u.email_verified_at,t.status AS tenant_status,w.archived_at FROM memberships m
   JOIN users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id JOIN workspaces w ON w.tenant_id=m.tenant_id AND w.id=?
   WHERE m.tenant_id=? AND m.user_id=?`).get(workspaceId,tenantId,actorId);
  if(!row || row.user_status!=='active'||!row.email_verified_at||row.status!=='active'||!roles.includes(row.role)) fail(403,'AUTHORIZATION_REVOKED');
  if(row.tenant_status!=='active')fail(403,'TENANT_SUSPENDED');
  if(row.archived_at)fail(409,'WORKSPACE_ARCHIVED');
  if(row.scope!=='organization'&&!db.prepare('SELECT 1 FROM workspace_grants WHERE tenant_id=? AND workspace_id=? AND user_id=?').get(tenantId,workspaceId,actorId))fail(403,'AUTHORIZATION_REVOKED');
  return row;
 }
 function prepared(input,{checkConnectionVersion=false}={}) {
  const {tenantId,workspaceId,postId,channelId,actorId,revision}=input;
  authorize(actorId,tenantId,workspaceId);
  const entitlement=ctx.services.entitlements.assertCan(tenantId,'posts',0);
  if(input.validationAt&&entitlement.endsAt<=input.validationAt)fail(409,'ENTITLEMENT_EXPIRES_BEFORE_SCHEDULE');
  const p=db.prepare('SELECT * FROM posts WHERE tenant_id=? AND workspace_id=? AND id=?').get(tenantId,workspaceId,postId);
  if(!p || p.revision!==revision || p.approved_revision!==revision || !['approved','planned'].includes(p.status))fail(409,'APPROVAL_STALE');
  const rev=db.prepare('SELECT * FROM post_revisions WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=?').get(tenantId,workspaceId,postId,revision);
  const approval=db.prepare("SELECT * FROM approvals WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(tenantId,workspaceId,postId,revision);
  if(!rev||!approval||approval.decision!=='approved')fail(409,'APPROVAL_STALE');
  authorize(approval.reviewer_id,tenantId,workspaceId,['owner','admin','reviewer']);
  const tenant=db.prepare('SELECT require_independent_approval FROM tenants WHERE id=?').get(tenantId);
  if(tenant.require_independent_approval&&approval.reviewer_id===rev.actor_id)fail(409,'APPROVAL_STALE');
  const content=JSON.parse(rev.content_snapshot);
  if(content.caption!==p.caption||content.format!==p.format||!Array.isArray(content.channelIds)||!content.channelIds.includes(channelId))fail(409,'APPROVAL_STALE');
  if(p.format!=='image'||!Array.isArray(content.mediaIds)||content.mediaIds.length!==1)fail(422,'UNSUPPORTED_FORMAT');
  const currentMedia=db.prepare('SELECT media_id FROM post_media WHERE tenant_id=? AND workspace_id=? AND post_id=? ORDER BY position').all(tenantId,workspaceId,postId);
  if(currentMedia.length!==1||currentMedia[0].media_id!==content.mediaIds[0])fail(409,'APPROVAL_STALE');
  const channel=db.prepare(`SELECT c.* FROM channels c JOIN post_channels pc ON pc.tenant_id=c.tenant_id AND pc.workspace_id=c.workspace_id AND pc.channel_id=c.id
   WHERE c.tenant_id=? AND c.workspace_id=? AND c.id=? AND pc.post_id=?`).get(tenantId,workspaceId,channelId,postId);
  if(!channel||channel.archived_at)fail(409,'CHANNEL_UNAVAILABLE');
  if(!['instagram','facebook'].includes(channel.platform))fail(422,'UNSUPPORTED_PLATFORM');
  if(input.platform&&input.platform!==channel.platform)fail(409,'CHANNEL_UNAVAILABLE');
  const m=db.prepare(`SELECT m.*,b.bytes FROM media m JOIN media_blobs b ON b.tenant_id=m.tenant_id AND b.workspace_id=m.workspace_id AND b.media_id=m.id
   WHERE m.tenant_id=? AND m.workspace_id=? AND m.id=?`).get(tenantId,workspaceId,content.mediaIds[0]);
  if(!m)fail(409,'MEDIA_UNAVAILABLE');
  const bytes=Buffer.from(m.bytes);
  if(bytes.length!==m.size_bytes||createHash('sha256').update(bytes).digest('hex')!==m.digest)fail(409,'MEDIA_UNAVAILABLE');
  const payload={tenantId,workspaceId,postId,channelId,platform:channel.platform,revision,caption:content.caption,format:content.format,
   media:{id:m.id,mime:m.normalized_mime,width:m.width,height:m.height,sizeBytes:m.size_bytes,digest:m.digest,bytes},now:input.validationAt??ctx.now()};
  if(!adapter.enabled)fail(503,'PUBLISHING_DISABLED');
  let ready;try{ready=adapter.validate(payload);}catch{fail(503,'CONNECTION_UNAVAILABLE');}
  if(!ready||ready.then||ready.ready!==true)fail(409,safeCode(ready?.code,'CONNECTION_UNAVAILABLE'));
  if(typeof ready.connectionVersion!=='string'||!ready.connectionVersion||ready.connectionVersion.length>200)fail(409,'CONNECTION_UNAVAILABLE');
  if(checkConnectionVersion&&input.connectionVersion!==ready.connectionVersion)fail(409,'CONNECTION_CHANGED');
  return {...payload,connectionVersion:ready.connectionVersion};
 }
 function workerStatus(){
  const cutoff=plus(ctx.now(),-30000),currentId=ctx.services.publishing?.worker?.id;
  const row=ctx.config.hosted?db.prepare('SELECT * FROM publication_workers WHERE id=? AND stopped_at IS NULL AND heartbeat_at>?').get(currentId??'',cutoff):db.prepare('SELECT * FROM publication_workers WHERE stopped_at IS NULL AND heartbeat_at>? ORDER BY heartbeat_at DESC LIMIT 1').get(cutoff);
  return {running:!!row,mode:ctx.config.hosted?'hosted-pilot':'local',lastHeartbeatAt:row?.heartbeat_at??null,warning:ctx.config.hosted?'O envio depende do serviço ativo na VPS e de autorização válida. Monitore a saúde do worker e as falhas. Atrasos acima de 15 minutos exigem reagendamento.':'O agendamento local só executa enquanto este aplicativo está aberto e o computador está ligado e acordado. Não é um serviço hospedado 24 horas. Se o envio atrasar mais de 15 minutos, ele falha e exige novo agendamento.'};
 }
 function assertReady(){if(!adapter.enabled)fail(503,'PUBLISHING_DISABLED');if(!workerStatus().running)fail(503,'WORKER_UNAVAILABLE');}
 function readiness(tid,wid){
  const worker=workerStatus();
  const channels=db.prepare('SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND archived_at IS NULL ORDER BY created_at,id').all(tid,wid).map(c=>{
   let result={ready:false,code:'PUBLISHING_DISABLED'};
   if(!['instagram','facebook'].includes(c.platform))result={ready:false,code:'UNSUPPORTED_PLATFORM'};
   else if(adapter.enabled){try{result=adapter.readiness({tenantId:tid,workspaceId:wid,channelId:c.id,platform:c.platform,now:ctx.now()});}catch{result={ready:false,code:'CONNECTION_UNAVAILABLE'};}}
   const ready=adapter.enabled&&worker.running&&result?.ready===true&&!result?.then;
   const code=ready?null:!adapter.enabled?'PUBLISHING_DISABLED':!worker.running?'WORKER_UNAVAILABLE':safeCode(result?.code,'CONNECTION_UNAVAILABLE');
   return {channelId:c.id,platform:c.platform,ready,code,connectionVersion:ready&&typeof result.connectionVersion==='string'?result.connectionVersion:null,destinationId:typeof result?.destinationId==='string'&&/^[0-9]{1,40}$/.test(result.destinationId)?result.destinationId:null,destinationLabel:typeof result?.destinationLabel==='string'?result.destinationLabel.slice(0,120):null,message:code?message(code):'Configuração disponível. A mídia, a aprovação e o acesso serão revalidados antes do envio.'};
  });
  const enabled=adapter.enabled===true&&worker.running;
  return {enabled,worker,maxLatenessMinutes:15,supportedFormats:['image'],channels,message:enabled?'Processo local ativo. Cada destino e imagem precisa passar pela validação antes do agendamento.':message(adapter.enabled?'WORKER_UNAVAILABLE':'PUBLISHING_DISABLED')};
 }
 function enqueue(req){
  assertReady();const {tid:tenantId,wid:workspaceId,pid:postId}=req.params,body=req.body;
  const schedule=validateSchedule(ctx,body.scheduledAt,body.scheduledTimezone,{future:true});
  if(Date.parse(schedule.scheduledAt)>Date.parse(ctx.now())+90*86400000)throw ctx.errors.http(422,'SCHEDULE_TOO_FAR','O agendamento local aceita até 90 dias.');
  const post=db.prepare('SELECT revision FROM posts WHERE tenant_id=? AND workspace_id=? AND id=?').get(tenantId,workspaceId,postId);
  if(!post)throw ctx.errors.http(404,'NOT_FOUND','Peça não encontrada.');
  if(post.revision!==body.expectedRevision)throw ctx.errors.http(409,'REVISION_CONFLICT','A peça mudou. Atualize antes de agendar.');
  if(Object.keys(body.connectionVersions).sort().join(',')!==[...body.channelIds].sort().join(','))throw ctx.errors.http(422,'CONNECTION_VERSIONS_INVALID','Confirme as conexões dos canais escolhidos antes de agendar.');
  const result=[];
  for(const channelId of body.channelIds){
   const payload=prepared({tenantId,workspaceId,postId,channelId,actorId:req.user.id,revision:body.expectedRevision,validationAt:schedule.scheduledAt,connectionVersion:body.connectionVersions[channelId]},{checkConnectionVersion:true});
   if(db.prepare("SELECT 1 FROM publication_jobs WHERE tenant_id=? AND workspace_id=? AND post_id=? AND channel_id=? AND (status='needs_attention' OR (revision=? AND status NOT IN ('cancelled','failed','blocked')))").get(tenantId,workspaceId,postId,channelId,body.expectedRevision))throw ctx.errors.http(409,'PUBLICATION_EXISTS','Esta revisão já tem um envio neste canal, ou uma revisão anterior ainda precisa de verificação antes de novo envio.');
   const jid=id(),now=ctx.now();
   db.prepare(`INSERT INTO publication_jobs(tenant_id,workspace_id,id,post_id,channel_id,platform,revision,actor_id,connection_version,status,scheduled_at,scheduled_timezone,next_attempt_at,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'scheduled',?,?,?,?,?,?)`).run(tenantId,workspaceId,jid,postId,channelId,payload.platform,body.expectedRevision,req.user.id,payload.connectionVersion,schedule.scheduledAt,schedule.scheduledTimezone,schedule.scheduledAt,plus(schedule.scheduledAt,15*60000),now,now);
   ctx.audit({tenantId,actorId:req.user.id,action:'publication.scheduled',targetType:'publication',targetId:jid,safeChanges:{postId,channelId,revision:body.expectedRevision,scheduledAt:schedule.scheduledAt},requestId:req.id});
   result.push(publicationDTO(rowJob(tenantId,workspaceId,jid)));
  }
  return result;
 }
 function mutate(req,action){
  const {tid,wid,jid}=req.params,row=rowJob(tid,wid,jid);if(!row)throw ctx.errors.http(404,'NOT_FOUND','Publicação não encontrada.');
  if(row.version!==req.body.expectedVersion)throw ctx.errors.http(409,'VERSION_CONFLICT','A publicação mudou. Atualize antes de tentar novamente.');
  if(row.status==='sending')throw ctx.errors.http(409,'PUBLICATION_IN_FLIGHT','O envio começou. Não é possível prometer cancelamento ou reagendamento. Aguarde o resultado.');
  if(!['scheduled','retry_wait','leased'].includes(row.status))throw ctx.errors.http(409,'PUBLICATION_NOT_MUTABLE','Esta publicação não pode ser alterada neste estado.');
  if(action==='cancel'){
   db.prepare("UPDATE publication_jobs SET status='cancelled',version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,error_code=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?").run(ctx.now(),tid,wid,jid);
  }else{
   assertReady();
   // Rescheduling grants this caller responsibility; every authorization is checked afresh.
   const schedule=validateSchedule(ctx,req.body.scheduledAt,req.body.scheduledTimezone,{future:true});
   if(Date.parse(schedule.scheduledAt)>Date.parse(ctx.now())+90*86400000)throw ctx.errors.http(422,'SCHEDULE_TOO_FAR','O agendamento local aceita até 90 dias.');
   prepared({tenantId:tid,workspaceId:wid,postId:row.post_id,channelId:row.channel_id,revision:row.revision,actorId:req.user.id,platform:row.platform,connectionVersion:row.connection_version,validationAt:schedule.scheduledAt},{checkConnectionVersion:true});
   db.prepare("UPDATE publication_jobs SET status='scheduled',provider_state=NULL,actor_id=?,scheduled_at=?,scheduled_timezone=?,next_attempt_at=?,expires_at=?,version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,error_code=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?")
    .run(req.user.id,schedule.scheduledAt,schedule.scheduledTimezone,schedule.scheduledAt,plus(schedule.scheduledAt,15*60000),ctx.now(),tid,wid,jid);
  }
  ctx.audit({tenantId:tid,actorId:req.user.id,action:`publication.${action==='cancel'?'cancelled':'rescheduled'}`,targetType:'publication',targetId:jid,safeChanges:{postId:row.post_id,revision:row.revision},requestId:req.id});
  return publicationDTO(rowJob(tid,wid,jid));
 }
 function assertPostMutable(tid,wid,pid){
  if(db.prepare("SELECT 1 FROM publication_jobs WHERE tenant_id=? AND workspace_id=? AND post_id=? AND status='sending'").get(tid,wid,pid))throw ctx.errors.http(409,'PUBLICATION_IN_FLIGHT','Aguarde o resultado do envio antes de alterar esta peça.');
 }
 return {adapter,rowJob,authorize,prepared,readiness,workerStatus,assertReady,enqueue,mutate,assertPostMutable};
}
