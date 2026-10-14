import test from 'node:test';
import assert from 'node:assert/strict';
import { domPage } from './qa-dom.mjs';
import { idempotency, route } from './qa-helpers.mjs';
import { publicationFixture } from './qa-publication-helpers.mjs';

test('security strategy DOM: real metrics, inert HTML, honest sources and versioned competitor CRUD', async t => {
  const h = await publicationFixture(t), base = h.path('/strategy');
  await h.post({ caption: '' });
  const marker = '<img src=x onerror="window.strategyXss=true">';
  await h.people.editor.client.ok('POST', base + '/entries', { quadrant: 'threat', title: marker, classification: 'hypothesis', description: '<script>window.strategyXss=true</script>' }, idempotency());
  const page = await domPage(h, t); await page.login(h.people.editor);
  await page.navigate('/app/reports', '.strategy-dashboard');
  await page.wait(() => page.$('.strategy-dashboard'), 'dashboard metrics and FOFA');
  assert.equal(page.$('.strategy-kpi strong').textContent, '1');
  assert.match(page.text(), /Alcance, engajamento e resultados das redes ainda não estão disponíveis/);
  assert.match(page.text(), /Sem verificação independente/);
  assert.ok(page.text().includes(marker));
  assert.equal(page.window.strategyXss, undefined); assert.equal(page.$('img[onerror]'), null);
  assert.equal(page.$('.strategy-quadrant.threat .strategy-badge').textContent, 'Hipótese');
  assert.ok([...page.document.querySelectorAll('.strategy-insight details')].some(node => node.textContent.includes('Regra:')));

  page.click('[data-strategy-action="new-competitor"]');
  await page.wait(() => page.$('[data-strategy-form="competitor"]'), 'competitor form');
  page.fill('#strategy-name', 'Observed competitor QA');
  page.fill('#strategy-observedOn', h.app.ctx.now().slice(0, 10));
  page.fill('#strategy-sourceNotes', 'Entered manually from our reference notes.');
  const submit = page.$('[data-strategy-form="competitor"] button[type="submit"]'); submit.click(); submit.click();
  await page.wait(() => !page.$('.strategy-dialog') && page.text().includes('Observed competitor QA'), 'one saved competitor');
  const competitors = await h.people.editor.client.ok('GET', base + '/competitors');
  assert.equal(competitors.length, 1); assert.equal(competitors[0].followers, null); assert.equal(competitors[0].postsPerWeek, null);
  assert.match(page.$('.strategy-comparison').textContent, /Não informado/);
  assert.match(page.$('.strategy-comparison').textContent, /Sem verificação independente/);

  const competitor = competitors[0];
  page.click(`[data-strategy-action="edit-competitor"][data-strategy-id="${competitor.id}"]`);
  await page.wait(() => page.$('[data-strategy-form="competitor"]'), 'fresh competitor version editor');
  page.fill('#strategy-positioning', 'My unsaved observation survives a conflict');
  await h.people.owner.client.ok('PATCH', base + '/competitors/' + competitor.id, { expectedVersion: competitor.version, positioning: 'Saved by another team member' }, idempotency());
  page.click('[data-strategy-form="competitor"] button[type="submit"]');
  await page.wait(() => page.$('.strategy-dialog .form-error')?.textContent.includes('Outra pessoa'), 'exact-version conflict notice');
  assert.equal(page.$('#strategy-positioning').value, 'My unsaved observation survives a conflict');
  page.click('[data-strategy-action="close"]');
  await page.wait(() => page.$('[data-strategy-action="discard"]'), 'explicit discard confirmation');
  page.click('[data-strategy-action="keep-editing"]');
  assert.equal(page.$('#strategy-positioning').value, 'My unsaved observation survives a conflict');
  page.click('[data-strategy-action="close"]'); page.click('[data-strategy-action="discard"]');
  assert.equal(page.$('.strategy-dialog'), null);
  assert.equal(page.window.strategyXss, undefined); assert.equal(page.errors.length, 0);

  const reader = await domPage(h, t); await reader.login(h.people.reviewer);
  await reader.navigate('/app/reports', '.strategy-dashboard');
  await reader.wait(() => reader.$('.strategy-dashboard'), 'reviewer dashboard');
  assert.equal(reader.$('[data-strategy-action="new-entry"]'), null);
  assert.equal(reader.$('[data-strategy-action="new-competitor"]'), null);
  assert.equal(reader.$('[data-strategy-action="edit-competitor"]'), null);
  assert.match(reader.text(), /Observed competitor QA/);
});

test('security strategy DOM: delayed old-brand dashboard cannot replace the newly selected brand', async t => {
  const h = await publicationFixture(t);
  const second = await h.people.owner.client.ok('POST', `/api/v1/tenants/${h.tenant.id}/workspaces`, { name: 'SECOND QA BRAND EXCLUSIVE' }, idempotency());
  await h.people.owner.client.ok('POST', route(h.tenant, second, '/strategy/entries'), { quadrant: 'strength', title: 'SECOND BRAND STRATEGY SENTINEL', classification: 'hypothesis' }, idempotency());
  let delay = false, unblock, started;
  const entered = new Promise(resolve => { started = resolve; });
  const hold = new Promise(resolve => { unblock = resolve; });
  const page = await domPage(h, t, { beforeFetch: async request => {
    if (delay && request.path.includes(`/workspaces/${h.workspace.id}/strategy/dashboard`)) { delay = false; started(); await hold; }
  } });
  await page.login(h.people.owner);
  await page.navigate('/app/reports', '.strategy-dashboard');
  await page.wait(() => page.$('.strategy-dashboard'), 'initial dashboard');
  if (page.$('#brand-select').value !== h.workspace.id) {
    page.change('#brand-select', h.workspace.id);
    await page.wait(() => page.$('.strategy-hero')?.textContent.includes(h.workspace.name), 'first brand selected');
  }
  delay = true; page.click('[data-strategy-action="period"][data-strategy-days="90"]'); await entered;
  page.change('#brand-select', second.id);
  await page.wait(() => page.$('.strategy-dashboard') && page.text().includes('SECOND BRAND STRATEGY SENTINEL'), 'second brand response');
  const oldResponses = page.requests.filter(r => r.path.includes(`/workspaces/${h.workspace.id}/strategy/dashboard`)).length;
  unblock();
  await page.wait(() => page.requests.filter(r => r.path.includes(`/workspaces/${h.workspace.id}/strategy/dashboard`)).length > oldResponses, 'old request eventually returned');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(page.$('#brand-select').value, second.id);
  assert.ok(page.$('.strategy-hero').textContent.includes('SECOND QA BRAND EXCLUSIVE'));
  assert.ok(page.text().includes('SECOND BRAND STRATEGY SENTINEL'));
  assert.equal(page.errors.length, 0);
});
