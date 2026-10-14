import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationFixture } from './qa-publication-helpers.mjs';

const first = async (h,p) => (await h.jobs(p))[0];
const one = h => ({channelIds:[h.channels[0].id]});

test('publishing: prepared checkpoints resume safely but irreversible checkpoints never replay after a crash',async t=>{
 const h=await publicationFixture(t),w=h.app.ctx.services.publishing.worker;
 for(const stage of ['prepared','processing','ready','publishing']){
  w.heartbeat();const post=await h.approve(await h.post()),[job]=await h.scheduled(post,one(h));h.advance(61000);w.heartbeat();
  let entered,release;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
  h.adapter.setHandler(async input=>{await input.saveProviderState({containerId:'12345',stage});entered();await gate;return {outcome:'published',remoteId:'late-confirmed'};});
  const pending=w.dispatch(w.claim());await ready;
  h.db.prepare('UPDATE publication_jobs SET lease_until=? WHERE id=?').run(new Date(h.now()-1).toISOString(),job.id);
  w.recover();const recovered=await first(h,post);
  assert.equal(recovered.status,stage==='publishing'?'needs_attention':'retry_wait');
  release();await pending;assert.equal((await first(h,post)).status,recovered.status);
  if(stage!=='publishing'){
   h.adapter.setHandler(async input=>{assert.equal(input.providerState.containerId,'12345');assert.equal(input.providerState.stage,stage);await input.saveProviderState({containerId:'12345',stage:'publishing'});return {outcome:'published',remoteId:'resumed-once'};});
   await w.tick();assert.equal((await first(h,post)).status,'published');
  }
 }
});

test('publishing: authority revoked while preparing blocks the irreversible checkpoint',async t=>{
 const h=await publicationFixture(t),w=h.app.ctx.services.publishing.worker,post=await h.approve(await h.post());
 await h.scheduled(post,one(h));let didSend=false;
 h.adapter.setHandler(async input=>{
  await input.saveProviderState({containerId:'12345',stage:'ready'});
  h.db.prepare("UPDATE memberships SET status='inactive' WHERE tenant_id=? AND user_id=?").run(h.tenant.id,h.people.editor.user.id);
  await input.saveProviderState({containerId:'12345',stage:'publishing'});didSend=true;
  return {outcome:'published',remoteId:'forbidden'};
 });
 h.advance(61000);await w.tick();assert.equal(didSend,false);assert.notEqual(h.db.prepare('SELECT status FROM publication_jobs WHERE post_id=?').get(post.id).status,'published');
});

test('publishing: five safe retries are the upper limit and remote payloads stay private',async t=>{
 const h=await publicationFixture(t),w=h.app.ctx.services.publishing.worker,post=await h.approve(await h.post());
 await h.scheduled(post,one(h));h.adapter.setHandler(async input=>{await input.saveProviderState({containerId:'67890',stage:'publishing'});return {outcome:'retry',safeToRetry:true,code:'META_RATE_LIMIT',retryAfterMs:1000,secret:'do-not-store'};});
 h.advance(61000);
 for(let i=0;i<6;i++){await w.tick();h.advance(1001);}
 const job=await first(h,post);assert.equal(job.status,'failed');assert.equal(job.attemptCount,5);assert.equal(job.errorCode,'RETRIES_EXHAUSTED');assert.equal(h.adapter.calls.length,5);
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM publication_attempts WHERE job_id=?').get(job.id).n,5);
 assert.doesNotMatch(JSON.stringify(job),/do-not-store|lease_token|provider_state/);
});

test('publishing: graceful shutdown aborts and waits for direct dispatch without replaying uncertain sends',async t=>{
 const h=await publicationFixture(t),w=h.app.ctx.services.publishing.worker,post=await h.approve(await h.post());
 await h.scheduled(post,one(h));let entered;const began=new Promise(r=>{entered=r;});
 h.adapter.setHandler(async()=>{entered();return new Promise(()=>{});});
 h.advance(61000);w.heartbeat();const pending=w.dispatch(w.claim());await began;await w.stop();await pending;
 assert.equal((await first(h,post)).status,'needs_attention');assert.equal(w.running,false);assert.equal(h.adapter.calls.length,1);
});

test('publishing: changing the displayed destination before enqueue cannot redirect approved content',async t=>{
 const h=await publicationFixture(t),post=await h.approve(await h.post()),channel=h.channels[0];
 const ready=await h.people.editor.client.ok('GET',h.path('/publishing/readiness'));
 const displayed=ready.channels.find(c=>c.channelId===channel.id).connectionVersion;
 h.adapter.connections.get(channel.id).version='destination-rebound-after-confirmation';
 const response=await h.schedule(post,{...one(h),connectionVersions:{[channel.id]:displayed}});
 assert.equal(response.status,409,response.body);assert.equal(response.json.error.code,'CONNECTION_CHANGED');assert.deepEqual(await h.jobs(post),[]);
});

test('publishing: a missed 15-minute window fails visibly without a late provider request',async t=>{
 const h=await publicationFixture(t),w=h.app.ctx.services.publishing.worker,post=await h.approve(await h.post());
 await h.scheduled(post,one(h));h.advance(16*60000+1);await w.tick();
 const job=await first(h,post);assert.equal(job.status,'failed');assert.equal(job.errorCode,'PUBLICATION_EXPIRED');assert.equal(h.adapter.calls.length,0);
 assert.equal((await h.people.editor.client.ok('GET',h.path('/publishing/readiness'))).maxLatenessMinutes,15);
});

test('publishing: crossing the lateness deadline during preparation prevents the irreversible send',async t=>{
 const h=await publicationFixture(t),w=h.app.ctx.services.publishing.worker,post=await h.approve(await h.post());
 await h.scheduled(post,one(h));let sent=false;
 h.adapter.setHandler(async input=>{await input.saveProviderState({containerId:'12345',stage:'ready'});h.advance(60001);await input.saveProviderState({containerId:'12345',stage:'publishing'});sent=true;return {outcome:'published',remoteId:'too-late'};});
 h.advance(15*60000);await w.tick();const job=await first(h,post);
 assert.equal(sent,false);assert.equal(job.status,'failed');assert.equal(job.errorCode,'PUBLICATION_EXPIRED');
});

test('publishing: editing to a new revision cannot bypass an unresolved ambiguous send',async t=>{
 const h=await publicationFixture(t),w=h.app.ctx.services.publishing.worker,post=await h.approve(await h.post());
 await h.scheduled(post,one(h));h.adapter.setHandler(async()=>({outcome:'ambiguous',code:'PROVIDER_AMBIGUOUS'}));h.advance(61000);await w.tick();
 const edited=await h.people.editor.client.ok('PATCH',h.path(`/posts/${post.id}`),{expectedRevision:post.revision,title:'A new title does not resolve an uncertain send'});
 const approved=await h.approve(edited);const response=await h.schedule(approved,one(h));
 assert.equal(response.status,409,response.body);assert.equal(response.json.error.code,'PUBLICATION_EXISTS');assert.equal((await h.jobs(post)).length,1);
});
