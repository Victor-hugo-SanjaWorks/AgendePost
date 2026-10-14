import { randomUUID,randomBytes,createHash,createHmac } from 'node:crypto';
import { base,object,string,identifier,positive,workspace } from '../editorial/shared.mjs';
import { API_VERSION,CALLBACK_PATH,OAuthError,buildSocialConnectionConfig } from './config.mjs';
import { createMetaOAuthClient,scopesFor } from './meta.mjs';
import { encryptPayload,decryptPayload,pendingBinding,connectionBinding } from './crypto.mjs';
const digest=s=>createHash('sha256').update(s).digest('hex');
const plus=(iso,ms)=>new Date(Date.parse(iso)+ms).toISOString();
const PREFIX=`${base}/social-connections`;
const TTL=10*60*1000;
const safeMessages={
 META_OAUTH_NOT_CONFIGURED:'A conexão Meta ainda precisa da configuração segura do operador, aplicativo Meta e callback HTTPS.',
 META_OAUTH_CONFIG_INVALID:'A configuração segura, chave de criptografia ou callback HTTPS da Meta não está válido.',
 META_OAUTH_PERMISSION_MISSING:'A Meta não concedeu todas as permissões solicitadas. Confira o acesso antes de reconectar.',
 META_OAUTH_PAGE_TASK_MISSING:'Esta Página não concede a tarefa CREATE_CONTENT ao usuário autorizado.',
 META_OAUTH_PROFESSIONAL_REQUIRED:'Selecione uma conta profissional Instagram Business ou Creator vinculada à Página.',
 META_OAUTH_DENIED:'A autorização da Meta foi cancelada ou recusada.',
 META_OAUTH_STATE_INVALID:'A autorização expirou, já foi usada ou pertence a outra sessão. Inicie novamente.',
 META_OAUTH_DESTINATION_UNAVAILABLE:'O destino selecionado não está mais disponível. Inicie a conexão novamente.',
 META_OAUTH_IDENTITY_INVALID:'A identidade retornada pela Meta não corresponde à autorização. Inicie novamente.',
 META_OAUTH_EXPIRED:'A autorização expirou. Reconecte a conta.',
 META_OAUTH_CREDENTIAL_UNAVAILABLE:'As credenciais seguras não puderam ser abertas. O operador deve revisar a chave.',
 META_OAUTH_PROVIDER_UNAVAILABLE:'Não foi possível validar a conta com a Meta. Inicie novamente.',
 META_OAUTH_FAILED:'A conexão não foi concluída. Inicie novamente e confira as permissões da conta.'
};
const message=code=>safeMessages[code]||safeMessages.META_OAUTH_FAILED;
function publicConnection(r,at){return {id:r.id,channelId:r.channel_id,platform:r.platform,status:r.status==='active'&&r.expires_at<=at?'expired':r.status,accountId:r.account_id,pageId:r.page_id,destinationLabel:r.destination_label,expiresAt:r.expires_at,verifiedAt:r.verified_at,version:r.version};}
const publicCandidate=c=>({id:c.id,platform:c.platform,accountId:c.accountId,pageId:c.pageId,destinationLabel:c.destinationLabel,eligible:c.eligible,code:c.code});
export function initializeSocialConnections(ctx,options={}){
 const config=buildSocialConnectionConfig(ctx.config,options),{db,now,transaction}=ctx;
 const client=config.enabled?createMetaOAuthClient(config,{fetchImpl:options.metaOAuthFetch??globalThis.fetch,now}):null;
 const fail=(status,code)=>{throw ctx.errors.http(status,code,message(code));};
 const requireConfig=()=>{if(!config.enabled)fail(503,config.code);};
 const manage=(req,recent=true)=>{workspace(ctx,req,'manage');if(req.tenant.status!=='active')fail(403,'TENANT_SUSPENDED');if(recent)ctx.auth.requireRecentAuth(req);};
 function channel(req,cid){const c=db.prepare('SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND id=?').get(req.params.tid,req.params.wid,cid);if(!c||c.archived_at)fail(404,'NOT_FOUND');if(!['facebook','instagram'].includes(c.platform))fail(422,'UNSUPPORTED_PLATFORM');return c;}
 function cleanup(){const at=now();db.prepare('DELETE FROM social_oauth_states WHERE expires_at<=?').run(plus(at,-24*60*60*1000));db.prepare("DELETE FROM social_oauth_pending WHERE expires_at<=?").run(at);}
 function list(req){
  manage(req,false);cleanup();
  const rows=db.prepare('SELECT * FROM social_connections WHERE tenant_id=? AND workspace_id=? ORDER BY created_at,id').all(req.params.tid,req.params.wid);
  const pending=[];let code=config.enabled?null:config.code;
  if(config.enabled)for(const r of db.prepare('SELECT * FROM social_oauth_pending WHERE tenant_id=? AND workspace_id=? AND user_id=? AND session_hash=? AND expires_at>? AND consumed_at IS NULL').all(req.params.tid,req.params.wid,req.user.id,req.session.token_hash,now())){
   try{const payload=decryptPayload(config.key,r.encrypted_payload,pendingBinding(r));pending.push({id:r.id,channelId:r.channel_id,channelVersion:r.channel_version,platform:r.platform,expiresAt:r.expires_at,candidates:payload.candidates.map(publicCandidate)});}catch{code='META_OAUTH_CREDENTIAL_UNAVAILABLE';}
  }
  const last=db.prepare('SELECT result_code FROM social_oauth_states WHERE tenant_id=? AND workspace_id=? AND user_id=? AND session_hash=? AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 1').get(req.params.tid,req.params.wid,req.user.id,req.session.token_hash);
  return {configured:config.enabled,code,message:code?message(code):null,blockers:code?[message(code)]:[],connections:rows.map(r=>publicConnection(r,now())),pending,lastResult:last?.result_code?{code:last.result_code,message:last.result_code==='META_OAUTH_READY'?'Escolha e confirme o destino verificado para este canal.':message(last.result_code)}:null};
 }
 function start(req){
  requireConfig();manage(req);const c=channel(req,req.body.channelId),state=randomBytes(32).toString('base64url'),at=now(),expiresAt=plus(at,TTL);
  transaction(()=>{manage(req);cleanup();db.prepare('DELETE FROM social_oauth_states WHERE session_hash=? AND tenant_id=? AND workspace_id=? AND channel_id=?').run(req.session.token_hash,c.tenant_id,c.workspace_id,c.id);db.prepare('DELETE FROM social_oauth_pending WHERE session_hash=? AND tenant_id=? AND workspace_id=? AND channel_id=?').run(req.session.token_hash,c.tenant_id,c.workspace_id,c.id);db.prepare('INSERT INTO social_oauth_states(state_hash,tenant_id,workspace_id,channel_id,channel_version,platform,user_id,session_hash,access_basis,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(digest(state),c.tenant_id,c.workspace_id,c.id,c.version,c.platform,req.user.id,req.session.token_hash,req.body.accessBasis,at,expiresAt);});
  const url=new URL(`https://www.facebook.com/${API_VERSION}/dialog/oauth`);url.search=new URLSearchParams({client_id:config.appId,redirect_uri:config.redirectUri,response_type:'code',scope:scopesFor(c.platform,req.body.accessBasis).join(','),state,...(config.loginConfigId?{config_id:config.loginConfigId}:{})});
  ctx.audit({tenantId:c.tenant_id,actorId:req.user.id,action:'social.oauth_started',targetType:'channel',targetId:c.id,safeChanges:{platform:c.platform},requestId:req.id});
  return {authorizationUrl:url.href,expiresAt};
 }
 async function callback(req,reply){
  requireConfig();ctx.auth.requireRecentAuth(req);
  const state=req.query.state;if(typeof state!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(state))fail(400,'META_OAUTH_STATE_INVALID');
  let row;
  transaction(()=>{
   row=db.prepare('SELECT * FROM social_oauth_states WHERE state_hash=? AND user_id=? AND session_hash=? AND expires_at>? AND consumed_at IS NULL').get(digest(state),req.user.id,req.session.token_hash,now());if(!row)fail(400,'META_OAUTH_STATE_INVALID');
   // Reuse the standard authorization policy with tenant/brand values exclusively from server state.
   req.params={tid:row.tenant_id,wid:row.workspace_id};
   const m=db.prepare("SELECT m.*,t.status AS tenant_status FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active'").get(row.tenant_id,req.user.id);
   if(!m||m.tenant_status!=='active'||!['owner','admin'].includes(m.role))fail(403,'FORBIDDEN');
   req.tenant={id:m.tenant_id,userId:m.user_id,role:m.role,scope:m.scope,status:m.tenant_status,version:m.version};manage(req);const c=channel(req,row.channel_id);if(c.version!==row.channel_version||c.platform!==row.platform)fail(409,'CHANNEL_VERSION_CONFLICT');
   const changed=db.prepare('UPDATE social_oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL').run(now(),row.state_hash);if(changed.changes!==1)fail(400,'META_OAUTH_STATE_INVALID');
  });
  let resultCode='META_OAUTH_READY';
  try{
   if(req.query.error)throw new OAuthError('META_OAUTH_DENIED');
   if(typeof req.query.code!=='string'||req.query.code.length<1||req.query.code.length>2048||/[\u0000-\u0020\u007f]/u.test(req.query.code))throw new OAuthError('META_OAUTH_STATE_INVALID');
   const payload=await client.exchange(req.query.code,row.platform,row.access_basis);
   transaction(()=>{
    manage(req);const c=channel(req,row.channel_id);if(!db.prepare('SELECT 1 FROM social_oauth_states WHERE state_hash=? AND consumed_at IS NOT NULL').get(row.state_hash)||row.expires_at<=now()||c.version!==row.channel_version)throw new OAuthError('META_OAUTH_STATE_INVALID');
    const r={...row,id:randomUUID(),provider_user_id:payload.userId,created_at:now(),expires_at:plus(now(),TTL)};
    const encrypted=encryptPayload(config.key,payload,pendingBinding(r));
    db.prepare('INSERT INTO social_oauth_pending(id,tenant_id,workspace_id,channel_id,channel_version,platform,user_id,session_hash,provider_user_id,access_basis,encrypted_payload,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.tenant_id,r.workspace_id,r.channel_id,r.channel_version,r.platform,r.user_id,r.session_hash,r.provider_user_id,r.access_basis,encrypted,r.created_at,r.expires_at);
   });
  }catch(error){resultCode=error instanceof OAuthError?error.code:'META_OAUTH_FAILED';}
  db.prepare('UPDATE social_oauth_states SET result_code=? WHERE state_hash=?').run(resultCode,row.state_hash);
  ctx.audit({tenantId:row.tenant_id,actorId:req.user.id,action:'social.oauth_completed',targetType:'channel',targetId:row.channel_id,outcome:resultCode==='META_OAUTH_READY'?'success':'failure',safeChanges:{code:resultCode},requestId:req.id});
  // Neither provider errors, authorization codes, state nor credentials enter the redirect.
  return reply.header('cache-control','no-store').header('referrer-policy','no-referrer').redirect(`/#/app/connections/${encodeURIComponent(row.tenant_id)}/${encodeURIComponent(row.workspace_id)}`);
 }
 async function select(req){
  requireConfig();manage(req);let pending,payload,c;
  transaction(()=>{
   manage(req);c=channel(req,req.body.channelId);if(c.version!==req.body.expectedChannelVersion)fail(409,'CHANNEL_VERSION_CONFLICT');
   pending=db.prepare('SELECT * FROM social_oauth_pending WHERE id=? AND tenant_id=? AND workspace_id=? AND channel_id=? AND user_id=? AND session_hash=? AND expires_at>? AND consumed_at IS NULL').get(req.body.pendingId,c.tenant_id,c.workspace_id,c.id,req.user.id,req.session.token_hash,now());
   if(!pending||pending.channel_version!==c.version||pending.platform!==c.platform)fail(400,'META_OAUTH_STATE_INVALID');
   payload=decryptPayload(config.key,pending.encrypted_payload,pendingBinding(pending));
   const selected=payload.candidates.find(r=>r.id===req.body.candidateId);if(!selected||!selected.eligible)fail(422,'META_OAUTH_DESTINATION_UNAVAILABLE');
   db.prepare('UPDATE social_oauth_pending SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now(),pending.id);
  });
  let verified;
  try{verified=await client.verifySelection(payload,payload.candidates.find(r=>r.id===req.body.candidateId),c.platform,pending.access_basis);}catch(error){fail(400,error instanceof OAuthError?error.code:'META_OAUTH_FAILED');}
  return transaction(()=>{
   manage(req);const fresh=channel(req,c.id);if(!db.prepare('SELECT 1 FROM social_oauth_pending WHERE id=? AND consumed_at IS NOT NULL').get(pending.id)||fresh.version!==c.version||pending.expires_at<=now())fail(409,'CHANNEL_VERSION_CONFLICT');
   const old=db.prepare('SELECT * FROM social_connections WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(c.tenant_id,c.workspace_id,c.id),at=now();
   const r={id:old?.id??randomUUID(),tenant_id:c.tenant_id,workspace_id:c.workspace_id,channel_id:c.id,platform:c.platform,provider_user_id:payload.userId,account_id:verified.accountId,page_id:verified.pageId,destination_label:verified.destinationLabel,access_basis:pending.access_basis,authorization_version:randomUUID(),expires_at:verified.expiresAt,verified_at:at,version:(old?.version??0)+1,status:'active'};
   const encrypted=encryptPayload(config.key,{accessToken:verified.accessToken},connectionBinding(r));
   db.prepare(`INSERT INTO social_connections(id,tenant_id,workspace_id,channel_id,platform,provider_user_id,account_id,page_id,destination_label,token_type,access_basis,permissions,page_tasks,encrypted_payload,status,expires_at,verified_at,version,authorization_version,connected_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'page',?,?,?,?,'active',?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,workspace_id,channel_id) DO UPDATE SET provider_user_id=excluded.provider_user_id,account_id=excluded.account_id,page_id=excluded.page_id,destination_label=excluded.destination_label,access_basis=excluded.access_basis,permissions=excluded.permissions,page_tasks=excluded.page_tasks,encrypted_payload=excluded.encrypted_payload,status='active',expires_at=excluded.expires_at,verified_at=excluded.verified_at,version=excluded.version,authorization_version=excluded.authorization_version,connected_by=excluded.connected_by,updated_at=excluded.updated_at,disconnected_at=NULL`).run(r.id,r.tenant_id,r.workspace_id,r.channel_id,r.platform,r.provider_user_id,r.account_id,r.page_id,r.destination_label,r.access_basis,JSON.stringify(verified.permissions),JSON.stringify(verified.pageTasks),encrypted,r.expires_at,r.verified_at,r.version,r.authorization_version,req.user.id,old?.created_at??at,at);
   db.prepare('UPDATE channels SET version=version+1,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?').run(at,c.tenant_id,c.workspace_id,c.id);
   db.prepare('DELETE FROM social_oauth_pending WHERE id=?').run(pending.id);
   ctx.audit({tenantId:c.tenant_id,actorId:req.user.id,action:'social.connected',targetType:'social_connection',targetId:r.id,safeChanges:{platform:r.platform,accountId:r.account_id,version:r.version},requestId:req.id});return publicConnection(r,at);
  });
 }
 function disconnect(req){return transaction(()=>{
  manage(req);const r=db.prepare('SELECT * FROM social_connections WHERE id=? AND tenant_id=? AND workspace_id=?').get(req.params.cid,req.params.tid,req.params.wid);if(!r)fail(404,'NOT_FOUND');if(r.version!==req.body.expectedVersion)fail(409,'CONNECTION_VERSION_CONFLICT');
  const at=now();db.prepare("UPDATE social_connections SET status='disconnected',encrypted_payload=NULL,version=version+1,authorization_version=?,disconnected_at=?,updated_at=? WHERE id=?").run(randomUUID(),at,at,r.id);
  db.prepare('DELETE FROM social_oauth_pending WHERE tenant_id=? AND workspace_id=? AND channel_id=?').run(r.tenant_id,r.workspace_id,r.channel_id);
  db.prepare('DELETE FROM social_oauth_states WHERE tenant_id=? AND workspace_id=? AND channel_id=?').run(r.tenant_id,r.workspace_id,r.channel_id);
  db.prepare('UPDATE channels SET version=version+1,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?').run(at,r.tenant_id,r.workspace_id,r.channel_id);
  ctx.audit({tenantId:r.tenant_id,actorId:req.user.id,action:'social.disconnected',targetType:'social_connection',targetId:r.id,safeChanges:{version:r.version+1},requestId:req.id});return publicConnection({...r,status:'disconnected',version:r.version+1},at);
 });}
 function resolveBinding(input){
  // A persisted tombstone is authoritative. Static operator bindings are allowed only for channels never OAuth-bound.
  const exists=db.prepare('SELECT 1 FROM social_connections WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(input.tenantId,input.workspaceId,input.channelId);
  if(!exists)return undefined;
  if(!config.enabled)return null;
  const r=db.prepare(`SELECT c.* FROM social_connections c JOIN channels ch ON ch.tenant_id=c.tenant_id AND ch.workspace_id=c.workspace_id AND ch.id=c.channel_id JOIN workspaces w ON w.tenant_id=c.tenant_id AND w.id=c.workspace_id JOIN tenants t ON t.id=c.tenant_id JOIN memberships m ON m.tenant_id=c.tenant_id AND m.user_id=c.connected_by JOIN users u ON u.id=m.user_id WHERE c.tenant_id=? AND c.workspace_id=? AND c.channel_id=? AND c.platform=? AND c.status='active' AND c.expires_at>? AND ch.archived_at IS NULL AND w.archived_at IS NULL AND t.status='active' AND m.status='active' AND m.role IN ('owner','admin') AND (m.scope='organization' OR EXISTS(SELECT 1 FROM workspace_grants g WHERE g.tenant_id=c.tenant_id AND g.workspace_id=c.workspace_id AND g.user_id=c.connected_by)) AND u.status='active' AND u.email_verified_at IS NOT NULL`).get(input.tenantId,input.workspaceId,input.channelId,input.platform,now());
  if(!r)return null;
  try{const {accessToken}=decryptPayload(config.key,r.encrypted_payload,connectionBinding(r));return {tenantId:r.tenant_id,workspaceId:r.workspace_id,channelId:r.channel_id,platform:r.platform,accountId:r.account_id,linkedPageId:r.page_id,destinationLabel:r.destination_label,tokenType:'page',accessToken,appSecretProof:createHmac('sha256',config.appSecret).update(accessToken).digest('hex'),expiresAt:r.expires_at,verifiedAt:r.verified_at,businessManagerGrant:r.access_basis==='business_manager',permissions:JSON.parse(r.permissions),pageTasks:JSON.parse(r.page_tasks),connectionVersion:r.authorization_version};}catch{return null;}
 }
 function revokeBinding(input){return transaction(()=>{const at=now();const r=db.prepare("SELECT id FROM social_connections WHERE tenant_id=? AND workspace_id=? AND channel_id=? AND platform=? AND status='active' AND authorization_version=?").get(input.tenantId,input.workspaceId,input.channelId,input.platform,input.connectionVersion??'');if(!r)return;db.prepare("UPDATE social_connections SET status='revoked',encrypted_payload=NULL,version=version+1,authorization_version=?,updated_at=?,disconnected_at=? WHERE id=?").run(randomUUID(),at,at,r.id);ctx.audit({tenantId:input.tenantId,action:'social.revoked',targetType:'social_connection',targetId:r.id,safeChanges:{code:'META_AUTH_REVOKED'}});});}
 const service={list,start,callback,select,disconnect,resolveBinding,revokeBinding};ctx.services.socialConnections=service;ctx.caps.socialConnections=config.enabled;return service;
}
export async function registerSocialConnections(app,ctx){
 const s=ctx.services.socialConnections,auth=[ctx.auth.requireUser,ctx.auth.requireTenant];
 app.get(`${PREFIX}/meta`,{preHandler:auth,schema:{querystring:object({})}},req=>({data:s.list(req)}));
 app.post(`${PREFIX}/meta/start`,{preHandler:auth,schema:{body:object({channelId:identifier,accessBasis:{enum:['direct','business_manager']}},['channelId','accessBasis'])}},req=>({data:s.start(req)}));
 app.get(CALLBACK_PATH,{preHandler:[ctx.auth.requireUser],schema:{querystring:object({state:string(43,43),code:string(2048),error:string(200),error_reason:string(200),error_description:string(1000)},['state'])}},(req,reply)=>s.callback(req,reply));
 app.post(`${PREFIX}/meta/select`,{preHandler:auth,schema:{body:object({pendingId:identifier,candidateId:identifier,channelId:identifier,expectedChannelVersion:positive},['pendingId','candidateId','channelId','expectedChannelVersion'])}},async req=>({data:await s.select(req)}));
 app.post(`${PREFIX}/:cid/disconnect`,{preHandler:auth,schema:{body:object({expectedVersion:positive},['expectedVersion'])}},req=>({data:s.disconnect(req)}));
}
