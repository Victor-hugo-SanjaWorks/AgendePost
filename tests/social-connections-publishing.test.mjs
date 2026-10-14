import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createMetaPublishingAdapter,META_API_VERSION } from '../src/publishing/providers/meta.mjs';
import { publicationFixture } from './qa-publication-helpers.mjs';
import { offlineOAuth,OAUTH_ORIGIN,OAUTH_FIXTURE } from './social-connections-helpers.mjs';
const response=data=>new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
async function integrated(t){
 let f;const oauth=offlineOAuth(()=>f?.now()??Date.now());
 f=await publicationFixture(t,{canonicalOrigin:OAUTH_ORIGIN,metaOAuthConfig:{enabled:true,apiVersion:META_API_VERSION,appId:OAUTH_FIXTURE.appId,appSecret:OAUTH_FIXTURE.appSecret,redirectUri:OAUTH_ORIGIN+'/api/v1/social-connections/meta/callback',encryptionKey:Buffer.alloc(32,7)},metaOAuthFetch:oauth.fetchImpl});
 const row=f.db.prepare('SELECT m.*,b.bytes FROM media m JOIN media_blobs b ON b.tenant_id=m.tenant_id AND b.workspace_id=m.workspace_id AND b.media_id=m.id WHERE m.id=?').get(f.media.id),bytes=Buffer.from(row.bytes),calls=[];
 let assetHook=null,providerHook=null;
 const actual=createMetaPublishingAdapter({enabled:true,apiVersion:META_API_VERSION,requestTimeoutMs:1000,assetHosts:['assets.example.com'],connections:[],assets:[{tenantId:f.tenant.id,workspaceId:f.workspace.id,digest:row.digest,url:`https://assets.example.com/${row.digest}.jpg`,expiresAt:new Date(f.now()+86400000).toISOString()}]},
 {clock:f.now,resolveConnection:f.app.ctx.services.socialConnections.resolveBinding,onConnectionRevoked:f.app.ctx.services.socialConnections.revokeBinding,
 assetFetchImpl:async()=>{await assetHook?.();return new Response(bytes,{headers:{'content-type':'image/jpeg'}});},
 fetchImpl:async(url,options)=>{const u=new URL(url);calls.push({url,options});const alternate=await providerHook?.(u,options);if(alternate)return alternate;const path=u.pathname;
 if(path.endsWith('/photos'))return response({id:'50005'});if(path.endsWith('/feed'))return response({id:`${OAUTH_FIXTURE.pageId}_60006`});if(path.endsWith('/media'))return response({id:'70007'});if(path.endsWith('/media_publish'))return response({id:'80008'});if(path.endsWith('/70007'))return response({status_code:'FINISHED'});throw Error('UNEXPECTED_OFFLINE_GRAPH_CALL');}});
 for(const method of ['readiness','validate','publish','reconcile'])f.adapter[method]=actual[method];
 const base=f.path('/social-connections'),client=f.people.owner.client;
 async function connect(channel){const started=await client.ok('POST',base+'/meta/start',{channelId:channel.id,accessBasis:'direct'}),state=new URL(started.authorizationUrl).searchParams.get('state');const cb=await client.request('GET',`/api/v1/social-connections/meta/callback?state=${state}&code=OFFLINE_INTEGRATION_CODE`);assert.equal(cb.status,302,cb.body);const pending=(await client.ok('GET',base+'/meta')).pending.find(p=>p.channelId===channel.id);assert.ok(pending);return client.ok('POST',base+'/meta/select',{pendingId:pending.id,candidateId:pending.candidates[0].id,channelId:channel.id,expectedChannelVersion:pending.channelVersion});}
 return {...f,actual,oauth,calls,base,client,connect,setAssetHook(fn){assetHook=fn;},setProviderHook(fn){providerHook=fn;}};
}
test('full actual OAuth HTTP exchange and verified FB/IG binding → scheduler → actual Meta HTTP adapter',async t=>{
 const f=await integrated(t);for(const c of f.channels)await f.connect(c);
 const post=await f.approve(await f.post({caption:'Exact OAuth-approved caption 🇧🇷\nPreserved.'}));const jobs=await f.scheduled(post);assert.equal(jobs.length,2);f.advance(60001);await f.app.ctx.services.publishing.worker.tick();
 const stored=await f.jobs(post);assert.equal(stored.filter(j=>j.status==='published').length,2);assert.deepEqual(stored.map(j=>j.remoteId).sort(),[`${OAUTH_FIXTURE.pageId}_60006`,'80008'].sort());
 const mutations=f.calls.filter(c=>c.options.method==='POST');assert.equal(mutations.length,4);assert.ok(mutations.every(c=>new Headers(c.options.headers).get('authorization')===`Bearer ${OAUTH_FIXTURE.pageToken}`));
 for(const c of mutations){const params=new URLSearchParams(c.options.body);assert.equal(params.get('appsecret_proof'),createHmac('sha256',OAUTH_FIXTURE.appSecret).update(OAUTH_FIXTURE.pageToken).digest('hex'));if(new URL(c.url).pathname.endsWith('/media'))assert.equal(params.get('caption'),post.caption);if(new URL(c.url).pathname.endsWith('/feed'))assert.equal(params.get('message'),post.caption);}
 assert.ok(!JSON.stringify(stored).includes(OAUTH_FIXTURE.pageToken));
});
test('disconnect and rebind immediately fence scheduled jobs and never fallback to stale credentials',async t=>{
 const f=await integrated(t),fb=f.channels.find(c=>c.platform==='facebook'),connection=await f.connect(fb);const post=await f.approve(await f.post()),[job]=await f.scheduled(post,{channelIds:[fb.id]});
 await f.client.ok('POST',`${f.base}/${connection.id}/disconnect`,{expectedVersion:connection.version});assert.equal(f.db.prepare('SELECT status FROM publication_jobs WHERE id=?').get(job.id).status,'blocked');f.advance(60001);await f.app.ctx.services.publishing.worker.tick();assert.equal(f.calls.length,0);
 const reconnected=await f.connect(fb);const second=await f.approve(await f.post());const [secondJob]=await f.scheduled(second,{channelIds:[fb.id]});const before=f.adapter.readiness({tenantId:f.tenant.id,workspaceId:f.workspace.id,channelId:fb.id,platform:'facebook',now:new Date(f.now()).toISOString()}).connectionVersion;
 await f.connect(fb);assert.equal(f.db.prepare('SELECT status FROM publication_jobs WHERE id=?').get(secondJob.id).status,'blocked');const after=f.adapter.readiness({tenantId:f.tenant.id,workspaceId:f.workspace.id,channelId:fb.id,platform:'facebook',now:new Date(f.now()).toISOString()}).connectionVersion;assert.notEqual(before,after);
 f.advance(60001);await f.app.ctx.services.publishing.worker.tick();assert.equal(f.calls.length,0);assert.ok(reconnected.version>connection.version);
});
test('disconnect during async media verification prevents any stale outbound Meta write',async t=>{
 const f=await integrated(t),fb=f.channels.find(c=>c.platform==='facebook'),connection=await f.connect(fb),post=await f.approve(await f.post());await f.scheduled(post,{channelIds:[fb.id]});f.advance(60001);
 let resume,entered;const arrived=new Promise(resolve=>entered=resolve),wait=new Promise(resolve=>resume=resolve);f.setAssetHook(async()=>{entered();await wait;});const tick=f.app.ctx.services.publishing.worker.tick();await arrived;
 await f.client.ok('POST',`${f.base}/${connection.id}/disconnect`,{expectedVersion:connection.version});resume();await tick;assert.equal(f.calls.length,0);assert.notEqual((await f.jobs(post))[0].status,'published');
});
test('stale provider revocation cannot invalidate a newly reconnected OAuth binding',async t=>{
 const f=await integrated(t),fb=f.channels.find(c=>c.platform==='facebook');await f.connect(fb);const input={tenantId:f.tenant.id,workspaceId:f.workspace.id,channelId:fb.id,platform:'facebook'},old=f.app.ctx.services.socialConnections.resolveBinding(input);await f.connect(fb);f.app.ctx.services.socialConnections.revokeBinding({...input,connectionVersion:old.connectionVersion});assert.ok(f.app.ctx.services.socialConnections.resolveBinding(input));assert.notEqual(f.app.ctx.services.socialConnections.resolveBinding(input).connectionVersion,old.connectionVersion);
});
