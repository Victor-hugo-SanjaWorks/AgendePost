import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { publicationFixture } from './qa-publication-helpers.mjs';
import { Client, verified, invite, idempotency, route } from './qa-helpers.mjs';
import { buildWhatsAppConfig, initializeWhatsAppNotifications } from '../src/whatsapp-notifications/index.mjs';

const PHONE = '+12025550199'; // Reserved fictional number; all transport below is synthetic and offline.
const ACCESS = 'SYNTHETIC_WHATSAPP_ACCESS_TOKEN_ONLY';
function configuration(tenantId) {
  return { enabled: true, apiVersion: 'v26.0', connections: [{ tenantId, phoneNumberId: '100000001', accessToken: ACCESS, templateName: 'approval_link', languageCode: 'pt_BR', bodyFormat: 'approval_url_only', senderLabel: 'Offline verified sender' }] };
}
function bodyFor(approval, overrides = {}) { return { token: new URL(approval.approvalUrl).hash.slice(1), recipientPhone: PHONE, recipientConsented: true, confirmSend: true, ...overrides }; }
function transport() {
  const calls = []; let handler = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.OFFLINE_ONLY_123' }] }), { headers: { 'content-type': 'application/json' } });
  return { calls, set(next) { handler = next; }, async fetch(url, options) { calls.push({ url, options, payload: JSON.parse(options.body) }); return handler(url, options); } };
}
async function fixture(t) {
  const logs = [], h = await publicationFixture(t, { logger: { level: 'info', stream: { write: line => logs.push(line) } } });
  const mock = transport();
  const configure = (raw = configuration(h.tenant.id)) => initializeWhatsAppNotifications(h.app.ctx, { whatsappConfig: raw, whatsappFetch: mock.fetch });
  configure();
  async function approval() {
    const post = await h.post(); await h.approve(post);
    const created = await h.people.editor.client.ok('POST', h.path('/client-approvals'), {
      postId: post.id, expectedRevision: post.revision, channelIds: h.channels.map(channel => channel.id),
      connectionVersions: Object.fromEntries(h.channels.map(channel => [channel.id, 'qa-connection-v1'])),
      scheduledAt: new Date(h.now() + 24 * 60 * 60 * 1000).toISOString(), scheduledTimezone: 'UTC', expiresInHours: 12,
    }, idempotency());
    return { ...created, post };
  }
  const path = approval => h.path(`/client-approvals/${approval.id}/notify-whatsapp`);
  return { ...h, logs, mock, configure, approval, notificationPath: path };
}

test('security WhatsApp notifications: configuration is opt-in, tenant bound and fixed to a safe official template', () => {
  const config = { mode: 'test' };
  assert.equal(buildWhatsAppConfig(config).enabled, false);
  assert.equal(buildWhatsAppConfig(config, { whatsappConfig: configuration('tenant-one') }).enabled, true);
  assert.equal(buildWhatsAppConfig({ mode: 'development' }, { whatsappConfig: configuration('tenant-one') }).enabled, false);
  const baseline = configuration('tenant-one');
  for (const value of [
    { ...baseline, apiVersion: 'v999.0' }, { ...baseline, enabled: false },
    { ...baseline, connections: [baseline.connections[0], baseline.connections[0]] },
    ...[{ phoneNumberId: '../other' }, { tenantId: '../other' }, { accessToken: 'short' }, { accessToken: ACCESS + '\n' }, { templateName: 'unapproved template' }, { languageCode: 'pt_BR?injected' }, { bodyFormat: 'arbitrary_text' }, { senderLabel: '' }].map(change => ({ ...baseline, connections: [{ ...baseline.connections[0], ...change }] })),
  ]) {
    const result = buildWhatsAppConfig(config, { whatsappConfig: value });
    assert.equal(result.enabled, false); assert.equal(result.code, 'WHATSAPP_CONFIG_INVALID');
    assert.equal(result.connections.size, 0);
  }
});

test('security WhatsApp notifications: operator configuration file must be private, owned, regular and outside code', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'whatsapp-config-security-'));
  const code = join(root, 'repository'), operator = join(root, 'operator');
  fs.mkdirSync(code, { mode: 0o700 }); fs.mkdirSync(operator, { mode: 0o700 });
  const filename = join(operator, 'whatsapp.json'), raw = JSON.stringify(configuration('tenant-one'));
  fs.writeFileSync(filename, raw, { mode: 0o600 });
  const keys = ['SOCIAL_SAAS_WHATSAPP_ENABLED', 'SOCIAL_SAAS_WHATSAPP_CONFIG_FILE'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } fs.rmSync(root, { recursive: true, force: true }); });
  const config = { mode: 'production', root: code };
  process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = filename;
  const invalid = () => { const value = buildWhatsAppConfig(config); assert.equal(value.enabled, false); assert.equal(value.code, 'WHATSAPP_CONFIG_INVALID'); assert.equal(value.connections.size, 0); };
  for (const flag of [undefined, '', 'false', '1', 'TRUE']) {
    if (flag === undefined) delete process.env.SOCIAL_SAAS_WHATSAPP_ENABLED; else process.env.SOCIAL_SAAS_WHATSAPP_ENABLED = flag;
    const value = buildWhatsAppConfig(config); assert.equal(value.enabled, false); assert.equal(value.code, 'WHATSAPP_NOT_CONFIGURED');
  }
  process.env.SOCIAL_SAAS_WHATSAPP_ENABLED = 'true';
  assert.equal(buildWhatsAppConfig(config).enabled, true);
  assert.equal(buildWhatsAppConfig({ ...config, mode: 'test' }).enabled, false, 'Test mode must ignore a live operator environment');
  for (const mode of [0o640, 0o644, 0o660, 0o666]) { fs.chmodSync(filename, mode); invalid(); }
  fs.chmodSync(filename, 0o600);
  const symlink = join(operator, 'symlink.json'); fs.symlinkSync(filename, symlink);
  process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = symlink; invalid();
  process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = filename;
  const hardlink = join(operator, 'hardlink.json'); fs.linkSync(filename, hardlink); invalid();
  process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = hardlink; invalid(); fs.unlinkSync(hardlink);
  const insideCode = join(code, 'whatsapp.json'); fs.writeFileSync(insideCode, raw, { mode: 0o600 });
  process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = insideCode; invalid();
  const codeAlias = join(operator, 'repository-alias'); fs.symlinkSync(code, codeAlias, 'dir');
  process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = join(codeAlias, 'whatsapp.json'); invalid();
  for (const path of [operator, 'relative-config.json', join(operator, 'missing.json')]) { process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = path; invalid(); }
  process.env.SOCIAL_SAAS_WHATSAPP_CONFIG_FILE = filename;
  for (const contents of ['{', '{}', ' '.repeat(131073)]) { fs.writeFileSync(filename, contents); invalid(); }
  fs.writeFileSync(filename, raw); assert.equal(buildWhatsAppConfig(config).enabled, true);
  // Exercise the ownership branch without privileged chown or altering anyone else's files.
  const originalFstat = fs.fstatSync;
  const ownerCheck = t.mock.method(fs, 'fstatSync', (...args) => { const stat = originalFstat(...args); Object.defineProperty(stat, 'uid', { value: process.getuid() + 1 }); return stat; });
  syncBuiltinESMExports();
  try { invalid(); } finally { ownerCheck.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(buildWhatsAppConfig(config).enabled, true);
  for (const mode of ['development', 'production']) {
    assert.equal(buildWhatsAppConfig({ ...config, mode }, { whatsappConfig: configuration('tenant-one') }).enabled, false);
    assert.equal(buildWhatsAppConfig({ ...config, mode }, { whatsappFetch: async () => { throw Error('MUST_NOT_RUN'); } }).enabled, false);
  }
});

test('security WhatsApp notifications: explicit send, scope, one-attempt behavior and secret redaction', async t => {
  const h = await fixture(t), owner = h.people.owner.client;
  let approved;

  await t.test('readiness reveals no credentials and disabled/foreign tenant configuration never sends', async () => {
    const readiness = await owner.request('GET', h.path('/whatsapp-notification-status'));
    assert.equal(readiness.status, 200, readiness.body); assert.equal(readiness.data.configured, true);
    assert.equal(readiness.data.deliveryTracking, false); assert.equal(readiness.data.templateOnly, true);
    assert.doesNotMatch(readiness.body, /accessToken|phoneNumberId|templateName|SYNTHETIC/);
    approved = await h.approval();
    for (const config of [undefined, configuration('another-tenant')]) {
      h.configure(config === undefined ? null : config);
      const response = await owner.request('POST', h.notificationPath(approved), bodyFor(approved), idempotency());
      assert.equal(response.status, 503, response.body); assert.equal(h.mock.calls.length, 0);
    }
    for (const mode of ['development', 'production']) {
      initializeWhatsAppNotifications({ ...h.app.ctx, config: { ...h.app.ctx.config, mode } }, { whatsappConfig: configuration(h.tenant.id), whatsappFetch: h.mock.fetch });
      const deniedOverride = await owner.request('POST', h.notificationPath(approved), bodyFor(approved), idempotency());
      assert.equal(deniedOverride.status, 503, deniedOverride.body); assert.equal(h.mock.calls.length, 0);
    }
    h.configure();
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM approval_whatsapp_notifications').get().n, 0);
  });

  await t.test('CSRF, recent authentication, role, exact approval scope and explicit recipient consent are required', async () => {
    const viewer = await verified(h, 'whatsapp-viewer'), outsider = await verified(h, 'whatsapp-outsider');
    await invite(h, owner, h.tenant.id, viewer, 'viewer', [h.workspace.id]);
    for (const client of [h.people.reviewer.client, viewer.client]) {
      assert.equal((await client.request('POST', h.notificationPath(approved), bodyFor(approved), idempotency())).status, 403);
      assert.equal((await client.request('GET', h.path('/whatsapp-notification-status'))).status, 403);
    }
    assert.equal((await outsider.client.request('POST', h.notificationPath(approved), bodyFor(approved), idempotency())).status, 404);
    assert.equal((await new Client(h).request('POST', h.notificationPath(approved), bodyFor(approved), idempotency())).status, 401);
    for (const headers of [{ 'x-csrf-token': 'wrong' }, { origin: 'https://attacker.invalid' }]) assert.equal((await owner.request('POST', h.notificationPath(approved), bodyFor(approved), { headers: { ...idempotency().headers, ...headers } })).status, 403);
    h.db.prepare("UPDATE sessions SET auth_at='2001-01-01T00:00:00.000Z' WHERE user_id=? AND revoked_at IS NULL").run(h.people.owner.user.id);
    const stale = await owner.request('POST', h.notificationPath(approved), bodyFor(approved), idempotency());
    assert.equal(stale.status, 403); assert.equal(stale.json.error.code, 'REAUTH_REQUIRED');
    h.db.prepare('UPDATE sessions SET auth_at=? WHERE user_id=? AND revoked_at IS NULL').run(h.app.ctx.now(), h.people.owner.user.id);
    for (const changes of [
      { recipientConsented: false }, { confirmSend: false }, { recipientPhone: '12025550199' }, { recipientPhone: '+0123456789' },
      { recipientPhone: '+1202 5550199' }, { recipientPhone: '+12025550199123456' }, { token: 'A'.repeat(42) },
      { templateName: 'other' }, { url: 'https://attacker.invalid' }, { tenantId: 'other' }, { message: 'Unapproved text' },
    ]) assert.equal((await owner.request('POST', h.notificationPath(approved), bodyFor(approved, changes), idempotency())).status, 422);
    for (const field of ['recipientConsented', 'confirmSend', 'token']) { const body = bodyFor(approved); delete body[field]; assert.equal((await owner.request('POST', h.notificationPath(approved), body, idempotency())).status, 422); }
    assert.equal((await owner.request('POST', h.notificationPath(approved), bodyFor(approved))).status, 422);
    assert.equal((await owner.request('POST', h.notificationPath(approved), bodyFor(approved, { token: 'B'.repeat(43) }), idempotency())).status, 404);
    const other = await owner.ok('POST', `/api/v1/tenants/${h.tenant.id}/workspaces`, { name: 'Unrelated WhatsApp brand' }, idempotency());
    assert.equal((await owner.request('POST', route(h.tenant, other, `/client-approvals/${approved.id}/notify-whatsapp`), bodyFor(approved), idempotency())).status, 404);
    assert.equal(h.mock.calls.length, 0);
  });

  await t.test('one approved request sends exactly one template URL to the confirmed phone and never claims delivery', async () => {
    const key = idempotency(), body = bodyFor(approved);
    const result = await owner.request('POST', h.notificationPath(approved), body, key);
    assert.equal(result.status, 200, result.body); assert.equal(result.data.status, 'accepted');
    assert.equal(result.data.recipientLast4, PHONE.slice(-4)); assert.match(result.data.message, /ainda não foi confirmada/);
    assert.equal(h.mock.calls.length, 1);
    const call = h.mock.calls[0];
    assert.equal(call.url, 'https://graph.facebook.com/v26.0/100000001/messages');
    assert.equal(call.options.method, 'POST'); assert.equal(call.options.redirect, 'error');
    assert.equal(new Headers(call.options.headers).get('authorization'), `Bearer ${ACCESS}`);
    assert.deepEqual(call.payload, { messaging_product: 'whatsapp', recipient_type: 'individual', to: PHONE.slice(1), type: 'template', template: { name: 'approval_link', language: { code: 'pt_BR' }, components: [{ type: 'body', parameters: [{ type: 'text', text: approved.approvalUrl }] }] } });
    const duplicate = await owner.request('POST', h.notificationPath(approved), body, key);
    assert.equal(duplicate.status, 200); assert.equal(duplicate.data.id, result.data.id); assert.equal(h.mock.calls.length, 1);
    assert.equal((await owner.request('POST', h.notificationPath(approved), bodyFor(approved, { recipientPhone: '+12025550198' }), key)).status, 409);
    assert.equal((await owner.request('POST', h.notificationPath(approved), body, idempotency())).status, 429);
    assert.equal(h.mock.calls.length, 1);
    const tables = h.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const { name } of tables) {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
      const contents = JSON.stringify(h.db.prepare(`SELECT * FROM "${name}"`).all());
      for (const secret of [body.token, PHONE, PHONE.slice(1), ACCESS]) assert.ok(!contents.includes(secret), `Secret leaked to ${name}`);
    }
    for (const secret of [body.token, PHONE, ACCESS]) { assert.ok(!result.body.includes(secret)); assert.ok(!h.logs.join('').includes(secret)); }
  });

  await t.test('timeout/network/invalid success and provider errors preserve unknown-or-rejected outcomes without automatic retries', async () => {
    const variants = [
      { handler: async () => { throw new Error('SYNTHETIC_PRIVATE_NETWORK_ERROR ' + ACCESS); }, expected: 'unknown' },
      { handler: async () => new Response(JSON.stringify({ messages: [{ id: '<bad-provider-id>' }], token: ACCESS }), { headers: { 'content-type': 'application/json' } }), expected: 'unknown' },
      { handler: async () => new Response(JSON.stringify({ error: { message: ACCESS } }), { status: 503, headers: { 'content-type': 'application/json' } }), expected: 'unknown' },
      { handler: async () => new Response(JSON.stringify({ error: { message: ACCESS } }), { status: 400, headers: { 'content-type': 'application/json' } }), expected: 'rejected' },
    ];
    for (const variant of variants) {
      const approval = await h.approval(), key = idempotency(); h.mock.set(variant.handler);
      const before = h.mock.calls.length;
      const response = await owner.request('POST', h.notificationPath(approval), bodyFor(approval), key);
      assert.equal(response.status, 200, response.body); assert.equal(response.data.status, variant.expected);
      assert.equal(h.mock.calls.length, before + 1); assert.ok(!response.body.includes(ACCESS));
      const repeated = await owner.request('POST', h.notificationPath(approval), bodyFor(approval), key);
      assert.equal(repeated.status, 200); assert.equal(repeated.data.id, response.data.id); assert.equal(h.mock.calls.length, before + 1);
      assert.ok(!h.logs.join('').includes(ACCESS));
    }
  });

  await t.test('duplicate submissions while delivery is in flight do not make another provider call', async () => {
    const approval = await h.approval(), key = idempotency(); let entered, finish;
    const started = new Promise(resolve => { entered = resolve; }); const hold = new Promise(resolve => { finish = resolve; });
    h.mock.set(async () => { entered(); await hold; return new Response(JSON.stringify({ messages: [{ id: 'wamid.CONCURRENT_OFFLINE' }] }), { headers: { 'content-type': 'application/json' } }); });
    const before = h.mock.calls.length;
    const pending = owner.request('POST', h.notificationPath(approval), bodyFor(approval), key); await started;
    const duplicate = await owner.request('POST', h.notificationPath(approval), bodyFor(approval), key);
    assert.equal(duplicate.status, 200, duplicate.body); assert.equal(duplicate.data.status, 'unknown'); assert.equal(h.mock.calls.length, before + 1);
    finish(); const result = await pending; assert.equal(result.data.status, 'accepted'); assert.equal(h.mock.calls.length, before + 1);
  });

  await t.test('revoked, expired, changed or no-longer-authorized approval requests cannot be notified', async () => {
    const approval = await h.approval(); const original = h.db.prepare('SELECT * FROM client_approval_requests WHERE id=?').get(approval.id);
    const before = h.mock.calls.length;
    for (const [field, value] of [['status', 'revoked'], ['status', 'approved'], ['expires_at', h.app.ctx.now()]]) {
      h.db.prepare(`UPDATE client_approval_requests SET ${field}=? WHERE id=?`).run(value, approval.id);
      const response = await owner.request('POST', h.notificationPath(approval), bodyFor(approval), idempotency()); assert.equal(response.status, 404, response.body);
      h.db.prepare(`UPDATE client_approval_requests SET ${field}=? WHERE id=?`).run(original[field], approval.id);
    }
    h.db.prepare("UPDATE memberships SET status='inactive' WHERE tenant_id=? AND user_id=?").run(h.tenant.id, h.people.editor.user.id);
    const unauthorized = await owner.request('POST', h.notificationPath(approval), bodyFor(approval), idempotency());
    assert.ok([403, 404].includes(unauthorized.status), unauthorized.body);
    h.db.prepare("UPDATE memberships SET status='active' WHERE tenant_id=? AND user_id=?").run(h.tenant.id, h.people.editor.user.id);
    await h.people.editor.client.ok('PATCH', h.path(`/posts/${approval.post.id}`), { expectedRevision: approval.post.revision, caption: 'Updated after the approval link' }, idempotency());
    const changed = await owner.request('POST', h.notificationPath(approval), bodyFor(approval), idempotency()); assert.ok([404, 409].includes(changed.status), changed.body);
    assert.equal(h.mock.calls.length, before);
  });
});


test('security WhatsApp notifications: abort-ignoring fetch, body and cancellation are bounded without a duplicate send', { timeout: 24000 }, async t => {
  const h = await fixture(t), cases = new Map();
  for (const kind of ['fetch', 'body', 'cancel', 'body-cancel-reject']) { const approval = await h.approval(); cases.set(approval.approvalUrl, { kind, approval, key: idempotency() }); }
  const never = () => new Promise(() => {});
  h.mock.set(async (_url, options) => {
    const entry = cases.get(JSON.parse(options.body).template.components[0].parameters[0].text);
    if (entry.kind === 'fetch') return never();
    let read = 0;
    return { status: 200, headers: new Headers({ 'content-type': 'application/json' }), body: { getReader() { return {
      read() { if (entry.kind.startsWith('body')) return never(); return Promise.resolve(++read === 1 ? { done: false, value: Buffer.from(JSON.stringify({ messages: [{ id: 'wamid.COMPLETE_BODY_OFFLINE' }] })) } : { done: true }); },
      cancel() { return entry.kind === 'body-cancel-reject' ? Promise.reject(new Error('Synthetic cancel rejection')) : never(); },
    }; } } };
  });
  const startedAt = performance.now();
  const results = await Promise.all([...cases.values()].map(async entry => ({ entry, response: await h.people.owner.client.request('POST', h.notificationPath(entry.approval), bodyFor(entry.approval), entry.key) })));
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed >= 14000 && elapsed < 21000, `Transport deadline was not bounded: ${elapsed} ms`);
  assert.equal(h.mock.calls.length, 4);
  for (const { entry, response } of results) {
    assert.equal(response.status, 200, response.body);
    assert.equal(response.data.status, entry.kind === 'cancel' ? 'accepted' : 'unknown');
    const repeated = await h.people.owner.client.request('POST', h.notificationPath(entry.approval), bodyFor(entry.approval), entry.key);
    assert.equal(repeated.data.id, response.data.id); assert.equal(repeated.data.status, response.data.status);
  }
  assert.equal(h.mock.calls.length, 4);
  assert.ok(h.mock.calls.every(call => call.options.signal.aborted));
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM approval_whatsapp_notifications WHERE status='sending'").get().n, 0);
});
