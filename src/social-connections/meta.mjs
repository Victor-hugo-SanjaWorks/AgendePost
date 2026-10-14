import { createHmac } from 'node:crypto';
import { API_VERSION,OAuthError } from './config.mjs';
const ID=/^[1-9][0-9]{0,39}$/;
const safeToken=v=>typeof v==='string'&&v.length>=20&&v.length<=8192&&!/[\s\u0000-\u001f\u007f]/u.test(v);
const label=v=>typeof v==='string'&&v.length>0&&v.length<=200&&!/[\u0000-\u001f\u007f]/u.test(v);
export function scopesFor(platform,basis){return platform==='facebook'?['pages_show_list','pages_read_engagement','pages_manage_posts']:['pages_show_list','pages_read_engagement','instagram_basic','instagram_content_publish',...(basis==='business_manager'?['ads_read']:[])];}
export function createMetaOAuthClient(config,{fetchImpl=globalThis.fetch,now=()=>new Date().toISOString()}={}){
 async function call(path,{token,parameters={},method='GET'}={}){
  if(!/^(?:oauth\/access_token|debug_token|me(?:\/permissions)?|[1-9][0-9]{0,39}(?:\/accounts)?)$/.test(path))throw new OAuthError();
  const url=new URL(`https://graph.facebook.com/${API_VERSION}/${path}`),params=new URLSearchParams(parameters);
  if(token){if(!safeToken(token)&&token!==`${config.appId}|${config.appSecret}`)throw new OAuthError();if(token!==`${config.appId}|${config.appSecret}`)params.set('appsecret_proof',createHmac('sha256',config.appSecret).update(token).digest('hex'));}
  const headers={accept:'application/json',...(token?{authorization:`Bearer ${token}`}:{})};
  if(method==='GET')url.search=params;else headers['content-type']='application/x-www-form-urlencoded';
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),config.requestTimeoutMs);let listener;
  const abort=new Promise((_,reject)=>{listener=()=>reject(new OAuthError('META_OAUTH_PROVIDER_UNAVAILABLE'));controller.signal.addEventListener('abort',listener,{once:true});});
  try{return await Promise.race([(async()=>{
   const res=await fetchImpl(url.href,{method,headers,...(method==='GET'?{}:{body:params.toString()}),redirect:'error',signal:controller.signal});
   if(!res||res.status!==200||!res.body||!res.headers?.get('content-type')?.toLowerCase().startsWith('application/json'))throw new OAuthError('META_OAUTH_PROVIDER_REJECTED');
   const reader=res.body.getReader();let n=0;const chunks=[];
   try{while(true){const {done,value}=await reader.read();if(done)break;n+=value.byteLength;if(n>512*1024)throw new OAuthError('META_OAUTH_PROVIDER_INVALID');chunks.push(Buffer.from(value));}}finally{try{await reader.cancel();}catch{}}
   let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new OAuthError('META_OAUTH_PROVIDER_INVALID');}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||parsed.error)throw new OAuthError('META_OAUTH_PROVIDER_REJECTED');return parsed;
  })(),abort]);}catch(error){throw error instanceof OAuthError?error:new OAuthError('META_OAUTH_PROVIDER_UNAVAILABLE');}finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',listener);}
 }
 async function debug(token,type,userId){
  const {data}=await call('debug_token',{token:`${config.appId}|${config.appSecret}`,parameters:{input_token:token}});
  if(!data||data.is_valid!==true||String(data.app_id)!==config.appId||data.type!==type||userId&&String(data.user_id)!==userId||!Array.isArray(data.scopes)||data.scopes.some(p=>typeof p!=='string'))throw new OAuthError('META_OAUTH_IDENTITY_INVALID');
  const at=Date.parse(now()),expiries=[];
  for(const key of ['expires_at','data_access_expires_at']){const value=data[key];if(value!==undefined&&(!Number.isSafeInteger(value)||value<0))throw new OAuthError('META_OAUTH_EXPIRY_INVALID');if(value>0)expiries.push(value*1000);}
  if(type==='USER'&&(!ID.test(String(data.user_id))||!Number.isSafeInteger(data.expires_at)||data.expires_at<=0))throw new OAuthError('META_OAUTH_EXPIRY_INVALID');
  if(expiries.some(e=>e<=at+60000))throw new OAuthError('META_OAUTH_EXPIRED');
  return {userId:String(data.user_id),scopes:data.scopes,expiresAt:expiries.length?new Date(Math.min(...expiries)).toISOString():null};
 }
 async function pages(token,userId){
  const rows=[],seen=new Set();let after;
  for(let count=0;count<10;count++){
   const result=await call(`${userId}/accounts`,{token,parameters:{fields:'id,name,access_token,tasks,instagram_business_account{id,username,account_type}',limit:'100',...(after?{after}:{})}});
   if(!Array.isArray(result.data)||rows.length+result.data.length>1000)throw new OAuthError('META_OAUTH_PROVIDER_INVALID');
   for(const row of result.data){if(!ID.test(row.id)||seen.has(row.id)||!label(row.name)||!safeToken(row.access_token)||!Array.isArray(row.tasks)||row.tasks.some(t=>typeof t!=='string'))throw new OAuthError('META_OAUTH_PROVIDER_INVALID');seen.add(row.id);rows.push(row);}
   if(!result.paging?.next)return rows;
   // Never follow the provider's next URL (it may contain credentials); only copy a bounded cursor onto the fixed endpoint.
   after=result.paging?.cursors?.after;if(typeof after!=='string'||!/^[A-Za-z0-9_=-]{1,2000}$/.test(after))throw new OAuthError('META_OAUTH_PROVIDER_INVALID');
  }
  throw new OAuthError('META_OAUTH_TOO_MANY_ACCOUNTS');
 }
 async function discover(userToken,platform,basis,expectedUserId){
  const details=await debug(userToken,'USER',expectedUserId);
  const identity=await call('me',{token:userToken,parameters:{fields:'id'}});
  if(identity.id!==details.userId)throw new OAuthError('META_OAUTH_IDENTITY_INVALID');
  const granted=await call('me/permissions',{token:userToken});if(!Array.isArray(granted.data)||granted.paging?.next)throw new OAuthError('META_OAUTH_PERMISSION_INVALID');
  const permissions=granted.data.filter(r=>r.status==='granted'&&typeof r.permission==='string').map(r=>r.permission);
  const required=scopesFor(platform,basis);if(required.some(p=>!permissions.includes(p)||!details.scopes.includes(p)))throw new OAuthError('META_OAUTH_PERMISSION_MISSING');
  const candidates=[];
  for(const page of await pages(userToken,details.userId)){
   const hasTask=page.tasks.includes('CREATE_CONTENT'),ig=page.instagram_business_account;
   if(platform==='instagram'&&(!ig||!ID.test(ig.id)))continue;
   const accountId=platform==='facebook'?page.id:ig.id;
   const professional=platform==='facebook'||['BUSINESS','MEDIA_CREATOR'].includes(ig.account_type);
   candidates.push({id:accountId,platform,accountId,pageId:page.id,destinationLabel:platform==='facebook'?page.name:label(ig.username)?`@${ig.username}`:page.name,pageTasks:page.tasks,eligible:hasTask&&professional,code:!hasTask?'META_OAUTH_PAGE_TASK_MISSING':!professional?'META_OAUTH_PROFESSIONAL_REQUIRED':null,accessToken:page.access_token});
  }
  return {userId:details.userId,expiresAt:details.expiresAt,permissions,candidates};
 }
 async function exchange(code,platform,basis){
  // OAuth secrets are server-to-server only. Never log/return this URL, request or raw provider errors.
  const short=await call('oauth/access_token',{parameters:{client_id:config.appId,client_secret:config.appSecret,redirect_uri:config.redirectUri,code}});
  if(!safeToken(short.access_token))throw new OAuthError('META_OAUTH_PROVIDER_INVALID');
  const long=await call('oauth/access_token',{parameters:{grant_type:'fb_exchange_token',client_id:config.appId,client_secret:config.appSecret,fb_exchange_token:short.access_token}});
  if(!safeToken(long.access_token)||!Number.isSafeInteger(long.expires_in)||long.expires_in<=60)throw new OAuthError('META_OAUTH_EXPIRY_INVALID');
  const result=await discover(long.access_token,platform,basis);
  result.expiresAt=new Date(Math.min(Date.parse(result.expiresAt),Date.parse(now())+long.expires_in*1000)).toISOString();
  return {...result,userToken:long.access_token};
 }
 async function verifySelection(payload,selected,platform,basis){
  const current=await discover(payload.userToken,platform,basis,payload.userId);
  const c=current.candidates.find(c=>c.accountId===selected.accountId&&c.pageId===selected.pageId);
  if(!c||!c.eligible)throw new OAuthError(c?.code||'META_OAUTH_DESTINATION_UNAVAILABLE');
  const details=await debug(c.accessToken,'PAGE');
  if(scopesFor(platform,basis).some(p=>!details.scopes.includes(p)))throw new OAuthError('META_OAUTH_PERMISSION_MISSING');
  const page=await call('me',{token:c.accessToken,parameters:{fields:'id,name,instagram_business_account{id,username,account_type}'}});
  if(page.id!==c.pageId||platform==='instagram'&&(page.instagram_business_account?.id!==c.accountId||!['BUSINESS','MEDIA_CREATOR'].includes(page.instagram_business_account?.account_type)))throw new OAuthError('META_OAUTH_IDENTITY_INVALID');
  const expiresAt=new Date(Math.min(Date.parse(payload.expiresAt),Date.parse(current.expiresAt),details.expiresAt?Date.parse(details.expiresAt):Infinity)).toISOString();
  return {...c,permissions:current.permissions,expiresAt};
 }
 return Object.freeze({exchange,verifySelection});
}
