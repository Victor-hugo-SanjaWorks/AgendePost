import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFixture } from './social-metrics-helpers.mjs';
import { OAUTH_FIXTURE } from './social-connections-helpers.mjs';
import { initializeSocialMetrics } from '../src/social-metrics/index.mjs';
import { safeMetrics,safePermalink,numeric } from '../src/social-metrics/model.mjs';
const metric=(a,k)=>a.metrics.find(m=>m.key===k);

test('metrics require both gates; DB-only reads never resolve credentials or call provider',async t=>{
 const f=await metricsFixture(t);await f.connect();
 assert.equal(f.summary().settings.version,1);await f.service.tick();assert.equal(f.transport.calls.length,0);
 f.configure();await f.service.stop();const off=initializeSocialMetrics(f.app.ctx,{});
 const resolve=f.app.ctx.services.socialConnections.resolveBinding;f.app.ctx.services.socialConnections.resolveBinding=()=>{throw Error('READ_MUST_NOT_RESOLVE_CREDENTIALS');};
 assert.equal(off.summary(f.tenant.id,f.workspace.id).collection.status,'disabled');await off.tick();assert.equal(f.transport.calls.length,0);
 f.app.ctx.services.socialConnections.resolveBinding=resolve;
 assert.throws(()=>initializeSocialMetrics({...f.app.ctx,config:{...f.app.ctx.config,mode:'development'}},{socialMetrics:{enabled:true,fetchImpl:f.transport.fetchImpl}}),/TEST_OPTIONS_FORBIDDEN/);
});
test('actual encrypted resolver and GET adapter persist truthful numeric snapshots for each account and publication',async t=>{
 const f=await metricsFixture(t);for(const c of f.channels){await f.connect(c);await f.published(c);}f.configure();
 const result=await f.service.tick();assert.equal(result.processed,2);const view=f.summary();assert.equal(view.accounts.length,2);
 for(const a of view.accounts){assert.equal(metric(a,'followers').value,51);assert.equal(metric(a,'reach').value,null);assert.equal(metric(a,'followers').period,'snapshot');assert.equal(a.status,'partial');assert.equal(a.posts.length,1);assert.ok(a.lastSyncedAt);}
 const fb=view.accounts.find(a=>a.platform==='facebook'),ig=view.accounts.find(a=>a.platform==='instagram');assert.equal(metric(fb.posts[0],'likes').value,0);assert.equal(metric(fb.posts[0],'reactions').value,4);assert.equal(metric(ig.posts[0],'likes').value,7);assert.equal(metric(ig.posts[0],'shares').value,null);
 assert.equal(fb.posts[0].permalink,`https://www.facebook.com/${OAUTH_FIXTURE.pageId}/posts/60006`);assert.equal(ig.posts[0].permalink,'https://www.instagram.com/p/TEST_PUBLIC_ONLY/');
 const serialized=JSON.stringify(view);assert.doesNotMatch(serialized,/PRIVATE_INTERNAL|SYNTHETIC_.*TOKEN|access_token|appsecret|encrypted|authorization_version|permissions|page_tasks|connected_by|NO_LEAK/);
 assert.ok(f.transport.calls.every(c=>c.options.method==='GET'&&new Headers(c.options.headers).get('authorization')===`Bearer ${OAUTH_FIXTURE.pageToken}`&&!c.url.includes(OAUTH_FIXTURE.pageToken)));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_accounts').get().n,2);const before=f.transport.calls.length;f.summary();await f.service.tick();assert.equal(f.transport.calls.length,before);
 f.transport.setFollowers(52);f.advance(15*60000);await f.service.tick();assert.equal(metric(f.summary().accounts[0],'followers').value,52);
});
test('missing counts remain null and cannot become fabricated zeroes or accept malicious response data',async t=>{
 const f=await metricsFixture(t);await f.connect();f.configure();f.transport.setFollowers('0');await f.service.tick();const m=metric(f.summary().accounts.find(a=>a.platform==='facebook'),'followers');assert.equal(m.value,null);assert.equal(m.state,'unavailable');
 for(const n of ['0',NaN,-1,Infinity,Number.MAX_SAFE_INTEGER+1,{},true])assert.equal(numeric(n),null);assert.equal(numeric(0),0);
 assert.equal(safePermalink('https://www.instagram.com.evil.test/p/test/','instagram'),null);assert.equal(safePermalink('https://user:password@www.instagram.com/p/test/','instagram'),null);
 const sanitized=safeMetrics([{key:'followers',value:123,source:'SECRET TOKEN',period:'made-up',observedAt:'2026-10-14T00:00:00.000Z',state:'available',code:'<raw-provider-error>'}],'account');assert.equal(sanitized[0].source,null);assert.equal(sanitized[0].period,null);assert.doesNotMatch(JSON.stringify(sanitized),/SECRET|raw-provider/);
});
test('brand opt-in enforces owner authority, optimistic version, cadence and recent authentication',async t=>{
 const f=await metricsFixture(t);assert.throws(()=>f.configure({cadenceMinutes:1}),e=>e.statusCode===422);assert.throws(()=>f.configure({expectedVersion:2}),e=>e.statusCode===409);
 f.db.prepare("UPDATE memberships SET role='admin' WHERE tenant_id=? AND user_id=?").run(f.tenant.id,f.owner.user.id);assert.throws(()=>f.configure(),e=>e.statusCode===403);f.db.prepare("UPDATE memberships SET role='owner' WHERE tenant_id=? AND user_id=?").run(f.tenant.id,f.owner.user.id);
 const configured=f.configure();assert.equal(configured.version,2);assert.equal(configured.enabled,true);assert.throws(()=>f.configure({expectedVersion:1}),e=>e.statusCode===409);
 f.advance(f.app.ctx.config.authRecentMs+1);assert.throws(()=>f.configure(),e=>e.code==='REAUTH_REQUIRED');
});
test('unsupported LinkedIn is explicit and wrong tenant summaries cannot return another brand',async t=>{
 const f=await metricsFixture(t),at=new Date(f.now()).toISOString();f.db.prepare("INSERT INTO channels(tenant_id,workspace_id,id,platform,label,created_at,updated_at) VALUES(?,?,?,'linkedin','LinkedIn test',?,?)").run(f.tenant.id,f.workspace.id,'linkedin-test',at,at);
 const li=f.summary().accounts.find(a=>a.platform==='linkedin');assert.equal(li.status,'unsupported');assert.equal(li.code,'METRICS_LINKEDIN_UNSUPPORTED');assert.ok(li.metrics.every(m=>m.value===null));
 assert.throws(()=>f.service.summary('other-tenant',f.workspace.id),e=>e.statusCode===404);assert.equal(f.transport.calls.length,0);
});

test('post rotation is bounded, excludes old history, and keeps snapshot time distinct from response time',async t=>{
 const f=await metricsFixture(t,{maxPosts:1}),fb=f.channels.find(c=>c.platform==='facebook');await f.connect(fb);
 for(let i=0;i<3;i++)await f.published(fb);f.configure();await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_posts').get().n,1);
 f.advance(15*60000);await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_posts').get().n,2);
 const observed=f.summary().lastSyncedAt,count=f.transport.calls.length;f.advance(31*60000);const view=f.summary();assert.equal(view.stale,true);assert.notEqual(view.generatedAt,observed);assert.equal(view.lastSyncedAt,observed);assert.equal(f.transport.calls.length,count);
 f.db.prepare('UPDATE publication_jobs SET published_at=? WHERE id NOT IN (SELECT publication_id FROM social_metrics_posts)').run(new Date(f.now()-91*86400000).toISOString());assert.equal(f.summary().accounts.find(a=>a.platform==='facebook').posts.find(p=>p.observedAt===null).code,'METRICS_HISTORY_WINDOW');
});
test('an expired persisted worker lease is reclaimed and service lifecycle is idempotent',async t=>{
 const f=await metricsFixture(t);await f.connect();f.configure();await f.service.tick();f.advance(15*60000);
 f.db.prepare("UPDATE social_metrics_sync SET status='syncing',lease_token='dead-worker',lease_until=?").run(new Date(f.now()+1000).toISOString());const calls=f.transport.calls.length;
 await f.service.tick();assert.equal(f.transport.calls.length,calls);f.advance(1001);await f.service.tick();assert.equal(f.transport.calls.length,calls+3);
 assert.equal(f.service.start().running,true);assert.equal(f.service.start().running,true);assert.equal((await f.service.stop()).running,false);assert.equal((await f.service.stop()).running,false);
});
