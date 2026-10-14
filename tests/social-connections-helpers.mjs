import { randomUUID } from 'node:crypto';
import { harness,verified,idempotency,route,fixtureTeamPlan } from './qa-helpers.mjs';
export const OAUTH_ORIGIN='https://127.0.0.1:8787';
export const OAUTH_FIXTURE={appId:'10001',appSecret:'a'.repeat(32),userId:'20002',pageId:'30003',igId:'40004',shortToken:'SYNTHETIC_SHORT_TOKEN_FIXTURE_ONLY',userToken:'SYNTHETIC_USER_TOKEN_FIXTURE_ONLY',pageToken:'SYNTHETIC_PAGE_TOKEN_FIXTURE_ONLY'};
export function offlineOAuth(now=()=>Date.now()){
 const calls=[];let intercept=null;
 const scopes=['pages_show_list','pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish','ads_read'];
 const ig={id:OAUTH_FIXTURE.igId,username:'offline_instagram',account_type:'BUSINESS'};
 const respond=data=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);calls.push({url,options});
  if(u.origin!=='https://graph.facebook.com'||!u.pathname.startsWith('/v26.0/'))throw Error('OFFLINE_UNEXPECTED_ENDPOINT');
  if(intercept){const override=await intercept(u,options);if(override!==undefined)return override;}
  const path=u.pathname.slice('/v26.0/'.length),page=options.headers.authorization===`Bearer ${OAUTH_FIXTURE.pageToken}`;
  if(path==='oauth/access_token')return respond(u.searchParams.has('code')?{access_token:OAUTH_FIXTURE.shortToken}:{access_token:OAUTH_FIXTURE.userToken,expires_in:3600});
  if(path==='debug_token')return respond({data:{is_valid:true,app_id:OAUTH_FIXTURE.appId,user_id:OAUTH_FIXTURE.userId,type:u.searchParams.get('input_token')===OAUTH_FIXTURE.pageToken?'PAGE':'USER',scopes,expires_at:Math.floor(now()/1000)+3600,data_access_expires_at:Math.floor(now()/1000)+7200}});
  if(path==='me')return respond(page?{id:OAUTH_FIXTURE.pageId,name:'Offline Facebook Page',instagram_business_account:ig}:{id:OAUTH_FIXTURE.userId});
  if(path==='me/permissions')return respond({data:scopes.map(permission=>({permission,status:'granted'}))});
  if(path===`${OAUTH_FIXTURE.userId}/accounts`)return respond({data:[{id:OAUTH_FIXTURE.pageId,name:'Offline Facebook Page',access_token:OAUTH_FIXTURE.pageToken,tasks:['CREATE_CONTENT'],instagram_business_account:ig}]});
  throw Error('OFFLINE_UNEXPECTED_REQUEST');
 };
 return {calls,fetchImpl,respond,scopes,setIntercept(fn){intercept=fn;}};
}
export async function oauthFixture(t,options={}){
 let time=Date.now();const mock=offlineOAuth(()=>time);
 const config={enabled:true,apiVersion:'v26.0',appId:OAUTH_FIXTURE.appId,appSecret:OAUTH_FIXTURE.appSecret,redirectUri:OAUTH_ORIGIN+'/api/v1/social-connections/meta/callback',encryptionKey:Buffer.alloc(32,7),requestTimeoutMs:1000};
 const h=await harness(t,{canonicalOrigin:OAUTH_ORIGIN,clock:()=>time,metaOAuthConfig:config,metaOAuthFetch:mock.fetchImpl,...options});
 const owner=await verified(h,'oauth-owner');
 const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'OAuth offline test',slug:`oauth-${randomUUID().slice(0,8)}`,timezone:'UTC'},idempotency());fixtureTeamPlan(h,tenant.id);
 const workspace=await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/workspaces`,{name:'Offline verified brand',channels:[{platform:'facebook',label:'Offline Facebook'},{platform:'instagram',label:'Offline Instagram'}]},idempotency());
 const channels=await owner.client.ok('GET',route(tenant,workspace,'/channels'));
 const base=route(tenant,workspace,'/social-connections');
 return {...h,owner,tenant,workspace,channels,mock,config,base,advance(ms){time+=ms;},now:()=>time,
 async start(channel=channels.find(c=>c.platform==='facebook'),basis='direct'){const data=await owner.client.ok('POST',base+'/meta/start',{channelId:channel.id,accessBasis:basis});return {...data,state:new URL(data.authorizationUrl).searchParams.get('state')};},
 async callback(start,client=owner.client,query='code=OFFLINE_AUTHORIZATION_CODE'){return client.request('GET',`/api/v1/social-connections/meta/callback?state=${encodeURIComponent(start.state)}&${query}`);},
 async pending(){return (await owner.client.ok('GET',base+'/meta')).pending[0];},
 async connect(channel=channels.find(c=>c.platform==='facebook'),basis='direct'){const started=await this.start(channel,basis);const callback=await this.callback(started);if(callback.status!==302)throw Error(callback.body);const p=await this.pending();if(!p)throw Error(JSON.stringify(await owner.client.ok('GET',base+'/meta')));return owner.client.ok('POST',base+'/meta/select',{pendingId:p.id,candidateId:p.candidates[0].id,channelId:p.channelId,expectedChannelVersion:p.channelVersion});}
 };
}
