import { createHash, randomUUID } from 'node:crypto';
import { BillingError } from './providers.mjs';
const TERMINAL_CODES = new Set(['PROVIDER_MAPPING_MISMATCH', 'PROVIDER_SCHEMA_INVALID']);
const STATUSES = new Set(['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused']);
export function createBillingService(ctx, provider) {
  const { db } = ctx, MAX_ATTEMPTS = 5, LEASE_MS = 30000;
  const at = (offset = 0) => new Date(Date.parse(ctx.now()) + offset).toISOString();
  function receive(rawBody, headers) {
    const event = provider.verifyWebhook(rawBody, headers);
    const digest = createHash('sha256').update(rawBody).digest('hex');
    return ctx.transaction(() => {
      const known = db.prepare('SELECT body_digest FROM billing_events WHERE provider=? AND account_scope=? AND event_id=?').get(event.provider, event.accountScope, event.eventId);
      if (known) {
        if (known.body_digest !== digest) throw ctx.errors.http(409, 'WEBHOOK_EVENT_CONFLICT', 'Evento já recebido com conteúdo diferente.');
        return { received: true, duplicate: true };
      }
      const customer = db.prepare('SELECT tenant_id FROM billing_customers WHERE provider=? AND provider_account_scope=? AND customer_id=?').get(event.provider, event.accountScope, event.customerId);
      const subscription = db.prepare('SELECT tenant_id,customer_id FROM subscriptions WHERE provider=? AND provider_account_scope=? AND subscription_id=?').get(event.provider, event.accountScope, event.subscriptionId);
      const matched = Boolean(customer && subscription && customer.tenant_id === subscription.tenant_id && subscription.customer_id === event.customerId);
      const eid = randomUUID(), now = ctx.now();
      db.prepare(`INSERT INTO billing_events(id,provider,account_scope,event_id,tenant_id,object_id,event_type,subscription_id,customer_id,received_at,body_digest,state,error_code)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eid, event.provider, event.accountScope, event.eventId, matched ? customer.tenant_id : null, event.objectId, event.eventType, event.subscriptionId, event.customerId, now, digest, matched ? 'queued' : 'quarantined', matched ? null : 'UNMAPPED_BILLING_OBJECT');
      if (matched) {
        db.prepare(`INSERT INTO jobs(id,tenant_id,type,dedupe_key,payload_ref,run_at,state,created_at)
          VALUES(?,?,'billing.reconcile',?,?,?,'queued',?)`).run(randomUUID(), customer.tenant_id, `${event.provider}:${event.accountScope}:${event.eventId}`, eid, now, now);
      }
      ctx.audit({ tenantId: matched ? customer.tenant_id : undefined, action: matched ? 'billing.event.queued' : 'billing.event.quarantined', targetType: 'billing_event', targetId: eid, outcome: 'success', safeChanges: { eventType: event.eventType } });
      return { received: true, duplicate: false, quarantined: !matched };
    });
  }
  function claim() {
    return ctx.transaction(() => {
      const now = ctx.now();
      // A worker crash on the final attempt must become visible, not remain stuck forever.
      db.prepare(`UPDATE billing_events SET state='failed',error_code='LEASE_RETRY_EXHAUSTED' WHERE id IN
        (SELECT payload_ref FROM jobs WHERE state='processing' AND lease_until<=? AND attempts>=?)`).run(now, MAX_ATTEMPTS);
      db.prepare("UPDATE jobs SET state='failed',last_error_code='LEASE_RETRY_EXHAUSTED',lease_token=NULL,lease_until=NULL WHERE state='processing' AND lease_until<=? AND attempts>=?").run(now, MAX_ATTEMPTS);
      const candidates = db.prepare(`SELECT j.*,e.provider,e.account_scope,e.subscription_id,e.customer_id,e.object_id,e.event_type
        FROM jobs j JOIN billing_events e ON e.id=j.payload_ref
        WHERE ((j.state IN ('queued','retry') AND j.run_at<=?) OR (j.state='processing' AND j.lease_until<=?)) AND j.attempts<?
        ORDER BY j.run_at,j.id LIMIT 100`).all(now, now, MAX_ATTEMPTS);
      for (const job of candidates) {
        const locked = db.prepare('SELECT lease_until FROM billing_reconciliation_locks WHERE provider=? AND account_scope=? AND subscription_id=?').get(job.provider, job.account_scope, job.subscription_id);
        if (locked && locked.lease_until > now) continue;
        const token = randomUUID(), until = at(LEASE_MS);
        db.prepare(`INSERT INTO billing_reconciliation_locks(provider,account_scope,subscription_id,lease_token,lease_until) VALUES(?,?,?,?,?)
          ON CONFLICT(provider,account_scope,subscription_id) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until`).run(job.provider, job.account_scope, job.subscription_id, token, until);
        db.prepare("UPDATE jobs SET state='processing',lease_until=?,lease_token=?,attempts=attempts+1 WHERE id=?").run(until, token, job.id);
        db.prepare("UPDATE billing_events SET state='processing',attempts=attempts+1,error_code=NULL WHERE id=?").run(job.payload_ref);
        return { ...job, lease_token: token, attempts: job.attempts + 1 };
      }
      return null;
    });
  }
  function ownsLease(job) {
    const row = db.prepare(`SELECT j.lease_token,j.lease_until,l.lease_token AS lock_token,l.lease_until AS lock_until FROM jobs j
      JOIN billing_reconciliation_locks l ON l.provider=? AND l.account_scope=? AND l.subscription_id=? WHERE j.id=? AND j.state='processing'`).get(job.provider, job.account_scope, job.subscription_id, job.id);
    return row && row.lease_token === job.lease_token && row.lock_token === job.lease_token && row.lease_until > ctx.now() && row.lock_until > ctx.now();
  }
  function release(job) {
    db.prepare('DELETE FROM billing_reconciliation_locks WHERE provider=? AND account_scope=? AND subscription_id=? AND lease_token=?').run(job.provider, job.account_scope, job.subscription_id, job.lease_token);
  }
  function applySnapshot(job, snapshot) {
    return ctx.transaction(() => {
      if (!ownsLease(job)) return { state: 'lease_lost', jobId: job.id };
      const binding = db.prepare('SELECT * FROM subscriptions WHERE provider=? AND provider_account_scope=? AND subscription_id=?').get(job.provider, job.account_scope, job.subscription_id);
      if (!binding || binding.tenant_id !== job.tenant_id || binding.customer_id !== job.customer_id || snapshot.id !== job.subscription_id || snapshot.customer !== job.customer_id)
        throw new BillingError('PROVIDER_MAPPING_MISMATCH');
      if (!STATUSES.has(snapshot.status) || snapshot.livemode !== false || (snapshot.account ?? 'platform') !== job.account_scope)
        throw new BillingError('PROVIDER_SCHEMA_INVALID');
      const now = ctx.now(), endSeconds = snapshot.status === 'trialing' ? snapshot.trial_end : snapshot.current_period_end;
      if (['active', 'trialing'].includes(snapshot.status) && (!Number.isSafeInteger(endSeconds) || endSeconds < 0 || endSeconds > 253402300799)) throw new BillingError('PROVIDER_SCHEMA_INVALID');
      const end = Number.isSafeInteger(endSeconds) && endSeconds >= 0 && endSeconds <= 253402300799 ? new Date(endSeconds * 1000).toISOString() : now;
      const access = ['active', 'trialing'].includes(snapshot.status) && end > now ? 'enabled' : 'read_only';
      db.prepare(`UPDATE subscriptions SET provider_status=?,period_end=?,cancel_at_period_end=?,reconciled_at=?,reconcile_version=reconcile_version+1
        WHERE provider=? AND provider_account_scope=? AND subscription_id=?`).run(snapshot.status, end, snapshot.cancel_at_period_end === true ? 1 : 0, now, job.provider, job.account_scope, job.subscription_id);
      const old = db.prepare('SELECT * FROM tenant_entitlements WHERE tenant_id=?').get(job.tenant_id);
      const changed = !old || old.plan_id !== binding.plan_id || old.plan_version !== binding.plan_version || old.source !== 'provider' || old.ends_at !== end || old.access_policy !== access;
      if (changed) {
        db.prepare(`INSERT INTO tenant_entitlements(tenant_id,plan_id,plan_version,source,starts_at,ends_at,version,access_policy,updated_at)
          VALUES(?,?,?,'provider',?,?,1,?,?) ON CONFLICT(tenant_id) DO UPDATE SET plan_id=excluded.plan_id,plan_version=excluded.plan_version,
          source='provider',starts_at=excluded.starts_at,ends_at=excluded.ends_at,version=tenant_entitlements.version+1,access_policy=excluded.access_policy,updated_at=excluded.updated_at`)
          .run(job.tenant_id, binding.plan_id, binding.plan_version, now, end, access, now);
        ctx.audit({ tenantId: job.tenant_id, action: 'billing.entitlement.reconciled', targetType: 'tenant', targetId: job.tenant_id, outcome: 'success', safeChanges: { providerStatus: snapshot.status, accessPolicy: access, planId: binding.plan_id } });
      }
      db.prepare("UPDATE jobs SET state='done',completed_at=?,lease_token=NULL,lease_until=NULL,last_error_code=NULL WHERE id=?").run(now, job.id);
      db.prepare("UPDATE billing_events SET state='processed',processed_at=?,error_code=NULL WHERE id=?").run(now, job.payload_ref);
      release(job);
      return { state: 'done', jobId: job.id, entitlementChanged: changed };
    });
  }
  function failJob(job, error) {
    return ctx.transaction(() => {
      if (!ownsLease(job)) return { state: 'lease_lost', jobId: job.id };
      // Never persist arbitrary provider messages, request bodies or credentials in logs/job rows.
      const code = error instanceof BillingError && ['PROVIDER_UNAVAILABLE', 'PROVIDER_OBJECT_NOT_FOUND', ...TERMINAL_CODES].includes(error.code) ? error.code : 'RECONCILIATION_FAILED';
      const failed = job.attempts >= MAX_ATTEMPTS || TERMINAL_CODES.has(code);
      const jitter = parseInt(createHash('sha256').update(`${job.id}:${job.attempts}`).digest('hex').slice(0, 4), 16) % 1000;
      db.prepare('UPDATE jobs SET state=?,run_at=?,lease_token=NULL,lease_until=NULL,last_error_code=? WHERE id=?').run(failed ? 'failed' : 'retry', at(Math.min(3600000, 1000 * 2 ** job.attempts) + jitter), code, job.id);
      db.prepare('UPDATE billing_events SET state=?,error_code=? WHERE id=?').run(failed ? 'failed' : 'queued', code, job.payload_ref);
      release(job);
      if (failed) ctx.audit({ tenantId: job.tenant_id, action: 'billing.reconciliation.failed', targetType: 'job', targetId: job.id, outcome: 'failure', safeChanges: { errorCode: code, attempts: job.attempts } });
      return { state: failed ? 'failed' : 'retry', jobId: job.id, errorCode: code };
    });
  }
  async function processNextJob() {
    if (!provider.enabled) return { state: 'disabled' };
    const job = claim();
    if (!job) return { state: 'idle' };
    try {
      if (job.event_type.startsWith('invoice.')) {
        const invoice = await provider.fetchInvoice(job.object_id);
        if (invoice.id !== job.object_id || invoice.customer !== job.customer_id || invoice.subscription !== job.subscription_id || invoice.livemode !== false || (invoice.account ?? 'platform') !== job.account_scope)
          throw new BillingError('PROVIDER_MAPPING_MISMATCH');
      }
      const snapshot = await provider.fetchSubscription(job.subscription_id);
      return applySnapshot(job, snapshot);
    } catch (error) { return failJob(job, error); }
  }
  return { provider, receive, processNextJob, maxAttempts: MAX_ATTEMPTS, leaseMs: LEASE_MS };
}
