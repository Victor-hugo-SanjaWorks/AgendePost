import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm, writeFile, chmod, link, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { buildConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { issueOperatorAccess } from '../src/operator-access.mjs';
import { multipart } from './qa-helpers.mjs';

// Independent offline review. Every request uses Fastify injection; no Meta,
// SMTP, hosting or external HTTP request is made by this suite.
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://agendepost.example';
const PASSWORD = 'Hosted pilot independent password!';
const digest = value => createHash('sha256').update(value).digest('hex');
const tokenFrom = issued => new URLSearchParams(new URL(issued.url).hash.split('?')[1]).get('token');
const goodHeaders = {
  host: 'agendepost.example',
  'x-forwarded-proto': 'https',
  'x-forwarded-for': '203.0.113.4'
};

async function privateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agendepost-hosted-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function hosted(dataDir, overrides = {}) {
  return { mode: 'test', deployment: 'hosted-pilot', trustedProxy: 'loopback',
    canonicalOrigin: ORIGIN, dataDir, logger: false, ...overrides };
}
async function appFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agendepost-hosted-review-'));
  const app = await createApp(hosted(directory, options));
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return app;
}
function inject(app, { headers = {}, remoteAddress = '127.0.0.1', ...options } = {}) {
  const combined = { ...goodHeaders, ...headers };
  for (const key of Object.keys(combined)) if (combined[key] === undefined) delete combined[key];
  return app.inject({ method: 'GET', url: '/api/v1/auth/session',
    remoteAddress, headers: combined, ...options });
}
const rejected = response => {
  assert.ok(response.statusCode >= 400 && response.statusCode < 500,
    `Expected a safe rejection, received ${response.statusCode}: ${response.body}`);
  assert.doesNotMatch(response.body, /SQLITE_|SELECT |INSERT INTO|node:|password_hash|token_hash/);
};
class HostedClient {
  constructor(app) { this.app = app; this.cookies = new Map(); this.csrf = null; }
  get cookie() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  async request(method, url, payload, headers = {}) {
    const response = await inject(this.app, { method, url, payload,
      headers: { origin: ORIGIN, cookie: this.cookie, ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}), ...headers } });
    for (const cookie of response.cookies) {
      if (!cookie.value || cookie.maxAge === 0) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    if (response.headers['content-type']?.includes('application/json')) {
      const csrf = response.json().data?.csrfToken;
      if (csrf) this.csrf = csrf;
    }
    return response;
  }
  async ok(method, url, payload, headers) {
    const response = await this.request(method, url, payload, headers);
    assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${method} ${url}: ${response.body}`);
    return response.json().data;
  }
  async bootstrap() { return this.ok('GET', '/api/v1/auth/session'); }
}
async function enrolled(app, email) {
  const client = new HostedClient(app), issued = issueOperatorAccess(app.ctx.config, { purpose: 'enroll', email, displayName: email.split('@')[0] });
  await client.bootstrap();
  await client.ok('POST', '/api/v1/auth/email/verify', { token: tokenFrom(issued), password: PASSWORD });
  await client.ok('POST', '/api/v1/auth/login', { email, password: PASSWORD });
  return client;
}

test('hosted review: production remains an explicit, single-host opt-in', async t => {
  const directory = await privateDir(t);
  assert.throws(() => buildConfig({ mode: 'production', dataDir: directory }));
  assert.throws(() => buildConfig(hosted(directory, { deployment: 'public-production' })));
  for (const host of ['0.0.0.0', '::', 'localhost', '192.0.2.10'])
    assert.throws(() => buildConfig(hosted(directory, { host })), `bind ${host}`);
  for (const trustedProxy of [undefined, false, true, '*', '127.0.0.0/8', 'private'])
    assert.throws(() => buildConfig(hosted(directory, { trustedProxy })), `proxy ${trustedProxy}`);
  const config = buildConfig(hosted(directory, { mode: 'production' }));
  assert.equal(config.deployment, 'hosted-pilot');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.secureCookies, true);
  assert.equal(config.sessionCookie, '__Host-ss_session');
  assert.equal(config.preauthCookie, '__Host-ss_preauth');
});

test('hosted review: canonical public origin is HTTPS DNS-only without alternate authorities', async t => {
  const directory = await privateDir(t);
  for (const canonicalOrigin of [
    'http://agendepost.example', 'https://localhost', 'https://127.0.0.1',
    'https://[::1]', 'https://192.168.1.4', 'https://agendepost.example:444',
    'https://agendepost.example/app', 'https://agendepost.example/?x=1',
    'https://agendepost.example/#fragment', 'https://user:pass@agendepost.example',
    'https://agendepost.example.', 'https://agendepost'
  ]) assert.throws(() => buildConfig(hosted(directory, { canonicalOrigin })), canonicalOrigin);
  assert.equal(buildConfig(hosted(directory, { canonicalOrigin: `${ORIGIN}:443` })).canonicalOrigin, ORIGIN);
});

test('hosted review: persistent data cannot be relative, served, or symlinked', async t => {
  const directory = await privateDir(t);
  for (const dataDir of [undefined, 'data', resolve(ROOT, 'data'), resolve(ROOT, 'public/data')])
    assert.throws(() => buildConfig(hosted(dataDir)), String(dataDir));
  const actual = join(directory, 'private-data'), alias = join(directory, 'alias');
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias);
  assert.throws(() => buildConfig(hosted(alias)), 'final symlink');
  assert.throws(() => buildConfig(hosted(join(alias, 'child'))), 'ancestor symlink');
});

test('hosted review: SQLite files reject dangling links, hardlinks, and permissive modes before opening', async t => {
  const directory = await privateDir(t);
  for (const name of ['social-saas.sqlite', 'social-saas.sqlite-wal', 'social-saas.sqlite-shm']) {
    const filename = join(directory, name), target = join(directory, 'missing-target');
    await symlink(target, filename);
    assert.throws(() => buildConfig(hosted(directory)), `dangling ${name}`);
    await rm(filename);
    await writeFile(filename, 'isolated test file', { mode: 0o600 });
    await chmod(filename, 0o644);
    assert.throws(() => buildConfig(hosted(directory)), `public mode ${name}`);
    await chmod(filename, 0o600);
    await link(filename, target);
    assert.throws(() => buildConfig(hosted(directory)), `hardlink ${name}`);
    await rm(filename); await rm(target);
  }
});

test('hosted review: nginx template matches the strict single-hop app contract', async () => {
  // Contract inspection only, not an assertion that nginx was installed or started.
  const template = await readFile(resolve(ROOT, 'deploy/nginx-agendepost.conf'), 'utf8');
  const directives = template.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
  assert.match(directives, /proxy_pass\s+http:\/\/127\.0\.0\.1:4180\s*;/);
  assert.match(directives, /proxy_set_header\s+Host\s+agendepost\.com\.br\s*;/);
  assert.match(directives, /proxy_set_header\s+X-Forwarded-Host\s+""\s*;/);
  assert.match(directives, /proxy_set_header\s+X-Forwarded-Proto\s+https\s*;/);
  assert.match(directives, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr\s*;/);
  assert.match(directives, /proxy_set_header\s+Forwarded\s+""\s*;/);
  assert.doesNotMatch(directives, /\$proxy_add_x_forwarded_for|\b(?:root|alias)\s/);
  assert.match(directives, /ssl_reject_handshake\s+on\s*;/);
  assert.match(directives, /access_log\s+off\s*;/);
});

test('hosted review: only the exact loopback proxy with canonical HTTPS headers is accepted', async t => {
  const app = await appFixture(t);
  assert.equal((await inject(app)).statusCode, 200);
  assert.equal((await inject(app, { remoteAddress: '::1' })).statusCode, 200);
  for (const remoteAddress of ['203.0.113.4', '192.168.1.1', '127.0.0.2', '::ffff:192.0.2.1'])
    rejected(await inject(app, { remoteAddress }));
  for (const headers of [
    { host: 'evil.example' }, { host: 'agendepost.example:444' },
    { host: '127.0.0.1:4180' }, { host: 'agendepost.example.' },
    { 'x-forwarded-proto': undefined }, { 'x-forwarded-proto': 'http' },
    { 'x-forwarded-proto': 'https,http' }, { 'x-forwarded-proto': 'https, https' },
    { 'x-forwarded-for': undefined }, { 'x-forwarded-for': 'attacker.example' },
    { 'x-forwarded-for': '203.0.113.4, 127.0.0.1' },
    { 'x-forwarded-for': '203.0.113.4, 198.51.100.4' },
    { 'x-forwarded-for': '203.0.113.4:5555' },
    { 'x-forwarded-host': 'agendepost.example' },
    { 'x-forwarded-host': 'evil.example' },
    { forwarded: 'for=203.0.113.4;proto=https;host=agendepost.example' }
  ]) rejected(await inject(app, { headers }));
});

test('hosted review: bootstrap uses secure private cookies and never discloses server secrets', async t => {
  const app = await appFixture(t);
  const response = await inject(app);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['cache-control'], /no-store/);
  const cookie = response.cookies.find(value => value.name === '__Host-ss_preauth');
  assert.ok(cookie, response.headers['set-cookie']);
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.path, '/');
  assert.equal(cookie.sameSite.toLowerCase(), 'lax');
  assert.equal(cookie.domain, undefined);
  assert.equal(response.json().data.user, null);
  assert.doesNotMatch(response.body, /appSecret|encryptionKey|password_hash|token_hash|dataDir|configFile/);
});

test('hosted review: one client cannot exhaust global preauth capacity and existing cookies still work', async t => {
  let now = Date.now();
  const app = await appFixture(t, { clock: () => now });
  const first = await inject(app);
  const cookie = first.cookies.map(value => `${value.name}=${value.value}`).join('; ');
  for (let i = 1; i < 30; i++) assert.equal((await inject(app)).statusCode, 200);
  const denied = await inject(app);
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, 'PREAUTH_RATE_LIMIT');
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM preauth_sessions').get().n, 30);
  assert.equal((await inject(app, { headers: { cookie } })).statusCode, 200, 'Existing valid preauth cookies are reused without issuing new rows');
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM preauth_sessions').get().n, 30);
  assert.equal((await inject(app, { headers: { 'x-forwarded-for': '198.51.100.12' } })).statusCode, 200, 'Another proxy-verified client gets an independent issuance budget');
  now += 16 * 60e3;
  assert.equal((await inject(app)).statusCode, 200, 'The issuance budget recovers after expiry');
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM preauth_sessions').get().n, 1);
});

test('hosted review: public signup, resend, and forgot cannot mint users or delivery links', async t => {
  const app = await appFixture(t), before = {};
  for (const table of ['users', 'auth_tokens', 'mail_outbox'])
    before[table] = app.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const bootstrap = await inject(app), csrf = bootstrap.json().data.csrfToken;
  const cookie = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
  for (const url of ['/api/v1/auth/register', '/api/v1/auth/email/resend', '/api/v1/auth/password/forgot',
    '/api/v1/auth/reg%69ster', '/api/v1/auth/email/%72esend', '/api/v1/auth/password/%66orgot']) {
    for (const authenticatedHeaders of [{}, { origin: ORIGIN, cookie, 'x-csrf-token': csrf }]) {
      const response = await inject(app, { method: 'POST', url,
        headers: authenticatedHeaders, payload: { email: 'outside@example.test', displayName: 'Outside' } });
      assert.equal(response.statusCode, 404, `${url}: ${response.body}`);
      assert.doesNotMatch(response.body, /token=|outbox|email enviado|test link/i);
    }
  }
  for (const table of Object.keys(before))
    assert.equal(app.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, before[table], table);
});

test('hosted review: operator enrollment is short-lived, hash-only, replaceable, and one-use', async t => {
  const app = await appFixture(t), client = new HostedClient(app), email = 'enrolled@example.test';
  const first = issueOperatorAccess(app.ctx.config, { purpose: 'enroll', email, displayName: 'Enrolled' });
  const second = issueOperatorAccess(app.ctx.config, { purpose: 'enroll', email, displayName: 'Enrolled' });
  assert.equal(new URL(second.url).origin, ORIGIN);
  assert.equal(new URL(second.url).search, '');
  assert.ok(Date.parse(second.expiresAt) <= Date.now() + 60 * 60e3);
  assert.notEqual(tokenFrom(first), tokenFrom(second));
  const rows = app.ctx.db.prepare('SELECT * FROM auth_tokens').all();
  assert.equal(rows.find(row => row.token_hash === digest(tokenFrom(first))).consumed_at !== null, true);
  assert.equal(rows.find(row => row.token_hash === digest(tokenFrom(second))).consumed_at, null);
  assert.ok(!JSON.stringify(rows).includes(tokenFrom(second)));
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n, 0);
  await client.bootstrap();
  rejected(await client.request('POST', '/api/v1/auth/email/verify', { token: tokenFrom(first), password: PASSWORD }));
  await client.ok('POST', '/api/v1/auth/email/verify', { token: tokenFrom(second), password: PASSWORD });
  assert.equal((await client.bootstrap()).user, null, 'The enrollment link must not automatically create a session');
  rejected(await client.request('POST', '/api/v1/auth/email/verify', { token: tokenFrom(second), password: PASSWORD }));
  assert.throws(() => issueOperatorAccess(app.ctx.config, { purpose: 'enroll', email, displayName: 'Replacement' }));
  const user = app.ctx.db.prepare('SELECT * FROM users WHERE email_normalized=?').get(email);
  assert.equal(user.status, 'active');
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM memberships').get().n, 0);
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM platform_admins').get().n, 0);
  assert.doesNotMatch(JSON.stringify(app.ctx.db.prepare('SELECT * FROM audit_events').all()), new RegExp(tokenFrom(second)));
});

test('hosted review: operator reset is purpose-bound and revokes every existing session', async t => {
  const app = await appFixture(t), email = 'reset@example.test', first = await enrolled(app, email);
  const second = new HostedClient(app); await second.bootstrap();
  await second.ok('POST', '/api/v1/auth/login', { email, password: PASSWORD });
  const issued = issueOperatorAccess(app.ctx.config, { purpose: 'reset', email });
  assert.ok(Date.parse(issued.expiresAt) <= Date.now() + 30 * 60e3);
  const anonymous = new HostedClient(app); await anonymous.bootstrap();
  rejected(await anonymous.request('POST', '/api/v1/auth/email/verify', { token: tokenFrom(issued), password: PASSWORD }));
  const nextPassword = 'Reset hosted pilot independent password!';
  await anonymous.ok('POST', '/api/v1/auth/password/reset', { token: tokenFrom(issued), password: nextPassword });
  assert.equal((await first.request('GET', '/api/v1/me')).statusCode, 401);
  assert.equal((await second.request('GET', '/api/v1/me')).statusCode, 401);
  rejected(await anonymous.request('POST', '/api/v1/auth/password/reset', { token: tokenFrom(issued), password: nextPassword }));
  await anonymous.ok('POST', '/api/v1/auth/login', { email, password: nextPassword });
  assert.throws(() => issueOperatorAccess(app.ctx.config, { purpose: 'reset', email: 'unknown@example.test' }));
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n, 0);
});

test('hosted review: tenant invitations need operator issuance and remain account-bound', async t => {
  const app = await appFixture(t), owner = await enrolled(app, 'owner@example.test');
  const invited = await enrolled(app, 'invited@example.test');
  const tenant = await owner.ok('POST', '/api/v1/tenants', { name: 'Private invited tenant', timezone: 'UTC' });
  const invitation = await owner.ok('POST', `/api/v1/tenants/${tenant.id}/invitations`, { email: 'invited@example.test', role: 'admin', workspaceIds: [] });
  assert.ok(!JSON.stringify(invitation).includes('token'));
  assert.equal(app.ctx.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n, 0);
  assert.throws(() => issueOperatorAccess(app.ctx.config, { purpose: 'invitation', email: 'other@example.test', invitationId: invitation.id }));
  const first = issueOperatorAccess(app.ctx.config, { purpose: 'invitation', email: 'invited@example.test', invitationId: invitation.id });
  const second = issueOperatorAccess(app.ctx.config, { purpose: 'invitation', email: 'invited@example.test', invitationId: invitation.id });
  rejected(await invited.request('POST', '/api/v1/invitations/accept', { token: tokenFrom(first) }));
  rejected(await owner.request('POST', '/api/v1/invitations/accept', { token: tokenFrom(second) }));
  await invited.ok('POST', '/api/v1/invitations/accept', { token: tokenFrom(second) });
  rejected(await invited.request('POST', '/api/v1/invitations/accept', { token: tokenFrom(second) }));
  assert.throws(() => issueOperatorAccess(app.ctx.config, { purpose: 'invitation', email: 'invited@example.test', invitationId: invitation.id }));
});

test('hosted review: a different hosted tenant cannot read normalized private media', async t => {
  const app = await appFixture(t), owner = await enrolled(app, 'media-owner@example.test');
  const outsider = await enrolled(app, 'media-outsider@example.test');
  const tenant = await owner.ok('POST', '/api/v1/tenants', { name: 'Private media tenant', timezone: 'UTC' });
  const outsideTenant = await outsider.ok('POST', '/api/v1/tenants', { name: 'Outside tenant', timezone: 'UTC' });
  const workspace = await owner.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Private brand' });
  const outsideWorkspace = await outsider.ok('POST', `/api/v1/tenants/${outsideTenant.id}/workspaces`, { name: 'Outside brand' });
  const bytes = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#113355' } }).png().toBuffer();
  const body = multipart(bytes), path = `/api/v1/tenants/${tenant.id}/workspaces/${workspace.id}/media`;
  const media = await owner.ok('POST', path, body.payload, { ...body.headers, 'idempotency-key': randomUUID() });
  const content = await owner.request('GET', media.contentUrl);
  assert.equal(content.statusCode, 200);
  assert.equal(content.headers['cache-control'], 'private, no-store');
  assert.equal(content.headers['x-content-type-options'], 'nosniff');
  assert.equal((await outsider.request('GET', media.contentUrl)).statusCode, 404);
  assert.equal((await outsider.request('GET', `/api/v1/tenants/${outsideTenant.id}/workspaces/${outsideWorkspace.id}/media/${media.id}/content`)).statusCode, 404);
  assert.equal((await outsider.request('DELETE', `${path}/${media.id}`)).statusCode, 404);
  const anonymous = new HostedClient(app);
  assert.equal((await anonymous.request('GET', media.contentUrl)).statusCode, 401);
});

test('hosted review: trusted HTTPS forwarding never bypasses Origin or CSRF checks', async t => {
  const app = await appFixture(t), bootstrap = await inject(app);
  const csrf = bootstrap.json().data.csrfToken;
  const cookie = bootstrap.cookies.map(value => `${value.name}=${value.value}`).join('; ');
  for (const overrides of [
    { origin: undefined }, { origin: 'null' }, { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' }, { 'x-csrf-token': 'forged' }, { cookie: '' }
  ]) {
    const response = await inject(app, { method: 'POST', url: '/api/v1/auth/login',
      headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf, ...overrides },
      payload: { email: 'outside@example.test', password: 'Strong but nonexistent password!' } });
    assert.equal(response.statusCode, 403, response.body);
  }
});

test('hosted review: database, outbox, and private media have no unauthenticated static route', async t => {
  const app = await appFixture(t);
  for (const url of ['/.env', '/data/social-saas.sqlite', '/social-saas.sqlite', '/mail_outbox',
    '/api/v1/auth/outbox', '/api/v1/dev/mail', '/api/v1/tenants/foreign/workspaces/foreign/media/foreign/content']) {
    const response = await inject(app, { url });
    assert.ok([401, 404].includes(response.statusCode), `${url}: ${response.statusCode}`);
    assert.doesNotMatch(response.body, /SQLite format|token=|password_hash|encrypted_payload/);
  }
});

function offlineWorkerAdapter() {
  return { enabled: true, readiness: () => ({ ready: false, code: 'CONNECTION_NOT_CONFIGURED' }),
    validate: () => ({ ready: false, code: 'CONNECTION_NOT_CONFIGURED' }),
    async publish() { throw new Error('UNEXPECTED_TEST_PUBLICATION'); } };
}
test('hosted review: readiness requires the expected current worker and its own fresh heartbeat', async t => {
  let now = Date.now();
  const app = await appFixture(t, { clock: () => now, publishingAdapter: offlineWorkerAdapter(),
    publishingWorker: { enabled: true, autoStart: false } });
  const service = app.ctx.services.publishing, worker = service.worker;
  assert.equal(service.workerExpected, true);
  assert.equal((await inject(app, { url: '/health/ready' })).statusCode, 200);
  now += 31e3;
  app.ctx.db.prepare('INSERT INTO publication_workers(id,started_at,heartbeat_at,stopped_at) VALUES(?,?,?,NULL)')
    .run('unrelated-worker', new Date(now).toISOString(), new Date(now).toISOString());
  assert.equal((await inject(app, { url: '/health/ready' })).statusCode, 503, 'An unrelated fresh heartbeat must not conceal the current worker failure');
  worker.heartbeat();
  assert.equal((await inject(app, { url: '/health/ready' })).statusCode, 200);
  await worker.stop();
  assert.equal((await inject(app, { url: '/health/ready' })).statusCode, 503);
  assert.equal((await inject(app, { url: '/health/live' })).statusCode, 200, 'The application factory does not terminate the test process');
});

test('hosted review: a requested worker with an unavailable adapter fails readiness', async t => {
  const app = await appFixture(t, { publishingWorker: { enabled: true, autoStart: false } });
  assert.equal(app.ctx.services.publishing.workerExpected, true);
  assert.equal(app.ctx.services.publishing.worker.running, false);
  const response = await inject(app, { url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'WORKER_UNAVAILABLE');
});

test('hosted review: an unexpected timer error stops the worker and makes readiness unhealthy', async t => {
  const app = await appFixture(t, { publishingAdapter: offlineWorkerAdapter(),
    publishingWorker: { enabled: true, autoStart: true } });
  const worker = app.ctx.services.publishing.worker;
  assert.equal(worker.running, true);
  app.ctx.db.exec("CREATE TEMP TRIGGER hosted_review_fail_heartbeat BEFORE INSERT ON publication_workers BEGIN SELECT RAISE(ABORT,'OFFLINE_REVIEW_HEARTBEAT_FAILURE'); END");
  const deadline = Date.now() + 5000;
  while (worker.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  app.ctx.db.exec('DROP TRIGGER hosted_review_fail_heartbeat');
  assert.equal(worker.running, false, 'Timer failure must be observable to the process supervisor');
  const response = await inject(app, { url: '/health/ready' });
  assert.equal(response.statusCode, 503);
  assert.doesNotMatch(response.body, /OFFLINE_REVIEW_HEARTBEAT_FAILURE|SQLITE_|TRIGGER/);
});
