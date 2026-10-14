import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { route, idempotency, assertDenied } from './qa-helpers.mjs';
import { publicationFixture } from './qa-publication-helpers.mjs';
import { buildConfig } from '../src/config.mjs';

test('QA publication configuration: no test injection or production/public runtime bypass', () => {
  assert.throws(() => buildConfig({ mode: 'development', publishingAdapter: {} }), /TEST_PUBLISHING_ADAPTER_ONLY/);
  assert.throws(() => buildConfig({ mode: 'development', publishingWorker: { enabled: true } }), /TEST_PUBLISHING_WORKER_OPTIONS_ONLY/);
  assert.throws(() => buildConfig({ mode: 'production' }), /PRODUCTION_NOT_READY/);
  assert.throws(() => buildConfig({ mode: 'development', host: '0.0.0.0' }), /PILOT_LOOPBACK_ONLY/);
});

test('QA publication API: exact revision, strict targets and dates, atomic jobs and safe mutations', async t => {
  const h = await publicationFixture(t), { people: p } = h;
  let post = await h.post(), scheduled;
  await t.test('drafts, reader writes and authority injection cannot schedule', async () => {
    assertDenied(await h.schedule(post), 409);
    post = await h.approve(post);
    assertDenied(await h.schedule(post, {}, p.reviewer.client), 403);
    for (const extra of [{ actorId: p.owner.user.id }, { status: 'published' }, { remoteId: 'forged' }, { accessToken: 'never-accepted' }, { tenantId: 'foreign' }, { expectedRevision: post.revision + 1 }]) {
      const response = await h.schedule(post, extra);
      assert.ok([409, 422].includes(response.status), response.body);
    }
    const response = await h.schedule(post, {}, p.editor.client, {});
    assert.ok([400, 422].includes(response.status), response.body);
    assert.equal((await h.jobs(post)).length, 0);
  });
  await t.test('invalid calendar, timezone, offset and unsupported shape are refused', async () => {
    for (const extra of [
      { scheduledAt: new Date(h.now() - 1000).toISOString() },
      { scheduledAt: new Date(h.now() + 60000).toISOString().replace('Z', '') },
      { scheduledTimezone: 'Not/A_Zone' }, { scheduledTimezone: '+03:00' },
      { scheduledAt: '2026-11-01T01:30:00-03:00', scheduledTimezone: 'America/New_York' },
      { scheduledAt: '2027-03-14T02:30:00-05:00', scheduledTimezone: 'America/New_York' },
      { scheduledAt: '2027-02-30T10:00:00Z' },
      { scheduledAt: new Date(h.now() + 91 * 86400000).toISOString() },
      { channelIds: [] }, { channelIds: [h.channels[0].id, h.channels[0].id] },
    ]) assert.equal((await h.schedule(post, extra)).status, 422, JSON.stringify(extra));
    for (const format of ['video', 'reel', 'story', 'carousel', 'text']) {
      const unsupported = await h.approve(await h.post({ format }));
      assertDenied(await h.schedule(unsupported), 422);
    }
    assert.equal(h.adapter.calls.length, 0);
  });
  await t.test('cross-brand channel bindings and mixed unready batches never partially enqueue', async () => {
    const hidden = await p.owner.client.ok('POST', `/api/v1/tenants/${h.tenant.id}/workspaces`, { name: 'Unrelated publication brand', channels: [{ platform: 'facebook', label: 'Other bound destination' }] }, idempotency());
    const hiddenChannels = await p.owner.client.ok('GET', route(h.tenant, hidden, '/channels'));
    const cross = await h.schedule(post, { channelIds: [h.channels[0].id, hiddenChannels[0].id] });
    assert.ok([404, 409, 422].includes(cross.status), cross.body);
    assert.equal((await h.jobs(post)).length, 0);
    h.adapter.connections.get(h.channels[1].id).revoked = true;
    assertDenied(await h.schedule(post), 409);
    assert.equal((await h.jobs(post)).length, 0, 'The earlier valid target must roll back with the rejected target');
    h.adapter.connections.get(h.channels[1].id).revoked = false;
    const key = idempotency('publication-exact-once');
    const first = await h.scheduled(post, {}, p.editor.client, key);
    const second = await h.scheduled(post, {}, p.editor.client, key);
    assert.deepEqual(first.map(j => j.id), second.map(j => j.id));
    assert.equal((await h.jobs(post)).length, 2);
    assertDenied(await h.schedule(post), 409);
    for (const job of first) {
      assert.equal(job.status, 'scheduled'); assert.equal(job.revision, post.revision); assert.equal(job.remoteId, null);
      assert.equal(job.scheduledTimezone, 'UTC'); assert.match(job.scheduledAt, /Z$/);
      assert.doesNotMatch(JSON.stringify(job), /lease_token|leaseToken|connection_version|connectionVersion|credential|accessToken|"bytes"|caption/);
    }
    scheduled = first;
    assertDenied(await p.reviewer.client.request('POST', h.path(`/publications/${first[0].id}/cancel`), { expectedVersion: first[0].version }, idempotency()), 403);
    assertDenied(await p.editor.client.request('GET', route(h.tenant, hidden, `/posts/${post.id}/publications`)));
  });
  await t.test('simultaneous cancellation and rescheduling have one winner and preserve content approval', async () => {
    const job = scheduled[0], nextDate = new Date(h.now() + 120_000).toISOString();
    const pair = await Promise.all([
      p.editor.client.request('POST', h.path(`/publications/${job.id}/cancel`), { expectedVersion: job.version }, idempotency()),
      p.editor.client.request('POST', h.path(`/publications/${job.id}/reschedule`), { expectedVersion: job.version, scheduledAt: nextDate, scheduledTimezone: 'UTC' }, idempotency()),
    ]);
    assert.deepEqual(pair.map(r => r.status).sort(), [200, 409]);
    const current = await p.editor.client.ok('GET', h.path(`/posts/${post.id}`));
    assert.equal(current.revision, post.revision); assert.equal(current.approvedRevision, post.revision);
    assertDenied(await p.editor.client.request('POST', h.path(`/publications/${job.id}/cancel`), { expectedVersion: job.version }, idempotency()), 409);
    assertDenied(await p.editor.client.request('POST', h.path(`/publications/${randomUUID()}/cancel`), { expectedVersion: 1 }, idempotency()));
  });
  await t.test('editing an approved revision immediately fences queued work and cannot inherit approval', async () => {
    const edited = await p.editor.client.ok('PATCH', h.path(`/posts/${post.id}`), { expectedRevision: post.revision, caption: 'New content requires fresh independent approval' });
    assert.ok(edited.revision > post.revision); assert.equal(edited.approvedRevision, null);
    const jobs = await h.jobs(post);
    assert.ok(jobs.every(j => ['blocked', 'cancelled'].includes(j.status)));
    assert.equal(jobs.find(j => j.id === scheduled[1].id).errorCode, 'APPROVAL_STALE');
    assertDenied(await h.schedule(edited), 409);
    assert.equal(h.adapter.calls.length, 0);
  });
});
