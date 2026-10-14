import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Client, harness, verified, fixtureTeamPlan, invite, route, idempotency } from './qa-helpers.mjs';

const PUBLIC = '/api/v1/public/dashboard';
const digest = value => createHash('sha256').update(value).digest('hex');
const input = (overrides = {}) => ({ label: 'Client-only report', expiresInDays: 30, acknowledgeBearerAccess: true, ...overrides });
let publicAddress = 100;

async function publicRequest(h, token, { path = PUBLIC, method = 'GET', payload, headers = {} } = {}) {
  const response = await h.app.inject({
    method, url: path, remoteAddress: `127.9.0.${publicAddress++ % 250 + 1}`,
    headers: { host: new URL(h.app.ctx.config.canonicalOrigin).host, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
  let json; try { json = response.json(); } catch { json = null; }
  return { response, status: response.statusCode, body: response.body, headers: response.headers, json, data: json?.data };
}
function tokenFrom(share) {
  const url = new URL(share.url);
  assert.equal(url.pathname, '/client-dashboard');
  assert.equal(url.search, '', 'Bearer material must never be placed in an HTTP query string');
  const params = new URLSearchParams(url.hash.slice(1)), raw = params.get('token');
  assert.deepEqual([...params.keys()], ['token']);
  assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(raw, 'base64url').length, 32, 'Share capabilities need 256 bits of random material');
  return raw;
}
function assertOpaqueFailure(result) {
  assert.equal(result.status, 404, result.body);
  assert.ok(result.json?.error?.code);
  assert.doesNotMatch(result.body, /SQLITE_|SELECT |token_hash|password_hash|encrypted_payload|at async|Bearer /);
  assert.match(result.headers['cache-control'], /no-store/);
}
async function fixture(t) {
  const logs = [];
  const h = await harness(t, { logger: { level: 'info', stream: { write: line => logs.push(line) } } });
  const people = {};
  for (const role of ['owner', 'admin', 'editor', 'reviewer', 'viewer', 'outsider']) people[role] = await verified(h, `share-${role}`);
  const tenant = await people.owner.client.ok('POST', '/api/v1/tenants', { name: 'INTERNAL TENANT SENTINEL 8021', timezone: 'UTC' }, idempotency());
  fixtureTeamPlan(h, tenant.id);
  const visible = await people.owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Publicly approved brand' }, idempotency());
  const hidden = await people.owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'HIDDEN BRAND SENTINEL 7922' }, idempotency());
  for (const role of ['admin', 'editor', 'reviewer', 'viewer']) await invite(h, people.owner.client, tenant.id, people[role], role, role === 'admin' ? [] : [visible.id]);
  const foreignTenant = await people.outsider.client.ok('POST', '/api/v1/tenants', { name: 'FOREIGN TENANT SENTINEL 8933', timezone: 'UTC' }, idempotency());
  const foreignWorkspace = await people.outsider.client.ok('POST', `/api/v1/tenants/${foreignTenant.id}/workspaces`, { name: 'FOREIGN BRAND SENTINEL 8844' }, idempotency());
  const base = route(tenant, visible, '/dashboard-shares');
  const hiddenBase = route(tenant, hidden, '/dashboard-shares');
  const foreignBase = route(foreignTenant, foreignWorkspace, '/dashboard-shares');
  return { ...h, logs, people, tenant, visible, hidden, foreignTenant, foreignWorkspace, base, hiddenBase, foreignBase };
}

test('security client dashboard: capability lifecycle, exact scope, redaction and read-only boundary', async t => {
  const h = await fixture(t), { people: p } = h;
  let main, raw, adminShare, adminRaw;

  await t.test('only recently authenticated owner/admin may explicitly issue or manage links', async () => {
    for (const role of ['editor', 'reviewer', 'viewer']) {
      assert.equal((await p[role].client.request('POST', h.base, input(), idempotency())).status, 403, role);
      assert.equal((await p[role].client.request('GET', h.base)).status, 403, role);
    }
    assert.equal((await p.outsider.client.request('POST', h.base, input(), idempotency())).status, 404);
    assert.equal((await p.outsider.client.request('GET', h.base)).status, 404);
    assert.equal((await new Client(h).request('POST', h.base, input(), idempotency())).status, 401);
    assert.equal((await p.owner.client.request('POST', h.base, input(), { headers: { ...idempotency().headers, 'x-csrf-token': 'incorrect' } })).status, 403);
    assert.equal((await p.owner.client.request('POST', h.base, input(), { headers: { ...idempotency().headers, origin: 'https://attacker.invalid' } })).status, 403);
    h.db.prepare("UPDATE sessions SET auth_at='2001-01-01T00:00:00.000Z' WHERE user_id=? AND revoked_at IS NULL").run(p.owner.user.id);
    const stale = await p.owner.client.request('POST', h.base, input(), idempotency());
    assert.equal(stale.status, 403); assert.equal(stale.json.error.code, 'REAUTH_REQUIRED');
    h.db.prepare('UPDATE sessions SET auth_at=? WHERE user_id=? AND revoked_at IS NULL').run(h.app.ctx.now(), p.owner.user.id);
    main = await p.owner.client.ok('POST', h.base, input(), idempotency()); raw = tokenFrom(main);
    adminShare = await p.admin.client.ok('POST', h.base, input({ label: 'Admin-authored share' }), idempotency()); adminRaw = tokenFrom(adminShare);
    assert.notEqual(raw, adminRaw);
    assert.equal((await publicRequest(h, raw)).status, 200);
    assert.equal((await publicRequest(h, adminRaw)).status, 200);
  });

  await t.test('strict input rejects implicit consent, injected scope, unbounded expiry and missing idempotency', async () => {
    for (const body of [
      { label: 'Missing consent', expiresInDays: 30 }, input({ acknowledgeBearerAccess: false }),
      input({ expiresInDays: 0 }), input({ expiresInDays: 91 }), input({ expiresInDays: 1.5 }), input({ expiresInDays: '30' }),
      input({ label: ' ' }), input({ label: 'x'.repeat(501) }), input({ tenantId: h.foreignTenant.id }),
      input({ workspaceId: h.hidden.id }), input({ createdBy: p.outsider.user.id }), input({ token: raw }),
      input({ scope: 'organization' }), input({ includeDrafts: true }),
    ]) {
      const response = await p.owner.client.request('POST', h.base, body, idempotency());
      assert.equal(response.status, 422, response.body);
    }
    assert.equal((await p.owner.client.request('POST', h.base, input())).status, 422);
    assert.equal((await p.owner.client.request('POST', h.base, input(), idempotency('short'))).status, 422);
  });

  await t.test('raw token exists only in first creation response, never lists, database, audit, logs or idempotency replay', async () => {
    const key = idempotency('independent-share-one-time-' + randomUUID());
    const created = await p.owner.client.ok('POST', h.base, input({ label: 'One-time disclosure' }), key), secret = tokenFrom(created);
    const stored = h.db.prepare('SELECT * FROM client_dashboard_shares WHERE id=?').get(created.id);
    assert.equal(stored.token_hash, digest(secret));
    assert.equal(stored.tenant_id, h.tenant.id); assert.equal(stored.workspace_id, h.visible.id);
    assert.ok(!JSON.stringify(stored).includes(secret));
    for (const body of [input({ label: 'One-time disclosure' }), input({ label: 'Different request' })]) {
      const replay = await p.owner.client.request('POST', h.base, body, key);
      assert.equal(replay.status, 409, replay.body); assert.ok(!replay.body.includes(secret));
    }
    const list = await p.owner.client.request('GET', h.base);
    assert.equal(list.status, 200); assert.ok(Array.isArray(list.data));
    assert.ok(list.data.some(row => row.id === created.id));
    assert.doesNotMatch(list.body, /token|url|createdBy|email|password/i);
    const tables = h.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      const dump = JSON.stringify(h.db.prepare(`SELECT * FROM "${name}"`).all());
      assert.ok(!dump.includes(secret), `Raw share token leaked into ${name}`);
    }
    assert.ok(!h.logs.join('').includes(secret), 'Share bearer must not appear in application logs');
    await p.owner.client.ok('POST', `${h.base}/${created.id}/revoke`, { expectedVersion: created.version }, idempotency());
    assertOpaqueFailure(await publicRequest(h, secret));
  });

  await t.test('known IDs never cross tenant or brand boundaries', async () => {
    const hidden = await p.owner.client.ok('POST', h.hiddenBase, input({ label: 'Private other brand' }), idempotency());
    const foreign = await p.outsider.client.ok('POST', h.foreignBase, input({ label: 'Other organization' }), idempotency());
    const wrongTenant = route(h.foreignTenant, h.visible, '/dashboard-shares');
    for (const path of [h.hiddenBase, h.foreignBase, wrongTenant]) {
      const response = await p.owner.client.request('POST', `${path}/${main.id}/revoke`, { expectedVersion: main.version }, idempotency());
      assert.equal(response.status, 404, response.body);
    }
    assert.equal((await p.owner.client.request('POST', `${h.base}/${hidden.id}/revoke`, { expectedVersion: hidden.version }, idempotency())).status, 404);
    assert.equal((await p.owner.client.request('POST', `${h.base}/${foreign.id}/revoke`, { expectedVersion: foreign.version }, idempotency())).status, 404);
    const publicResult = await publicRequest(h, raw);
    assert.equal(publicResult.status, 200);
    for (const marker of [h.hidden.id, h.foreignTenant.id, h.foreignWorkspace.id, 'HIDDEN BRAND SENTINEL', 'FOREIGN BRAND SENTINEL']) assert.ok(!publicResult.body.includes(marker));
    assert.equal((await publicRequest(h, tokenFrom(hidden))).status, 200);
    assert.equal((await publicRequest(h, tokenFrom(foreign))).status, 200);
  });

  await t.test('public responses exclude drafts, strategy, membership, billing, private identity and credentials', async () => {
    await p.owner.client.ok('POST', route(h.tenant, h.visible, '/posts'), { title: 'INTERNAL DRAFT SENTINEL 6501', caption: 'PRIVATE CAPTION SENTINEL 6502' }, idempotency());
    await p.owner.client.ok('POST', route(h.tenant, h.visible, '/strategy/entries'), { quadrant: 'weakness', title: 'PRIVATE FOFA SENTINEL 6503', description: 'PRIVATE STRATEGY NOTES 6504', classification: 'hypothesis' }, idempotency());
    await p.owner.client.ok('POST', route(h.tenant, h.visible, '/strategy/competitors'), { name: 'PRIVATE COMPETITOR SENTINEL 6505', sourceType: 'user_provided', observedOn: h.app.ctx.now().slice(0, 10), sourceNotes: 'PRIVATE RESEARCH NOTES 6506' }, idempotency());
    const response = await publicRequest(h, raw);
    assert.equal(response.status, 200, response.body);
    assert.ok(response.body.includes(h.visible.name));
    for (const marker of [h.tenant.name, ...Object.values(p).map(person => person.email), 'INTERNAL DRAFT', 'PRIVATE CAPTION', 'PRIVATE FOFA', 'PRIVATE STRATEGY', 'PRIVATE COMPETITOR', 'PRIVATE RESEARCH']) assert.ok(!response.body.includes(marker), marker);
    assert.doesNotMatch(response.body, /password_hash|token_hash|access_token|encrypted_payload|provider_user_id|connected_by|csrf_token|session_epoch|billing_customer|memberships|derivedEntries|missingCaption|missingChannels/);
    assert.equal(response.headers['set-cookie'], undefined, 'Public viewer must not require an admin or anonymous login cookie');
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  });

  await t.test('public projection is an allowlist, never forwards provider payloads, and reads only exact-scope stored data', async () => {
    const previous = h.app.ctx.services.socialMetrics, previousFetch = globalThis.fetch;
    const at = h.app.ctx.now(), calls = [], privateMarker = 'NEVER_PUBLIC_PROVIDER_OR_INTERNAL_SECRET_7331';
    let network = 0;
    globalThis.fetch = async () => { network++; throw new Error('Public view must not fetch external data'); };
    h.app.ctx.services.socialMetrics = { summary(tid, wid) {
      calls.push([tid, wid]);
      return {
        token: privateMarker, memberships: [{ email: privateMarker }], entries: [{ description: privateMarker }],
        collection: { enabled: true, status: 'ready', lastAttemptAt: at, nextRunAt: at, access_token: privateMarker },
        lastSyncedAt: at, stale: false, notices: [{ message: privateMarker }],
        accounts: [{
          channelId: 'private-channel-id-7731', platform: 'instagram', displayName: 'Published social account', status: 'ready',
          connectionStatus: 'active', lastSyncedAt: at, provider_user_id: privateMarker, encrypted_payload: privateMarker,
          metrics: [
            { key: 'followers', value: 120, state: 'available', period: 'snapshot', observedAt: at, source: 'instagram.followers_count', token: privateMarker },
            { key: 'reach', value: -1, state: 'available', source: privateMarker },
            { key: 'private_metric', value: 7751, state: 'available', source: privateMarker },
          ],
          posts: [
            { id: 'private-publication-id-7732', publishedAt: at, observedAt: at, status: 'ready', title: privateMarker, caption: privateMarker, remote_id: privateMarker, permalink: 'javascript:alert(1)', metrics: [{ key: 'likes', value: 9, state: 'available', period: 'snapshot', observedAt: at, source: 'instagram.like_count', raw: privateMarker }] },
            { id: 'private-publication-id-7733', publishedAt: at, status: 'ready', permalink: 'http://127.0.0.1/private-media', metrics: [] },
            { id: 'private-draft-id-7734', title: privateMarker, publishedAt: null, metrics: [] },
          ],
        }],
      };
    } };
    try {
      const beforeChanges = h.db.prepare('SELECT total_changes() AS n').get().n;
      const response = await publicRequest(h, raw);
      assert.equal(response.status, 200, response.body);
      assert.deepEqual(calls, [[h.tenant.id, h.visible.id]]);
      assert.equal(network, 0);
      assert.equal(h.db.prepare('SELECT total_changes() AS n').get().n, beforeChanges, 'Public reads cannot mutate application state');
      assert.ok(!response.body.includes(privateMarker));
      assert.doesNotMatch(response.body, /private-channel-id|private-publication-id|private-draft-id|private_metric|provider_user_id|encrypted_payload|remote_id|caption|memberships/);
      assert.equal(response.data.accounts.length, 1); assert.equal(response.data.posts.length, 2);
      assert.equal(response.data.accounts[0].metrics.followers, 120); assert.equal(response.data.accounts[0].metrics.reach, null);
      assert.equal(response.data.posts[0].metrics.likes, 9);
      assert.ok(response.data.posts.every(post => post.permalink === null));
    } finally { h.app.ctx.services.socialMetrics = previous; globalThis.fetch = previousFetch; }
  });

  await t.test('bearer transport is header-only, canonical and opaque for invalid, encoded or misplaced tokens', async () => {
    const baseline = await publicRequest(h, 'A'.repeat(43)); assertOpaqueFailure(baseline);
    for (const secret of [undefined, '', raw + '=', raw + 'x', raw.slice(1), '%41' + raw.slice(1), encodeURIComponent('Bearer ' + raw), raw + ',other', raw + ' ', '"' + raw + '"']) {
      const response = await publicRequest(h, secret);
      assertOpaqueFailure(response); assert.deepEqual(response.json.error, baseline.json.error);
    }
    for (const authorization of [raw, `Basic ${raw}`, `Bearer  ${raw}`, `Bearer ${raw}, Bearer ${raw}`]) assertOpaqueFailure(await publicRequest(h, undefined, { headers: { authorization } }));
    for (const path of [`${PUBLIC}?token=${raw}`, `${PUBLIC}?access_token=${raw}`, `${PUBLIC}?workspaceId=${h.hidden.id}`, `${PUBLIC}/${raw}`]) {
      const response = await publicRequest(h, undefined, { path });
      assert.ok([404, 422].includes(response.status), response.body); assert.ok(!response.body.includes(raw));
    }
    const combined = await publicRequest(h, raw, { path: `${PUBLIC}?workspaceId=${h.hidden.id}` });
    assert.ok([404, 422].includes(combined.status), combined.body);
    const cookie = await publicRequest(h, undefined, { headers: { cookie: `token=${raw}; dashboardToken=${raw}` } }); assertOpaqueFailure(cookie);
  });

  await t.test('a dashboard bearer cannot read private APIs, create a session or authorize any mutation', async () => {
    const before = h.db.prepare('SELECT count(*) AS n FROM posts').get().n;
    for (const path of [h.base, route(h.tenant, h.visible, '/posts'), route(h.tenant, h.visible, '/strategy/dashboard'), `/api/v1/tenants/${h.tenant.id}/members`, '/api/v1/me']) {
      const response = await publicRequest(h, raw, { path }); assert.equal(response.status, 401, response.body);
    }
    for (const [path, payload] of [
      [h.base, input()], [`${h.base}/${main.id}/revoke`, { expectedVersion: main.version }],
      [route(h.tenant, h.visible, '/posts'), { title: 'UNAUTHORIZED MUTATION' }],
      [route(h.tenant, h.visible, '/social-metrics/sync'), {}],
      [PUBLIC, {}],
    ]) {
      const response = await publicRequest(h, raw, { path, method: 'POST', payload, headers: { origin: h.app.ctx.config.canonicalOrigin, 'idempotency-key': randomUUID() } });
      assert.ok([401, 403, 404].includes(response.status), response.body);
    }
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM posts').get().n, before);
    assert.equal((await publicRequest(h, raw)).status, 200);
  });

  await t.test('every public read rechecks creator role, membership, account, brand and tenant eligibility', async () => {
    const cases = [
      ["UPDATE memberships SET status='inactive' WHERE tenant_id=? AND user_id=?", "UPDATE memberships SET status='active' WHERE tenant_id=? AND user_id=?", [h.tenant.id, p.admin.user.id]],
      ["UPDATE memberships SET role='editor',scope='workspaces' WHERE tenant_id=? AND user_id=?", "UPDATE memberships SET role='admin',scope='organization' WHERE tenant_id=? AND user_id=?", [h.tenant.id, p.admin.user.id]],
      ["UPDATE users SET status='blocked' WHERE id=?", "UPDATE users SET status='active' WHERE id=?", [p.admin.user.id]],
      ["UPDATE workspaces SET archived_at='2026-10-14T00:00:00.000Z' WHERE tenant_id=? AND id=?", 'UPDATE workspaces SET archived_at=NULL WHERE tenant_id=? AND id=?', [h.tenant.id, h.visible.id]],
      ["UPDATE tenants SET status='suspended' WHERE id=?", "UPDATE tenants SET status='active' WHERE id=?", [h.tenant.id]],
    ];
    for (const [block, restore, values] of cases) {
      assert.equal((await publicRequest(h, adminRaw)).status, 200);
      h.db.prepare(block).run(...values);
      try { assertOpaqueFailure(await publicRequest(h, adminRaw)); }
      finally { h.db.prepare(restore).run(...values); }
    }
    const originalExpiry = h.db.prepare('SELECT expires_at FROM client_dashboard_shares WHERE id=?').get(adminShare.id).expires_at;
    h.db.prepare('UPDATE client_dashboard_shares SET expires_at=? WHERE id=?').run(h.app.ctx.now(), adminShare.id);
    assertOpaqueFailure(await publicRequest(h, adminRaw));
    h.db.prepare('UPDATE client_dashboard_shares SET expires_at=? WHERE id=?').run(originalExpiry, adminShare.id);
    assert.equal((await publicRequest(h, adminRaw)).status, 200);
  });

  await t.test('active sharing is bounded per brand and revocation frees capacity without replaying secrets', async () => {
    const temporary = [];
    for (let i = 0; i < 3; i++) temporary.push(await p.owner.client.ok('POST', h.base, input({ label: 'Bounded extra link ' + i, expiresInDays: i === 0 ? 1 : 90 }), idempotency()));
    const denied = await p.owner.client.request('POST', h.base, input({ label: 'Sixth active link' }), idempotency());
    assert.equal(denied.status, 409, denied.body); assert.equal(denied.json.error.code, 'SHARE_LIMIT');
    for (const share of temporary) await p.owner.client.ok('POST', `${h.base}/${share.id}/revoke`, { expectedVersion: share.version }, idempotency());
    const replacement = await p.owner.client.ok('POST', h.base, input({ label: 'Capacity restored' }), idempotency());
    assert.ok(!temporary.map(tokenFrom).includes(tokenFrom(replacement)));
    await p.owner.client.ok('POST', `${h.base}/${replacement.id}/revoke`, { expectedVersion: replacement.version }, idempotency());
  });

  await t.test('revocation requires exact version, is immediate, and replay never recovers the bearer', async () => {
    for (const role of ['editor', 'reviewer', 'viewer']) assert.equal((await p[role].client.request('POST', `${h.base}/${main.id}/revoke`, { expectedVersion: main.version }, idempotency())).status, 403);
    const stale = await p.owner.client.request('POST', `${h.base}/${main.id}/revoke`, { expectedVersion: main.version + 1 }, idempotency());
    assert.equal(stale.status, 409); assert.equal((await publicRequest(h, raw)).status, 200);
    const revokeKey = idempotency();
    const revoked = await p.owner.client.ok('POST', `${h.base}/${main.id}/revoke`, { expectedVersion: main.version }, revokeKey);
    assert.ok(revoked.revokedAt); assert.equal(revoked.version, main.version + 1);
    assertOpaqueFailure(await publicRequest(h, raw));
    const repeat = await p.owner.client.request('POST', `${h.base}/${main.id}/revoke`, { expectedVersion: main.version }, revokeKey);
    assert.ok([200, 409].includes(repeat.status)); assert.ok(!repeat.body.includes(raw));
    const list = await p.owner.client.ok('GET', h.base);
    assert.ok(list.find(row => row.id === main.id).revokedAt);
    assert.ok(!h.logs.join('').includes(raw));
  });
});

async function viewerPage(h, t, { hash = '#token=' + 'A'.repeat(43), reply, beforeReply } = {}) {
  const { JSDOM, VirtualConsole, requestInterceptor } = await import('jsdom');
  const origin = h.app.ctx.config.canonicalOrigin, requests = [], resourcesSeen = [], storageWrites = [], errors = [];
  const html = await h.app.inject({ url: '/client-dashboard', headers: { host: new URL(origin).host } });
  assert.equal(html.statusCode, 200, html.body);
  const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', error => errors.push(error));
  const resources = { interceptors: [requestInterceptor(async request => {
    const url = new URL(request.url); resourcesSeen.push(url.href);
    assert.equal(url.origin, origin, 'Public dashboard must not load external scripts, fonts or images');
    assert.equal(url.hash, ''); assert.ok(!url.search.includes('token'));
    const result = await h.app.inject({ url: url.pathname + url.search, headers: { host: url.host } });
    assert.equal(result.statusCode, 200, result.body);
    return new Response(result.rawPayload, { status: result.statusCode, headers: result.headers });
  })] };
  const dom = new JSDOM(html.body, {
    url: origin + '/client-dashboard' + hash, runScripts: 'dangerously', resources, pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.Storage.prototype.setItem = function (key, value) { storageWrites.push({ key, value }); throw new Error('Public bearer persistence forbidden'); };
      window.fetch = async (path, options = {}) => {
        const url = new URL(path, window.location.href);
        requests.push({ url, options, browserURL: window.location.href });
        const requestNumber = requests.length;
        if (beforeReply) await beforeReply({ path, options, window });
        const result = typeof reply === 'function' ? reply(requestNumber) : reply;
        return new Response(JSON.stringify(result?.body ?? { data: publicFixture() }), { status: result?.status ?? 200, headers: { 'content-type': 'application/json' } });
      };
    },
  });
  t.after(() => dom.window.close());
  const page = { window: dom.window, document: dom.window.document, requests, resourcesSeen, storageWrites, errors };
  page.wait = async (condition, label) => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { if (condition()) return; if (errors.length) throw errors[0]; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error(`Public view timed out: ${label}. ${page.document.body.textContent.slice(-2000)}`); };
  page.text = () => page.document.body.textContent;
  await page.wait(() => page.document.readyState === 'complete', 'public assets loaded');
  return page;
}
function publicFixture(overrides = {}) {
  return {
    brand: { name: 'Client-approved brand' }, period: { start: null, end: null, label: 'Última coleta disponível' },
    generatedAt: '2026-10-14T12:00:00.000Z', lastSyncedAt: null, stale: false,
    collection: { enabled: false, status: 'disabled', lastAttemptAt: null, nextRunAt: null },
    accounts: [], posts: [], notices: [{ code: 'METRICS_DISABLED', message: 'A coleta ainda não está ativada.' }], ...overrides,
  };
}

test('security client dashboard DOM: fragment-only bearer transport, inert display and safe navigation', async t => {
  const h = await harness(t);
  const marker = '<img src=x onerror="window.shareXss=true">';
  const raw = 'A'.repeat(43);
  const page = await viewerPage(h, t, { reply: { body: { data: publicFixture({ brand: { name: marker } }) } } });
  await page.wait(() => page.document.querySelector('.sr-dashboard'), 'public report');
  assert.equal(page.requests.length, 1);
  const request = page.requests[0];
  assert.equal(request.url.pathname, PUBLIC); assert.equal(request.url.search, ''); assert.equal(request.url.hash, '');
  assert.ok(!request.browserURL.includes(raw), 'Fragment must be erased before fetching any report data');
  assert.equal(new Headers(request.options.headers).get('authorization'), `Bearer ${raw}`);
  assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.cache, 'no-store');
  assert.equal(request.options.redirect, 'error'); assert.equal(request.options.mode, 'same-origin');
  assert.equal(request.options.referrerPolicy, 'no-referrer');
  assert.equal(page.window.location.hash, ''); assert.equal(page.window.document.cookie, '');
  assert.deepEqual(page.storageWrites, []);
  assert.ok(page.text().includes(marker)); assert.equal(page.document.querySelector('img[onerror]'), null); assert.equal(page.window.shareXss, undefined);
  assert.ok(!page.document.documentElement.outerHTML.includes(raw));
  assert.ok(page.resourcesSeen.every(url => !url.endsWith('/app.js')));
  page.window.location.hash = '#token=invalid';
  await page.wait(() => !page.document.querySelector('.sr-dashboard') && page.document.querySelector('.sr-empty'), 'invalid navigation clears the previous report');
  assert.ok(!page.text().includes(marker)); assert.equal(page.requests.length, 1, 'Invalid navigation must never reuse the previous bearer');
  assert.equal(page.errors.length, 0);
});

test('security client dashboard DOM: malformed/duplicate/encoded token fragments cannot authorize requests', async t => {
  const h = await harness(t), raw = 'A'.repeat(43);
  for (const hash of ['', '#token=', '#token=short', '#token=' + '%41'.repeat(43), `#token=${raw}&token=${'B'.repeat(43)}`, `#token=${raw}&workspace=foreign`]) {
    const page = await viewerPage(h, t, { hash });
    await page.wait(() => page.document.querySelector('.sr-empty'), 'invalid-link display');
    assert.equal(page.requests.length, 0, `Malformed fragment must not issue an authenticated API request: ${hash}`);
    assert.ok(!page.document.documentElement.outerHTML.includes(raw)); assert.equal(page.window.location.hash, '');
    assert.equal(page.errors.length, 0);
  }
});

test('security client dashboard DOM: invalid responses and revoked links fail closed without stale content', async t => {
  const h = await harness(t);
  for (const reply of [
    { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Recurso não encontrado.' } } },
    { body: { data: null } }, { body: { data: [] } }, { body: { data: { brand: { name: 'PARTIAL PRIVATE MARKER' }, accounts: 'wrong shape' } } },
    { body: { data: publicFixture({ accounts: [{ platform: 'instagram', displayName: 'INVALID ACCOUNT MARKER', metrics: 'wrong shape' }] }) } },
  ]) {
    const page = await viewerPage(h, t, { reply });
    await page.wait(() => page.document.querySelector('.sr-empty'), 'safe unavailable display');
    assert.equal(page.document.querySelector('.sr-dashboard'), null);
    assert.doesNotMatch(page.text(), /PARTIAL PRIVATE MARKER|INVALID ACCOUNT MARKER|NaN|undefined|\[object Object\]/);
    assert.equal(page.window.location.hash, ''); assert.equal(page.storageWrites.length, 0); assert.equal(page.errors.length, 0);
  }
});

test('security client dashboard DOM: late responses cannot restore data after pagehide or history navigation', async t => {
  const h = await harness(t);
  for (const eventName of ['pagehide', 'popstate', 'pageshow']) {
    let entered, unblock;
    const started = new Promise(resolve => { entered = resolve; });
    const hold = new Promise(resolve => { unblock = resolve; });
    const page = await viewerPage(h, t, {
      beforeReply: async () => { entered(); await hold; },
      reply: { body: { data: publicFixture({ brand: { name: 'STALE LATE REPORT SENTINEL' } }) } },
    });
    await started;
    page.window.dispatchEvent(eventName === 'pageshow' ? new page.window.PageTransitionEvent(eventName, { persisted: true }) : new page.window.Event(eventName));
    unblock();
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(page.document.querySelector('.sr-dashboard'), null, eventName);
    assert.ok(!page.text().includes('STALE LATE REPORT SENTINEL'), eventName);
    assert.ok(page.requests[0].options.signal.aborted, eventName);
    assert.equal(page.requests.length, 1); assert.equal(page.window.location.hash, ''); assert.equal(page.errors.length, 0);
  }
});


test('security client dashboard DOM: untrusted numeric values and external links are not presented as valid results', async t => {
  const h = await harness(t);
  const page = await viewerPage(h, t, { reply: { body: { data: publicFixture({
    accounts: [{ id: 'safe-account', platform: 'instagram', displayName: 'Approved public account', status: 'ready', metrics: { followers: -100, reach: '321', impressions: { nested: 123 }, engagements: null, profileViews: 0 } }],
    posts: [
      { id: 'first', platform: 'instagram', publishedAt: '2026-10-14T12:00:00.000Z', permalink: 'javascript:alert(1)', metrics: {} },
      { id: 'second', platform: 'facebook', publishedAt: '2026-10-14T12:00:00.000Z', permalink: 'https://facebook.com.attacker.invalid/posts/123', metrics: {} },
      { id: 'third', platform: 'instagram', publishedAt: '2026-10-14T12:00:00.000Z', permalink: 'https://www.instagram.com/p/SAFEPOST/', metrics: { likes: 7 } },
    ],
  }) } } });
  await page.wait(() => page.document.querySelector('.sr-dashboard'), 'public numeric projection');
  assert.doesNotMatch(page.text(), /-100|321|NaN|undefined|\[object Object\]/);
  assert.match(page.text(), /Não disponível/);
  const links = [...page.document.querySelectorAll('#client-dashboard a[href]')];
  assert.equal(links.length, 1); assert.equal(links[0].href, 'https://www.instagram.com/p/SAFEPOST/');
  assert.equal(links[0].getAttribute('referrerpolicy'), 'no-referrer');
  assert.match(links[0].rel, /noopener/); assert.match(links[0].rel, /noreferrer/);
  assert.equal(page.errors.length, 0);
});


test('security client dashboard: invalid bearer enumeration is rate limited and shell aliases are non-cacheable', async t => {
  const h = await harness(t), host = new URL(h.app.ctx.config.canonicalOrigin).host;
  for (const url of ['/client-dashboard', '/client-dashboard.html']) {
    const response = await h.app.inject({ url, headers: { host } });
    assert.equal(response.statusCode, 200); assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.headers['referrer-policy'], 'no-referrer'); assert.match(response.headers['x-robots-tag'], /noindex/);
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  const responses = [];
  for (let i = 0; i < 61; i++) responses.push(await h.app.inject({ url: PUBLIC, remoteAddress: '127.9.3.7', headers: { host, authorization: 'Bearer ' + 'A'.repeat(43) } }));
  assert.ok(responses.some(response => response.statusCode === 404));
  assert.equal(responses.at(-1).statusCode, 429);
  assert.match(responses.at(-1).headers['cache-control'], /no-store/);
  assert.ok(!responses.at(-1).body.includes('A'.repeat(43)));
});

test('security client dashboard: offline restore cannot reactivate previously issued read links or metric collection', async t => {
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { privateBackup } = await import('../src/backup.mjs');
  const { restoreCheck } = await import('../scripts/restore-check.mjs');
  const h = await harness(t), owner = await verified(h, 'restore-dashboard-owner');
  const tenant = await owner.client.ok('POST', '/api/v1/tenants', { name: 'Restore share fixture', timezone: 'UTC' }, idempotency());
  const brand = await owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Restore brand' }, idempotency());
  const share = await owner.client.ok('POST', route(tenant, brand, '/dashboard-shares'), input(), idempotency());
  const raw = tokenFrom(share), at = h.app.ctx.now();
  h.db.prepare('INSERT INTO social_metrics_settings(tenant_id,workspace_id,enabled,cadence_minutes,enabled_by,version,updated_at) VALUES(?,?,1,15,?,1,?)').run(tenant.id, brand.id, owner.user.id, at);
  const source = join(h.dataDir, 'dashboard.snapshot.sqlite'), targetDir = join(h.dataDir, 'dashboard-restore');
  await privateBackup(h.app.ctx.filename, source);
  const report = await restoreCheck({ source, targetDir, liveDataDir: h.dataDir, consistentSnapshotConfirmed: true });
  assert.equal(report.result, 'verified_offline_only');
  const restored = new DatabaseSync(join(targetDir, 'social-saas.sqlite'), { readOnly: true, allowExtension: false });
  try {
    const row = restored.prepare('SELECT * FROM client_dashboard_shares WHERE id=?').get(share.id);
    assert.ok(row.revoked_at, 'A restored snapshot must not resurrect old bearer capabilities');
    assert.ok(row.version > share.version);
    assert.equal(restored.prepare('SELECT enabled FROM social_metrics_settings WHERE tenant_id=? AND workspace_id=?').get(tenant.id, brand.id).enabled, 0);
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { restored.close(); }
  assert.equal(h.db.prepare('SELECT revoked_at FROM client_dashboard_shares WHERE id=?').get(share.id).revoked_at, null, 'Recovery drill must not alter its live source');
  assert.equal((await publicRequest(h, raw)).status, 200);
});

test('security client dashboard: public link reflects stored scoped account/post results without acquiring credentials', async t => {
  const { metricsFixture } = await import('./social-metrics-helpers.mjs');
  const f = await metricsFixture(t);
  for (const channel of f.channels) { await f.connect(channel); await f.published(channel); }
  f.configure(); await f.service.tick();
  const share = await f.owner.client.ok('POST', route(f.tenant, f.workspace, '/dashboard-shares'), input(), idempotency());
  const raw = tokenFrom(share), beforeCalls = f.transport.calls.length;
  const resolver = f.app.ctx.services.socialConnections.resolveBinding;
  f.app.ctx.services.socialConnections.resolveBinding = () => { throw new Error('PUBLIC_VIEW_MUST_NOT_ACCESS_CREDENTIALS'); };
  try {
    const response = await publicRequest(f, raw);
    assert.equal(response.status, 200, response.body);
    assert.equal(response.data.accounts.length, 2); assert.equal(response.data.posts.length, 2);
    for (const account of response.data.accounts) { assert.equal(account.metrics.followers, 51); assert.equal(account.metrics.reach, null); assert.equal(account.status, 'partial'); }
    assert.equal(response.data.posts.find(post => post.platform === 'facebook').metrics.likes, 0);
    assert.equal(response.data.posts.find(post => post.platform === 'instagram').metrics.likes, 7);
    assert.equal(response.data.posts.find(post => post.platform === 'instagram').metrics.shares, null);
    assert.doesNotMatch(response.body, /PRIVATE_INTERNAL|SYNTHETIC_.*TOKEN|access_token|appsecret|encrypted|authorization_version|permissions|page_tasks|connected_by|NO_LEAK/);
    for (const channel of f.channels) assert.ok(!response.body.includes(channel.id), 'Internal IDs must be replaced by share-scoped opaque identifiers');
    assert.equal(f.transport.calls.length, beforeCalls);
    const facebook = f.channels.find(channel => channel.platform === 'facebook');
    f.db.prepare("UPDATE social_connections SET status='revoked',encrypted_payload=NULL WHERE tenant_id=? AND workspace_id=? AND channel_id=?").run(f.tenant.id, f.workspace.id, facebook.id);
    const revokedConnection = await publicRequest(f, raw);
    assert.equal(revokedConnection.status, 200);
    const fb = revokedConnection.data.accounts.find(account => account.platform === 'facebook');
    assert.equal(fb.status, 'disconnected'); assert.ok(Object.values(fb.metrics).every(value => value === null));
    const fbPost = revokedConnection.data.posts.find(post => post.platform === 'facebook');
    assert.ok(Object.values(fbPost.metrics).every(value => value === null)); assert.equal(fbPost.permalink, null);
    assert.equal(revokedConnection.data.accounts.find(account => account.platform === 'instagram').metrics.followers, 51);
    assert.equal(f.transport.calls.length, beforeCalls);
  } finally { f.app.ctx.services.socialConnections.resolveBinding = resolver; }
});


test('security client dashboard DOM: opening a new explicit capability cannot reuse the old token or late old report', async t => {
  const h = await harness(t), first = 'A'.repeat(43), second = 'B'.repeat(43);
  let enter, release;
  const started = new Promise(resolve => { enter = resolve; }), hold = new Promise(resolve => { release = resolve; });
  const page = await viewerPage(h, t, {
    beforeReply: async ({ options }) => { if (new Headers(options.headers).get('authorization') === 'Bearer ' + first) { enter(); await hold; } },
    reply: number => ({ body: { data: publicFixture({ brand: { name: number === 1 ? 'OLD PRIVATE BRAND SENTINEL' : 'NEW APPROVED BRAND SENTINEL' } }) } }),
  });
  await started;
  page.window.location.hash = '#token=' + second;
  await page.wait(() => page.document.querySelector('.sr-dashboard') && page.text().includes('NEW APPROVED BRAND SENTINEL'), 'new capability report');
  assert.equal(page.requests.length, 2); assert.ok(page.requests[0].options.signal.aborted);
  assert.equal(new Headers(page.requests[0].options.headers).get('authorization'), 'Bearer ' + first);
  assert.equal(new Headers(page.requests[1].options.headers).get('authorization'), 'Bearer ' + second);
  assert.ok(page.requests.every(request => !request.browserURL.includes(first) && !request.browserURL.includes(second)));
  release(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(page.text().includes('NEW APPROVED BRAND SENTINEL')); assert.ok(!page.text().includes('OLD PRIVATE BRAND SENTINEL'));
  assert.equal(page.window.location.hash, ''); assert.deepEqual(page.storageWrites, []);
  assert.ok(!page.document.documentElement.outerHTML.includes(first)); assert.ok(!page.document.documentElement.outerHTML.includes(second));
  assert.equal(page.errors.length, 0);
});

test('security client dashboard: discovered account posts stay owner/tenant/version scoped and paging payloads never escape', async t => {
  const { metricsFixture } = await import('./social-metrics-helpers.mjs');
  const { OAUTH_FIXTURE } = await import('./social-connections-helpers.mjs');
  const { observed } = await import('../src/social-metrics/model.mjs');
  const f = await metricsFixture(t), fb = f.channels.find(channel => channel.platform === 'facebook');
  await f.connect(fb); f.configure();
  const at = new Date(f.now()).toISOString(), privateMarker = 'PRIVATE_REMOTE_PROVIDER_SENTINEL_92341';
  const ownRow = { id: `${OAUTH_FIXTURE.pageId}_70007`, from: { id: OAUTH_FIXTURE.pageId }, created_time: at, likes: { summary: { total_count: 19 } }, comments: { summary: { total_count: 0 }, data: [{ message: privateMarker, from: { id: privateMarker } }] }, message: privateMarker, caption: privateMarker, access_token: privateMarker, permalink_url: `https://www.facebook.com/${OAUTH_FIXTURE.pageId}/posts/70007?access_token=${privateMarker}` };
  f.transport.setIntercept(url => url.pathname.endsWith('/published_posts') ? f.transport.respond({ data: [ownRow], paging: { next: `https://attacker.invalid/collect?token=${privateMarker}`, cursors: { after: privateMarker } } }) : undefined);
  await f.service.tick();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM publication_jobs').get().n, 0, 'Remote account results must not require or fabricate local publishing jobs');
  const share = await f.owner.client.ok('POST', route(f.tenant, f.workspace, '/dashboard-shares'), input(), idempotency()), raw = tokenFrom(share);
  const connection = f.db.prepare('SELECT * FROM social_connections WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(f.tenant.id, f.workspace.id, fb.id);
  const otherBrand = await f.owner.client.ok('POST', `/api/v1/tenants/${f.tenant.id}/workspaces`, { name: 'PRIVATE FOREIGN METRIC BRAND', channels: [{ platform: 'facebook', label: 'Private other channel' }] }, idempotency());
  const otherChannels = await f.owner.client.ok('GET', route(f.tenant, otherBrand, '/channels'));
  const metrics = JSON.stringify([observed('likes', 987654321, 'facebook.post.likes.summary.total_count', at)]);
  const insert = f.db.prepare('INSERT INTO social_metrics_remote_posts(tenant_id,workspace_id,channel_id,remote_id,account_id,authorization_version,published_at,observed_at,permalink,metrics_json) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insert.run(f.tenant.id, f.workspace.id, fb.id, `${OAUTH_FIXTURE.pageId}_70008`, '999999', connection.authorization_version, at, at, null, metrics);
  insert.run(f.tenant.id, f.workspace.id, fb.id, `${OAUTH_FIXTURE.pageId}_70009`, OAUTH_FIXTURE.pageId, 'expired-authorization-version', at, at, null, metrics);
  insert.run(f.tenant.id, otherBrand.id, otherChannels[0].id, `${OAUTH_FIXTURE.pageId}_70010`, OAUTH_FIXTURE.pageId, connection.authorization_version, at, at, null, metrics);
  const calls = f.transport.calls.length, resolver = f.app.ctx.services.socialConnections.resolveBinding;
  f.app.ctx.services.socialConnections.resolveBinding = () => { throw Error('PUBLIC_LISTING_MUST_NOT_RESOLVE_CREDENTIALS'); };
  try {
    const report = await publicRequest(f, raw);
    assert.equal(report.status, 200, report.body); assert.equal(report.data.posts.length, 1);
    assert.equal(report.data.posts[0].metrics.likes, 19); assert.equal(report.data.posts[0].metrics.comments, 0);
    const coverage = report.data.accounts.find(account => account.platform === 'facebook').coverage;
    assert.equal(coverage.limit, 25); assert.equal(coverage.pages, 1); assert.equal(coverage.fullHistory, false);
    assert.equal(coverage.returnedCount, 1); assert.equal(coverage.hasMore, true);
    assert.doesNotMatch(report.body, /PRIVATE_REMOTE_PROVIDER|PRIVATE FOREIGN|987654321|attacker\.invalid|access_token|expired-authorization-version|remote:|70008|70009|70010/);
    assert.ok(!report.body.includes(fb.id)); assert.ok(!report.body.includes(otherBrand.id));
    assert.equal(f.transport.calls.length, calls);
    const stored = JSON.stringify({ posts: f.db.prepare('SELECT * FROM social_metrics_remote_posts').all(), discovery: f.db.prepare('SELECT * FROM social_metrics_discovery').all() });
    assert.ok(!stored.includes(privateMarker)); assert.ok(!stored.includes('attacker.invalid'));
    assert.ok(f.transport.calls.every(call => new URL(call.url).origin === 'https://graph.facebook.com'));
  } finally { f.app.ctx.services.socialConnections.resolveBinding = resolver; }
  f.advance(15 * 60000);
  f.transport.setIntercept(url => url.pathname.endsWith('/published_posts') ? f.transport.respond({ data: [{ ...ownRow, id: '999999_70011', from: { id: '999999' }, likes: { summary: { total_count: 888777666 } } }] }) : undefined);
  await f.service.tick();
  assert.equal(f.db.prepare('SELECT code FROM social_metrics_discovery WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(f.tenant.id, f.workspace.id, fb.id).code, 'METRICS_IDENTITY_MISMATCH');
  const rejectedForeign = await publicRequest(f, raw);
  assert.equal(rejectedForeign.status, 200); assert.ok(!rejectedForeign.body.includes('888777666')); assert.equal(rejectedForeign.data.posts.length, 1);
  assert.equal(rejectedForeign.data.posts[0].status, 'stale');
  f.db.prepare('UPDATE social_connections SET authorization_version=? WHERE tenant_id=? AND workspace_id=? AND channel_id=?').run('replacement-authorization-version', f.tenant.id, f.workspace.id, fb.id);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM social_metrics_remote_posts WHERE tenant_id=? AND workspace_id=? AND channel_id=?').get(f.tenant.id, f.workspace.id, fb.id).n, 0);
  assert.equal((await publicRequest(f, raw)).data.posts.length, 0);
});

test('security client dashboard: owner authorization lost during remote listing prevents persistence and publication in shared views', async t => {
  const { metricsFixture } = await import('./social-metrics-helpers.mjs');
  const { OAUTH_FIXTURE } = await import('./social-connections-helpers.mjs');
  const f = await metricsFixture(t); await f.connect(); f.configure();
  const share = await f.owner.client.ok('POST', route(f.tenant, f.workspace, '/dashboard-shares'), input(), idempotency());
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), hold = new Promise(resolve => { release = resolve; });
  f.transport.setIntercept(async url => {
    if (!url.pathname.endsWith('/published_posts')) return;
    entered(); await hold;
    return f.transport.respond({ data: [{ id: `${OAUTH_FIXTURE.pageId}_99001`, from: { id: OAUTH_FIXTURE.pageId }, created_time: new Date(f.now()).toISOString(), likes: { summary: { total_count: 774422 } } }] });
  });
  const pending = f.service.tick(); await arrived;
  // Admin retains dashboard-link authority, but cannot act as the owner who enabled collection.
  f.db.prepare("UPDATE memberships SET role='admin' WHERE tenant_id=? AND user_id=?").run(f.tenant.id, f.owner.user.id);
  release(); await pending;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM social_metrics_remote_posts').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM social_metrics_discovery').get().n, 0);
  const report = await publicRequest(f, tokenFrom(share));
  assert.equal(report.status, 200, report.body); assert.equal(report.data.posts.length, 0);
  assert.ok(report.data.accounts.every(account => Object.values(account.metrics).every(value => value === null)));
  assert.ok(!report.body.includes('774422'));
});
