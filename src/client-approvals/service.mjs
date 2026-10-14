import { createHash } from 'node:crypto';
import { id, token, digest, plus } from '../auth/utils.mjs';
import { validateSchedule } from '../editorial/shared.mjs';
import { message as publicationMessage, publicationDTO } from '../publishing/shared.mjs';

const ownMessages = {
 CLIENT_APPROVAL_STALE: 'O conteúdo ou o planejamento mudou. É necessário um novo link de aprovação.',
 INTERNAL_APPROVAL_REQUIRED: 'A revisão precisa de aprovação interna válida antes de compartilhar com o cliente.',
 SCHEDULE_IN_PAST: 'O horário planejado passou. Defina uma nova data e solicite nova aprovação.',
 CONNECTION_UNAVAILABLE: 'A conexão não estava confirmada neste pedido. Conecte o canal e gere um novo link.',
 PUBLICATION_EXISTS: 'Esta revisão já tem um envio ou um envio anterior precisa de conferência.',
 CLIENT_REQUEST_REVOKED: 'Este link foi revogado.',
};
const safeMessage = code => ownMessages[code] || publicationMessage(code);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const canonicalChannels = channels => [...channels].sort();
export function createClientApprovalService(ctx) {
 const {db}=ctx, publishing=ctx.services.publishing;
 const fail=(status,code,message)=>{throw ctx.errors.http(status,code,message||safeMessage(code));};
 const row=(tid,wid,aid)=>db.prepare('SELECT * FROM client_approval_requests WHERE tenant_id=? AND workspace_id=? AND id=?').get(tid,wid,aid);
 function currentContent(r,{internal=false}={}) {
  const p=db.prepare('SELECT * FROM posts WHERE tenant_id=? AND workspace_id=? AND id=?').get(r.tenant_id,r.workspace_id,r.post_id);
  const rev=db.prepare('SELECT * FROM post_revisions WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=?').get(r.tenant_id,r.workspace_id,r.post_id,r.revision);
  if(!p||!rev||p.revision!==r.revision||p.status==='archived'||(r.snapshot_digest&&digest(rev.content_snapshot)!==r.snapshot_digest))fail(409,'CLIENT_APPROVAL_STALE');
  let content;try{content=JSON.parse(rev.content_snapshot);}catch{fail(409,'CLIENT_APPROVAL_STALE');}
  const args=[r.tenant_id,r.workspace_id,r.post_id];
  const channels=db.prepare('SELECT channel_id FROM post_channels WHERE tenant_id=? AND workspace_id=? AND post_id=? ORDER BY position').all(...args).map(c=>c.channel_id);
  const media=db.prepare('SELECT media_id FROM post_media WHERE tenant_id=? AND workspace_id=? AND post_id=? ORDER BY position').all(...args).map(m=>m.media_id);
  const tags=db.prepare('SELECT tag FROM post_tags WHERE tenant_id=? AND workspace_id=? AND post_id=? ORDER BY position').all(...args).map(t=>t.tag);
  if(content.title!==p.title||content.caption!==p.caption||content.format!==p.format||!same(content.channelIds,channels)||!same(content.mediaIds,media)||!same(content.tags,tags))fail(409,'CLIENT_APPROVAL_STALE');
  if(Object.hasOwn(r,'source_scheduled_at')&&(p.scheduled_at!==r.source_scheduled_at||p.scheduled_timezone!==r.source_scheduled_timezone))fail(409,'CLIENT_APPROVAL_STALE');
  if(internal){
   const approval=db.prepare('SELECT * FROM approvals WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(...args,r.revision);
   if(p.approved_revision!==r.revision||!['approved','planned'].includes(p.status)||!approval||approval.decision!=='approved')fail(409,'INTERNAL_APPROVAL_REQUIRED');
   publishing.authorize(approval.reviewer_id,r.tenant_id,r.workspace_id,['owner','admin','reviewer']);
   if(db.prepare('SELECT require_independent_approval FROM tenants WHERE id=?').get(r.tenant_id)?.require_independent_approval&&approval.reviewer_id===rev.actor_id)fail(409,'INTERNAL_APPROVAL_REQUIRED');
  }
  return {post:p,revision:rev,content};
 }
 function dto(r,{publicView=false}={}) {
  const publications=JSON.parse(r.publication_ids_json).map(jid=>publishing.rowJob(r.tenant_id,r.workspace_id,jid)).filter(Boolean).map(publicationDTO);
  let status=r.status;
  if(status==='pending'&&r.expires_at<=ctx.now())status='expired';
  const scheduling={status:r.scheduling_status,code:r.scheduling_code,message:r.scheduling_code?safeMessage(r.scheduling_code):r.scheduling_status==='scheduled'?'Incluído na fila. O resultado do envio ainda depende do serviço e da autorização válidos.':r.status==='changes_requested'?'Ajustes solicitados. Nenhum envio foi agendado.':'Aguardando a decisão do cliente.',publications:publications.map(p=>({id:p.id,channelId:p.channelId,status:p.status,scheduledAt:p.scheduledAt,publishedAt:p.publishedAt,errorCode:p.errorCode,errorMessage:p.errorMessage}))};
  const allCancelled=publications.length>0&&publications.every(p=>p.status==='cancelled');
  const allPublished=publications.length>0&&publications.every(p=>p.status==='published'&&p.remoteId);
  const uncertain=publications.some(p=>p.status==='needs_attention');
  if(uncertain){scheduling.status='attention';scheduling.message='O resultado de um envio é incerto. Confira a conta e reconcilie o envio antes de outra tentativa.';}
  else if(allPublished){scheduling.status='published';scheduling.message='As publicações foram confirmadas em todos os canais deste pedido.';}
  else if(allCancelled){scheduling.status='cancelled';scheduling.message='Todos os envios deste pedido foram cancelados antes de começar.';}
  else if(publications.some(p=>['blocked','failed','cancelled'].includes(p.status))){scheduling.status='attention';scheduling.message='Um ou mais envios exigem atenção. Confira os resultados reais na fila; publicações concluídas permanecem na rede.';}
  if(status==='revoked'){
   if(uncertain)scheduling.message='Link revogado. O resultado de um envio continua incerto e exige conferência na conta. A revogação não confirma seu cancelamento.';
   else if(allPublished)scheduling.message='Link revogado. As publicações já foram confirmadas e permanecem na rede.';
   else if(allCancelled)scheduling.message='Link revogado. Todos os envios deste pedido foram cancelados antes de começar.';
   else if(publications.length)scheduling.message='Link revogado. Envios que ainda não começaram foram cancelados; confira os demais resultados na fila. Publicações concluídas permanecem na rede.';
   else scheduling.message='Link revogado. Nenhum envio foi criado por este pedido.';
  }
  if(status==='expired')scheduling.message='O link expirou sem decisão. Nenhum agendamento foi criado por este pedido.';
  const notificationReady=ctx.services.whatsappNotifications?.readiness(r.tenant_id)?.configured===true;
  return {id:r.id,...(!publicView?{postId:r.post_id,requesterId:r.requester_id}:{}),revision:r.revision,preview:JSON.parse(r.preview_json),channelIds:JSON.parse(r.channel_ids_json),scheduledAt:r.scheduled_at,scheduledTimezone:r.scheduled_timezone,status,version:r.version,createdAt:r.created_at,expiresAt:r.expires_at,decidedAt:r.decided_at,feedback:r.feedback,scheduling,notification:{status:notificationReady?'available':'not_configured',message:notificationReady?'WhatsApp disponível. Isso não indica envio nem entrega de notificação.':'WhatsApp não está configurado neste ambiente.'},identityNotice:'A decisão identifica quem possui este link; não comprova a identidade de uma pessoa nomeada.'};
 }
 function create(req) {
  const {tid:tenant_id,wid:workspace_id}=req.params,b=req.body;
  publishing.authorize(req.user.id,tenant_id,workspace_id);
  ctx.services.entitlements.assertCan(tenant_id,'posts',0);
  const seed={tenant_id,workspace_id,post_id:b.postId,revision:b.expectedRevision};
  const {post,revision,content}=currentContent(seed,{internal:true});
  const schedule=validateSchedule(ctx,b.scheduledAt,b.scheduledTimezone,{future:true});
  if(Date.parse(schedule.scheduledAt)>Date.parse(ctx.now())+90*86400000)fail(422,'SCHEDULE_TOO_FAR','Escolha uma data nos próximos 90 dias.');
  if(content.format!=='image'||content.mediaIds.length!==1)fail(422,'UNSUPPORTED_FORMAT');
  const selected=canonicalChannels(b.channelIds);
  if(!same(Object.keys(b.connectionVersions).sort(),selected))fail(422,'CONNECTION_VERSIONS_INVALID','Confirme as conexões dos canais selecionados.');
  const previewChannels=selected.map(cid=>{
   if(!content.channelIds.includes(cid))fail(422,'CHANNEL_UNAVAILABLE');
   const c=db.prepare('SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND id=? AND archived_at IS NULL').get(tenant_id,workspace_id,cid);
   if(!c||!['instagram','facebook'].includes(c.platform))fail(422,'UNSUPPORTED_PLATFORM');
   let ready;try{ready=publishing.adapter.readiness({tenantId:tenant_id,workspaceId:workspace_id,channelId:cid,platform:c.platform,now:schedule.scheduledAt});}catch{ready=null;}
   const actual=ready?.ready===true&&typeof ready.connectionVersion==='string'?ready.connectionVersion:null;
   if(b.connectionVersions[cid]!==actual)fail(409,'CONNECTION_CHANGED');
   return {id:cid,label:c.label,platform:c.platform,destinationLabel:typeof ready?.destinationLabel==='string'?ready.destinationLabel.slice(0,120):null};
  });
  if(db.prepare("SELECT 1 FROM client_approval_requests WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=? AND status IN ('pending','approved')").get(tenant_id,workspace_id,b.postId,b.expectedRevision))fail(409,'CLIENT_REQUEST_EXISTS','Já existe um pedido ativo para esta revisão. Revogue-o antes de gerar outro link.');
  for(const cid of selected)if(db.prepare("SELECT 1 FROM publication_jobs WHERE tenant_id=? AND workspace_id=? AND post_id=? AND channel_id=? AND (status='needs_attention' OR (revision=? AND status NOT IN ('cancelled','failed','blocked')))").get(tenant_id,workspace_id,b.postId,cid,b.expectedRevision))fail(409,'PUBLICATION_EXISTS');
  const media=db.prepare('SELECT * FROM media WHERE tenant_id=? AND workspace_id=? AND id=?').get(tenant_id,workspace_id,content.mediaIds[0]);
  if(!media||!['image/jpeg','image/png','image/webp'].includes(media.normalized_mime))fail(409,'MEDIA_UNAVAILABLE');
  const raw=token(),aid=id(),at=ctx.now();
  const expiresAt=[plus(at,(b.expiresInHours??72)*3600000),schedule.scheduledAt].sort()[0];
  const preview={title:content.title,caption:content.caption,format:content.format,channels:previewChannels,media:{id:media.id,mime:media.normalized_mime,digest:media.digest,width:media.width,height:media.height}};
  db.prepare(`INSERT INTO client_approval_requests(tenant_id,workspace_id,id,post_id,revision,requester_id,token_hash,snapshot_digest,preview_json,channel_ids_json,connection_versions_json,scheduled_at,scheduled_timezone,source_scheduled_at,source_scheduled_timezone,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(tenant_id,workspace_id,aid,b.postId,b.expectedRevision,req.user.id,digest(raw),digest(revision.content_snapshot),JSON.stringify(preview),JSON.stringify(selected),JSON.stringify(Object.fromEntries(selected.map(cid=>[cid,b.connectionVersions[cid]]))),schedule.scheduledAt,schedule.scheduledTimezone,post.scheduled_at,post.scheduled_timezone,at,expiresAt,at);
  ctx.audit({tenantId:tenant_id,actorId:req.user.id,action:'client_approval.requested',targetType:'client_approval',targetId:aid,safeChanges:{postId:b.postId,revision:b.expectedRevision,channelCount:selected.length,scheduledAt:schedule.scheduledAt},requestId:req.id});
  return {request:dto(row(tenant_id,workspace_id,aid)),raw};
 }
 function bearer(req) {
  const h=req.headers.authorization;
  if(typeof h!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(h))fail(404,'CLIENT_LINK_UNAVAILABLE','Link indisponível, expirado ou revogado.');
  const r=db.prepare('SELECT * FROM client_approval_requests WHERE token_hash=?').get(digest(h.slice(7)));
  if(!r||['revoked','invalidated'].includes(r.status)||r.expires_at<=ctx.now())fail(404,'CLIENT_LINK_UNAVAILABLE','Link indisponível, expirado ou revogado.');
  currentContent(r);
  // Read access is continuously scoped to the requester's current workspace authority.
  publishing.authorize(r.requester_id,r.tenant_id,r.workspace_id);
  return r;
 }
 function preview(req,reply) {
  const r=bearer(req);
  const source=req.session||ctx.auth.createPreauth(req,reply);
  const challenge=token();
  ctx.transaction(()=>{
   db.prepare('DELETE FROM client_approval_challenges WHERE expires_at<=?').run(ctx.now());
   // A bounded number of tabs per link; opening a preview never records a decision.
   db.prepare('DELETE FROM client_approval_challenges WHERE challenge_hash IN (SELECT challenge_hash FROM client_approval_challenges WHERE request_id=? AND tenant_id=? AND workspace_id=? ORDER BY expires_at DESC LIMIT -1 OFFSET 9)').run(r.id,r.tenant_id,r.workspace_id);
   if(db.prepare('SELECT count(*) n FROM client_approval_challenges').get().n>=10000)fail(429,'RATE_LIMITED','Aguarde e tente novamente.');
   db.prepare('INSERT INTO client_approval_challenges VALUES(?,?,?,?,?,?,?)').run(digest(challenge),r.tenant_id,r.workspace_id,r.id,r.token_hash,r.version,[plus(ctx.now(),15*60000),r.expires_at].sort()[0]);
  });
  return {...dto(r,{publicView:true}),csrfToken:source.csrf_token,challenge};
 }
 function media(req,reply) {
  const r=bearer(req),snapshot=JSON.parse(r.preview_json).media;
  const m=db.prepare(`SELECT m.*,b.bytes FROM media m JOIN media_blobs b ON b.tenant_id=m.tenant_id AND b.workspace_id=m.workspace_id AND b.media_id=m.id JOIN post_revision_media pr ON pr.tenant_id=m.tenant_id AND pr.workspace_id=m.workspace_id AND pr.media_id=m.id WHERE m.tenant_id=? AND m.workspace_id=? AND m.id=? AND pr.post_id=? AND pr.revision=?`).get(r.tenant_id,r.workspace_id,snapshot.id,r.post_id,r.revision);
  if(!m||m.digest!==snapshot.digest||!['image/jpeg','image/png','image/webp'].includes(m.normalized_mime))fail(404,'MEDIA_UNAVAILABLE');
  const bytes=Buffer.from(m.bytes);if(bytes.length!==m.size_bytes||createHash('sha256').update(bytes).digest('hex')!==snapshot.digest)fail(409,'MEDIA_UNAVAILABLE');
  return reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff').header('content-security-policy',"default-src 'none'; sandbox").header('content-disposition','inline; filename="approved-image"').type(m.normalized_mime).send(bytes);
 }
 function schedule(r,requestId) {
  // Savepoint isolates the all-or-nothing enqueue from the already recorded client consent.
  db.exec('SAVEPOINT client_approval_enqueue');
  try {
   if(r.scheduled_at<=ctx.now())fail(409,'SCHEDULE_IN_PAST');
   currentContent(r,{internal:true});
   const connectionVersions=JSON.parse(r.connection_versions_json);
   if(Object.values(connectionVersions).some(v=>typeof v!=='string'||!v))fail(409,'CONNECTION_UNAVAILABLE');
   // Stored timestamps are UTC. Reconstruct an offset-bearing local value for the existing validator.
   const scheduledAt=localOffsetTime(r.scheduled_at,r.scheduled_timezone);
   const jobs=publishing.enqueue({params:{tid:r.tenant_id,wid:r.workspace_id,pid:r.post_id},user:{id:r.requester_id},id:requestId,body:{expectedRevision:r.revision,channelIds:JSON.parse(r.channel_ids_json),connectionVersions,scheduledAt,scheduledTimezone:r.scheduled_timezone}});
   db.prepare("UPDATE client_approval_requests SET scheduling_status='scheduled',scheduling_code=NULL,publication_ids_json=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?").run(JSON.stringify(jobs.map(j=>j.id)),ctx.now(),r.tenant_id,r.workspace_id,r.id);
   db.exec('RELEASE client_approval_enqueue');
  } catch(error) {
   db.exec('ROLLBACK TO client_approval_enqueue');db.exec('RELEASE client_approval_enqueue');
   const code=error.isPublic&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:'PROVIDER_FAILED';
   db.prepare("UPDATE client_approval_requests SET scheduling_status='blocked',scheduling_code=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?").run(code,ctx.now(),r.tenant_id,r.workspace_id,r.id);
  }
 }
 function decision(req) { return ctx.transaction(()=>{
  if(req.headers.origin!==ctx.config.canonicalOrigin||req.headers['sec-fetch-site']==='cross-site')fail(403,'ORIGIN_REJECTED','Origem da solicitação inválida.');
  const r=bearer(req),b=req.body;
  if(r.status!=='pending')fail(409,'CLIENT_DECISION_RECORDED','Uma decisão já foi registrada para este link.');
  if(r.version!==b.expectedVersion)fail(409,'VERSION_CONFLICT','Este pedido mudou. Reabra o link.');
  const challenge=db.prepare('SELECT * FROM client_approval_challenges WHERE challenge_hash=? AND tenant_id=? AND workspace_id=? AND request_id=? AND token_hash=? AND version=? AND expires_at>?').get(digest(b.challenge),r.tenant_id,r.workspace_id,r.id,r.token_hash,r.version,ctx.now());
  if(!challenge)fail(403,'CLIENT_CHALLENGE_INVALID','Reabra o link original de aprovação e tente novamente.');
  if(b.decision==='request_changes'&&!b.feedback?.trim())fail(422,'REASON_REQUIRED','Explique quais ajustes são necessários.');
  const at=ctx.now(),status=b.decision==='approve'?'approved':'changes_requested';
  const updated=db.prepare("UPDATE client_approval_requests SET status=?,feedback=?,decided_at=?,version=version+1,scheduling_status=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND status='pending' AND version=?").run(status,b.feedback?.trim()||null,at,status==='approved'?'blocked':'not_requested',at,r.tenant_id,r.workspace_id,r.id,r.version);
  if(updated.changes!==1)fail(409,'CLIENT_DECISION_RECORDED','Uma decisão já foi registrada para este link.');
  db.prepare('DELETE FROM client_approval_challenges WHERE tenant_id=? AND workspace_id=? AND request_id=?').run(r.tenant_id,r.workspace_id,r.id);
  // actorId stays null: a bearer link is not an authenticated internal reviewer.
  ctx.audit({tenantId:r.tenant_id,actorId:null,action:`client_approval.${status}`,targetType:'client_approval',targetId:r.id,safeChanges:{revision:r.revision,identityAssurance:'bearer_link'},requestId:req.id});
  if(status==='approved')schedule(row(r.tenant_id,r.workspace_id,r.id),req.id);
  return dto(row(r.tenant_id,r.workspace_id,r.id),{publicView:true});
 }); }
 function mutate(req,action) {
  const {tid,wid,aid}=req.params,r=row(tid,wid,aid);
  if(!r)fail(404,'NOT_FOUND','Pedido não encontrado.');
  publishing.authorize(req.user.id,tid,wid);
  if(r.version!==req.body.expectedVersion)fail(409,'VERSION_CONFLICT','Este pedido mudou. Atualize a página.');
  if(action==='retry-scheduling'){
   if(r.status!=='approved'||r.scheduling_status!=='blocked')fail(409,'CLIENT_RETRY_UNAVAILABLE','Não há agendamento aprovado pendente para tentar novamente.');
   if(r.scheduled_at<=ctx.now())fail(409,'SCHEDULE_IN_PAST');
   db.prepare('UPDATE client_approval_requests SET version=version+1 WHERE tenant_id=? AND workspace_id=? AND id=?').run(tid,wid,aid);
   schedule(r,req.id);
  }else{
   const ids=JSON.parse(r.publication_ids_json),jobs=ids.map(jid=>publishing.rowJob(tid,wid,jid)).filter(Boolean);
   if(jobs.some(j=>j.status==='sending'))fail(409,'PUBLICATION_IN_FLIGHT','O envio já começou. Aguarde o resultado antes de revogar.');
   for(const j of jobs)if(['scheduled','retry_wait','leased'].includes(j.status))db.prepare("UPDATE publication_jobs SET status='cancelled',version=version+1,lease_token=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?").run(ctx.now(),tid,wid,j.id);
   const after=ids.map(jid=>publishing.rowJob(tid,wid,jid)).filter(Boolean);
   const allCancelled=after.length>0&&after.every(j=>j.status==='cancelled');
   const schedulingStatus=allCancelled?'cancelled':r.scheduling_status;
   db.prepare("UPDATE client_approval_requests SET status='revoked',scheduling_status=?,revoked_at=?,version=version+1,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?").run(schedulingStatus,ctx.now(),ctx.now(),tid,wid,aid);
   db.prepare('DELETE FROM client_approval_challenges WHERE tenant_id=? AND workspace_id=? AND request_id=?').run(tid,wid,aid);
  }
  ctx.audit({tenantId:tid,actorId:req.user.id,action:`client_approval.${action}`,targetType:'client_approval',targetId:aid,requestId:req.id});
  return dto(row(tid,wid,aid));
 }
 function assertNotification(req,rawToken) {
  const {tid,wid,aid}=req.params;
  publishing.authorize(req.user.id,tid,wid);
  const r=row(tid,wid,aid);
  if(!r||typeof rawToken!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(rawToken)||digest(rawToken)!==r.token_hash||r.status!=='pending'||r.expires_at<=ctx.now())fail(404,'CLIENT_LINK_UNAVAILABLE','Link indisponível, expirado ou revogado.');
  publishing.authorize(r.requester_id,tid,wid);currentContent(r,{internal:true});
  return {id:r.id,tenantId:tid,workspaceId:wid,url:`${ctx.config.canonicalOrigin}/approval.html#${rawToken}`};
 }
 return {row,dto,create,bearer,preview,media,decision,mutate,currentContent,assertNotification};
}
export function localOffsetTime(iso,zone) {
 const date=new Date(iso),parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 const local=`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
 const offset=Math.round((Date.parse(local+'Z')-Math.floor(date.getTime()/1000)*1000)/60000),sign=offset<0?'-':'+';
 return `${local}.${String(date.getUTCMilliseconds()).padStart(3,'0')}${sign}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}:${String(Math.abs(offset)%60).padStart(2,'0')}`;
}
