import { id,digest,plus } from './auth/utils.mjs';
function canonical(value){if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function addSharedServices(ctx){
 ctx.audit=({tenantId=null,actorId=null,action,targetType,targetId=null,outcome='success',safeChanges={},requestId=null})=>{
  const safe={};for(const [key,value]of Object.entries(safeChanges)){if(/password|cookie|secret|token|caption|body|email|name|content/i.test(key))continue;if(['string','number','boolean'].includes(typeof value))safe[key]=typeof value==='string'?value.slice(0,200):value;else if(value===null)safe[key]=null;}
  ctx.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(id(),tenantId,actorId,action,targetType,targetId,outcome,JSON.stringify(safe),requestId,ctx.now());
 };
 ctx.idempotency=(req,fn,{required=false,bodyHash}={})=>ctx.transaction(()=>{
  if(req.tenant)ctx.auth.freshTenant(req);else ctx.auth.requireFresh(req);
  const key=req.headers['idempotency-key'];if(key===undefined){if(required)throw ctx.errors.http(422,'IDEMPOTENCY_REQUIRED','Informe uma chave de idempotência.');return fn();}
  if(typeof key!=='string'||!/^[\w.:~-]{8,128}$/.test(key))throw ctx.errors.http(422,'INVALID_IDEMPOTENCY_KEY','Chave de idempotência inválida.');
  const tenantId=req.tenant?.id||req.params?.tid||'global',route=(req.routeOptions.url||req.url.split('?')[0])+':'+req.url.split('?')[0];
  const hash=bodyHash||digest(canonical(req.body??null));const params=[tenantId,req.user.id,req.method,route,key];
  ctx.db.prepare('DELETE FROM idempotency_keys WHERE expires_at<=?').run(ctx.now());
  const previous=ctx.db.prepare('SELECT request_hash,result_ref FROM idempotency_keys WHERE tenant_id=? AND actor_id=? AND method=? AND route=? AND key=?').get(...params);
  if(previous){if(previous.request_hash!==hash)throw ctx.errors.http(409,'IDEMPOTENCY_CONFLICT','Esta chave já foi usada com outros dados.');return JSON.parse(previous.result_ref);}
  const result=fn();if(result?.then)throw new Error('ASYNC_IDEMPOTENCY_FORBIDDEN');const serialized=JSON.stringify(result);if(Buffer.byteLength(serialized)>256*1024)throw new Error('IDEMPOTENCY_RESPONSE_TOO_LARGE');ctx.db.prepare('INSERT INTO idempotency_keys VALUES(?,?,?,?,?,?,?,?)').run(...params,hash,serialized,plus(ctx.now(),24*60*60e3));return result;
 });
}
