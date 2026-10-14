import { createEntitlements } from './entitlements.mjs';
import { createBillingService } from './billing.mjs';
import { BillingError, DisabledBillingProvider } from './providers.mjs';
export { DisabledBillingProvider, OfflineStripeTestAdapter, StripeWebhookVerifier, STRIPE_API_VERSION, WEBHOOK_TOLERANCE_SECONDS } from './providers.mjs';
export function initializeCommercial(ctx, { billingAdapter } = {}) {
  if (billingAdapter && (ctx.config.mode !== 'test' || billingAdapter.testOnly !== true)) throw new Error('Billing adapter injection is restricted to explicit offline tests');
  ctx.services ||= {};
  ctx.services.entitlements = createEntitlements(ctx);
  ctx.services.billing = createBillingService(ctx, billingAdapter ?? new DisabledBillingProvider());
  return ctx.services;
}
const params = { type: 'object', additionalProperties: false, required: ['tid'], properties: { tid: { type: 'string', minLength: 1, maxLength: 200 } } };
const reason = { type: 'string', minLength: 3, maxLength: 500 };
const emptyBody = { type: 'object', additionalProperties: false, properties: {} };
const listQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, cursor: { type: 'string', maxLength: 512 } } };
function decodeCursor(ctx, cursor) {
  if (!cursor) return '';
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (value.v !== 1 || typeof value.id !== 'string' || value.id.length > 200 || Object.keys(value).sort().join(',') !== 'id,v') throw new Error();
    return value.id;
  } catch { throw ctx.errors.http(422, 'INVALID_CURSOR', 'Cursor inválido.'); }
}
const cursorFor = id => Buffer.from(JSON.stringify({ v: 1, id })).toString('base64url');
export async function registerCommercial(app, ctx) {
  if (!ctx.services?.entitlements) initializeCommercial(ctx);
  const { db } = ctx, { entitlements, billing } = ctx.services;
  const tenantAuth = [ctx.auth.requireUser, ctx.auth.requireTenant];
  const adminAuth = [ctx.auth.requireUser, ctx.auth.requirePlatformAdmin];
  const owner = request => { if (request.tenant.role !== 'owner') throw ctx.errors.http(403, 'FORBIDDEN', 'Somente o proprietário pode gerenciar cobrança.'); };
  app.get('/api/v1/plans', async () => ({ data: db.prepare('SELECT id,version,label,limits_json,flags_json FROM plans WHERE active=1 ORDER BY id,version').all().map(p => ({
    id: p.id, version: p.version, label: p.label, limits: JSON.parse(p.limits_json), flags: JSON.parse(p.flags_json),
    priceLabel: 'a definir', technicalPreset: true, purchasable: false,
  })), meta: { billingEnabled: false } }));
  app.get('/api/v1/tenants/:tid/entitlements', { preHandler: tenantAuth, schema: { params } }, async request => {
    const entitlement = entitlements.get(request.tenant.id);
    const mayReadOrganizationUsage = ['owner', 'admin'].includes(request.tenant.role);
    return { data: { ...entitlement, usage: mayReadOrganizationUsage ? entitlement.usage : null,
      overLimit: mayReadOrganizationUsage ? entitlement.overLimit : [], usageScope: mayReadOrganizationUsage ? 'organization' : 'restricted' } };
  });
  for (const operation of ['checkout', 'portal']) {
    app.post(`/api/v1/tenants/:tid/billing/${operation}`, { preHandler: tenantAuth, schema: { params, body: emptyBody } }, async request => {
      owner(request); ctx.auth.requireRecentAuth(request);
      // No provider checkout exists in this pilot, even with the offline webhook test adapter.
      throw ctx.errors.http(503, 'BILLING_NOT_CONFIGURED', operation === 'checkout' ? 'Cobrança desativada. Preços a definir; nenhuma assinatura será criada.' : 'Portal de cobrança indisponível neste piloto.');
    });
  }
  app.get('/api/v1/admin/tenants', { preHandler: adminAuth, schema: { querystring: listQuery } }, async request => {
    const limit = request.query.limit ?? 25, after = decodeCursor(ctx, request.query.cursor);
    const rows = db.prepare('SELECT id,name,status,created_at FROM tenants WHERE id>? ORDER BY id LIMIT ?').all(after, limit + 1);
    const data = rows.slice(0, limit).map(row => {
      const e = entitlements.get(row.id);
      return { id: row.id, name: row.name, status: row.status, createdAt: row.created_at, memberCount: e.usage.members, workspaceCount: e.usage.workspaces, postCount: e.usage.posts,
        entitlement: { planId: e.plan.id, source: e.source, endsAt: e.endsAt, accessMode: e.accessMode } };
    });
    return { data, meta: { nextCursor: rows.length > limit ? cursorFor(data.at(-1).id) : null } };
  });
  app.get('/api/v1/admin/health-summary', { preHandler: adminAuth }, async () => {
    const count = sql => Number(db.prepare(sql).get().n);
    return { data: { billingEnabled: false, tenantCount: count('SELECT COUNT(*) AS n FROM tenants'),
      failedJobs: count("SELECT COUNT(*) AS n FROM jobs WHERE state='failed'"), pendingJobs: count("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','retry','processing')"),
      quarantinedEvents: count("SELECT COUNT(*) AS n FROM billing_events WHERE state='quarantined'"),
      expiredEntitlements: Number(db.prepare('SELECT COUNT(*) AS n FROM tenant_entitlements WHERE ends_at<=?').get(ctx.now()).n),
      publicLaunchReady: false, scope: 'operational-metadata-only' } };
  });
  app.post('/api/v1/admin/tenants/:tid/entitlement-grants', { preHandler: adminAuth, schema: { params, body: { type: 'object', additionalProperties: false,
    required: ['planId', 'planVersion', 'endsAt', 'reason'], properties: { planId: { type: 'string', maxLength: 100 }, planVersion: { type: 'integer', minimum: 1 }, endsAt: { type: 'string', maxLength: 32 }, reason,
      expectedVersion: { type: 'integer', minimum: 1 } } } } }, async (request, reply) => {
    ctx.auth.requireRecentAuth(request);
    const result = ctx.idempotency(request, () => {
      if (!db.prepare("SELECT user_id FROM platform_admins WHERE user_id=? AND status='active'").get(request.user.id)) throw ctx.errors.http(403, 'PLATFORM_ADMIN_REQUIRED', 'Acesso de operação necessário.');
      ctx.auth.requireRecentAuth(request);
      const body = request.body, now = ctx.now();
      if (body.reason.trim().length < 3 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(body.endsAt) || !Number.isFinite(Date.parse(body.endsAt))) throw ctx.errors.http(422, 'INVALID_GRANT', 'Informe motivo e prazo UTC válidos.');
      const end = new Date(body.endsAt).toISOString();
      if (end.replace('.000Z', 'Z') !== body.endsAt.replace('.000Z', 'Z')) throw ctx.errors.http(422, 'INVALID_GRANT', 'Informe uma data UTC existente.');
      if (end <= now || Date.parse(end) - Date.parse(now) > 90 * 86400000) throw ctx.errors.http(422, 'INVALID_GRANT_DURATION', 'O acesso manual precisa terminar em até 90 dias.');
      const old = db.prepare('SELECT * FROM tenant_entitlements WHERE tenant_id=?').get(request.params.tid);
      if (!old) throw ctx.errors.http(404, 'NOT_FOUND', 'Organização indisponível.');
      if (body.expectedVersion !== undefined && body.expectedVersion !== old.version) throw ctx.errors.http(409, 'REVISION_CONFLICT', 'O acesso foi atualizado. Recarregue antes de tentar novamente.');
      const plan = db.prepare('SELECT id,version FROM plans WHERE id=? AND version=? AND active=1').get(body.planId, body.planVersion);
      if (!plan) throw ctx.errors.http(422, 'INVALID_PLAN', 'Preset técnico indisponível.');
      db.prepare("UPDATE tenant_entitlements SET plan_id=?,plan_version=?,source='manual_trial',starts_at=?,ends_at=?,version=version+1,access_policy='enabled',updated_at=? WHERE tenant_id=?")
        .run(plan.id, plan.version, now, end, now, request.params.tid);
      ctx.audit({ tenantId: request.params.tid, actorId: request.user.id, action: 'admin.entitlement.granted', targetType: 'tenant', targetId: request.params.tid, outcome: 'success', requestId: request.id,
        safeChanges: { planId: plan.id, planVersion: plan.version, endsAt: end, source: 'manual_trial', reason: body.reason.trim() } });
      return { statusCode: 201, data: entitlements.get(request.params.tid) };
    }, { required: true });
    reply.code(result.statusCode).send({ data: result.data });
  });
  app.get('/api/v1/admin/billing-failures', { preHandler: adminAuth, schema: { querystring: listQuery } }, async request => {
    const limit = request.query.limit ?? 25, after = decodeCursor(ctx, request.query.cursor);
    const rows = db.prepare(`SELECT e.id,e.tenant_id,e.state,e.event_type,e.error_code,e.attempts,e.received_at,j.id AS job_id FROM billing_events e
      LEFT JOIN jobs j ON j.payload_ref=e.id AND j.tenant_id=e.tenant_id
      WHERE e.state IN ('failed','quarantined') AND e.id>? ORDER BY e.id LIMIT ?`).all(after, limit + 1);
    const data = rows.slice(0, limit).map(e => ({ id: e.id, jobId: e.job_id ?? null, tenantId: e.tenant_id, state: e.state, eventType: e.event_type, errorCode: e.error_code, attempts: e.attempts, receivedAt: e.received_at }));
    return { data, meta: { nextCursor: rows.length > limit ? cursorFor(data.at(-1).id) : null } };
  });
  app.post('/api/v1/admin/billing-jobs/:jobId/retry', { preHandler: adminAuth, schema: {
    params: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: { type: 'string', minLength: 1, maxLength: 200 } } },
    body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } },
  } }, async (request, reply) => {
    ctx.auth.requireRecentAuth(request);
    const result = ctx.idempotency(request, () => {
      if (!db.prepare("SELECT user_id FROM platform_admins WHERE user_id=? AND status='active'").get(request.user.id)) throw ctx.errors.http(403, 'PLATFORM_ADMIN_REQUIRED', 'Acesso de operação necessário.');
      ctx.auth.requireRecentAuth(request);
      if (request.body.reason.trim().length < 3) throw ctx.errors.http(422, 'INVALID_REASON', 'Informe o motivo.');
      const job = db.prepare("SELECT * FROM jobs WHERE id=? AND state='failed'").get(request.params.jobId);
      if (!job) throw ctx.errors.http(404, 'NOT_FOUND', 'Falha indisponível.');
      db.prepare("UPDATE jobs SET state='queued',attempts=0,run_at=?,last_error_code=NULL,lease_until=NULL,lease_token=NULL WHERE id=?").run(ctx.now(), job.id);
      db.prepare("UPDATE billing_events SET state='queued',error_code=NULL WHERE id=?").run(job.payload_ref);
      ctx.audit({ tenantId: job.tenant_id, actorId: request.user.id, action: 'admin.billing.retry', targetType: 'job', targetId: job.id, outcome: 'success', requestId: request.id, safeChanges: { reason: request.body.reason.trim() } });
      return { statusCode: 200, data: { id: job.id, state: 'queued' } };
    }, { required: true });
    reply.code(result.statusCode).send({ data: result.data });
  });
  if (billing.provider.enabled) {
    await app.register(async raw => {
      raw.removeContentTypeParser('application/json');
      raw.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 256 * 1024 }, (_request, body, done) => done(null, body));
      raw.post('/api/v1/webhooks/stripe', { bodyLimit: 256 * 1024, config: { signedWebhook: true } }, async (request, reply) => {
        try { return { data: billing.receive(request.body, request.headers) }; }
        catch (error) { if (error instanceof BillingError) throw ctx.errors.http(error.statusCode, error.code, error.message); throw error; }
      });
    });
  }
}
