import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, verified, idempotency } from './qa-helpers.mjs';
import { domPage } from './qa-dom.mjs';

test('dashboard UI integration: registered brand, authenticated results, one-time share and real revocation',async t=>{
  const h=await harness(t),owner=await verified(h,'client-dashboard-ui');
  const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Dashboard UI organization',timezone:'UTC'},idempotency());
  const brand=await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/workspaces`,{name:'Dashboard UI client'},idempotency());
  const page=await domPage(h,t);await page.login(owner);await page.navigate('/app/results','[data-results-action="share"]');
  assert.match(page.text(),/Dashboard UI client/);assert.match(page.text(),/Ainda não há contas/);assert.equal(page.$('.sr-account'),null);
  page.click('[data-results-action="share"]');page.fill('[name="label"]','Client review link');page.$('[name="acknowledgeBearerAccess"]').checked=true;
  page.submit('[data-results-form="share"]');page.submit('[data-results-form="share"]');await page.wait(()=>page.$('#sr-created-url'),'share created');
  const url=new URL(page.$('#sr-created-url').value);assert.equal(url.pathname,'/client-dashboard');assert.match(url.hash,/^#token=[A-Za-z0-9_-]{43}$/);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM client_dashboard_shares WHERE workspace_id=?').get(brand.id).n,1);
  const headers={host:new URL(h.app.ctx.config.canonicalOrigin).host,authorization:'Bearer '+url.hash.slice(7)};
  const before=await h.app.inject({url:'/api/v1/public/dashboard',headers});assert.equal(before.statusCode,200);assert.equal(before.json().data.brand.name,brand.name);assert.equal(before.json().data.management,undefined);
  page.click('[data-results-close]');assert.equal(page.$('#sr-created-url'),null);await page.wait(()=>page.$('[data-results-action="revoke"]'),'active link metadata');
  page.click('[data-results-action="revoke"]');page.click('[data-results-confirm-revoke]');await page.wait(()=>!page.$('.sr-dialog')&&page.text().includes('Revogado'),'revoked');
  const after=await h.app.inject({url:'/api/v1/public/dashboard',headers});assert.equal(after.statusCode,404);assert.equal(page.$('[data-results-action="revoke"]'),null);assert.equal(page.errors.length,0);
  assert.equal(page.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/dashboard-shares')).length,1);
});
