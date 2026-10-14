import { randomUUID } from 'node:crypto';
import { oauthFixture,OAUTH_FIXTURE } from './social-connections-helpers.mjs';
import { initializeSocialMetrics } from '../src/social-metrics/index.mjs';
import { idempotency,route } from './qa-helpers.mjs';
export function metricsTransport(){
 const calls=[];let intercept=null,followers=51;
 const respond=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});const u=new URL(url),path=u.pathname.slice('/v26.0/'.length);
  if(u.origin!=='https://graph.facebook.com'||!u.pathname.startsWith('/v26.0/')||options.method!=='GET')throw new Error('OFFLINE_METRICS_UNEXPECTED_REQUEST');
  const override=await intercept?.(u,options);if(override!==undefined)return override;
  if(path===`${OAUTH_FIXTURE.pageId}/published_posts`||path===`${OAUTH_FIXTURE.igId}/media`)return respond({data:[]});
  if(path==='me')return respond({id:OAUTH_FIXTURE.pageId,instagram_business_account:{id:OAUTH_FIXTURE.igId}});
  if([OAUTH_FIXTURE.pageId,OAUTH_FIXTURE.igId].includes(path))return respond({id:path,followers_count:followers});
  if(path===`${OAUTH_FIXTURE.pageId}_60006`)return respond({id:path,from:{id:OAUTH_FIXTURE.pageId},likes:{summary:{total_count:0}},comments:{summary:{total_count:3}},reactions:{summary:{total_count:4}},shares:{count:2},permalink_url:`https://www.facebook.com/${OAUTH_FIXTURE.pageId}/posts/60006?access_token=SHOULD_NOT_LEAK`});
  if(path==='80008')return respond({id:path,owner:{id:OAUTH_FIXTURE.igId},like_count:7,comments_count:2,permalink:'https://www.instagram.com/p/TEST_PUBLIC_ONLY/?secret=NO_LEAK'});
  throw Error('OFFLINE_METRICS_UNKNOWN_PATH');
 };
 return {calls,respond,fetchImpl,setIntercept(fn){intercept=fn;},setFollowers(value){followers=value;}};
}
export async function metricsFixture(t,opts={}){
 const h=await oauthFixture(t),transport=metricsTransport();await h.app.ctx.services.socialMetrics?.stop();
 const service=initializeSocialMetrics(h.app.ctx,{socialMetrics:{enabled:true,fetchImpl:transport.fetchImpl,autoStart:false,...opts}});
 t.after(()=>service.stop());
 const configure=(body={})=>{
  const session=h.db.prepare('SELECT * FROM sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get(h.owner.user.id);
  return service.configure({user:h.owner.user,session,tenant:{id:h.tenant.id},params:{tid:h.tenant.id,wid:h.workspace.id},method:'POST',id:randomUUID(),body:{enabled:true,cadenceMinutes:15,expectedVersion:service.settings(h.tenant.id,h.workspace.id).version,...body}});
 };
 return {...h,service,transport,configure,summary:()=>service.summary(h.tenant.id,h.workspace.id),
 async published(channel=h.channels[0]){
  const post=await h.owner.client.ok('POST',route(h.tenant,h.workspace,'/posts'),{title:'PRIVATE_INTERNAL_TITLE',caption:'PRIVATE_INTERNAL_CAPTION',format:'text',channelIds:[channel.id]},idempotency());
  const id=randomUUID(),at=new Date(h.now()).toISOString(),remote=channel.platform==='facebook'?`${OAUTH_FIXTURE.pageId}_60006`:'80008';
  h.db.prepare(`INSERT INTO publication_jobs(tenant_id,workspace_id,id,post_id,channel_id,platform,revision,actor_id,connection_version,status,scheduled_at,scheduled_timezone,next_attempt_at,expires_at,remote_id,published_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'published',?,'UTC',?,?,?,?,?,?)`).run(h.tenant.id,h.workspace.id,id,post.id,channel.id,channel.platform,post.revision,h.owner.user.id,'synthetic-publication-only',at,at,at,remote,at,at,at);
  return {id,post,channel,remote};
 }};
}
