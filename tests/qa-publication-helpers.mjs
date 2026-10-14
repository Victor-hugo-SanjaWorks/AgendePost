import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { harness, verified, fixtureTeamPlan, invite, route, idempotency, multipart } from './qa-helpers.mjs';

// Explicitly offline fixture: no provider endpoint or credential exists here.
export function offlinePublicationAdapter() {
  const connections = new Map(), calls = [], validations = [];
  let handler = async input => ({ outcome: 'published', remoteId: `offline-${input.jobId}` });
  const adapter = {
    enabled: true, kind: 'test', connections, calls, validations,
    readiness(input) {
      const connection = connections.get(input.channelId);
      if (!connection || connection.tenantId !== input.tenantId || connection.workspaceId !== input.workspaceId || connection.platform !== input.platform) return { ready: false, code: 'CONNECTION_NOT_CONFIGURED' };
      if (connection.revoked) return { ready: false, code: 'CONNECTION_REVOKED' };
      return { ready: true, connectionVersion: connection.version };
    },
    validate(input) { validations.push(input); return adapter.readiness(input); },
    async publish(input) { calls.push(input); return handler(input); },
    setHandler(next) { handler = next; },
    bind(tenant, workspace, channels) {
      for (const channel of channels) connections.set(channel.id, { tenantId: tenant.id, workspaceId: workspace.id, platform: channel.platform, version: 'qa-connection-v1' });
    },
  };
  return adapter;
}

export async function publicationFixture(t, options = {}) {
  let milliseconds = Date.now();
  const adapter = options.publishingAdapter ?? offlinePublicationAdapter();
  const h = await harness(t, { clock: () => milliseconds, publishingAdapter: adapter, publishingWorker: { enabled: true, autoStart: false }, ...options });
  const people = {};
  for (const role of ['owner', 'editor', 'reviewer']) people[role] = await verified(h, `publication-${role}`);
  const tenant = await people.owner.client.ok('POST', '/api/v1/tenants', { name: 'Independent publication QA', slug: `publication-${randomUUID().slice(0, 8)}`, timezone: 'UTC' }, idempotency());
  fixtureTeamPlan(h, tenant.id);
  const workspace = await people.owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Publication QA visible brand', channels: [{ platform: 'instagram', label: 'Offline Instagram fixture' }, { platform: 'facebook', label: 'Offline Facebook fixture' }] }, idempotency());
  for (const role of ['editor', 'reviewer']) await invite(h, people.owner.client, tenant.id, people[role], role, [workspace.id]);
  const channels = await people.owner.client.ok('GET', route(tenant, workspace, '/channels'));
  adapter.bind?.(tenant, workspace, channels);
  const bytes = await sharp({ create: { width: 1080, height: 1080, channels: 3, background: '#285cb8' } }).jpeg().toBuffer();
  const form = multipart(bytes, { filename: 'qa-only.jpg', mime: 'image/jpeg' });
  const media = await people.editor.client.ok('POST', route(tenant, workspace, '/media'), form.payload, { headers: { ...form.headers, 'idempotency-key': randomUUID() } });
  const result = { ...h, people, tenant, workspace, channels, media, adapter,
    now: () => milliseconds,
    advance(ms) { milliseconds += ms; },
    setTime(ms) { milliseconds = typeof ms === 'number' ? ms : Date.parse(ms); },
    path(suffix) { return route(tenant, workspace, suffix); },
    async post(overrides = {}) {
      return people.editor.client.ok('POST', route(tenant, workspace, '/posts'), { title: `Independent QA ${randomUUID().slice(0, 8)}`, caption: 'Exact approved offline fixture', format: 'image', mediaIds: [media.id], channelIds: channels.map(c => c.id), ...overrides }, idempotency());
    },
    async approve(post) {
      await people.editor.client.ok('POST', route(tenant, workspace, `/posts/${post.id}/transitions`), { action: 'submit_review', expectedRevision: post.revision }, idempotency());
      return people.reviewer.client.ok('POST', route(tenant, workspace, `/posts/${post.id}/transitions`), { action: 'approve', expectedRevision: post.revision }, idempotency());
    },
    async schedule(post, overrides = {}, client = people.editor.client, key = idempotency()) {
      const selected = overrides.channelIds ?? channels.map(c => c.id);
      const connectionVersions = Object.fromEntries(selected.map(channelId => [channelId, adapter.readiness({ tenantId: tenant.id, workspaceId: workspace.id, channelId, platform: channels.find(c => c.id === channelId)?.platform, now: new Date(milliseconds).toISOString() }).connectionVersion ?? 'qa-unready']));
      return client.request('POST', route(tenant, workspace, `/posts/${post.id}/publications`), { expectedRevision: post.revision, channelIds: channels.map(c => c.id), connectionVersions, scheduledAt: new Date(milliseconds + 60_000).toISOString(), scheduledTimezone: 'UTC', ...overrides }, key);
    },
    async scheduled(post, overrides = {}, client = people.editor.client, key = idempotency()) {
      const response = await result.schedule(post, overrides, client, key);
      assert.equal(response.status, 201, response.body);
      assert.ok(Array.isArray(response.data), response.body);
      return response.data;
    },
    async jobs(post, client = people.editor.client) { return client.ok('GET', route(tenant, workspace, `/posts/${post.id}/publications`)); },
  };
  return result;
}
