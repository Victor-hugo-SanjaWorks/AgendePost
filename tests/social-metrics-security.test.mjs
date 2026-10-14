import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFixture } from './social-metrics-helpers.mjs';
import { OAUTH_FIXTURE } from './social-connections-helpers.mjs';
import { initializeSocialMetrics } from '../src/social-metrics/index.mjs';
const metric=(a,k)=>a.metrics.find(m=>m.key===k);
const facebook=f=>f.summary().accounts.find(a=>a.platform==='facebook');

test('disconnect during a request fences the result and prevents any subsequent credential use',async t=>{
 const f=await metricsFixture(t),connection=await f.connect();f.configure();
 let entered,release;const arrived=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 f.transport.setIntercept(async u=>{if(u.pathname.endsWith('/me')){entered();await pending;}});
 const tick=f.service.tick();await arrived;
 await f.owner.client.ok('POST',`${f.base}/${connection.id}/disconnect`,{expectedVersion:connection.version});release();await tick;
 assert.equal(f.transport.calls.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_accounts').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_sync').get().n,0);assert.equal(facebook(f).status,'disconnected');
});
test('disable during request rejects asynchronous result and reconnect clears all prior snapshot records',async t=>{
 const f=await metricsFixture(t);await f.connect();f.configure();
 let entered,release;const arrived=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 f.transport.setIntercept(async u=>{if(u.pathname.endsWith('/'+OAUTH_FIXTURE.pageId)){entered();await pending;}});
 const work=f.service.tick();await arrived;f.configure({enabled:false});release();await work;assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_accounts').get().n,0);
 f.transport.setIntercept(null);f.configure();await f.service.tick();assert.equal(metric(facebook(f),'followers').value,51);
 await f.connect();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_accounts').get().n,0);assert.equal(metric(facebook(f),'followers').value,null);
});
test('membership, scope, tenant and channel authority are rechecked before each provider GET',async t=>{
 for(const change of [f=>f.db.prepare("UPDATE memberships SET status='inactive' WHERE tenant_id=? AND user_id=?").run(f.tenant.id,f.owner.user.id),f=>f.db.prepare("UPDATE social_connections SET permissions='[]'").run(),f=>f.db.prepare("UPDATE tenants SET status='suspended' WHERE id=?").run(f.tenant.id),f=>f.db.prepare('UPDATE channels SET version=version+1 WHERE id=?').run(f.channels.find(c=>c.platform==='facebook').id)]){
  const f=await metricsFixture(t);await f.connect();f.configure();let changed=false;f.transport.setIntercept(u=>{if(!changed&&u.pathname.endsWith('/me')){changed=true;change(f);}});
  await f.service.tick();assert.equal(f.transport.calls.length,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_accounts').get().n,0);
 }
});
test('rate limits honor Retry-After, persist backoff through service restart, preserve old timestamps and redact errors',async t=>{
 const f=await metricsFixture(t);await f.connect();f.configure();await f.service.tick();const first=facebook(f).observedAt;
 f.advance(15*60000);f.transport.setIntercept(()=>f.transport.respond({error:{code:4,message:OAUTH_FIXTURE.pageToken+' PRIVATE_PROVIDER_ERROR'}},429,{'retry-after':'3600'}));await f.service.tick();
 let state=f.db.prepare('SELECT * FROM social_metrics_sync').get();assert.equal(state.failure_count,1);assert.equal(state.next_run_at,new Date(f.now()+3600000).toISOString());assert.equal(facebook(f).observedAt,first);assert.equal(facebook(f).status,'error');assert.equal(metric(facebook(f),'followers').state,'stale');assert.doesNotMatch(JSON.stringify(f.summary()),/SYNTHETIC_PAGE_TOKEN|PRIVATE_PROVIDER_ERROR/);
 const before=f.transport.calls.length;await f.service.stop();const again=initializeSocialMetrics(f.app.ctx,{socialMetrics:{enabled:true,fetchImpl:f.transport.fetchImpl,autoStart:false}});t.after(()=>again.stop());await again.tick();assert.equal(f.transport.calls.length,before);
});
test('remote token revocation hides persisted snapshots and no provider errors or credentials enter tables',async t=>{
 const f=await metricsFixture(t);await f.connect();await f.published(f.channels.find(c=>c.platform==='facebook'));f.configure();await f.service.tick();f.advance(15*60000);
 f.transport.setIntercept(()=>f.transport.respond({error:{code:190,message:'secret='+OAUTH_FIXTURE.pageToken}},400));await f.service.tick();const a=facebook(f);assert.equal(a.status,'disconnected');assert.ok(a.metrics.every(m=>m.value===null));assert.ok(a.posts.every(p=>p.metrics.every(m=>m.value===null)&&p.permalink===null));
 for(const table of ['social_metrics_sync','social_metrics_accounts','social_metrics_posts','social_metrics_settings'])assert.doesNotMatch(JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()),/SYNTHETIC_PAGE_TOKEN|secret=|accessToken|appSecret/);
});
test('bounded timeout, stop and shared persistent lease prevent hangs and duplicate fetches',async t=>{
 const f=await metricsFixture(t,{timeoutMs:20});await f.connect();f.configure();f.transport.setIntercept(()=>new Promise(()=>{}));await f.service.tick();assert.equal(facebook(f).code,'METRICS_TIMEOUT');assert.equal(f.transport.calls.length,1);
 f.advance(15*60000);f.transport.setIntercept(null);await f.service.tick();assert.equal(metric(facebook(f),'followers').value,51);
 f.advance(15*60000);let entered,release;const arrived=new Promise(r=>entered=r),pending=new Promise(r=>release=r);f.transport.setIntercept(async()=>{entered();await pending;});
 const again=initializeSocialMetrics(f.app.ctx,{socialMetrics:{enabled:true,fetchImpl:f.transport.fetchImpl,autoStart:false}});t.after(()=>again.stop());const first=f.service.tick();await arrived;const count=f.transport.calls.length;await again.tick();assert.equal(f.transport.calls.length,count);const stop=f.service.stop();release();await Promise.all([first,stop]);
});
test('wrong account and post ownership fail closed rather than leaking another account metrics',async t=>{
 const f=await metricsFixture(t);await f.connect();f.configure();f.transport.setIntercept(u=>u.pathname.endsWith('/me')?f.transport.respond({id:'99999999'}):undefined);await f.service.tick();assert.equal(facebook(f).code,'METRICS_IDENTITY_MISMATCH');assert.equal(metric(facebook(f),'followers').value,null);
 f.advance(15*60000);f.transport.setIntercept(null);await f.published(f.channels.find(c=>c.platform==='facebook'));f.transport.setIntercept(u=>u.pathname.endsWith('_60006')?f.transport.respond({id:`${OAUTH_FIXTURE.pageId}_60006`,from:{id:'99999999'},likes:{summary:{total_count:9999}}}):undefined);await f.service.tick();assert.equal(facebook(f).posts[0].code,'METRICS_IDENTITY_MISMATCH');assert.equal(metric(facebook(f).posts[0],'likes').value,null);
});
