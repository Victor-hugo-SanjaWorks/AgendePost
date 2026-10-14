import { randomBytes,randomUUID,createHash } from 'node:crypto';
import { base,object,string,positive,workspace } from '../editorial/shared.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const accountKeys=['followers','reach','impressions','engagements','profileViews'];
const postKeys=['reach','impressions','likes','comments','reactions','shares','saves','clicks'];
const platforms=new Set(['facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','x','other']);
const statuses=new Set(['available','fresh','stale','error','unsupported','disabled','not_configured','not_connected','disconnected','expired','revoked','pending','syncing','never_synced','permission_missing','active','connected','unavailable','ready','partial','scope_missing','paused']);
const iso=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const text=(value,max=150)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max):'';
const number=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=1e12?value:null;
const state=value=>statuses.has(value)?value:'unavailable';
const safePlatform=value=>platforms.has(value)?value:'other';
const safeColor=value=>typeof value==='string'&&/^#[a-fA-F0-9]{6}$/.test(value)?value:'#7561cd';
const metadata=row=>({id:row.id,label:row.label,createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,version:row.version});
function coverageProjection(value){
 if(value?.scope!=='recent_account_posts_and_agendepost')return {scope:'unavailable',fullHistory:false,limit:25,pages:1,returnedCount:null,hasMore:null,observedAt:null,status:'unavailable'};
 return {scope:'recent_account_posts_and_agendepost',fullHistory:false,limit:25,pages:1,returnedCount:Number.isInteger(value.returnedCount)&&value.returnedCount>=0&&value.returnedCount<=25?value.returnedCount:null,hasMore:typeof value.hasMore==='boolean'?value.hasMore:null,observedAt:iso(value.observedAt),lastAttemptAt:iso(value.lastAttemptAt),status:state(value.status)};
}
function metricProjection(rows,keys,platform){
 const metrics={},metricSources={};
 for(const key of keys){
  const row=Array.isArray(rows)?rows.find(r=>r?.key===key):null;
  const value=number(row?.value),valid=['available','fresh','stale'].includes(row?.state)&&value!==null;
  metrics[key]=valid?value:null;
  metricSources[key]={state:valid?state(row.state):state(row?.state),period:['snapshot','lifetime','day','week','days_28'].includes(row?.period)?row.period:null,source:valid&&['facebook','instagram'].includes(platform)?'Meta Graph API':'Indisponível',observedAt:iso(row?.observedAt)};
 }
 return {metrics,metricSources};
}
// No arbitrary external URI, private media URL, admin route, provider code, or querystring is exposed.
function permalink(raw,platform){
 if(typeof raw!=='string'||raw.length>2048)return null;
 try{const u=new URL(raw),allowed={facebook:['www.facebook.com','facebook.com'],instagram:['www.instagram.com','instagram.com'],linkedin:['www.linkedin.com','linkedin.com']};
  if(u.protocol!=='https:'||u.port||u.username||u.password||u.search||u.hash||!allowed[platform]?.includes(u.hostname))return null;
  if(platform==='instagram'&&!/^\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname))return null;
  if(platform==='facebook'&&!/^\/[A-Za-z0-9_.\/-]+$/.test(u.pathname))return null;
  if(platform==='linkedin'&&!/^\/feed\/update\/urn:li:/.test(u.pathname))return null;
  return u.href;
 }catch{return null;}
}
export function initializeClientDashboard(ctx){
 const {db,now}=ctx;
 function build(tid,wid,{publicId='internal'}={}){
  const brand=db.prepare('SELECT name,color FROM workspaces WHERE tenant_id=? AND id=?').get(tid,wid);
  if(!brand)throw ctx.errors.http(404,'NOT_FOUND','Painel indisponível.');
  const source=ctx.services.socialMetrics?.summary(tid,wid)??{accounts:[],collection:{enabled:false,status:'not_configured'},settings:{enabled:false,version:1,cadenceMinutes:15}};
  const opaque=id=>digest(publicId+':'+String(id)).slice(0,24),accounts=[],posts=[];
  for(const input of (Array.isArray(source.accounts)?source.accounts:[]).slice(0,30)){
   const platform=safePlatform(input?.platform),id=opaque(input?.channelId??input?.id??accounts.length);
   accounts.push({id,platform,displayName:text(input?.displayName??input?.label)||({facebook:'Facebook',instagram:'Instagram',linkedin:'LinkedIn'}[platform]??'Rede social'),status:state(input?.status),connectionStatus:state(input?.connectionStatus),lastSyncedAt:iso(input?.lastSyncedAt??input?.observedAt),lastAttemptAt:iso(input?.lastAttemptAt),nextRefreshAt:iso(input?.nextRefreshAt),coverage:coverageProjection(input?.coverage),...metricProjection(input?.metrics,accountKeys,platform)});
   for(const post of (Array.isArray(input?.posts)?input.posts:[]).slice(0,50)){
    if(!iso(post?.publishedAt))continue;
    posts.push({id:opaque(post?.id??posts.length),accountId:id,platform,publishedAt:iso(post.publishedAt),lastSyncedAt:iso(post.observedAt),permalink:permalink(post.permalink,platform),status:state(post.status),...metricProjection(post.metrics,postKeys,platform)});
   }
  }
  posts.sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt));
  const collection={enabled:source.collection?.enabled===true,status:state(source.collection?.status),lastAttemptAt:iso(source.collection?.lastAttemptAt),nextRunAt:iso(source.collection?.nextRunAt)};
  const notices=[{code:'REFRESH_CADENCE',message:'A tela consulta os dados salvos a cada 60 segundos. A coleta nas redes depende da integração e ocorre em intervalos de pelo menos 15 minutos; não é tempo real.'},{code:'POST_COVERAGE',message:'Cobertura parcial: uma página de até 25 publicações retornadas por conta Meta, mais o histórico identificado no AgendePost. A ordem depende da rede; não é o histórico completo da conta.'},{code:'METRIC_SCOPE',message:'Cada rede e indicador pode ter uma janela diferente. Campo indisponível não significa zero. Não somamos alcance entre plataformas.'}];
  if(accounts.some(a=>a.platform==='linkedin'))notices.push({code:'LINKEDIN_UNSUPPORTED',message:'LinkedIn: coleta automática ainda não implementada. Conectar um canal editorial não autoriza acesso às métricas da rede.'});
  if(!collection.enabled)notices.push({code:'COLLECTION_DISABLED',message:'A coleta automática desta marca está desligada. O responsável precisa configurar e autorizar a integração.'});
  return {brand:{name:text(brand.name,100),color:safeColor(brand.color)},generatedAt:now(),lastSyncedAt:iso(source.lastSyncedAt),stale:source.stale!==false,collection,accounts,posts:posts.slice(0,100),notices};
 }
 ctx.services.clientDashboard={build};return ctx.services.clientDashboard;
}
export async function registerClientDashboard(app,ctx){
 const {db,now,transaction}=ctx,auth=[ctx.auth.requireUser,ctx.auth.requireTenant],prefix=`${base}/dashboard-shares`;
 const missing=()=>{throw ctx.errors.http(404,'DASHBOARD_UNAVAILABLE','Link indisponível, expirado ou revogado.');};
 function manage(req){const brand=workspace(ctx,req,'manage');if(brand.archived_at||req.tenant.status!=='active')throw ctx.errors.http(403,'DASHBOARD_UNAVAILABLE','Marca indisponível.');return brand;}
 const shareFor=req=>db.prepare('SELECT * FROM client_dashboard_shares WHERE tenant_id=? AND workspace_id=? AND id=?').get(req.params.tid,req.params.wid,req.params.sid);
 app.get(`${base}/client-dashboard`,{preHandler:auth},req=>{
  const brand=workspace(ctx,req);const data=ctx.services.clientDashboard.build(req.params.tid,req.params.wid);
  const settings=ctx.services.socialMetrics?.settings(req.params.tid,req.params.wid)??{enabled:false,version:1,cadenceMinutes:15};
  return {data:{...data,management:{canManage:['owner','admin'].includes(req.tenant.role)&&!brand.archived_at,canConfigureMetrics:req.tenant.role==='owner'&&!brand.archived_at,metricsSettings:{enabled:settings.enabled===true,version:settings.version,cadenceMinutes:settings.cadenceMinutes}}}};
 });
 app.post(`${base}/social-metrics/settings`,{preHandler:auth,schema:{body:object({enabled:{type:'boolean'},expectedVersion:positive,cadenceMinutes:{type:'integer',minimum:15,maximum:1440}},['enabled','expectedVersion'])}},req=>{
  manage(req);ctx.auth.requireRecentAuth(req);if(req.tenant.role!=='owner')throw ctx.errors.http(403,'OWNER_REQUIRED','Somente o proprietário pode configurar a coleta.');
  if(!ctx.services.socialMetrics)throw ctx.errors.http(503,'METRICS_UNAVAILABLE','Coleta indisponível.');return {data:ctx.services.socialMetrics.configure(req)};
 });
 app.get(prefix,{preHandler:auth},req=>{manage(req);return {data:db.prepare('SELECT * FROM client_dashboard_shares WHERE tenant_id=? AND workspace_id=? ORDER BY created_at DESC,id LIMIT 100').all(req.params.tid,req.params.wid).map(metadata)};});
 app.post(prefix,{preHandler:auth,schema:{body:object({label:string(100),expiresInDays:{type:'integer',minimum:1,maximum:90},acknowledgeBearerAccess:{const:true}},['label','expiresInDays','acknowledgeBearerAccess'])}},(req,reply)=>{
  manage(req);ctx.auth.requireRecentAuth(req);
  if(!ctx.config.hosted&&ctx.config.mode!=='test')throw ctx.errors.http(503,'HOSTED_REQUIRED','Compartilhamento externo exige o piloto HTTPS hospedado.');
  const label=req.body.label.trim();if(!label)throw ctx.errors.http(422,'LABEL_REQUIRED','Informe uma referência para o link.');
  const key=req.headers['idempotency-key'];if(typeof key!=='string'||!/^[A-Za-z0-9_.:~-]{8,128}$/.test(key))throw ctx.errors.http(422,'IDEMPOTENCY_REQUIRED','Informe uma chave única para a criação.');
  const at=now(),id=randomUUID(),raw=randomBytes(32).toString('base64url'),expiresAt=new Date(Date.parse(at)+req.body.expiresInDays*86400e3).toISOString();
  transaction(()=>{
   manage(req);ctx.auth.requireRecentAuth(req);
   if(db.prepare('SELECT 1 FROM client_dashboard_shares WHERE tenant_id=? AND workspace_id=? AND created_by=? AND request_key_hash=?').get(req.params.tid,req.params.wid,req.user.id,digest(key)))throw ctx.errors.http(409,'SHARE_ALREADY_CREATED','Esta solicitação já criou um link. Por segurança ele não pode ser recuperado; revogue e gere outro se necessário.');
   if(db.prepare('SELECT count(*) AS n FROM client_dashboard_shares WHERE tenant_id=? AND workspace_id=?').get(req.params.tid,req.params.wid).n>=100)throw ctx.errors.http(409,'SHARE_HISTORY_LIMIT','Limite de links desta marca atingido. Procure o operador.');
   if(db.prepare('SELECT count(*) AS n FROM client_dashboard_shares WHERE tenant_id=? AND workspace_id=? AND revoked_at IS NULL AND expires_at>?').get(req.params.tid,req.params.wid,at).n>=5)throw ctx.errors.http(409,'SHARE_LIMIT','Revogue um link existente antes de criar outro.');
   db.prepare('INSERT INTO client_dashboard_shares(tenant_id,workspace_id,id,token_hash,request_key_hash,label,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(req.params.tid,req.params.wid,id,digest(raw),digest(key),label,req.user.id,at,expiresAt);
   ctx.audit({tenantId:req.params.tid,actorId:req.user.id,action:'dashboard.share_created',targetType:'dashboard_share',targetId:id,safeChanges:{workspaceId:req.params.wid,expiresInDays:req.body.expiresInDays},requestId:req.id});
  });
  // Deliberately no generic idempotency response cache: the bearer secret is returned only once.
  reply.code(201).header('cache-control','private, no-store').header('referrer-policy','no-referrer');
  return {data:{id,label,version:1,expiresAt,url:`${ctx.config.canonicalOrigin}/client-dashboard#token=${raw}`}};
 });
 app.post(`${prefix}/:sid/revoke`,{preHandler:auth,schema:{body:object({expectedVersion:positive},['expectedVersion'])}},req=>({data:transaction(()=>{
  manage(req);ctx.auth.requireRecentAuth(req);const row=shareFor(req);if(!row)missing();
  if(row.version!==req.body.expectedVersion)throw ctx.errors.http(409,'VERSION_CONFLICT','O link foi alterado. Atualize a lista.');
  if(!row.revoked_at){db.prepare('UPDATE client_dashboard_shares SET revoked_at=?,version=version+1 WHERE tenant_id=? AND workspace_id=? AND id=? AND version=?').run(now(),req.params.tid,req.params.wid,row.id,row.version);ctx.audit({tenantId:req.params.tid,actorId:req.user.id,action:'dashboard.share_revoked',targetType:'dashboard_share',targetId:row.id,requestId:req.id});}
  return metadata(shareFor(req));
 })}));
 app.get('/api/v1/public/dashboard',{schema:{querystring:object({})},config:{rateLimit:{max:60,timeWindow:60000}}},(req,reply)=>{
  reply.header('cache-control','private, no-store').header('referrer-policy','no-referrer').header('x-robots-tag','noindex, nofollow, noarchive').header('vary','Authorization');
  const authHeader=req.headers.authorization;if(typeof authHeader!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(authHeader))missing();
  const row=db.prepare(`SELECT s.* FROM client_dashboard_shares s JOIN users u ON u.id=s.created_by JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.created_by JOIN tenants t ON t.id=s.tenant_id JOIN workspaces w ON w.tenant_id=s.tenant_id AND w.id=s.workspace_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active' AND u.email_verified_at IS NOT NULL AND m.status='active' AND m.role IN ('owner','admin') AND m.scope='organization' AND t.status='active' AND w.archived_at IS NULL`).get(digest(authHeader.slice(7)),now());
  if(!row)missing();
  return {data:ctx.services.clientDashboard.build(row.tenant_id,row.workspace_id,{publicId:row.id})};
 });
 app.get('/client-dashboard',async(_req,reply)=>reply.header('cache-control','no-store').header('referrer-policy','no-referrer').header('x-robots-tag','noindex, nofollow, noarchive').sendFile('client-dashboard.html'));
}
