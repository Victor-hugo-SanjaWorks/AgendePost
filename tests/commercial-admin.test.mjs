import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, verified, idempotency, assertDenied, Client, route } from './qa-helpers.mjs';

async function setup(t) {
  const h = await harness(t), owner = await verified(h, 'commercial-owner'), operator = await verified(h, 'commercial-operator');
  const tenant = await owner.client.ok('POST', '/api/v1/tenants', { name: 'Private customer organization', timezone: 'UTC' }, idempotency());
  return { h, owner, operator, tenant };
}
function bootstrapOperator(h, operator) {
  // Fixture-only bootstrap simulates the explicit local-operator command; no HTTP endpoint assigns this privilege.
  h.db.prepare("INSERT INTO platform_admins(user_id,status,created_at) VALUES(?,'active',?)").run(operator.user.id, h.app.ctx.now());
}
function grant(h) { return { planId: 'pilot_team', planVersion: 1, endsAt: new Date(Date.parse(h.app.ctx.now()) + 30 * 86400000).toISOString(), reason: 'Controlled pilot evaluation extension' }; }

test('commercial HTTP: plans are honest, checkout disabled, webhook absent and tenant entitlements scoped', async t => {
  const { h, owner, operator, tenant } = await setup(t), anonymous = new Client(h);
  const plans = await anonymous.request('GET', '/api/v1/plans');
  assert.equal(plans.status, 200); assert.equal(plans.json.meta.billingEnabled, false);
  assert.ok(plans.data.every(p => p.priceLabel === 'a definir' && p.purchasable === false && p.technicalPreset === true));
  assertDenied(await operator.client.request('GET', `/api/v1/tenants/${tenant.id}/entitlements`), 404);
  const e = await owner.client.ok('GET', `/api/v1/tenants/${tenant.id}/entitlements`);
  assert.equal(e.source, 'manual_trial'); assert.equal(e.usage.members, 1); assert.equal(e.accessMode, 'read_write');
  for (const action of ['checkout', 'portal']) {
    const result = await owner.client.request('POST', `/api/v1/tenants/${tenant.id}/billing/${action}`, {});
    assert.equal(result.status, 503, result.body); assert.equal(result.json.error.code, 'BILLING_NOT_CONFIGURED'); assert.ok(!result.body.includes('https://'));
  }
  const absent = await owner.client.request('POST', '/api/v1/webhooks/stripe', {});
  assert.equal(absent.status, 404, absent.body);
  assert.equal(h.app.hasRoute({ method: 'POST', url: '/api/v1/webhooks/stripe' }), false);
});

test('commercial HTTP: operator metadata grants no editorial access and manual grants are atomic/idempotent/audited', async t => {
  const { h, owner, operator, tenant } = await setup(t);
  assertDenied(await owner.client.request('GET', '/api/v1/admin/tenants'), 403);
  assertDenied(await operator.client.request('POST', `/api/v1/admin/tenants/${tenant.id}/entitlement-grants`, grant(h), idempotency()), 403);
  bootstrapOperator(h, operator);
  const workspace = await owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Private editorial workspace', color: '#123456' }, idempotency());
  const post = await owner.client.ok('POST', route(tenant, workspace, '/posts'), { title: 'Confidential editorial title', caption: 'Private customer secret', format: 'text' }, idempotency());
  assertDenied(await operator.client.request('GET', route(tenant, workspace, `/posts/${post.id}`)), 404);
  assertDenied(await operator.client.request('GET', `/api/v1/tenants/${tenant.id}/entitlements`), 404);
  const tenants = await operator.client.request('GET', '/api/v1/admin/tenants');
  assert.equal(tenants.status, 200, tenants.body); assert.equal(tenants.data[0].postCount, 1);
  assert.doesNotMatch(tenants.body, /Confidential editorial title|Private customer secret|password_hash|token_hash/);
  const summary = await operator.client.ok('GET', '/api/v1/admin/health-summary'); assert.equal(summary.scope, 'operational-metadata-only');
  const path = `/api/v1/admin/tenants/${tenant.id}/entitlement-grants`, body = grant(h), idem = idempotency();
  const first = await operator.client.request('POST', path, body, idem);
  assert.equal(first.status, 201, first.body); assert.equal(first.data.source, 'manual_trial'); assert.equal(first.data.plan.id, 'pilot_team');
  const second = await operator.client.request('POST', path, body, idem);
  assert.equal(second.status, 201); assert.deepEqual(second.data, first.data);
  assertDenied(await operator.client.request('POST', path, { ...body, reason: 'Different grant request' }, idem), 409);
  const audit = h.db.prepare("SELECT safe_changes FROM audit_events WHERE action='admin.entitlement.granted'").all();
  assert.equal(audit.length, 1); assert.equal(JSON.parse(audit[0].safe_changes).source, 'manual_trial');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0, 'Manual grants do not fabricate provider subscriptions');
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM memberships WHERE user_id=?").get(operator.user.id).n, 0);
});

test('commercial HTTP: manual grants reject stale auth, absent reason, invalid dates and client payment fields', async t => {
  const { h, operator, tenant } = await setup(t); bootstrapOperator(h, operator);
  const path = `/api/v1/admin/tenants/${tenant.id}/entitlement-grants`, good = grant(h);
  for (const body of [{ ...good, reason: '   ' }, { ...good, endsAt: '2026-02-30T00:00:00Z' }, { ...good, endsAt: new Date(Date.parse(h.app.ctx.now()) + 91 * 86400000).toISOString() }, { ...good, planVersion: 999 }, { ...good, paid: true }, { ...good, tenantId: 'other' }]) {
    const result = await operator.client.request('POST', path, body, idempotency()); assert.ok([400, 422].includes(result.status), result.body);
  }
  assertDenied(await operator.client.request('POST', path, good), 422);
  assertDenied(await operator.client.request('POST', path, { ...good, expectedVersion: 999 }, idempotency()), 409);
  h.db.prepare('UPDATE sessions SET auth_at=? WHERE user_id=?').run(new Date(Date.parse(h.app.ctx.now()) - 11 * 60000).toISOString(), operator.user.id);
  const old = await operator.client.request('POST', path, good, idempotency()); assertDenied(old, 403); assert.equal(old.json.error.code, 'REAUTH_REQUIRED');
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='admin.entitlement.granted'").get().n, 0);
  assert.equal(h.app.ctx.services.entitlements.get(tenant.id).version, 1);
});

test('commercial HTTP: visible failed jobs can be retried only by a recently authenticated operator with audit', async t => {
  const { h, owner, operator, tenant } = await setup(t); bootstrapOperator(h, operator);
  h.db.prepare(`INSERT INTO billing_events(id,provider,account_scope,event_id,tenant_id,object_id,event_type,subscription_id,customer_id,received_at,body_digest,state,attempts,error_code)
    VALUES('failure-a','stripe','platform','evt_Failure',?,'sub_A','customer.subscription.updated','sub_A','cus_A',?,'digest-only','failed',5,'PROVIDER_UNAVAILABLE')`).run(tenant.id, h.app.ctx.now());
  h.db.prepare(`INSERT INTO jobs(id,tenant_id,type,dedupe_key,payload_ref,run_at,state,attempts,last_error_code,created_at)
    VALUES('job-failure-a',?,'billing.reconcile','dedupe-failure','failure-a',?,'failed',5,'PROVIDER_UNAVAILABLE',?)`).run(tenant.id, h.app.ctx.now(), h.app.ctx.now());
  const failures = await operator.client.ok('GET', '/api/v1/admin/billing-failures');
  assert.equal(failures.length, 1); assert.equal(failures[0].jobId, 'job-failure-a'); assert.equal(failures[0].errorCode, 'PROVIDER_UNAVAILABLE');
  assert.equal(failures[0].body_digest, undefined); assert.equal(failures[0].customerId, undefined);
  const path = '/api/v1/admin/billing-jobs/job-failure-a/retry', body = { reason: 'Reviewed local provider failure' }, idem = idempotency();
  assertDenied(await owner.client.request('POST', path, body, idempotency()), 403);
  const first = await operator.client.ok('POST', path, body, idem); assert.equal(first.state, 'queued');
  assert.deepEqual(await operator.client.ok('POST', path, body, idem), first);
  assert.equal(h.db.prepare('SELECT attempts FROM jobs WHERE id=\'job-failure-a\'').get().attempts, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='admin.billing.retry'").get().n, 1);
  assert.equal((await operator.client.ok('GET', '/api/v1/admin/billing-failures')).length, 0);
});

test('commercial HTTP: restricted brand roles cannot read organization-wide usage or hidden-brand quota counts', async t => {
  const { h, owner, operator: member, tenant } = await setup(t);
  const workspace = await owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Visible brand' }, idempotency());
  const hidden = await owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Hidden brand' }, idempotency());
  await owner.client.ok('POST', route(tenant, hidden, '/posts'), { title: 'Hidden editorial content', format: 'text' }, idempotency());
  h.db.prepare("INSERT INTO memberships(tenant_id,user_id,role,status,scope,created_at) VALUES(?,?,'viewer','active','workspaces',?)").run(tenant.id, member.user.id, h.app.ctx.now());
  h.db.prepare('INSERT INTO workspace_grants(tenant_id,workspace_id,user_id) VALUES(?,?,?)').run(tenant.id, workspace.id, member.user.id);
  for (const role of ['viewer', 'reviewer', 'editor']) {
    h.db.prepare('UPDATE memberships SET role=? WHERE tenant_id=? AND user_id=?').run(role, tenant.id, member.user.id);
    const e = await member.client.ok('GET', `/api/v1/tenants/${tenant.id}/entitlements`);
    assert.equal(e.usage, null); assert.equal(e.usageScope, 'restricted'); assert.deepEqual(e.overLimit, []);
    assert.equal(e.plan.id, 'pilot_base'); assert.equal(e.limits.posts, 100);
  }
  const e = await owner.client.ok('GET', `/api/v1/tenants/${tenant.id}/entitlements`);
  assert.equal(e.usage.posts, 1); assert.equal(e.usage.workspaces, 2); assert.equal(e.usageScope, 'organization');
  const now = h.app.ctx.now();
  const insert = h.db.prepare("INSERT INTO posts(tenant_id,workspace_id,id,title,author_id,updated_by,created_at,updated_at) VALUES(?,?,?,'Hidden fixture',?,?,?,?)");
  h.app.ctx.transaction(() => { for (let i = 0; i < 99; i++) insert.run(tenant.id, hidden.id, `quota-hidden-${i}`, owner.user.id, owner.user.id, now, now); });
  const quota = await member.client.request('POST', route(tenant, workspace, '/posts'), { title: 'Visible attempt', format: 'text' }, idempotency());
  assertDenied(quota, 409); assert.equal(quota.json.error.code, 'QUOTA_EXCEEDED');
  assert.deepEqual(quota.json.error.fields, { resource: 'posts', limit: 100 });
  assert.equal(quota.json.error.fields.used, undefined);
});
