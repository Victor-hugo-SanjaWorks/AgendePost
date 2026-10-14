import { graphRequest, SafeProviderError } from '../publishing/providers/transport.mjs';
import { API_VERSION, MetricsError, emptyMetrics, observed, safePermalink } from './model.mjs';
const ID=/^[1-9][0-9]{0,39}$/;
export const REMOTE_POST_LIMIT=25;
const IG_FIELDS='id,owner{id},timestamp,permalink,like_count,comments_count';
const FB_FIELDS='id,from{id},created_time,permalink_url,likes.limit(0).summary(true),comments.limit(0).summary(true),reactions.limit(0).summary(true),shares';
/** Parse only provider ISO timestamps with real Gregorian dates; Date.parse alone normalizes February 30. */
export function parseProviderTimestamp(value,at){
 if(typeof value!=='string')return null;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/.exec(value);
 if(!m)return null;
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
 const leap=year%4===0&&(year%100!==0||year%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(year<1||month<1||month>12||day<1||day>days[month-1]||hour>23||minute>59||second>59)return null;
 if(m[8]!=='Z'){const offset=m[8].slice(1).replace(':','');if(Number(offset.slice(0,2))>23||Number(offset.slice(2))>59)return null;}
 const parsed=Date.parse(value),reference=Date.parse(at);
 if(!Number.isFinite(parsed)||!Number.isFinite(reference)||parsed>reference+60000)return null;
 return new Date(parsed).toISOString();
}

export function requiredScopes(platform){return platform==='instagram'?['pages_read_engagement','instagram_basic']:platform==='facebook'?['pages_read_engagement']:[];}
export function scopeCode(connection){
 if(!Array.isArray(connection.permissions)||connection.permissions.some(p=>typeof p!=='string')||!requiredScopes(connection.platform).every(p=>connection.permissions.includes(p)))return 'METRICS_SCOPE_MISSING';
 if(connection.platform==='instagram'&&connection.businessManagerGrant&&!connection.permissions?.some(p=>['ads_read','ads_management'].includes(p)))return 'METRICS_SCOPE_MISSING';
 return null;
}
export function safeError(error){
 if(error instanceof MetricsError)return error;
 if(!(error instanceof SafeProviderError))return new MetricsError();
 const code=({META_AUTH_EXPIRED:'METRICS_DISCONNECTED',META_PERMISSION_DENIED:'METRICS_SCOPE_MISSING',META_RATE_LIMIT:'METRICS_RATE_LIMIT',META_REQUEST_REJECTED:'METRICS_UNSUPPORTED',PROVIDER_TIMEOUT:'METRICS_TIMEOUT',PROVIDER_RESPONSE_INVALID:'METRICS_RESPONSE_INVALID',PROVIDER_RESPONSE_TOO_LARGE:'METRICS_RESPONSE_INVALID'})[error.code]||'METRICS_PROVIDER_ERROR';
 return new MetricsError(code,error.retryAfterMs);
}
/** Deliberately small read-only adapter. One bounded page of owned posts/media; no captions, audience data or paging-URL traversal. */
export function createMetaMetricsAdapter({fetchImpl=globalThis.fetch,now=()=>new Date().toISOString(),timeoutMs=10000}={}){
 async function call(input,path,fields,parameters={}){
  // Re-resolve secure binding and its local grant immediately before each GET, never retain it in DTOs.
  const c=input.assertCurrent();
  if(!ID.test(c.accountId)||!ID.test(c.linkedPageId)||c.tokenType!=='page'||typeof c.accessToken!=='string'||c.accessToken.length<20||c.accessToken.length>8192||/[\s\u0000-\u001f\u007f]/u.test(c.accessToken)||typeof c.appSecretProof!=='string'||!/^[a-f0-9]{64}$/.test(c.appSecretProof))throw new MetricsError('METRICS_DISCONNECTED');
  const scope=scopeCode(c);if(scope)throw new MetricsError(scope);
  if(!/^(?:me|[1-9][0-9]{0,39}(?:_[1-9][0-9]{0,39})?(?:\/(?:media|published_posts))?)$/.test(path)||path.includes('/')&&path!==`${c.accountId}/${c.platform==='instagram'?'media':'published_posts'}`)throw new MetricsError('METRICS_IDENTITY_MISMATCH');
  try{
   const boundedFetch=async(url,options)=>{const response=await fetchImpl(url,options);if(response.status===429){const header=response.headers?.get('retry-after'),delay=/^\d+$/.test(header||'')?Number(header)*1000:Date.parse(header)-Date.parse(now());try{await response.body?.cancel();}catch{}throw new SafeProviderError('META_RATE_LIMIT',{retryAfterMs:Number.isFinite(delay)&&delay>0?Math.min(delay,86400000):60000,safeToRetry:true});}if(!response.headers?.get('content-type')?.toLowerCase().startsWith('application/json'))throw new SafeProviderError('PROVIDER_RESPONSE_INVALID');return response;};
   const result=await graphRequest({fetchImpl:boundedFetch,apiVersion:API_VERSION,token:c.accessToken,path,method:'GET',parameters:{...parameters,fields,appsecret_proof:c.appSecretProof},signal:input.signal,timeoutMs,effect:'none',now:Date.parse(now())});
   input.assertCurrent();return result;
  }catch(error){throw safeError(error);}
 }
 async function account(input){
  const c=input.assertCurrent();
  const page=await call(input,'me',c.platform==='instagram'?'id,instagram_business_account{id}':'id');
  if(page.id!==c.linkedPageId||c.platform==='instagram'&&page.instagram_business_account?.id!==c.accountId||c.platform==='facebook'&&page.id!==c.accountId)throw new MetricsError('METRICS_IDENTITY_MISMATCH');
  const data=await call(input,c.accountId,'id,followers_count');
  if(data.id!==c.accountId)throw new MetricsError('METRICS_IDENTITY_MISMATCH');
  const at=now(),metrics=emptyMetrics('account');metrics[0]=observed('followers',data.followers_count,`${c.platform}.followers_count`,at);
  return {observedAt:at,metrics};
 }
 function parsePost(c,data,expectedId,at){
  if(!data||typeof data!=='object'||Array.isArray(data)||data.id!==expectedId)throw new MetricsError('METRICS_IDENTITY_MISMATCH');
  if(c.platform==='instagram'){
   if(!ID.test(data.id)||data.owner?.id!==c.accountId)throw new MetricsError('METRICS_IDENTITY_MISMATCH');
  }else if(!new RegExp(`^${c.accountId}_[1-9][0-9]{0,39}$`).test(data.id)||data.from?.id!==c.accountId)throw new MetricsError('METRICS_IDENTITY_MISMATCH');
  const values=c.platform==='instagram'?{likes:data.like_count,comments:data.comments_count}:{likes:data.likes?.summary?.total_count,comments:data.comments?.summary?.total_count,shares:data.shares?.count,reactions:data.reactions?.summary?.total_count};
  const fields=c.platform==='instagram'?{likes:'like_count',comments:'comments_count'}:{likes:'post.likes.summary.total_count',comments:'post.comments.summary.total_count',shares:'post.shares.count',reactions:'post.reactions.summary.total_count'};
  const metrics=emptyMetrics('post').map(m=>Object.hasOwn(values,m.key)?observed(m.key,values[m.key],`${c.platform}.${fields[m.key]}`,at,'snapshot'):m);
  return {observedAt:at,metrics,permalink:safePermalink(data.permalink??data.permalink_url,c.platform)};
 }
 async function post(input,post){
  const c=input.assertCurrent();
  if(c.platform==='instagram'?!ID.test(post.remote_id):!new RegExp(`^${c.accountId}_[1-9][0-9]{0,39}$`).test(post.remote_id))throw new MetricsError('METRICS_IDENTITY_MISMATCH');
  const data=await call(input,post.remote_id,c.platform==='instagram'?IG_FIELDS:FB_FIELDS);
  return parsePost(c,data,post.remote_id,now());
 }
 async function recentPosts(input){
  const c=input.assertCurrent(),edge=c.platform==='instagram'?'media':'published_posts';
  const result=await call(input,`${c.accountId}/${edge}`,c.platform==='instagram'?IG_FIELDS:FB_FIELDS,{limit:String(REMOTE_POST_LIMIT),...(c.platform==='facebook'?{include_hidden:'false',show_expired:'false'}:{})});
  if(!Array.isArray(result.data)||result.data.length>REMOTE_POST_LIMIT)throw new MetricsError('METRICS_RESPONSE_INVALID');
  const at=now(),seen=new Set(),posts=[];
  for(const row of result.data){
   const parsed=parsePost(c,row,row?.id,at);
   if(seen.has(row.id))throw new MetricsError('METRICS_RESPONSE_INVALID');seen.add(row.id);
   const timestamp=parseProviderTimestamp(row.timestamp??row.created_time,at);
   if(timestamp===null)throw new MetricsError('METRICS_RESPONSE_INVALID');
   posts.push({...parsed,remoteId:row.id,publishedAt:timestamp});
  }
  // The provider's opaque next URL is never followed, saved, or returned. A full page is conservatively incomplete.
  return {observedAt:at,posts,hasMore:result.data.length===REMOTE_POST_LIMIT||Boolean(result.paging?.next)};
 }
 return Object.freeze({account,post,recentPosts});
}
