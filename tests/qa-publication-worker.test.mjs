import test from 'node:test';
import assert from 'node:assert/strict';
import { idempotency } from './qa-helpers.mjs';
import { publicationFixture } from './qa-publication-helpers.mjs';

const worker = h => h.app.ctx.services.publishing.worker;
const one = h => ({ channelIds: [h.channels[0].id] });
const due = async h => { h.advance(61_000); await worker(h).tick(); };
const job = async (h, post) => (await h.jobs(post))[0];

test('QA publication worker: real durable queue dispatches approved bytes exactly once, per target', async t => {
  const h = await publicationFixture(t), post = await h.approve(await h.post());
  const scheduled = await h.scheduled(post);
  await worker(h).tick(); assert.equal(h.adapter.calls.length, 0, 'Future work must not be sent early');
  h.adapter.setHandler(async input => input.platform === 'instagram' ? { outcome: 'published', remoteId: 'qa-instagram-actual-response' } : { outcome: 'failed', code: 'META_PERMISSION_DENIED', message: 'secret-provider-payload-must-not-escape' });
  await due(h);
  const jobs = await h.jobs(post);
  assert.deepEqual(jobs.map(j => j.status).sort(), ['failed', 'published']);
  const published = jobs.find(j => j.status === 'published');
  assert.equal(published.remoteId, 'qa-instagram-actual-response'); assert.ok(published.publishedAt);
  assert.equal(jobs.find(j => j.status === 'failed').remoteId, null);
  assert.equal(h.adapter.calls.length, 2);
  for (const sent of h.adapter.calls) {
    assert.equal(sent.caption, post.caption); assert.equal(sent.revision, post.revision);
    assert.equal(sent.tenantId, h.tenant.id); assert.equal(sent.workspaceId, h.workspace.id);
    assert.equal(sent.media.id, h.media.id); assert.equal(sent.media.sizeBytes, sent.media.bytes.length);
    assert.equal(sent.connectionVersion, 'qa-connection-v1');
    assert.ok(scheduled.some(j => j.id === sent.jobId));
  }
  await worker(h).tick(); await worker(h).tick(); assert.equal(h.adapter.calls.length, 2);
  assert.equal((await h.schedule(post, { channelIds: [published.channelId] })).status, 409);
  assert.ok(!JSON.stringify(jobs).includes('secret-provider-payload'));
});

test('QA publication worker: ambiguity is never blindly replayed and safe retries are explicit', async t => {
  const h = await publicationFixture(t), outcomes = new Map(), posts = [];
  h.adapter.setHandler(async input => {
    const fn = outcomes.get(input.postId); return fn(input);
  });
  for (const outcome of [
    () => { throw new Error('token=secret raw network timeout'); },
    () => ({ outcome: 'published' }),
    () => ({ outcome: 'retry', code: 'UNPROVEN_RETRY' }),
    () => ({ outcome: 'ambiguous', code: 'PROVIDER_AMBIGUOUS' }),
    () => ({ outcome: 'invented', remoteId: 'not-confirmation' }),
  ]) {
    const post = await h.approve(await h.post()); outcomes.set(post.id, outcome); posts.push(post);
    await h.scheduled(post, one(h));
  }
  let retryCalls = 0;
  const safe = await h.approve(await h.post());
  outcomes.set(safe.id, () => ++retryCalls === 1 ? { outcome: 'retry', code: 'META_RATE_LIMIT', safeToRetry: true, retryAfterMs: 60000 } : { outcome: 'published', remoteId: 'safe-retry-confirmed' });
  await h.scheduled(safe, one(h));
  await due(h);
  for (const post of posts) {
    assert.equal((await job(h, post)).status, 'needs_attention');
    assert.equal((await h.schedule(post, one(h))).status, 409, 'Uncertain job must prevent a duplicate revision/target');
  }
  assert.equal((await job(h, safe)).status, 'retry_wait');
  assert.equal(h.adapter.calls.length, 6);
  await due(h);
  assert.equal((await job(h, safe)).status, 'published');
  assert.equal((await job(h, safe)).attemptCount, 2);
  assert.equal(h.adapter.calls.length, 7, 'Only the positively safe retry may run again');
  assert.doesNotMatch(JSON.stringify(await h.jobs(posts[0])), /token=secret|raw network timeout|stack|lease_token/);
});

test('QA publication worker: current role, brand grants, approver and connection are checked at timer time', async t => {
  const h = await publicationFixture(t), owner = h.people.owner.client;
  const hidden = await owner.ok('POST', `/api/v1/tenants/${h.tenant.id}/workspaces`, { name: 'Other grants brand' }, idempotency());
  const change = async (identity, patch) => {
    const row = h.db.prepare('SELECT version FROM memberships WHERE tenant_id=? AND user_id=?').get(h.tenant.id, identity.user.id);
    return owner.ok('PATCH', `/api/v1/tenants/${h.tenant.id}/members/${identity.user.id}`, { expectedVersion: row.version, ...patch });
  };
  for (const scenario of ['actor_role', 'actor_grant', 'reviewer_role', 'connection_version', 'connection_revocation', 'tenant_suspended']) {
    await t.test(scenario, async () => {
      worker(h).heartbeat();
      const post = await h.approve(await h.post()); await h.scheduled(post, one(h));
      const priorCalls = h.adapter.calls.length;
      if (scenario === 'actor_role') await change(h.people.editor, { role: 'viewer' });
      if (scenario === 'actor_grant') await change(h.people.editor, { workspaceIds: [hidden.id] });
      if (scenario === 'reviewer_role') await change(h.people.reviewer, { role: 'viewer' });
      if (scenario === 'connection_version') h.adapter.connections.get(h.channels[0].id).version = 'qa-changed-destination';
      if (scenario === 'connection_revocation') h.adapter.connections.get(h.channels[0].id).revoked = true;
      if (scenario === 'tenant_suspended') h.db.prepare("UPDATE tenants SET status='suspended' WHERE id=?").run(h.tenant.id);
      await due(h);
      const row = h.db.prepare('SELECT status,error_code FROM publication_jobs WHERE post_id=?').get(post.id);
      assert.equal(row.status, 'blocked', scenario); assert.ok(row.error_code);
      assert.equal(h.adapter.calls.length, priorCalls, 'Revocation must prevent all provider calls');
      if (scenario === 'tenant_suspended') h.db.prepare("UPDATE tenants SET status='active' WHERE id=?").run(h.tenant.id);
      if (scenario === 'actor_role') await change(h.people.editor, { role: 'editor', workspaceIds: [h.workspace.id] });
      if (scenario === 'actor_grant') await change(h.people.editor, { workspaceIds: [h.workspace.id] });
      if (scenario === 'reviewer_role') await change(h.people.reviewer, { role: 'reviewer', workspaceIds: [h.workspace.id] });
      h.adapter.connections.get(h.channels[0].id).version = 'qa-connection-v1';
      h.adapter.connections.get(h.channels[0].id).revoked = false;
    });
  }
});

test('QA publication worker: cancelling or rescheduling a lease fences the old dispatcher', async t => {
  const h = await publicationFixture(t);
  for (const action of ['cancel', 'reschedule']) {
    worker(h).heartbeat(); const post = await h.approve(await h.post());
    await h.scheduled(post, one(h)); h.advance(61_000); worker(h).heartbeat();
    const claimed = worker(h).claim(); assert.ok(claimed);
    const current = await job(h, post); assert.equal(current.status, 'leased');
    const body = { expectedVersion: current.version, ...(action === 'reschedule' ? { scheduledAt: new Date(h.now() + 60_000).toISOString(), scheduledTimezone: 'UTC' } : {}) };
    await h.people.editor.client.ok('POST', h.path(`/publications/${current.id}/${action}`), body, idempotency());
    await worker(h).dispatch(claimed);
    assert.equal(h.adapter.calls.length, 0, 'The fenced lease must not invoke the adapter');
    assert.equal((await job(h, post)).status, action === 'cancel' ? 'cancelled' : 'scheduled');
    if (action === 'reschedule') {
      await due(h); assert.equal(h.adapter.calls.length, 1); assert.equal((await job(h, post)).status, 'published');
    }
  }
});

test('QA publication worker: in-flight sends reject cancellation, content edits and stale success', async t => {
  const h = await publicationFixture(t), post = await h.approve(await h.post());
  const [scheduled] = await h.scheduled(post, one(h));
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.adapter.setHandler(async () => { started(); await gate; return { outcome: 'published', remoteId: 'late-response-cannot-overwrite-recovery' }; });
  h.advance(61_000); worker(h).heartbeat(); const claimed = worker(h).claim();
  const pending = worker(h).dispatch(claimed); await entered;
  const current = await job(h, post); assert.equal(current.status, 'sending');
  assert.equal((await h.people.editor.client.request('POST', h.path(`/publications/${scheduled.id}/cancel`), { expectedVersion: current.version }, idempotency())).status, 409);
  assert.equal((await h.people.editor.client.request('POST', h.path(`/publications/${scheduled.id}/reschedule`), { expectedVersion: current.version, scheduledAt: new Date(h.now() + 60000).toISOString(), scheduledTimezone: 'UTC' }, idempotency())).status, 409);
  assert.equal((await h.people.editor.client.request('PATCH', h.path(`/posts/${post.id}`), { expectedRevision: post.revision, caption: 'Changed during remote send' })).status, 409);
  h.db.prepare("UPDATE publication_jobs SET lease_until=? WHERE id=?").run(new Date(h.now() - 1000).toISOString(), scheduled.id);
  worker(h).recover();
  assert.equal((await job(h, post)).status, 'needs_attention');
  release(); await pending;
  assert.equal((await job(h, post)).status, 'needs_attention', 'A response after losing the durable lease cannot falsely claim success');
  await worker(h).tick(); assert.equal(h.adapter.calls.length, 1);
});

test('QA publication worker: safe lease crash recovers, stopped or stale worker fails closed', async t => {
  const h = await publicationFixture(t), post = await h.approve(await h.post());
  const [scheduled] = await h.scheduled(post, one(h));
  h.advance(61_000); worker(h).heartbeat();
  const claimed = worker(h).claim(); assert.ok(claimed);
  h.db.prepare('UPDATE publication_jobs SET lease_until=? WHERE id=?').run(new Date(h.now() - 1000).toISOString(), scheduled.id);
  worker(h).recover();
  assert.equal((await job(h, post)).status, 'scheduled');
  await worker(h).tick(); assert.equal((await job(h, post)).status, 'published');
  assert.equal(h.adapter.calls.length, 1);
  const future = await h.approve(await h.post());
  h.advance(31_000);
  const stale = await h.people.editor.client.ok('GET', h.path('/publishing/readiness'));
  assert.equal(stale.enabled, false); assert.equal(stale.worker.running, false);
  assert.equal((await h.schedule(future, one(h))).status, 503);
  await worker(h).stop();
  assert.equal((await h.schedule(future, one(h))).status, 503);
  assert.equal(h.adapter.calls.length, 1);
});

test('QA publication worker: lease expiry fences a late success even before explicit recovery runs', async t => {
  const h = await publicationFixture(t), post = await h.approve(await h.post());
  const [scheduled] = await h.scheduled(post, one(h));
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.adapter.setHandler(async () => { entered(); await gate; return { outcome: 'published', remoteId: 'too-late-unfenced-response' }; });
  h.advance(61_000); worker(h).heartbeat();
  const pending = worker(h).dispatch(worker(h).claim()); await started;
  h.db.prepare('UPDATE publication_jobs SET lease_until=? WHERE id=?').run(new Date(h.now() - 1000).toISOString(), scheduled.id);
  release(); await pending;
  assert.equal((await job(h, post)).status, 'needs_attention');
  assert.equal((await job(h, post)).remoteId, null);
  await worker(h).tick(); assert.equal(h.adapter.calls.length, 1);
});

test('QA publication worker: missed fifteen-minute window fails without a surprise late post', async t => {
  const h = await publicationFixture(t), post = await h.approve(await h.post());
  await h.scheduled(post, one(h));
  h.advance(17 * 60_000);
  await worker(h).tick();
  const row = await job(h, post);
  assert.equal(row.status, 'failed'); assert.equal(row.errorCode, 'PUBLICATION_EXPIRED');
  assert.equal(row.remoteId, null); assert.equal(h.adapter.calls.length, 0);
});

test('QA publication worker: preparation crossing the lateness deadline cannot reach irreversible publish', async t => {
  const h = await publicationFixture(t), post = await h.approve(await h.post());
  await h.scheduled(post, one(h));
  let irreversible = false;
  h.adapter.setHandler(async input => {
    await input.saveProviderState({ containerId: '1234567', stage: 'ready' });
    h.advance(90_000); // Still inside this lease, but beyond the scheduled-time safety window.
    await input.saveProviderState({ containerId: '1234567', stage: 'publishing' });
    irreversible = true;
    return { outcome: 'published', remoteId: 'late-after-preparation' };
  });
  h.advance(15 * 60_000); // Scheduled one minute after creation: currently fourteen minutes late.
  await worker(h).tick();
  assert.equal(irreversible, false, 'Preflight cannot carry a job beyond its promised safety window');
  assert.notEqual((await job(h, post)).status, 'published');
});
