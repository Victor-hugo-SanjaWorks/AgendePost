import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, verified, idempotency } from './qa-helpers.mjs';
import { domPage } from './qa-dom.mjs';

test('commercial DOM integration: platform-only operator reaches admin, reauthenticates and grants through real API', async t => {
  const h = await harness(t), owner = await verified(h, 'commercial-dom-owner'), operator = await verified(h, 'commercial-dom-operator');
  const tenant = await owner.client.ok('POST', '/api/v1/tenants', { name: 'Commercial DOM customer', timezone: 'UTC' }, idempotency());
  h.db.prepare("INSERT INTO platform_admins(user_id,status,created_at) VALUES(?,'active',?)").run(operator.user.id, h.app.ctx.now());
  const submitted = [];
  const page = await domPage(h, t, { beforeFetch(request) { if (request.path.endsWith('/entitlement-grants')) submitted.push({ body: JSON.parse(request.payload), headers: request.headers }); } });
  await page.login(operator);
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM memberships WHERE user_id=?').get(operator.user.id).n, 0);
  await page.navigate('/app/admin', '[data-admin-grant]');
  assert.ok(page.text().includes('Operação da plataforma.')); assert.equal(page.$('#tenant-form'), null);
  assert.ok(page.$('#main [data-action="reauthenticate"]'), 'Operator can confirm identity without an editorial membership');
  assert.equal(page.requests.filter(r => /^\/api\/v1\/tenants\//.test(r.path)).length, 0);
  h.db.prepare('UPDATE sessions SET auth_at=? WHERE user_id=?').run(new Date(Date.parse(h.app.ctx.now()) - 11 * 60000).toISOString(), operator.user.id);
  async function fillGrant() {
    page.click(`[data-admin-grant="${tenant.id}"]`); await page.wait(() => page.$('#grant-form'), 'manual grant form');
    page.change('#grant-plan', 'pilot_team');
    page.fill('#grant-end', new Date(Date.parse(h.app.ctx.now()) + 7 * 86400000).toISOString().slice(0, 16));
    page.fill('#grant-reason', 'Controlled frontend grant regression'); page.submit('#grant-form');
  }
  await fillGrant();
  await page.wait(() => page.$('#grant-form [data-action="reauthenticate"]'), 'stale-auth recovery action');
  assert.equal(h.app.ctx.services.entitlements.get(tenant.id).version, 1);
  page.click('#grant-form [data-action="reauthenticate"]'); await page.wait(() => page.$('#reauth-form'), 'reauthentication form');
  page.fill('#reauth-password', operator.password); page.submit('#reauth-form');
  await page.wait(() => !page.$('#reauth-form') && page.requests.some(r => r.path.endsWith('/auth/reauthenticate') && r.status === 200), 'reauthenticated operator');
  await fillGrant();
  await page.wait(() => !page.$('#grant-form') && h.app.ctx.services.entitlements.get(tenant.id).plan.id === 'pilot_team', 'persisted manual grant');
  assert.equal(h.app.ctx.services.entitlements.get(tenant.id).source, 'manual_trial');
  assert.equal(h.db.prepare('SELECT COUNT(*) n FROM subscriptions').get().n, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='admin.entitlement.granted'").get().n, 1);
  assert.equal(submitted.length, 2);
  assert.deepEqual(Object.keys(submitted[1].body).sort(), ['endsAt', 'planId', 'planVersion', 'reason']);
  assert.equal(submitted[1].body.planVersion, 1); assert.match(submitted[1].body.endsAt, /:00Z$/);
  assert.ok(submitted[1].headers['Idempotency-Key']); assert.ok(submitted[1].headers['X-CSRF-Token']);
  assert.equal(page.errors.length, 0);
});
