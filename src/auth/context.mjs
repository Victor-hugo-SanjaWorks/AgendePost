import { id,token,digest,plus,safeEqual,publicUser } from './utils.mjs';
export function initializeAuth(ctx) {
 const {db,config,now,errors}=ctx;
 const preauthIssuance=new Map();
 const cookieOptions={httpOnly:true,secure:config.secureCookies,sameSite:'lax',path:'/'};
 const authenticated=(req)=>{
  const raw=req.cookies?.[config.sessionCookie];if(!raw||!/^[\w-]{43}$/.test(raw))return null;
  const at=now();
  const row=db.prepare(`SELECT s.*,u.id,u.email_normalized,u.display_name,u.email_verified_at,u.status AS user_status,u.session_epoch AS user_epoch FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.absolute_expires_at>? AND u.status='active' AND u.email_verified_at IS NOT NULL AND s.session_epoch=u.session_epoch`).get(digest(raw),at,at);
  if(!row)return null;
  row.expires_at=plus(at,config.sessionIdleMs)<row.absolute_expires_at?plus(at,config.sessionIdleMs):row.absolute_expires_at;
  db.prepare('UPDATE sessions SET last_seen_at=?,expires_at=? WHERE token_hash=?').run(at,row.expires_at,row.token_hash);
  req.session=row;req.user=publicUser(row);return row;
 };
 const preauth=(req)=>{const raw=req.cookies?.[config.preauthCookie];if(!raw||!/^[\w-]{43}$/.test(raw))return null;return db.prepare('SELECT * FROM preauth_sessions WHERE token_hash=? AND expires_at>?').get(digest(raw),now())||null;};
 function createPreauth(req,reply,{rotate=false}={}){
  const existing=!rotate&&preauth(req);if(existing)return existing;
  if(config.hosted){
   const time=Date.parse(now());for(const [key,value]of preauthIssuance)if(value.until<=time)preauthIssuance.delete(key);
   let bucket=preauthIssuance.get(req.ip);
   if(!bucket){if(preauthIssuance.size>=10000)throw errors.http(429,'PREAUTH_RATE_LIMIT','Aguarde antes de iniciar outra sessão.');bucket={count:0,until:time+config.preauthMs};preauthIssuance.set(req.ip,bucket);}
   if(++bucket.count>30)throw errors.http(429,'PREAUTH_RATE_LIMIT','Aguarde antes de iniciar outra sessão.');
  }

  const at=now(),raw=token(),csrf=token();
  ctx.transaction(()=>{db.prepare('DELETE FROM preauth_sessions WHERE expires_at<=?').run(at);if(db.prepare('SELECT COUNT(*) AS n FROM preauth_sessions').get().n>=1000)throw errors.http(429,'PREAUTH_CAPACITY','Aguarde e tente novamente.');const old=req.cookies?.[config.preauthCookie];if(old)db.prepare('DELETE FROM preauth_sessions WHERE token_hash=?').run(digest(old));db.prepare('INSERT INTO preauth_sessions VALUES(?,?,?,?)').run(digest(raw),csrf,at,plus(at,config.preauthMs));});
  reply.setCookie(config.preauthCookie,raw,{...cookieOptions,maxAge:config.preauthMs/1000});return {csrf_token:csrf};
 }
 function setSessionCookie(reply,raw){reply.setCookie(config.sessionCookie,raw,{...cookieOptions,maxAge:config.sessionAbsoluteMs/1000});reply.clearCookie(config.preauthCookie,cookieOptions);}
 function clearSessionCookie(reply){reply.clearCookie(config.sessionCookie,cookieOptions);}
 function newSession(user,req){const raw=token(),csrf=token(),at=now();if(req.session)db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(at,req.session.token_hash);const pre=req.cookies?.[config.preauthCookie];if(pre)db.prepare('DELETE FROM preauth_sessions WHERE token_hash=?').run(digest(pre));db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen_at,expires_at,absolute_expires_at,auth_at,session_epoch) VALUES(?,?,?,?,?,?,?,?,?)').run(digest(raw),user.id,csrf,at,at,plus(at,config.sessionIdleMs),plus(at,config.sessionAbsoluteMs),at,user.session_epoch);return {raw,csrfToken:csrf};}
 function requireFresh(req){const s=req.session;if(!s)throw errors.http(401,'AUTH_REQUIRED','Entre na sua conta.');const found=db.prepare(`SELECT s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.absolute_expires_at>? AND u.status='active' AND s.session_epoch=u.session_epoch`).get(s.token_hash,now(),now());if(!found)throw errors.http(401,'AUTH_REQUIRED','Sua sessão expirou. Entre novamente.');}
 async function requireUser(req){if(!req.user&&!authenticated(req))throw errors.http(401,'AUTH_REQUIRED','Entre na sua conta.');requireFresh(req);}
 async function requireTenant(req){if(!req.user)await requireUser(req);const m=db.prepare(`SELECT m.*,t.status AS tenant_status FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active'`).get(req.params.tid,req.user.id);if(!m)throw errors.http(404,'NOT_FOUND','Recurso não encontrado.');req.tenant={id:m.tenant_id,userId:m.user_id,role:m.role,scope:m.scope,status:m.tenant_status,version:m.version};if(m.tenant_status!=='active'&&!['GET','HEAD','OPTIONS'].includes(req.method))throw errors.http(403,'TENANT_SUSPENDED','Organização suspensa para alterações.');}
 function freshTenant(req){requireFresh(req);if(!req.tenant)return;const m=db.prepare('SELECT m.*,t.status AS tenant_status FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=? AND m.user_id=? AND m.status=\'active\'').get(req.tenant.id,req.user.id);if(!m)throw errors.http(404,'NOT_FOUND','Recurso não encontrado.');req.tenant={id:m.tenant_id,userId:m.user_id,role:m.role,scope:m.scope,status:m.tenant_status,version:m.version};if(m.tenant_status!=='active'&&!['GET','HEAD','OPTIONS'].includes(req.method))throw errors.http(403,'TENANT_SUSPENDED','Organização suspensa para alterações.');}
 async function requirePlatformAdmin(req){if(!req.user)await requireUser(req);if(!db.prepare("SELECT user_id FROM platform_admins WHERE user_id=? AND status='active'").get(req.user.id))throw errors.http(403,'PLATFORM_ADMIN_REQUIRED','Acesso de operação necessário.');}
 function requireRecentAuth(req){requireFresh(req);const row=db.prepare('SELECT auth_at FROM sessions WHERE token_hash=?').get(req.session.token_hash);if(!row||Date.parse(now())-Date.parse(row.auth_at)>config.authRecentMs)throw errors.http(403,'REAUTH_REQUIRED','Confirme sua senha para continuar.');}
 function revokeUser(userId){const at=now();db.prepare('UPDATE users SET session_epoch=session_epoch+1 WHERE id=?').run(userId);db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(at,userId);db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(at,userId);}
 async function guard(req,reply){
  req.user=null;req.session=null;req.tenant=null;
  authenticated(req);
  if(['GET','HEAD','OPTIONS'].includes(req.method))return;
  const exempt=req.url.split('?')[0]==='/api/v1/webhooks/stripe'&&req.routeOptions.config?.signedWebhook===true&&config.mode==='test'&&ctx.services.billing?.provider?.enabled;
  if(exempt)return;
  if(req.headers.origin!==config.canonicalOrigin||req.headers['sec-fetch-site']==='cross-site')throw errors.http(403,'ORIGIN_REJECTED','Origem da solicitação inválida.');
  const source=req.session||preauth(req);
  if(!source){if(!/^\/api\/v1\/auth\//.test(req.url))throw errors.http(401,'AUTH_REQUIRED','Entre na sua conta.');throw errors.http(403,'CSRF_INVALID','Atualize a página e tente novamente.');}
  if(!safeEqual(req.headers['x-csrf-token'],source.csrf_token))throw errors.http(403,'CSRF_INVALID','Atualize a página e tente novamente.');
 }
 ctx.auth={authenticated,preauth,createPreauth,setSessionCookie,clearSessionCookie,newSession,requireFresh,requireUser,requireTenant,freshTenant,requirePlatformAdmin,requireRecentAuth,revokeUser,guard};
 ctx.policy={workspace(req,wid,action='read'){
  freshTenant(req);if(!req.tenant)throw errors.http(404,'NOT_FOUND','Recurso não encontrado.');
  const t=req.tenant,w=db.prepare('SELECT * FROM workspaces WHERE tenant_id=? AND id=?').get(t.id,wid);
  if(!w||(t.scope!=='organization'&&!db.prepare('SELECT 1 FROM workspace_grants WHERE tenant_id=? AND workspace_id=? AND user_id=?').get(t.id,wid,req.user.id)))throw errors.http(404,'NOT_FOUND','Recurso não encontrado.');
  const roles={read:['owner','admin','editor','reviewer','viewer'],write:['owner','admin','editor'],media:['owner','admin','editor'],review:['owner','admin','reviewer'],manage:['owner','admin'],members:['owner','admin'],billing:['owner']};
  if(!roles[action]?.includes(t.role))throw errors.http(403,'FORBIDDEN','Você não tem permissão para esta ação.');
  if(w.archived_at&&action!=='read'&&action!=='manage')throw errors.http(409,'WORKSPACE_ARCHIVED','Restaure a marca antes de alterar conteúdo.');return w;
 }};
}
