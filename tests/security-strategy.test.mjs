import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, verified, fixtureTeamPlan, invite, route, idempotency, assertDenied } from './qa-helpers.mjs';

async function fixture(t) {
  const h = await harness(t), people = {};
  for (const role of ['owner', 'editor', 'reviewer', 'viewer', 'outsider']) people[role] = await verified(h, `strategy-${role}`);
  const tenant = await people.owner.client.ok('POST', '/api/v1/tenants', { name: 'QA strategy tenant', slug: 'qa-strategy', timezone: 'UTC' }, idempotency());
  fixtureTeamPlan(h, tenant.id);
  const visible = await people.owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Visible brand' }, idempotency());
  const hidden = await people.owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'HIDDEN BRAND SENTINEL 9037' }, idempotency());
  for (const role of ['editor', 'reviewer', 'viewer']) await invite(h, people.owner.client, tenant.id, people[role], role, [visible.id]);
  const base = route(tenant, visible, '/strategy'), hiddenBase = route(tenant, hidden, '/strategy');
  return { ...h, people, tenant, visible, hidden, base, hiddenBase };
}

test('security strategy: role and brand isolation, source integrity, bounded mutations and honest dashboard', async t => {
  const h = await fixture(t), { people: p, base, hiddenBase } = h;
  const entry = { quadrant: 'strength', title: 'QA evidence', classification: 'evidence', sourceType: 'user_provided', observedOn: '2026-10-14', sourceNotes: 'Entered by the analyst; not externally verified.' };
  const competitor = { name: 'QA public competitor', sourceType: 'public_source', sourceUrl: 'https://example.com/research', observedOn: '2026-10-14', sourceNotes: 'Manually entered observation.', followers: 1200, postsObserved: 12, observationDays: 14 };
  let storedEntry, storedCompetitor;

  await t.test('hidden brand records and metrics are inaccessible even with known identifiers', async () => {
    const privateEntry = await p.owner.client.ok('POST', hiddenBase + '/entries', { ...entry, title: 'HIDDEN STRATEGY SENTINEL 5519' }, idempotency());
    await p.owner.client.ok('POST', hiddenBase + '/competitors', { ...competitor, name: 'HIDDEN COMPETITOR SENTINEL 2241' }, idempotency());
    for (let i = 0; i < 7; i++) await p.owner.client.ok('POST', route(h.tenant, h.hidden, '/posts'), { title: 'HIDDEN POST SENTINEL 6652 ' + i }, idempotency());
    for (const role of ['editor', 'reviewer', 'viewer', 'outsider']) {
      for (const suffix of ['/dashboard', '/entries', '/competitors']) assertDenied(await p[role].client.request('GET', hiddenBase + suffix));
      assertDenied(await p[role].client.request('PATCH', base + '/entries/' + privateEntry.id, { expectedVersion: privateEntry.version, title: 'Moved illegally' }, idempotency()));
    }
    const dashboard = await p.editor.client.request('GET', base + '/dashboard');
    assert.equal(dashboard.status, 200, dashboard.body);
    assert.doesNotMatch(dashboard.body, /HIDDEN|9037|5519|2241|6652/);
    assert.ok(!dashboard.body.includes(h.hidden.id));
    assert.equal(dashboard.data.metrics.totalPosts, 0, 'Hidden brand posts must not increase any visible count');
    assert.equal(dashboard.data.socialMetrics, null);
    assert.equal(dashboard.data.source, 'editorial-only');
    assert.equal(dashboard.data.methodology.externalDataFetched, false);
    await p.editor.client.ok('POST', route(h.tenant, h.visible, '/posts'), { title: 'Visible internal fixture', caption: '' }, idempotency());
    const visibleMetrics = await p.editor.client.ok('GET', base + '/dashboard');
    assert.equal(visibleMetrics.metrics.totalPosts, 1);
    assert.equal(visibleMetrics.metrics.missingCaption, 1);
    assert.equal(visibleMetrics.metrics.missingChannels, 1);
    assert.ok(visibleMetrics.derivedEntries.every(row => row.readOnly && row.classification === 'evidence' && row.sourceType === 'internal_editorial' && row.formula));
    for (const role of ['reviewer', 'viewer']) assert.equal((await p[role].client.request('GET', base + '/dashboard')).status, 200);
    assertDenied(await p.outsider.client.request('GET', base + '/dashboard'));
  });

  await t.test('reader roles cannot write, and identity/scope injection is refused', async () => {
    for (const role of ['reviewer', 'viewer']) {
      assertDenied(await p[role].client.request('POST', base + '/entries', entry, idempotency()), 403);
      assertDenied(await p[role].client.request('POST', base + '/competitors', competitor, idempotency()), 403);
    }
    for (const body of [{ ...entry, tenantId: 'foreign' }, { ...entry, workspaceId: h.hidden.id }, { ...entry, createdBy: p.owner.user.id }, { ...entry, verified: true }]) {
      const response = await p.editor.client.request('POST', base + '/entries', body, idempotency());
      assert.equal(response.status, 422, response.body);
    }
    const missingKey = await p.editor.client.request('POST', base + '/entries', entry);
    assert.ok([400, 422].includes(missingKey.status), missingKey.body);
  });

  await t.test('FOFA distinguishes hypotheses from user-supplied evidence and validates dates/sources', async () => {
    for (const body of [
      { quadrant: 'strength', title: 'No source', classification: 'evidence' },
      { ...entry, sourceNotes: '', sourceUrl: '' },
      { ...entry, observedOn: '2026-02-30' },
      { ...entry, observedOn: '2026-13-01' },
      { ...entry, sourceType: 'public_source' },
      { ...entry, classification: 'verified_fact' },
      { ...entry, title: ' ' },
    ]) assert.equal((await p.editor.client.request('POST', base + '/entries', body, idempotency())).status, 422, JSON.stringify(body));
    storedEntry = await p.editor.client.ok('POST', base + '/entries', entry, idempotency());
    assert.equal(storedEntry.classification, 'evidence');
    assert.equal(storedEntry.sourceNotes, entry.sourceNotes);
    const hypothesis = await p.editor.client.ok('POST', base + '/entries', { quadrant: 'opportunity', title: 'A tentative idea', classification: 'hypothesis' }, idempotency());
    assert.equal(hypothesis.classification, 'hypothesis');
    assert.notEqual(hypothesis.verified, true);
  });

  await t.test('all external URLs reject executable schemes and credentials without fetching them', async () => {
    const invalid = ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'https://user:secret@example.com/a', '//example.com/a', 'not a url'];
    const oldFetch = globalThis.fetch; let fetchCalls = 0;
    globalThis.fetch = async () => { fetchCalls++; throw new Error('QA forbids external fetch'); };
    try {
      for (const value of invalid) {
        const r = await p.editor.client.request('POST', base + '/entries', { ...entry, sourceUrl: value }, idempotency());
        assert.equal(r.status, 422, `${value}: ${r.body}`);
        for (const field of ['sourceUrl', 'websiteUrl', 'profileUrl']) assert.equal((await p.editor.client.request('POST', base + '/competitors', { ...competitor, [field]: value }, idempotency())).status, 422, `${field}: ${value}`);
      }
      // Even inert local addresses must never cause a request, whether rejected or stored.
      for (const value of ['http://127.0.0.1:4180/admin', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
        const r = await p.editor.client.request('POST', base + '/entries', { ...entry, sourceUrl: value }, idempotency());
        assert.equal(r.status, 422, r.body);
      }
      storedCompetitor = await p.editor.client.ok('POST', base + '/competitors', competitor, idempotency());
      await p.editor.client.ok('GET', base + '/dashboard');
      assert.equal(fetchCalls, 0, 'Source fields must never trigger a backend HTTP request');
    } finally { globalThis.fetch = oldFetch; }
  });

  await t.test('competitor measurements require a stated observation window, source and feasible numeric data', async () => {
    for (const body of [
      { ...competitor, followers: -1 }, { ...competitor, followers: 1.5 },
      { ...competitor, postsObserved: -1 }, { ...competitor, observationDays: null },
      { ...competitor, observationDays: 0 }, { ...competitor, observationDays: 366 },
      { ...competitor, sourceUrl: '' }, { ...competitor, observedOn: '2026-02-30' },
      { ...competitor, name: ' ' }, { ...competitor, name: 'x'.repeat(121) },
      { ...competitor, score: 99 }, { ...competitor, followerGrowth: 10 },
    ]) assert.equal((await p.editor.client.request('POST', base + '/competitors', body, idempotency())).status, 422, JSON.stringify(body));
    assert.equal(storedCompetitor.followers, 1200);
    assert.equal(storedCompetitor.postsObserved, 12);
    assert.equal(storedCompetitor.observationDays, 14);
    assert.notEqual(storedCompetitor.verified, true);
  });

  await t.test('idempotency, exact version conflicts, reversible archive and scoped audit history', async () => {
    const key = idempotency('strategy-idempotent-independent');
    const a = await p.editor.client.ok('POST', base + '/entries', { ...entry, title: 'Exactly once' }, key);
    const b = await p.editor.client.ok('POST', base + '/entries', { ...entry, title: 'Exactly once' }, key);
    assert.equal(a.id, b.id);
    const edits = await Promise.all(['New A', 'New B'].map(title => p.editor.client.request('PATCH', base + '/entries/' + storedEntry.id, { expectedVersion: storedEntry.version, title }, idempotency())));
    assert.deepEqual(edits.map(r => r.status).sort(), [200, 409]);
    storedEntry = edits.find(r => r.status === 200).data;
    for (const role of ['reviewer', 'viewer']) assertDenied(await p[role].client.request('PATCH', base + '/entries/' + storedEntry.id, { expectedVersion: storedEntry.version, archived: true }, idempotency()), 403);
    storedEntry = await p.editor.client.ok('PATCH', base + '/entries/' + storedEntry.id, { expectedVersion: storedEntry.version, archived: true }, idempotency());
    assert.ok(!(await p.editor.client.ok('GET', base + '/entries')).some(row => row.id === storedEntry.id));
    assert.ok((await p.editor.client.ok('GET', base + '/entries?archived=true')).some(row => row.id === storedEntry.id));
    storedEntry = await p.editor.client.ok('PATCH', base + '/entries/' + storedEntry.id, { expectedVersion: storedEntry.version, archived: false }, idempotency());
    assert.ok((await p.editor.client.ok('GET', base + '/entries')).some(row => row.id === storedEntry.id));
    const audit = JSON.stringify(h.db.prepare('SELECT * FROM audit_events').all());
    assert.ok(!audit.includes(entry.sourceNotes));
    assert.doesNotMatch(audit, /password_hash|credential|secret@example/);
    assert.ok(h.db.prepare('SELECT count(*) AS n FROM strategy_revisions').get().n >= 5);
  });

  await t.test('dashboard dates are bounded and grants are rechecked on the next read', async () => {
    for (const query of ['?from=2026-01-01', '?from=2026-02-30&to=2026-03-01', '?from=2026-10-14&to=2026-10-01', '?from=2020-01-01&to=2026-10-14']) assert.equal((await p.editor.client.request('GET', base + '/dashboard' + query)).status, 422, query);
    const dashboard = await p.editor.client.request('GET', base + '/dashboard?from=2026-10-01&to=2026-10-14');
    assert.equal(dashboard.status, 200, dashboard.body);
    assert.doesNotMatch(dashboard.body, /HIDDEN|password_hash|access_token|token_hash/);
    const membership = h.db.prepare('SELECT version FROM memberships WHERE tenant_id=? AND user_id=?').get(h.tenant.id, p.viewer.user.id);
    await p.owner.client.ok('PATCH', `/api/v1/tenants/${h.tenant.id}/members/${p.viewer.user.id}`, { workspaceIds: [h.hidden.id], expectedVersion: membership.version });
    for (const suffix of ['/dashboard', '/entries', '/competitors']) assertDenied(await p.viewer.client.request('GET', base + suffix));
  });
});
