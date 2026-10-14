import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { errors } from '../src/errors.mjs';
import { addSharedServices } from '../src/context.mjs';
import { initializeCommercial, OfflineStripeTestAdapter, STRIPE_API_VERSION } from '../src/commercial/index.mjs';

function fixture(t, { enabled = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  let now = Date.parse('2026-10-14T05:00:00.000Z');
  const secret = randomBytes(32).toString('hex'), clock = () => new Date(now).toISOString();
  const adapter = enabled ? new OfflineStripeTestAdapter({ mode: 'test', webhookSecret: secret, clock }) : undefined;
  const ctx = { db, config: { mode: 'test' }, now: clock, errors, services: {}, transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  addSharedServices(ctx); initializeCommercial(ctx, { billingAdapter: adapter });
  const stamp = clock();
  for (const uid of ['ua', 'ub', 'uc']) db.prepare("INSERT INTO users(id,email_normalized,display_name,password_hash,email_verified_at,status,created_at) VALUES(?,?,?,'test-only-hash',?,'active',?)").run(uid, `${uid}@example.invalid`, uid, stamp, stamp);
  for (const [tid, uid] of [['ta', 'ua'], ['tb', 'ub']]) ctx.transaction(() => {
    db.prepare('INSERT INTO tenants(id,name,slug,timezone,created_at,updated_at) VALUES(?,?,?,\'UTC\',?,?)').run(tid, tid, tid, stamp, stamp);
    db.prepare("INSERT INTO memberships(tenant_id,user_id,role,status,scope,created_at) VALUES(?,?,'owner','active','organization',?)").run(tid, uid, stamp);
    ctx.services.entitlements.initializeTenant(tid);
  });
  function bind(tid = 'ta', customer = 'cus_A', sub = 'sub_A') {
    db.prepare("INSERT INTO billing_customers VALUES(?,'stripe','platform',?)").run(tid, customer);
    db.prepare("INSERT INTO subscriptions(tenant_id,provider,provider_account_scope,subscription_id,customer_id,plan_id,plan_version,provider_status) VALUES(?,'stripe','platform',?,?,'pilot_team',1,'incomplete')").run(tid, sub, customer);
    adapter.subscriptions.set(sub, { id: sub, customer, status: 'active', livemode: false, current_period_end: Math.floor(now / 1000) + 86400, cancel_at_period_end: false });
  }
  function event(eventId = 'evt_A', overrides = {}) { return { id: eventId, object: 'event', type: 'customer.subscription.updated', api_version: STRIPE_API_VERSION, livemode: false, created: Math.floor(now / 1000), data: { object: { id: 'sub_A', object: 'subscription', customer: 'cus_A', metadata: { tenantId: 'tb', plan: 'fraudulent' }, status: 'active' } }, ...overrides }; }
  function signed(value, options = {}) {
    const body = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    const header = Stripe.webhooks.generateTestHeaderString({ payload: body.toString(), secret: options.secret ?? secret, timestamp: options.timestamp ?? Math.floor(now / 1000) });
    return [body, { 'stripe-signature': header, 'content-type': 'application/json' }];
  }
  function workspace(id, tid = 'ta') { db.prepare('INSERT INTO workspaces(tenant_id,id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(tid, id, id, clock(), clock()); }
  t.after(() => db.close());
  return { db, ctx, adapter, bind, event, signed, workspace, advance: ms => { now += ms; } };
}

test('technical plans are immutable and billing defaults to disabled without fabricated checkout', t => {
  const { db, ctx } = fixture(t, { enabled: false });
  const e = ctx.services.entitlements.get('ta');
  assert.equal(e.source, 'manual_trial'); assert.equal(e.priceLabel, 'a definir'); assert.equal(e.billing.enabled, false); assert.equal(e.limits.workspaces, 2);
  assert.throws(() => db.prepare("UPDATE plans SET limits_json='{}' WHERE id='pilot_base'").run(), /immutable/);
  assert.throws(() => db.exec("DELETE FROM plans WHERE id='pilot_team'"), /cannot be deleted/);
  assert.throws(() => ctx.services.billing.provider.createCheckout(), { code: 'BILLING_NOT_CONFIGURED', statusCode: 503 });
  assert.throws(() => new OfflineStripeTestAdapter({ mode: 'development' }), /restricted/);
  assert.throws(() => initializeCommercial({ ...ctx, config: { mode: 'development' } }, { billingAdapter: { testOnly: true } }), /restricted/);
});

test('quota check and mutation are one transaction and rollback preserves counts', t => {
  const { ctx, workspace } = fixture(t);
  assert.throws(() => ctx.services.entitlements.assertCan('ta', 'workspaces'), /transaction/);
  for (const id of ['w1', 'w2']) ctx.transaction(() => { ctx.services.entitlements.assertCan('ta', 'workspaces'); workspace(id); });
  assert.throws(() => ctx.transaction(() => { ctx.services.entitlements.assertCan('ta', 'workspaces'); workspace('w3'); }), { code: 'QUOTA_EXCEEDED' });
  assert.equal(ctx.services.entitlements.get('ta').usage.workspaces, 2);
  assert.equal(ctx.services.entitlements.get('tb').usage.workspaces, 0);
  assert.doesNotThrow(() => ctx.transaction(() => ctx.services.entitlements.assertCan('ta', 'workspaces', 0)));
});

test('valid pending invitations reserve seats; expired and accepted invitations do not', t => {
  const { db, ctx } = fixture(t), now = ctx.now();
  const invite = (id, end, accepted = null) => db.prepare("INSERT INTO invitations(id,tenant_id,email_normalized,role,scope,token_hash,expires_at,accepted_at,invited_by,created_at) VALUES(?,'ta',?,'viewer','workspaces',?,?,?,'ua',?)").run(id, `${id}@example.invalid`, id, end, accepted, now);
  invite('iv1', '2026-10-15T00:00:00.000Z'); invite('iv2', '2026-10-15T00:00:00.000Z'); invite('iv3', '2026-10-13T00:00:00.000Z'); invite('iv4', '2026-10-15T00:00:00.000Z', now);
  assert.equal(ctx.services.entitlements.get('ta').usage.members, 3);
  assert.throws(() => ctx.transaction(() => ctx.services.entitlements.assertCan('ta', 'members')), { code: 'QUOTA_EXCEEDED' });
});

test('expired trial is read-only and downgrade never deletes existing data', t => {
  const { ctx, db, workspace, advance } = fixture(t);
  ctx.transaction(() => { workspace('w1'); workspace('w2'); workspace('w3'); });
  assert.deepEqual(ctx.services.entitlements.get('ta').overLimit, ['workspaces']);
  assert.throws(() => ctx.transaction(() => ctx.services.entitlements.assertCan('ta', 'workspaces')), { code: 'QUOTA_EXCEEDED' });
  assert.doesNotThrow(() => ctx.transaction(() => ctx.services.entitlements.assertCan('ta', 'posts')));
  advance(15 * 86400000);
  assert.equal(ctx.services.entitlements.get('ta').accessMode, 'read_only');
  assert.throws(() => ctx.transaction(() => ctx.services.entitlements.assertCan('ta', 'posts', 0)), { code: 'ENTITLEMENT_READ_ONLY' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workspaces').get().n, 3);
});

test('official SDK signatures require exact raw bytes, secret and bounded clock', t => {
  const { ctx, event, signed } = fixture(t);
  const [body, headers] = signed(event());
  assert.doesNotThrow(() => ctx.services.billing.receive(body, headers));
  assert.throws(() => ctx.services.billing.receive(Buffer.from(body.toString().replace(/:/, ': ')), headers), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  for (const delta of [-301, 301]) assert.throws(() => ctx.services.billing.receive(...signed(event(`evt_Time${Math.abs(delta)}`), { timestamp: Date.parse('2026-10-14T05:00:00Z') / 1000 + delta })), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  assert.throws(() => ctx.services.billing.receive(...signed(event('evt_Wrong'), { secret: randomBytes(32).toString('hex') })), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  assert.throws(() => ctx.services.billing.receive(body, {}), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  assert.throws(() => ctx.services.billing.receive(body, { ...headers, 'content-encoding': 'gzip' }), { code: 'WEBHOOK_ENCODING_INVALID' });
});

test('mode/account/API schema mismatch and unsupported event types never persist', t => {
  const { ctx, db, event, signed } = fixture(t);
  for (const change of [{ livemode: true }, { account: 'acct_unexpected' }, { api_version: 'unknown' }, { type: 'checkout.session.completed' }, { data: { object: { id: 'sub_A', object: 'subscription', customer: { id: 'cus_A' } } } }]) {
    assert.throws(() => ctx.services.billing.receive(...signed(event('evt_Invalid', change))));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_events').get().n, 0);
});

test('unknown mappings quarantine while hostile metadata cannot change the authoritative tenant', async t => {
  const { ctx, db, bind, event, signed } = fixture(t);
  bind();
  const beforeB = ctx.services.entitlements.get('tb').version;
  assert.equal(ctx.services.billing.receive(...signed(event())).quarantined, false);
  assert.equal((await ctx.services.billing.processNextJob()).state, 'done');
  assert.equal(ctx.services.entitlements.get('ta').plan.id, 'pilot_team');
  assert.equal(ctx.services.entitlements.get('tb').version, beforeB);
  const bad = event('evt_Unknown', { data: { object: { id: 'sub_Unknown', object: 'subscription', customer: 'cus_A', metadata: { tenantId: 'ta' } } } });
  assert.equal(ctx.services.billing.receive(...signed(bad)).quarantined, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
  assert.equal(db.prepare("SELECT tenant_id FROM billing_events WHERE event_id='evt_Unknown'").get().tenant_id, null);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM billing_events').all()).includes('fraudulent'), false);
});

test('duplicate event is durable and idempotent; repeated current state does not double-grant', async t => {
  const { ctx, db, bind, event, signed } = fixture(t); bind();
  const payload = signed(event());
  const receipt = await Promise.all([Promise.resolve().then(() => ctx.services.billing.receive(...payload)), Promise.resolve().then(() => ctx.services.billing.receive(...payload))]);
  assert.deepEqual(receipt.map(x => x.duplicate).sort(), [false, true]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
  assert.equal((await ctx.services.billing.processNextJob()).entitlementChanged, true);
  const version = ctx.services.entitlements.get('ta').version;
  assert.equal((await ctx.services.billing.processNextJob()).state, 'idle');
  ctx.services.billing.receive(...signed(event('evt_SameState')));
  assert.equal((await ctx.services.billing.processNextJob()).entitlementChanged, false);
  assert.equal(ctx.services.entitlements.get('ta').version, version);
  assert.throws(() => ctx.services.billing.receive(...signed(event('evt_A', { created: 1 }))), { code: 'WEBHOOK_EVENT_CONFLICT' });
});

test('out-of-order activation and invoices reconcile current cancellation rather than their stale snapshots', async t => {
  const { ctx, adapter, bind, event, signed } = fixture(t); bind();
  adapter.subscriptions.get('sub_A').status = 'canceled';
  ctx.services.billing.receive(...signed(event('evt_OldActive', { created: 1 })));
  await ctx.services.billing.processNextJob();
  assert.equal(ctx.services.entitlements.get('ta').accessMode, 'read_only');
  adapter.invoices.set('in_A', { id: 'in_A', customer: 'cus_A', subscription: 'sub_A', livemode: false });
  ctx.services.billing.receive(...signed(event('evt_Invoice', { created: 1, type: 'invoice.paid', data: { object: { id: 'in_A', object: 'invoice', customer: 'cus_A', subscription: 'sub_A' } } })));
  await ctx.services.billing.processNextJob();
  assert.equal(ctx.services.entitlements.get('ta').accessMode, 'read_only');
  assert.equal(adapter.calls.invoice, 1);
});

test('jobs use bounded retries and terminal safe errors without retaining provider secrets', async t => {
  const { ctx, db, adapter, bind, event, signed, advance } = fixture(t); bind(); adapter.failuresRemaining = 20;
  ctx.services.billing.receive(...signed(event()));
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await ctx.services.billing.processNextJob();
    assert.equal(result.state, attempt === 5 ? 'failed' : 'retry'); advance(3600000);
  }
  assert.equal((await ctx.services.billing.processNextJob()).state, 'idle');
  const row = db.prepare('SELECT * FROM jobs').get(); assert.equal(row.attempts, 5); assert.equal(row.last_error_code, 'PROVIDER_UNAVAILABLE');
  assert.equal(db.prepare('SELECT state FROM billing_events').get().state, 'failed');
});

test('subscription lease serializes workers and an expired owner cannot apply a stale snapshot', async t => {
  const { ctx, adapter, bind, event, signed, advance } = fixture(t); bind();
  ctx.services.billing.receive(...signed(event()));
  let resolveFirst, started;
  const began = new Promise(r => { started = r; });
  const fetch = adapter.fetchSubscription.bind(adapter);
  adapter.fetchSubscription = async id => { adapter.fetchSubscription = fetch; const stale = await fetch(id); started(); return new Promise(r => { resolveFirst = () => r(stale); }); };
  const first = ctx.services.billing.processNextJob(); await began;
  assert.equal((await ctx.services.billing.processNextJob()).state, 'idle');
  advance(31000); adapter.subscriptions.get('sub_A').status = 'canceled';
  assert.equal((await ctx.services.billing.processNextJob()).state, 'done');
  resolveFirst(); assert.equal((await first).state, 'lease_lost');
  assert.equal(ctx.services.entitlements.get('ta').accessMode, 'read_only');
});

test('normalized FK bindings reject cross-tenant customer records and invalid plan versions', t => {
  const { db, bind } = fixture(t); bind();
  assert.throws(() => db.prepare("INSERT INTO subscriptions(tenant_id,provider,provider_account_scope,subscription_id,customer_id,plan_id,plan_version,provider_status) VALUES('tb','stripe','platform','sub_B','cus_A','pilot_base',1,'active')").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE tenant_entitlements SET plan_version=999 WHERE tenant_id='ta'").run(), /FOREIGN KEY/);
});

test('post and normalized-media quotas count actual tenant rows and release only archived post capacity', t => {
  const { db, ctx, workspace } = fixture(t); workspace('w1');
  const post = db.prepare("INSERT INTO posts(tenant_id,workspace_id,id,title,author_id,updated_by,created_at,updated_at) VALUES('ta','w1',?,?,'ua','ua',?,?)");
  ctx.transaction(() => { for (let i = 0; i < 100; i++) { ctx.services.entitlements.assertCan('ta', 'posts'); post.run(`p${i}`, `Post ${i}`, ctx.now(), ctx.now()); } });
  assert.throws(() => ctx.transaction(() => { ctx.services.entitlements.assertCan('ta', 'posts'); post.run('overflow', 'Overflow', ctx.now(), ctx.now()); }), { code: 'QUOTA_EXCEEDED' });
  db.prepare("UPDATE posts SET status='archived' WHERE tenant_id='ta' AND id='p0'").run();
  assert.doesNotThrow(() => ctx.transaction(() => { ctx.services.entitlements.assertCan('ta', 'posts'); post.run('replacement', 'Replacement', ctx.now(), ctx.now()); }));
  const size = 5 * 1024 * 1024;
  const media = db.prepare("INSERT INTO media(tenant_id,workspace_id,id,original_name,normalized_mime,size_bytes,width,height,digest,created_by,created_at) VALUES('ta','w1',?,'test.png','image/png',?,1,1,'test','ua',?)");
  ctx.transaction(() => { for (let i = 0; i < 4; i++) { ctx.services.entitlements.assertCan('ta', 'mediaBytes', size); media.run(`m${i}`, size, ctx.now()); } });
  assert.throws(() => ctx.transaction(() => ctx.services.entitlements.assertCan('ta', 'mediaBytes', 1)), { code: 'QUOTA_EXCEEDED' });
  assert.equal(ctx.services.entitlements.get('ta').usage.mediaBytes, 20 * 1024 * 1024);
  assert.equal(ctx.services.entitlements.get('tb').usage.mediaBytes, 0);
});

test('event acknowledgment happens only after atomic durable event, job and audit insertion', t => {
  const { ctx, db, bind, event, signed } = fixture(t); bind();
  const audit = ctx.audit; ctx.audit = () => { throw new Error('simulated persistence failure'); };
  assert.throws(() => ctx.services.billing.receive(...signed(event())), /persistence failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  ctx.audit = audit;
  assert.equal(ctx.services.billing.receive(...signed(event())).received, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM billing_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
});

test('provider-mapping mismatch fails safely instead of changing a different tenant entitlement', async t => {
  const { ctx, adapter, bind, event, signed } = fixture(t); bind();
  const initial = ctx.services.entitlements.get('ta').version;
  adapter.subscriptions.get('sub_A').customer = 'cus_Forged';
  ctx.services.billing.receive(...signed(event()));
  assert.equal((await ctx.services.billing.processNextJob()).state, 'failed');
  assert.equal(ctx.services.entitlements.get('ta').version, initial);
  assert.equal(ctx.services.entitlements.get('tb').source, 'manual_trial');
});

test('final crashed worker lease expires into the visible failure queue', async t => {
  const { ctx, db, bind, event, signed, advance } = fixture(t); bind();
  ctx.services.billing.receive(...signed(event()));
  db.prepare("UPDATE jobs SET state='processing',attempts=5,lease_token='abandoned',lease_until=?").run(ctx.now());
  advance(1000);
  assert.equal((await ctx.services.billing.processNextJob()).state, 'idle');
  assert.equal(db.prepare('SELECT state FROM jobs').get().state, 'failed');
  assert.equal(db.prepare('SELECT error_code FROM billing_events').get().error_code, 'LEASE_RETRY_EXHAUSTED');
});

test('invalid verification clock fails closed and jobs cannot cross their event tenant', t => {
  const { ctx, db, adapter, bind, event, signed } = fixture(t); bind();
  const packet = signed(event());
  const clock = adapter.verifier.clock; adapter.verifier.clock = () => 'invalid-clock';
  assert.throws(() => ctx.services.billing.receive(...packet), { code: 'WEBHOOK_SIGNATURE_INVALID' });
  adapter.verifier.clock = clock;
  ctx.services.billing.receive(...packet);
  assert.throws(() => db.prepare("UPDATE jobs SET tenant_id='tb'").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE jobs SET tenant_id=NULL').run(), /CHECK constraint/);
});
