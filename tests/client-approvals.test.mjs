import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { publicationFixture } from './qa-publication-helpers.mjs';
import { Client,idempotency,verified } from './qa-helpers.mjs';
import { localOffsetTime } from '../src/client-approvals/service.mjs';

// All links, clients, images and provider adapters are loopback-only fixtures. No external requests.
const endpoint='/api/v1/client-approval';
async function fixture(t){
 const h=await publicationFixture(t),post=await h.approve(await h.post()),anon=new Client(h);
 const body=(overrides={})=>({postId:post.id,expectedRevision:post.revision,channelIds:h.channels.map(c=>c.id),connectionVersions:Object.fromEntries(h.channels.map(c=>[c.id,'qa-connection-v1'])),scheduledAt:new Date(h.now()+3600000).toISOString(),scheduledTimezone:'UTC',expiresInHours:24,...overrides});
 const create=async(overrides={},key=idempotency())=>h.people.editor.client.ok('POST',h.path('/client-approvals'),body(overrides),key);
 const link=await create(),bearer=link.approvalUrl.split('#')[1],headers={authorization:'Bearer '+bearer};
 const preview=()=>anon.ok('GET',endpoint,undefined,{headers});
 const decide=(view,decision='approve',extra={})=>anon.request('POST',endpoint+'/decision',{expectedVersion:view.version,challenge:view.challenge,decision,...extra},{headers});
 return {...h,newPost:h.post,post,anon,body,create,link,bearer,headers,preview,decide};
}

test('client approvals: bearer links are one-time disclosed, hashed, and never saved in idempotency or audit',async t=>{
 const h=await publicationFixture(t),post=await h.approve(await h.post());
 const body={postId:post.id,expectedRevision:post.revision,channelIds:[h.channels[0].id],connectionVersions:{[h.channels[0].id]:'qa-connection-v1'},scheduledAt:new Date(h.now()+3600000).toISOString(),scheduledTimezone:'UTC'};
 const key=idempotency();const first=await h.people.editor.client.ok('POST',h.path('/client-approvals'),body,key);
 assert.match(first.approvalUrl,/^http:\/\/127\.0\.0\.1:8787\/approval\.html#[\w-]{43}$/);
 const raw=first.approvalUrl.split('#')[1],row=h.db.prepare('SELECT * FROM client_approval_requests').get();
 assert.equal(row.token_hash,createHash('sha256').update(raw).digest('hex'));assert.ok(!JSON.stringify(row).includes(raw));
 const again=await h.people.editor.client.ok('POST',h.path('/client-approvals'),body,key);assert.equal(again.id,first.id);assert.equal(again.approvalUrl,null);
 for(const table of ['idempotency_keys','audit_events'])assert.ok(!JSON.stringify(h.db.prepare(`SELECT * FROM ${table}`).all()).includes(raw));
 const list=await h.people.editor.client.ok('GET',h.path('/client-approvals'));assert.ok(!JSON.stringify(list).includes(raw));assert.equal(first.notification.status,'not_configured');
});

test('client approvals: public GET never decides; consent enqueues exact independent approved revision once',async t=>{
 const h=await fixture(t),initial=h.db.prepare('SELECT count(*) n FROM approvals').get().n;
 const shell=await h.anon.request('GET','/approval.html');assert.equal(shell.status,200);
 assert.equal(h.db.prepare('SELECT status FROM client_approval_requests').get().status,'pending');assert.deepEqual(await h.jobs(h.post),[]);
 const view=await h.preview();assert.equal(view.preview.caption,h.post.caption);assert.equal(view.preview.channels.length,2);
 const result=await h.decide(view);assert.equal(result.status,200,result.body);assert.equal(result.data.status,'approved');assert.equal(result.data.scheduling.status,'scheduled');
 const jobs=await h.jobs(h.post);assert.equal(jobs.length,2);for(const job of jobs){assert.equal(job.revision,h.post.revision);assert.equal(job.scheduledAt,h.link.scheduledAt);assert.equal(job.status,'scheduled');}
 assert.equal(h.db.prepare('SELECT count(*) n FROM approvals').get().n,initial);
 assert.equal(h.db.prepare("SELECT actor_id FROM audit_events WHERE action='client_approval.approved'").get().actor_id,null);
 assert.ok(h.db.prepare('SELECT actor_id FROM publication_jobs').all().every(j=>j.actor_id===h.people.editor.user.id));
 assert.equal((await h.decide(view)).status,409);assert.equal((await h.jobs(h.post)).length,2);assert.equal(h.adapter.calls.length,0);
 h.advance(3600001);await h.app.ctx.services.publishing.worker.tick();assert.ok(h.db.prepare('SELECT status,remote_id FROM publication_jobs WHERE post_id=?').all(h.post.id).every(j=>j.status==='published'&&j.remote_id));assert.equal(h.adapter.calls.length,2);
});

test('client approvals: changes require feedback, remain separate, and create no publication',async t=>{
 const h=await fixture(t),view=await h.preview();assert.equal((await h.decide(view,'request_changes')).status,422);
 const result=await h.decide(view,'request_changes',{feedback:'<script>alert(1)</script> Trocar o título'});assert.equal(result.status,200,result.body);assert.equal(result.data.status,'changes_requested');assert.equal(result.data.scheduling.status,'not_requested');assert.equal(result.data.feedback,'<script>alert(1)</script> Trocar o título');assert.deepEqual(await h.jobs(h.post),[]);
 assert.equal(h.db.prepare('SELECT status FROM posts WHERE id=?').get(h.post.id).status,'approved');assert.equal((await h.decide(view)).status,409);
});

test('client approvals: drafts, self-approval bypass, reviewers and unrelated tenants cannot create requests',async t=>{
 const h=await fixture(t),draft=await h.newPost();
 let r=await h.people.editor.client.request('POST',h.path('/client-approvals'),h.body({postId:draft.id,expectedRevision:draft.revision}),idempotency());assert.equal(r.status,409);assert.equal(r.json.error.code,'INTERNAL_APPROVAL_REQUIRED');
 r=await h.people.reviewer.client.request('POST',h.path('/client-approvals'),h.body(),idempotency());assert.equal(r.status,403);
 const outsider=await verified(h,'approval-outsider');r=await outsider.client.request('POST',h.path('/client-approvals'),h.body(),idempotency());assert.equal(r.status,404);
 assert.equal(h.db.prepare('SELECT count(*) n FROM client_approval_requests').get().n,1);
});

test('client approvals: anti-CSRF, Origin, token-bound challenge and single-decision replay checks',async t=>{
 const h=await fixture(t),view=await h.preview(),payload={expectedVersion:view.version,challenge:view.challenge,decision:'approve'};
 let r=await h.anon.request('POST',endpoint+'/decision',payload,{headers:{...h.headers,origin:'https://attacker.invalid'}});assert.equal(r.status,403);
 r=await h.anon.request('POST',endpoint+'/decision',payload,{headers:{...h.headers,'x-csrf-token':'invalid'}});assert.equal(r.status,403);
 r=await h.anon.request('POST',endpoint+'/decision',payload,{headers:{...h.headers,'sec-fetch-site':'cross-site'}});assert.equal(r.status,403);
 r=await h.anon.request('POST',endpoint+'/decision',payload);assert.equal(r.status,404);
 const otherPost=await h.approve(await h.newPost()),second=await h.create({postId:otherPost.id,expectedRevision:otherPost.revision});
 r=await h.anon.request('POST',endpoint+'/decision',payload,{headers:{authorization:'Bearer '+second.approvalUrl.split('#')[1]}});assert.equal(r.status,403);assert.equal(r.json.error.code,'CLIENT_CHALLENGE_INVALID');
 assert.deepEqual(await h.jobs(h.post),[]);assert.equal((await h.decide(view)).status,200);
});

test('client approvals: editing invalidates preview, media access and prior decisions without exposing new content',async t=>{
 const h=await fixture(t),view=await h.preview();
 await h.people.editor.client.ok('PATCH',h.path(`/posts/${h.post.id}`),{expectedRevision:h.post.revision,caption:'New unapproved private caption'},idempotency());
 for(const path of [endpoint,endpoint+'/media']){const r=await h.anon.request('GET',path,undefined,{headers:h.headers});assert.equal(r.status,404);assert.ok(!r.body.includes('New unapproved private caption'));}
 assert.equal((await h.decide(view)).status,404);assert.equal(h.db.prepare('SELECT status FROM client_approval_requests').get().status,'invalidated');assert.deepEqual(await h.jobs(h.post),[]);
});

test('client approvals: unavailable worker preserves consent truthfully; authorized retry retains original schedule',async t=>{
 const h=await fixture(t),view=await h.preview();await h.app.ctx.services.publishing.worker.stop();
 const r=await h.decide(view);assert.equal(r.status,200,r.body);assert.equal(r.data.status,'approved');assert.equal(r.data.scheduling.status,'blocked');assert.equal(r.data.scheduling.code,'WORKER_UNAVAILABLE');assert.deepEqual(await h.jobs(h.post),[]);
 h.app.ctx.services.publishing.worker.start({timer:false});
 const retry=await h.people.owner.client.ok('POST',h.path(`/client-approvals/${h.link.id}/retry-scheduling`),{expectedVersion:r.data.version},idempotency());assert.equal(retry.scheduling.status,'scheduled');assert.equal((await h.jobs(h.post)).length,2);
});

test('client approvals: partial multichannel enqueue rolls back while client consent is retained',async t=>{
 const h=await fixture(t),view=await h.preview();h.adapter.connections.get(h.channels[1].id).version='changed-destination';
 const r=await h.decide(view);assert.equal(r.status,200,r.body);assert.equal(r.data.status,'approved');assert.equal(r.data.scheduling.status,'blocked');assert.equal(r.data.scheduling.code,'CONNECTION_CHANGED');assert.deepEqual(await h.jobs(h.post),[]);
 assert.equal(h.db.prepare("SELECT count(*) n FROM audit_events WHERE action='publication.scheduled'").get().n,0);
});

test('client approvals: revoked internal reviewer cannot be impersonated by external approval',async t=>{
 const h=await fixture(t),view=await h.preview();h.db.prepare("UPDATE memberships SET status='inactive' WHERE tenant_id=? AND user_id=?").run(h.tenant.id,h.people.reviewer.user.id);
 const r=await h.decide(view);assert.equal(r.status,200,r.body);assert.equal(r.data.status,'approved');assert.equal(r.data.scheduling.status,'blocked');assert.equal(r.data.scheduling.code,'AUTHORIZATION_REVOKED');assert.deepEqual(await h.jobs(h.post),[]);
});

test('client approvals: requester access removal immediately fences the link',async t=>{
 const h=await fixture(t),view=await h.preview();h.db.prepare("UPDATE memberships SET status='inactive' WHERE tenant_id=? AND user_id=?").run(h.tenant.id,h.people.editor.user.id);
 assert.equal((await h.decide(view)).status,403);assert.equal((await h.anon.request('GET',endpoint+'/media',undefined,{headers:h.headers})).status,403);assert.deepEqual(await h.jobs(h.post,h.people.owner.client),[]);
});

test('client approvals: expired link or expired challenge never approves or reschedules into the past',async t=>{
 const h=await fixture(t),view=await h.preview();h.advance(16*60000);await h.anon.bootstrap();let r=await h.decide(view);assert.equal(r.status,403);assert.equal(r.json.error.code,'CLIENT_CHALLENGE_INVALID');
 const fresh=await h.preview();h.advance(45*60000);await h.anon.bootstrap();r=await h.decide(fresh);assert.equal(r.status,404);assert.equal(h.db.prepare('SELECT count(*) n FROM publication_jobs WHERE post_id=?').get(h.post.id).n,0);
});

test('client approvals: revocation cancels unsent associated jobs and denies old bearer access',async t=>{
 const h=await fixture(t),view=await h.preview(),decision=await h.decide(view);
 const revoked=await h.people.owner.client.ok('POST',h.path(`/client-approvals/${h.link.id}/revoke`),{expectedVersion:decision.data.version},idempotency());assert.equal(revoked.status,'revoked');assert.equal(revoked.scheduling.status,'cancelled');assert.ok((await h.jobs(h.post)).every(j=>j.status==='cancelled'));
 assert.equal((await h.anon.request('GET',endpoint,undefined,{headers:h.headers})).status,404);
});

test('client approvals: public media is exact-revision scoped, no-store, bearer-header gated and integrity checked',async t=>{
 const h=await fixture(t);let r=await h.anon.request('GET',endpoint+'/media',undefined,{headers:h.headers});assert.equal(r.status,200);assert.equal(r.headers['content-type'],'image/jpeg');assert.match(r.headers['cache-control'],/no-store/);assert.match(r.headers['content-security-policy'],/sandbox/);assert.equal(r.headers['x-content-type-options'],'nosniff');
 r=await h.anon.request('GET',endpoint+'/media');assert.equal(r.status,404);
 r=await h.anon.request('GET',endpoint+'/media?mid=unrelated',undefined,{headers:h.headers});assert.equal(r.status,422);
 h.db.prepare('UPDATE media_blobs SET bytes=? WHERE media_id=?').run(Buffer.from('corrupted'),h.media.id);r=await h.anon.request('GET',endpoint+'/media',undefined,{headers:h.headers});assert.equal(r.status,409);
});

test('client approvals: changing an editorial planned time invalidates approved consent and cancels its queue',async t=>{
 const h=await fixture(t),view=await h.preview();await h.decide(view);
 await h.people.editor.client.ok('POST',h.path(`/posts/${h.post.id}/transitions`),{action:'plan',expectedRevision:h.post.revision,scheduledAt:new Date(h.now()+7200000).toISOString(),scheduledTimezone:'UTC'},idempotency());
 assert.equal(h.db.prepare('SELECT status FROM client_approval_requests').get().status,'invalidated');assert.ok((await h.jobs(h.post)).every(j=>j.status==='blocked'));
});

test('client approvals: non-UTC exact instant, milliseconds and daylight-saving offsets are preserved',async t=>{
 const h=await publicationFixture(t),post=await h.approve(await h.post()),zone='America/Sao_Paulo',iso=new Date(h.now()+3600000).toISOString();
 const created=await h.people.editor.client.ok('POST',h.path('/client-approvals'),{postId:post.id,expectedRevision:post.revision,channelIds:[h.channels[0].id],connectionVersions:{[h.channels[0].id]:'qa-connection-v1'},scheduledAt:localOffsetTime(iso,zone),scheduledTimezone:zone},idempotency());
 const anon=new Client(h),headers={authorization:'Bearer '+created.approvalUrl.split('#')[1]},view=await anon.ok('GET',endpoint,undefined,{headers});
 const result=await anon.ok('POST',endpoint+'/decision',{expectedVersion:view.version,challenge:view.challenge,decision:'approve'},{headers});assert.equal(result.scheduling.status,'scheduled');assert.equal((await h.jobs(post))[0].scheduledAt,iso);
 assert.equal(localOffsetTime('2026-11-01T05:30:00.123Z','America/New_York'),'2026-11-01T01:30:00.123-04:00');assert.equal(localOffsetTime('2026-11-01T06:30:00.123Z','America/New_York'),'2026-11-01T01:30:00.123-05:00');
});

test('client approvals: notification seam accepts only exact current token and active authorized request',async t=>{
 const h=await fixture(t),service=h.app.ctx.services.clientApprovals,req={params:{tid:h.tenant.id,wid:h.workspace.id,aid:h.link.id},user:h.people.owner.user};
 assert.equal(service.assertNotification(req,h.bearer).url,h.link.approvalUrl);assert.throws(()=>service.assertNotification(req,randomUUID()));
 await h.decide(await h.preview());assert.throws(()=>service.assertNotification(req,h.bearer));assert.equal(h.adapter.calls.length,0);
});

test('client approvals: existing send is rejected before a client is offered a misleading approval gate',async t=>{
 const h=await publicationFixture(t),post=await h.approve(await h.post());await h.scheduled(post);
 const r=await h.people.editor.client.request('POST',h.path('/client-approvals'),{postId:post.id,expectedRevision:post.revision,channelIds:h.channels.map(c=>c.id),connectionVersions:Object.fromEntries(h.channels.map(c=>[c.id,'qa-connection-v1'])),scheduledAt:new Date(h.now()+3600000).toISOString(),scheduledTimezone:'UTC'},idempotency());
 assert.equal(r.status,409,r.body);assert.equal(r.json.error.code,'PUBLICATION_EXISTS');assert.equal(h.db.prepare('SELECT count(*) n FROM client_approval_requests').get().n,0);assert.equal(h.adapter.calls.length,0);
});

test('client approvals: simultaneous approve and request-changes serialize to one irrevocable decision',async t=>{
 const h=await fixture(t),first=await h.preview(),secondClient=new Client(h),second=await secondClient.ok('GET',endpoint,undefined,{headers:h.headers});
 const outcomes=await Promise.all([h.decide(first),secondClient.request('POST',endpoint+'/decision',{expectedVersion:second.version,challenge:second.challenge,decision:'request_changes',feedback:'Trocar a arte'},{headers:h.headers})]);
 assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
 const state=h.db.prepare('SELECT status,version FROM client_approval_requests WHERE id=?').get(h.link.id);assert.equal(state.version,2);assert.equal(h.db.prepare("SELECT count(*) n FROM audit_events WHERE target_id=? AND action IN ('client_approval.approved','client_approval.changes_requested')").get(h.link.id).n,1);
 const jobs=await h.jobs(h.post);assert.equal(jobs.length,state.status==='approved'?2:0);assert.equal(h.db.prepare('SELECT count(*) n FROM client_approval_challenges').get().n,0);
});

for(const outcome of ['published','needs_attention'])test(`client approvals: revoking after ${outcome} preserves real send outcomes instead of claiming cancellation`,async t=>{
 const h=await fixture(t),decision=await h.decide(await h.preview());
 if(outcome==='needs_attention')h.adapter.setHandler(async()=>({outcome:'ambiguous',code:'PROVIDER_AMBIGUOUS'}));
 h.advance(3600001);await h.app.ctx.services.publishing.worker.tick();
 const before=h.db.prepare('SELECT status FROM publication_jobs WHERE post_id=?').all(h.post.id);assert.ok(before.every(j=>j.status===outcome));
 await h.people.owner.client.login(h.people.owner.email);
 const result=await h.people.owner.client.ok('POST',h.path(`/client-approvals/${h.link.id}/revoke`),{expectedVersion:decision.data.version},idempotency());
 assert.equal(result.status,'revoked');assert.equal(result.scheduling.status,outcome==='published'?'published':'attention');assert.notEqual(h.db.prepare('SELECT scheduling_status FROM client_approval_requests WHERE id=?').get(h.link.id).scheduling_status,'cancelled');assert.ok(result.scheduling.publications.every(j=>j.status===outcome));assert.match(result.scheduling.message,outcome==='published'?/confirmadas e permanecem/:/incerto.*conferência/);assert.doesNotMatch(result.scheduling.message,/Todos os envios.*cancelados/);
});
