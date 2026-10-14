import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const statuses = ['draft', 'in_review', 'changes_requested', 'approved', 'planned', 'archived'];
export const platforms = ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'pinterest', 'threads', 'x', 'other'];
export const formats = ['image', 'carousel', 'video', 'reel', 'story', 'text'];
export const string = (maxLength, minLength = 1) => ({ type: 'string', minLength, maxLength });
export const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const identifier = string(100);
export const positive = { type: 'integer', minimum: 1 };
export const listQuery = { limit: { type: 'integer', minimum: 1, maximum: 100 }, cursor: string(512) };
export const base = '/api/v1/tenants/:tid/workspaces/:wid';
export function fail(ctx, status, code, message) { throw ctx.errors.http(status, code, message); }
export function role(ctx, request, allowed) {
  if (!allowed.includes(request.tenant.role)) fail(ctx, 403, 'FORBIDDEN', 'Você não tem permissão para esta ação.');
}
export function workspace(ctx, request, action = 'read', allowArchived = false) {
  const row = ctx.policy.workspace(request, request.params.wid, action);
  if (!allowArchived && action !== 'read' && row.archived_at) fail(ctx, 409, 'WORKSPACE_ARCHIVED', 'Restaure a marca antes de alterá-la.');
  return row;
}
export function writable(ctx, request) { ctx.services.entitlements.assertCan(request.params.tid, 'posts', 0); }
export function audit(ctx, request, action, targetType, targetId, safeChanges) {
  ctx.audit({ tenantId: request.params.tid, actorId: request.user.id, action, targetType, targetId,
    outcome: 'success', safeChanges, requestId: request.id });
}
export function mutation(ctx, request, reply, fn, options) {
  const result = ctx.idempotency(request, fn, options);
  return reply.code(result.statusCode).send({ data: result.data });
}
export function page(ctx, query = {}) {
  let after = '';
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (Object.keys(parsed).sort().join(',') !== 'after,v' || parsed.v !== 1 || typeof parsed.after !== 'string' || !/^[\w-]{1,100}$/.test(parsed.after)) throw Error();
      after = parsed.after;
    } catch { fail(ctx, 422, 'INVALID_CURSOR', 'Cursor inválido.'); }
  }
  return { limit: query.limit || 50, after };
}
export function paginated(rows, limit, mapper = row => row, key = 'id') {
  const hasNext = rows.length > limit;
  const kept = rows.slice(0, limit);
  return { data: kept.map(mapper), meta: { nextCursor: hasNext ? Buffer.from(JSON.stringify({ v: 1, after: String(kept.at(-1)[key]) })).toString('base64url') : null } };
}
export function workspaceDTO(row) {
  return { id: row.id, name: row.name, color: row.color, archivedAt: row.archived_at, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at };
}
export function channelDTO(row) {
  return { id: row.id, workspaceId: row.workspace_id, platform: row.platform, label: row.label,
    connectionStatus: row.connection_status, archivedAt: row.archived_at, version: row.version };
}
export function mediaDTO(row) {
  return { id: row.id, workspaceId: row.workspace_id, originalName: row.original_name,
    mime: row.normalized_mime, sizeBytes: row.size_bytes, width: row.width, height: row.height,
    createdAt: row.created_at, contentUrl: `/api/v1/tenants/${encodeURIComponent(row.tenant_id)}/workspaces/${encodeURIComponent(row.workspace_id)}/media/${encodeURIComponent(row.id)}/content` };
}
export function postRow(ctx, request) {
  const row = ctx.db.prepare('SELECT * FROM posts WHERE tenant_id=? AND workspace_id=? AND id=?')
    .get(request.params.tid, request.params.wid, request.params.pid);
  if (!row) fail(ctx, 404, 'NOT_FOUND', 'Peça não encontrada.');
  return row;
}
export function postDTO(ctx, row) {
  const args = [row.tenant_id, row.workspace_id, row.id];
  const channels = ctx.db.prepare('SELECT c.* FROM post_channels pc JOIN channels c ON c.tenant_id=pc.tenant_id AND c.workspace_id=pc.workspace_id AND c.id=pc.channel_id WHERE pc.tenant_id=? AND pc.workspace_id=? AND pc.post_id=? ORDER BY pc.position').all(...args).map(channelDTO);
  const media = ctx.db.prepare('SELECT m.* FROM post_media pm JOIN media m ON m.tenant_id=pm.tenant_id AND m.workspace_id=pm.workspace_id AND m.id=pm.media_id WHERE pm.tenant_id=? AND pm.workspace_id=? AND pm.post_id=? ORDER BY pm.position').all(...args).map(mediaDTO);
  const tags = ctx.db.prepare('SELECT tag FROM post_tags WHERE tenant_id=? AND workspace_id=? AND post_id=? ORDER BY position').all(...args).map(r => r.tag);
  return { id: row.id, workspaceId: row.workspace_id, title: row.title, caption: row.caption,
    format: row.format, status: row.status, revision: row.revision, approvedRevision: row.approved_revision,
    scheduledAt: row.scheduled_at, scheduledTimezone: row.scheduled_timezone, authorId: row.author_id,
    updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
    tags, channelIds: channels.map(r => r.id), mediaIds: media.map(r => r.id), channels, media };
}
export function expected(ctx, actual, supplied, label = 'REVISION') {
  if (actual !== supplied) fail(ctx, 409, `${label}_CONFLICT`, 'Este item mudou. Atualize a página antes de tentar novamente.');
}
export function notBlank(ctx, value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(ctx, 422, 'VALIDATION_ERROR', `${label} não pode ficar em branco.`);
  return value.trim();
}
export function validateSchedule(ctx, value, timezone, { future = false } = {}) {
  if (typeof timezone !== 'string' || timezone.length > 100 || /^[+-]/.test(timezone)) fail(ctx, 422, 'INVALID_TIMEZONE', 'Escolha um fuso horário IANA válido.');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { fail(ctx, 422, 'INVALID_TIMEZONE', 'Escolha um fuso horário IANA válido.'); }
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail(ctx, 422, 'INVALID_SCHEDULE', 'Informe data e hora com offset explícito.');
  const [, y, mo, d, h, mi, s = '00', , offset] = match;
  const expectedParts = { year: y, month: mo, day: d, hour: h, minute: mi, second: s };
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || +y < 1000 || +mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59 || (offset !== 'Z' && (+offset.slice(1, 3) > 14 || +offset.slice(4, 6) > 59))) fail(ctx, 422, 'INVALID_SCHEDULE', 'Data ou offset inválido.');
  const actual = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  if (Object.entries(expectedParts).some(([key, val]) => actual[key] !== val)) fail(ctx, 422, 'SCHEDULE_TIMEZONE_MISMATCH', 'A hora e o offset não correspondem ao fuso escolhido. Confirme também mudanças de horário de verão.');
  if (future && timestamp <= Date.parse(ctx.now())) fail(ctx, 422, 'SCHEDULE_IN_PAST', 'O planejamento precisa de uma data futura.');
  return { scheduledAt: new Date(timestamp).toISOString(), scheduledTimezone: timezone };
}
