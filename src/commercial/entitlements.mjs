const RESOURCES = new Set(['workspaces', 'members', 'posts', 'mediaBytes']);
export const PILOT_TRIAL_DAYS = 14;
export function createEntitlements(ctx) {
  const { db } = ctx;
  const fail = (status, code, message, fields) => { throw ctx.errors.http(status, code, message, fields); };
  const count = (sql, ...args) => Number(db.prepare(sql).get(...args).n);
  function usage(tid) {
    return {
      workspaces: count('SELECT COUNT(*) AS n FROM workspaces WHERE tenant_id=? AND archived_at IS NULL', tid),
      members: count("SELECT COUNT(*) AS n FROM memberships WHERE tenant_id=? AND status='active'", tid)
        + count('SELECT COUNT(*) AS n FROM invitations WHERE tenant_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?', tid, ctx.now()),
      posts: count("SELECT COUNT(*) AS n FROM posts WHERE tenant_id=? AND status!='archived'", tid),
      mediaBytes: count('SELECT COALESCE(SUM(size_bytes),0) AS n FROM media WHERE tenant_id=?', tid),
    };
  }
  function get(tid) {
    const row = db.prepare(`SELECT e.*,p.label,p.limits_json,t.status AS tenant_status FROM tenant_entitlements e
      JOIN plans p ON p.id=e.plan_id AND p.version=e.plan_version JOIN tenants t ON t.id=e.tenant_id WHERE e.tenant_id=?`).get(tid);
    if (!row) fail(404, 'ENTITLEMENT_NOT_FOUND', 'Organização indisponível.');
    const limits = JSON.parse(row.limits_json), consumed = usage(tid), now = ctx.now();
    return {
      tenantId: tid, plan: { id: row.plan_id, version: row.plan_version, label: row.label },
      source: row.source, startsAt: row.starts_at, endsAt: row.ends_at, version: row.version,
      accessMode: row.access_policy === 'enabled' && row.starts_at <= now && row.ends_at > now && row.tenant_status === 'active' ? 'read_write' : 'read_only',
      usage: consumed, limits, overLimit: [...RESOURCES].filter(r => consumed[r] > limits[r]),
      billing: { enabled: false, label: 'Cobrança desativada' }, priceLabel: 'a definir',
    };
  }
  function assertCan(tid, resource, delta = 1) {
    if (!RESOURCES.has(resource) || !Number.isSafeInteger(delta) || delta < 0) throw new TypeError('Invalid quota request');
    // Fail closed if a caller forgot atomic quota checking. DatabaseSync exposes transaction state.
    if (!db.isTransaction) throw new Error('Quota checks require the enclosing write transaction');
    const entitlement = get(tid);
    if (entitlement.accessMode !== 'read_write') fail(409, 'ENTITLEMENT_READ_ONLY', 'O período de acesso terminou ou a organização está suspensa. Os dados permanecem disponíveis para leitura e exportação.');
    if (delta > 0 && entitlement.usage[resource] + delta > entitlement.limits[resource])
      fail(409, 'QUOTA_EXCEEDED', 'Limite técnico do piloto atingido.', { resource, limit: entitlement.limits[resource] });
    return entitlement;
  }
  function initializeTenant(tid) {
    if (!db.isTransaction) throw new Error('Tenant entitlement initialization requires a transaction');
    const now = ctx.now(), ends = new Date(Date.parse(now) + PILOT_TRIAL_DAYS * 86400000).toISOString();
    db.prepare(`INSERT INTO tenant_entitlements(tenant_id,plan_id,plan_version,source,starts_at,ends_at,version,access_policy,updated_at)
      VALUES(?,'pilot_base',1,'manual_trial',?,?,1,'enabled',?)`).run(tid, now, ends, now);
    return get(tid);
  }
  return { get, assertCan, initializeTenant, usage };
}
