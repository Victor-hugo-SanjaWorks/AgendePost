import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const QA_PASSWORD = 'Independent QA passphrase 2026!';
export const QA_ORIGIN = 'http://127.0.0.1:8787';
let addressCounter = 2;

export async function harness(t, options = {}) {
  const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'social-saas-qa-'));
  const messages = [];
  const { createApp } = await import('../src/app.mjs');
  const app = await createApp({ mode: 'test', dataDir, canonicalOrigin: QA_ORIGIN,
    mailAdapter: { send(message) { messages.push(message); } }, ...options });
  if (t) t.after(async () => { await app.close(); if (!options.dataDir) await rm(dataDir, { recursive: true, force: true }); });
  return { app, db: app.ctx.db, messages, dataDir, options };
}

export class Client {
  constructor(h) { this.h = h; this.cookies = new Map(); this.csrf = null; this.address = `127.0.1.${addressCounter++}`; }
  get cookie() { return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '); }
  async request(method, path, payload, options = {}) {
    const origin = this.h.app.ctx.config.canonicalOrigin;
    const headers = { host: new URL(origin).host, origin, ...options.headers };
    if (this.cookie && !Object.hasOwn(headers, 'cookie')) headers.cookie = this.cookie;
    if (this.csrf && !Object.hasOwn(headers, 'x-csrf-token')) headers['x-csrf-token'] = this.csrf;
    const response = await this.h.app.inject({ method, url: path, remoteAddress: this.address, headers, ...(payload === undefined ? {} : { payload }), ...options.inject });
    for (const cookie of response.cookies) {
      if (cookie.value === '' || cookie.maxAge === 0) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    let json;
    try { json = response.json(); } catch { json = null; }
    if (json?.data?.csrfToken) this.csrf = json.data.csrfToken;
    return { response, status: response.statusCode, headers: response.headers, json, data: json?.data, body: response.body, raw: response.rawPayload };
  }
  async ok(method, path, payload, options) {
    const result = await this.request(method, path, payload, options);
    assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: ${result.status} ${result.body}`);
    return result.data;
  }
  async bootstrap() { return this.ok('GET', '/api/v1/auth/session'); }
  async login(email, password = QA_PASSWORD) {
    await this.bootstrap();
    const result = await this.ok('POST', '/api/v1/auth/login', { email, password });
    await this.bootstrap();
    return result;
  }
}

export async function verified(h, name = 'qa-user', options = {}) {
  const client = new Client(h);
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  await client.bootstrap();
  await client.ok('POST', '/api/v1/auth/register', { email, displayName: name });
  const message = h.messages.findLast(item => item.to === email && item.purpose === 'email_verify');
  assert.ok(message?.token, `Test mail adapter must capture verification for ${email}; got ${JSON.stringify(h.messages.map(m => ({to:m.to,purpose:m.purpose})))}`);
  await client.ok('POST', '/api/v1/auth/email/verify', { token: message.token, password: options.password ?? QA_PASSWORD });
  await client.login(email, options.password ?? QA_PASSWORD);
  const user = (await client.ok('GET', '/api/v1/me'));
  return { client, email, user: user.user ?? user, password: options.password ?? QA_PASSWORD };
}

export function route(tenant, workspace, suffix = '') {
  return `/api/v1/tenants/${typeof tenant === 'string' ? tenant : tenant.id}/workspaces/${typeof workspace === 'string' ? workspace : workspace.id}${suffix}`;
}
export function idempotency(key = randomUUID()) { return { headers: { 'idempotency-key': key } }; }
export function multipart(bytes, { filename = 'fixture.png', mime = 'image/png', extra = '' } = {}) {
  const boundary = `qa-${randomUUID()}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`), bytes, Buffer.from(`\r\n${extra}--${boundary}--\r\n`)]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
export function assertDenied(result, expected = 404) {
  assert.equal(result.status, expected, result.body);
  assert.ok(result.json?.error?.code, result.body);
  assert.doesNotMatch(result.body, /SQLITE_|SELECT |INSERT INTO|node:|at async |password_hash|token_hash/);
}

// Fixture entitlement only; permission and editorial assertions still use real HTTP sessions.
export function fixtureTeamPlan(h, tenantId) {
  h.db.prepare("UPDATE tenant_entitlements SET plan_id='pilot_team',plan_version=1,ends_at=?,access_policy='enabled',version=version+1 WHERE tenant_id=?")
    .run(new Date(Date.now() + 30 * 86400e3).toISOString(), tenantId);
}
export async function invite(h, ownerClient, tenantId, identity, role, workspaceIds = []) {
  const invitation = await ownerClient.ok('POST', `/api/v1/tenants/${tenantId}/invitations`, { email: identity.email, role, workspaceIds }, idempotency());
  const message = h.messages.findLast(item => item.to === identity.email && item.purpose === 'invitation');
  assert.ok(message?.token, 'Invitation token is delivered only to the test mail adapter');
  await identity.client.ok('POST', '/api/v1/invitations/accept', { token: message.token });
  return { invitation, message };
}
