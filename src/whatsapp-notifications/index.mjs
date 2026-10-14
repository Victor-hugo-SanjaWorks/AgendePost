import { randomUUID,createHash } from 'node:crypto';
import { constants,openSync,closeSync,fstatSync,readFileSync,realpathSync } from 'node:fs';
import { isAbsolute,relative,sep } from 'node:path';
import { base,object,string,workspace } from '../editorial/shared.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const inside=(root,path)=>{const r=relative(root,path);return r===''||(r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r));};
const invalid=()=>{throw new Error('WHATSAPP_CONFIG_INVALID');};
function bounded(promise,signal){
 return new Promise((resolve,reject)=>{
  const stop=()=>reject(new Error('WHATSAPP_TIMEOUT'));
  if(signal.aborted){Promise.resolve(promise).catch(()=>{});stop();return;}
  signal.addEventListener('abort',stop,{once:true});
  Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
 });
}
export function buildWhatsAppConfig(config,options={}){
 try{
  const injected=options.whatsappConfig!==undefined||options.whatsappFetch!==undefined;
  if(injected&&config.mode!=='test')invalid();
  let raw;
  if(config.mode==='test')raw=options.whatsappConfig;
  else{
   if(process.env.SOCIAL_SAAS_WHATSAPP_ENABLED!=='true')return {enabled:false,code:'WHATSAPP_NOT_CONFIGURED',connections:new Map()};
   const filename=process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE;
   if(process.platform!=='linux'||typeof filename!=='string'||!isAbsolute(filename)||inside(realpathSync(config.root),realpathSync(filename)))invalid();
   let fd;try{fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const f=fstatSync(fd);if(!f.isFile()||f.nlink!==1||f.uid!==process.getuid()||(f.mode&0o077)!==0||f.size>131072||f.size<2)invalid();raw=JSON.parse(readFileSync(fd,'utf8'));}finally{if(fd!==undefined)closeSync(fd);}
  }
  if(!raw)return {enabled:false,code:'WHATSAPP_NOT_CONFIGURED',connections:new Map()};
  if(raw.enabled!==true||raw.apiVersion!=='v26.0'||!Array.isArray(raw.connections)||raw.connections.length>100)invalid();
  const connections=new Map();
  for(const c of raw.connections){
   if(!c||typeof c.tenantId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(c.tenantId)||connections.has(c.tenantId)||typeof c.phoneNumberId!=='string'||!/^[1-9][0-9]{0,39}$/.test(c.phoneNumberId)||typeof c.accessToken!=='string'||c.accessToken.length<20||c.accessToken.length>8192||/[\s\u0000-\u001f\u007f]/u.test(c.accessToken)||typeof c.templateName!=='string'||!/^[a-z][a-z0-9_]{0,511}$/.test(c.templateName)||typeof c.languageCode!=='string'||!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(c.languageCode)||c.bodyFormat!=='approval_url_only'||typeof c.senderLabel!=='string'||!c.senderLabel.trim()||c.senderLabel.length>100)invalid();
   connections.set(c.tenantId,Object.freeze({...c}));
  }
  return {enabled:true,connections};
 }catch{return {enabled:false,code:'WHATSAPP_CONFIG_INVALID',connections:new Map()};}
}
const dto=row=>({id:row.id,status:row.status==='sending'?'unknown':row.status,recipientLast4:row.recipient_last4,createdAt:row.created_at,updatedAt:row.updated_at,code:row.error_code??null,message:row.status==='accepted'?'A API do WhatsApp aceitou a solicitação. A entrega ao cliente ainda não foi confirmada.':row.status==='rejected'?'A API recusou a solicitação. Nenhum envio foi confirmado.':'O resultado do envio é desconhecido. Confira o WhatsApp antes de tentar novamente; não reenviamos automaticamente.'});
export function initializeWhatsAppNotifications(ctx,options={}){
 const config=buildWhatsAppConfig(ctx.config,options),fetchImpl=options.whatsappFetch??globalThis.fetch;
 if(options.whatsappFetch!==undefined&&typeof options.whatsappFetch!=='function')throw new Error('WHATSAPP_TEST_FETCH_INVALID');
 const {db,now,transaction}=ctx;
 function readiness(tid){const c=config.connections.get(tid);return {configured:config.enabled&&!!c,code:config.enabled&&c?null:config.code??'WHATSAPP_TENANT_NOT_CONFIGURED',senderLabel:c?.senderLabel??null,deliveryTracking:false,templateOnly:true};}
 function authorize(req,raw){
  workspace(ctx,req,'write');ctx.auth.requireRecentAuth(req);
  if(req.tenant.status!=='active')throw ctx.errors.http(403,'TENANT_SUSPENDED','Organização indisponível.');
  if(!ctx.services.clientApprovals?.assertNotification)throw ctx.errors.http(503,'APPROVAL_NOT_READY','Recurso de aprovação indisponível.');
  const approval=ctx.services.clientApprovals.assertNotification(req,raw);
  const expected=`${ctx.config.canonicalOrigin}/approval.html#${raw}`;
  if(approval?.tenantId!==req.params.tid||approval?.workspaceId!==req.params.wid||approval?.id!==req.params.aid||approval?.url!==expected)throw ctx.errors.http(409,'APPROVAL_LINK_MISMATCH','O link não corresponde à solicitação.');
  return approval;
 }
 async function notify(req){
  const raw=req.body.token,phone=req.body.recipientPhone;
  if(!/^\+[1-9][0-9]{7,14}$/.test(phone))throw ctx.errors.http(422,'INVALID_PHONE','Use o número internacional completo, começando com + e código do país.');
  authorize(req,raw);const c=config.connections.get(req.params.tid);
  if(!config.enabled||!c)throw ctx.errors.http(503,'WHATSAPP_NOT_CONFIGURED','WhatsApp oficial ainda não configurado para esta organização. Copie o link para compartilhar manualmente.');
  const requestKey=req.headers['idempotency-key'];if(typeof requestKey!=='string'||!/^[A-Za-z0-9_.:~-]{8,128}$/.test(requestKey))throw ctx.errors.http(422,'IDEMPOTENCY_REQUIRED','Informe uma chave única para o envio.');
  const key=[req.params.tid,req.params.wid,req.params.aid,req.user.id,hash(requestKey)],fingerprint=hash(phone+'\0'+hash(raw));
  const reserved=transaction(()=>{
   authorize(req,raw);const previous=db.prepare('SELECT * FROM approval_whatsapp_notifications WHERE tenant_id=? AND workspace_id=? AND approval_id=? AND actor_id=? AND request_key_hash=?').get(...key);
   if(previous){if(previous.request_hash!==fingerprint)throw ctx.errors.http(409,'IDEMPOTENCY_CONFLICT','A chave já foi usada para outro envio.');return {previous};}
   const recent=db.prepare('SELECT created_at FROM approval_whatsapp_notifications WHERE tenant_id=? AND workspace_id=? AND approval_id=? ORDER BY created_at DESC LIMIT 1').get(...key.slice(0,3));
   if(recent&&Date.parse(now())-Date.parse(recent.created_at)<300000)throw ctx.errors.http(429,'WHATSAPP_COOLDOWN','Aguarde cinco minutos e confira o resultado antes de enviar outra notificação.');
   if(db.prepare('SELECT count(*) AS n FROM approval_whatsapp_notifications WHERE tenant_id=? AND workspace_id=? AND approval_id=?').get(...key.slice(0,3)).n>=5)throw ctx.errors.http(409,'WHATSAPP_LIMIT','Limite de notificações desta solicitação atingido.');
   const id=randomUUID(),at=now();db.prepare("INSERT INTO approval_whatsapp_notifications(tenant_id,workspace_id,approval_id,id,request_key_hash,request_hash,actor_id,recipient_hash,recipient_last4,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'sending',?,?)").run(req.params.tid,req.params.wid,req.params.aid,id,hash(requestKey),fingerprint,req.user.id,hash(req.params.tid+'\0'+phone),phone.slice(-4),at,at);
   ctx.audit({tenantId:req.params.tid,actorId:req.user.id,action:'approval.whatsapp_requested',targetType:'client_approval',targetId:req.params.aid,safeChanges:{notificationId:id,recipientConsent:true},requestId:req.id});return {id};
  });
  if(reserved.previous)return dto(reserved.previous);
  let status='unknown',code='WHATSAPP_RESULT_UNKNOWN',messageId=null;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const approval=authorize(req,raw);
   const response=await bounded(fetchImpl(`https://graph.facebook.com/v26.0/${c.phoneNumberId}/messages`,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Bearer ${c.accessToken}`,'content-type':'application/json',accept:'application/json'},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',to:phone.slice(1),type:'template',template:{name:c.templateName,language:{code:c.languageCode},components:[{type:'body',parameters:[{type:'text',text:approval.url}]}]}})}),controller.signal);
   if(response.status>=400&&response.status<500){status='rejected';code='WHATSAPP_REQUEST_REJECTED';}
   else if(response.status===200&&response.body&&response.headers.get('content-type')?.includes('application/json')){
    const reader=response.body.getReader(),chunks=[];let length=0;try{while(true){const x=await bounded(reader.read(),controller.signal);if(x.done)break;length+=x.value.byteLength;if(length>131072)throw Error();chunks.push(Buffer.from(x.value));}}finally{try{await bounded(reader.cancel(),controller.signal);}catch{}}
    const data=JSON.parse(Buffer.concat(chunks).toString('utf8')),id=data?.messages?.[0]?.id;
    if(typeof id==='string'&&/^wamid\.[A-Za-z0-9._~+\/=:-]{1,1000}$/.test(id)){status='accepted';code=null;messageId=id;}
   }
  }catch(error){if(error.isPublic){status='rejected';code='APPROVAL_CHANGED_BEFORE_SEND';}}
  finally{clearTimeout(timer);}
  transaction(()=>{db.prepare('UPDATE approval_whatsapp_notifications SET status=?,provider_message_id=?,error_code=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?').run(status,messageId,code,now(),req.params.tid,req.params.wid,reserved.id);ctx.audit({tenantId:req.params.tid,actorId:req.user.id,action:'approval.whatsapp_result',targetType:'client_approval',targetId:req.params.aid,outcome:status==='accepted'?'success':'failure',safeChanges:{status,notificationId:reserved.id},requestId:req.id});});
  return dto(db.prepare('SELECT * FROM approval_whatsapp_notifications WHERE tenant_id=? AND workspace_id=? AND id=?').get(req.params.tid,req.params.wid,reserved.id));
 }
 ctx.services.whatsappNotifications={readiness,notify};return ctx.services.whatsappNotifications;
}
export async function registerWhatsAppNotifications(app,ctx){
 const auth=[ctx.auth.requireUser,ctx.auth.requireTenant];
 app.get(`${base}/whatsapp-notification-status`,{preHandler:auth},req=>{workspace(ctx,req,'write');return {data:ctx.services.whatsappNotifications.readiness(req.params.tid)};});
 app.post(`${base}/client-approvals/:aid/notify-whatsapp`,{preHandler:auth,bodyLimit:4096,schema:{body:object({token:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},recipientPhone:string(16),recipientConsented:{const:true},confirmSend:{const:true}},['token','recipientPhone','recipientConsented','confirmSend'])}},async req=>({data:await ctx.services.whatsappNotifications.notify(req)}));
}
