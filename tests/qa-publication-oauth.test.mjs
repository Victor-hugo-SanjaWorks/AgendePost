import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, idempotency, route } from './qa-helpers.mjs';
import { publicationFixture } from './qa-publication-helpers.mjs';

const USER_TOKEN = 'QA_SYNTHETIC_USER_TOKEN_NEVER_REAL_123456789';
const PAGE_TOKEN = 'QA_SYNTHETIC_PAGE_TOKEN_NEVER_REAL_987654321';
const scopes = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish'];
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('QA publication OAuth: state/session replay, strict brand binding, encrypted storage and revoke-before-timer', async t => {
  const calls = [], origin = 'https://127.0.0.1:8787';
  let h;
  const page = { id: '300001', name: 'Synthetic QA Page', access_token: PAGE_TOKEN, tasks: ['CREATE_CONTENT'], instagram_business_account: { id: '400001', username: 'synthetic_qa', account_type: 'BUSINESS' } };
  const metaOAuthFetch = async (raw, options) => {
    const url = new URL(raw), path = url.pathname.replace('/v26.0/', ''); calls.push({ path, method: options.method });
    assert.equal(url.origin, 'https://graph.facebook.com'); assert.equal(options.redirect, 'error');
    if (path === 'oauth/access_token') return json({ access_token: USER_TOKEN, expires_in: 7200 });
    if (path === 'debug_token') return json({ data: { is_valid: true, app_id: '10001', type: url.searchParams.get('input_token') === PAGE_TOKEN ? 'PAGE' : 'USER', user_id: '200001', scopes, expires_at: Math.floor(h.now() / 1000) + 7200, data_access_expires_at: Math.floor(h.now() / 1000) + 7200 } });
    if (path === 'me/permissions') return json({ data: scopes.map(permission => ({ permission, status: 'granted' })) });
    if (path === 'me') return json(options.headers.authorization === `Bearer ${PAGE_TOKEN}` ? { id: page.id, name: page.name, instagram_business_account: page.instagram_business_account } : { id: '200001' });
    if (path === '200001/accounts') return json({ data: [page] });
    throw new Error('Unexpected offline OAuth endpoint: ' + path);
  };
  h = await publicationFixture(t, { canonicalOrigin: origin, metaOAuthConfig: { enabled: true, apiVersion: 'v26.0', appId: '10001', appSecret: 'a'.repeat(32), redirectUri: origin + '/api/v1/social-connections/meta/callback', encryptionKey: Buffer.alloc(32, 7) }, metaOAuthFetch });
  const owner = h.people.owner.client, channel = h.channels.find(c => c.platform === 'facebook'), base = h.path('/social-connections');
  const other = await owner.ok('POST', `/api/v1/tenants/${h.tenant.id}/workspaces`, { name: 'Other OAuth QA brand', channels: [{ platform: 'facebook', label: 'Other destination' }] }, idempotency());
  const otherChannel = (await owner.ok('GET', route(h.tenant, other, '/channels')))[0];
  let pending, connected;

  await t.test('state is bound to the initiating session, is single-use and never leaks tokens', async () => {
    const start = await owner.ok('POST', base + '/meta/start', { channelId: channel.id, accessBasis: 'direct' });
    const authorization = new URL(start.authorizationUrl), state = authorization.searchParams.get('state');
    assert.equal(authorization.origin, 'https://www.facebook.com'); assert.ok(state && state.length === 43);
    assert.equal(authorization.searchParams.get('redirect_uri'), origin + '/api/v1/social-connections/meta/callback');
    assert.ok(!start.authorizationUrl.includes('client_secret'));
    const sessionTwo = new Client(h); await sessionTwo.login(h.people.owner.email);
    const callbackPath = '/api/v1/social-connections/meta/callback?state=' + encodeURIComponent(state) + '&code=QA_SYNTHETIC_AUTHORIZATION_CODE';
    assert.equal((await sessionTwo.request('GET', callbackPath)).status, 400);
    assert.equal(calls.length, 0, 'A wrong-session callback must never exchange a code');
    const callback = await owner.request('GET', callbackPath);
    assert.equal(callback.status, 302, callback.body);
    assert.equal(callback.headers['referrer-policy'], 'no-referrer');
    assert.ok(callback.headers.location.includes(encodeURIComponent(h.workspace.id)));
    assert.doesNotMatch(callback.headers.location, /state=|code=|token|secret/);
    const prior = calls.length;
    assert.equal((await owner.request('GET', callbackPath)).status, 400);
    assert.equal(calls.length, prior, 'An already consumed state must not exchange again');
    const stateView = await owner.request('GET', base + '/meta');
    assert.equal(stateView.status, 200); assert.equal(stateView.data.pending.length, 1); pending = stateView.data.pending[0];
    assert.equal(pending.candidates[0].accountId, page.id); assert.equal(pending.candidates[0].eligible, true);
    assert.ok(!stateView.body.includes(USER_TOKEN)); assert.ok(!stateView.body.includes(PAGE_TOKEN));
    assert.equal((await sessionTwo.ok('GET', base + '/meta')).pending.length, 0);
    const persisted = JSON.stringify(h.db.prepare('SELECT * FROM social_oauth_pending').all());
    assert.ok(!persisted.includes(USER_TOKEN)); assert.ok(!persisted.includes(PAGE_TOKEN));
    assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM social_oauth_states').all()).includes(state));
  });

  await t.test('pending candidates cannot be attached to another brand, channel or reader session', async () => {
    const selection = { pendingId: pending.id, candidateId: page.id, channelId: channel.id, expectedChannelVersion: channel.version };
    assert.equal((await h.people.editor.client.request('POST', base + '/meta/select', selection)).status, 403);
    assert.equal((await h.people.reviewer.client.request('GET', base + '/meta')).status, 403);
    const bad = await owner.request('POST', route(h.tenant, other, '/social-connections/meta/select'), { ...selection, channelId: otherChannel.id, expectedChannelVersion: otherChannel.version });
    assert.equal(bad.status, 400, bad.body);
    assert.equal((await owner.ok('GET', route(h.tenant, other, '/social-connections/meta'))).connections.length, 0);
    const result = await owner.request('POST', base + '/meta/select', selection);
    assert.equal(result.status, 200, result.body); connected = result.data;
    assert.equal(connected.channelId, channel.id); assert.equal(connected.accountId, page.id); assert.equal(connected.status, 'active');
    assert.equal((await owner.request('POST', base + '/meta/select', selection)).status, 409, 'The channel version changed and pending selection is one-use');
    const stored = JSON.stringify(h.db.prepare('SELECT * FROM social_connections').all());
    assert.ok(!stored.includes(PAGE_TOKEN)); assert.ok(!stored.includes(USER_TOKEN));
    assert.ok(!JSON.stringify(h.db.prepare('SELECT * FROM audit_events').all()).includes(PAGE_TOKEN));
    const binding = h.app.ctx.services.socialConnections.resolveBinding({ tenantId: h.tenant.id, workspaceId: h.workspace.id, channelId: channel.id, platform: 'facebook' });
    assert.equal(binding.accountId, page.id);
    assert.equal(h.app.ctx.services.socialConnections.resolveBinding({ tenantId: h.tenant.id, workspaceId: other.id, channelId: channel.id, platform: 'facebook' }) ?? null, null);
  });

  await t.test('disconnect removes usable credential and blocks an already scheduled job before dispatch', async () => {
    h.adapter.readiness = input => {
      const binding = h.app.ctx.services.socialConnections.resolveBinding(input);
      return binding ? { ready: true, connectionVersion: binding.connectionVersion } : { ready: false, code: 'CONNECTION_REVOKED' };
    };
    const post = await h.approve(await h.post({ channelIds: [channel.id] }));
    await h.scheduled(post, { channelIds: [channel.id] });
    const disconnected = await owner.ok('POST', base + '/' + connected.id + '/disconnect', { expectedVersion: connected.version });
    assert.equal(disconnected.status, 'disconnected');
    assert.equal(h.db.prepare('SELECT encrypted_payload FROM social_connections WHERE id=?').get(connected.id).encrypted_payload, null);
    assert.equal(h.app.ctx.services.socialConnections.resolveBinding({ tenantId: h.tenant.id, workspaceId: h.workspace.id, channelId: channel.id, platform: 'facebook' }), null);
    h.advance(61_000); await h.app.ctx.services.publishing.worker.tick();
    assert.equal((await h.jobs(post))[0].status, 'blocked'); assert.equal(h.adapter.calls.length, 0);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM social_oauth_pending').get().n, 0);
  });
});
