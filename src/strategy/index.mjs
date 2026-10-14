import { id, identifier, positive, listQuery, base, fail, workspace, writable, audit, mutation, page, paginated, expected, notBlank, platforms } from '../editorial/shared.mjs';
import { string, object, nullable, urlInput, dateInput, quadrants, safeURL, validDate, entryDTO, competitorDTO } from './shared.mjs';
import { editorialMetrics } from './metrics.mjs';

const sourceProps = { sourceType: { enum: ['user_provided', 'public_source'] }, sourceUrl: urlInput, observedOn: dateInput, sourceNotes: string(2000, 0) };
const entryProps = { quadrant: { enum: quadrants }, title: string(160), description: string(2000, 0), classification: { enum: ['hypothesis', 'evidence'] }, ...sourceProps };
const competitorProps = { name: string(120), websiteUrl: urlInput, profileUrl: urlInput, platform: { enum: platforms }, positioning: string(1000, 0), audience: string(1000, 0), formats: string(1000, 0),
  followers: nullable({ type: 'integer', minimum: 0, maximum: 10000000000 }), postsObserved: nullable({ type: 'integer', minimum: 0, maximum: 1000000 }), observationDays: nullable({ type: 'integer', minimum: 1, maximum: 365 }), ...sourceProps };
const specs = [
  { path: 'entries', type: 'entry', table: 'strategy_entries', props: entryProps, required: ['quadrant', 'title', 'classification'], dto: entryDTO, max: 200,
    fields: { quadrant: 'quadrant', title: 'title', description: 'description', classification: 'classification', sourceType: 'source_type', sourceUrl: 'source_url', observedOn: 'observed_on', sourceNotes: 'source_notes' },
    defaults: { description: '', sourceType: 'user_provided', sourceUrl: null, observedOn: null, sourceNotes: '' } },
  { path: 'competitors', type: 'competitor', table: 'strategy_competitors', props: competitorProps, required: ['name', 'sourceType', 'observedOn', 'sourceNotes'], dto: competitorDTO, max: 100,
    fields: { name: 'name', websiteUrl: 'website_url', profileUrl: 'profile_url', platform: 'platform', positioning: 'positioning', audience: 'audience', formats: 'formats', followers: 'followers', postsObserved: 'posts_observed', observationDays: 'observation_days', sourceType: 'source_type', sourceUrl: 'source_url', observedOn: 'observed_on', sourceNotes: 'source_notes' },
    defaults: { websiteUrl: null, profileUrl: null, platform: 'other', positioning: '', audience: '', formats: '', followers: null, postsObserved: null, observationDays: null, sourceUrl: null } }
];
const archivedSchema = { enum: ['false', 'true', 'all'] };
const dateQuery = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const prefix = `${base}/strategy`;
const args = request => [request.params.tid, request.params.wid];
const archivedWhere = value => value === 'all' ? '' : value === 'true' ? ' AND archived_at IS NOT NULL' : ' AND archived_at IS NULL';
function rowFor(ctx, request, spec) {
  const row = ctx.db.prepare(`SELECT * FROM ${spec.table} WHERE tenant_id=? AND workspace_id=? AND id=?`).get(...args(request), request.params.id);
  if (!row) fail(ctx, 404, 'NOT_FOUND', 'Registro estratégico não encontrado.');
  return row;
}
function normalize(ctx, spec, input) {
  const out = Object.fromEntries(Object.keys(spec.fields).map(key => [key, input[key]]));
  for (const key of ['sourceUrl', ...(spec.type === 'competitor' ? ['websiteUrl', 'profileUrl'] : [])]) out[key] = safeURL(ctx, out[key]);
  for (const key of ['sourceNotes', ...(spec.type === 'entry' ? ['description'] : ['positioning', 'audience', 'formats'])]) out[key] = out[key].trim();
  const main = spec.type === 'entry' ? 'title' : 'name';
  out[main] = notBlank(ctx, out[main], spec.type === 'entry' ? 'Título' : 'Nome');
  const isEvidence = spec.type === 'competitor' || out.classification === 'evidence';
  out.observedOn = validDate(ctx, out.observedOn, { required: isEvidence });
  if (out.sourceType === 'public_source' && !out.sourceUrl) fail(ctx, 422, 'SOURCE_URL_REQUIRED', 'Uma fonte pública precisa de URL.');
  if (isEvidence && !out.sourceUrl && !out.sourceNotes) fail(ctx, 422, 'SOURCE_REQUIRED', 'Registre uma fonte ou nota de origem para a evidência.');
  if (spec.type === 'competitor') {
    out.sourceNotes = notBlank(ctx, out.sourceNotes, 'Nota sobre a fonte');
    if ((out.postsObserved === null) !== (out.observationDays === null)) fail(ctx, 422, 'OBSERVATION_WINDOW_REQUIRED', 'Informe juntos o número de posts observados e os dias de observação, ou deixe ambos vazios.');
  }
  return out;
}
function snapshot(ctx, request, spec, row, action) {
  const dto = spec.dto(row);
  ctx.db.prepare('INSERT INTO strategy_revisions(tenant_id,workspace_id,entity_type,entity_id,version,actor_id,snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(...args(request), spec.type, row.id, row.version, request.user.id, JSON.stringify(dto), ctx.now());
  audit(ctx, request, `strategy.${spec.type}.${action}`, `strategy_${spec.type}`, row.id, { version: row.version, archived: !!row.archived_at, ...(spec.type === 'entry' ? { quadrant: row.quadrant, classification: row.classification } : { sourceType: row.source_type }) });
  return dto;
}
function authorizeWrite(ctx, request) { workspace(ctx, request, 'write'); writable(ctx, request); }

export async function registerStrategy(app, ctx) {
  const auth = [ctx.auth.requireUser, ctx.auth.requireTenant];
  app.get(`${prefix}/dashboard`, { preHandler: auth, schema: { querystring: object({ from: dateQuery, to: dateQuery, archived: archivedSchema }) } }, request => {
    const brand = workspace(ctx, request);
    const result = editorialMetrics(ctx, ...args(request), request.query);
    const entries = ctx.db.prepare(`SELECT * FROM strategy_entries WHERE tenant_id=? AND workspace_id=?${archivedWhere(request.query.archived)} ORDER BY created_at DESC,id`).all(...args(request)).map(entryDTO);
    const competitors = ctx.db.prepare(`SELECT * FROM strategy_competitors WHERE tenant_id=? AND workspace_id=?${archivedWhere(request.query.archived)} ORDER BY name COLLATE NOCASE,id`).all(...args(request)).map(competitorDTO);
    return { data: { ...result, workspace: { id: brand.id, name: brand.name, color: brand.color, archivedAt: brand.archived_at }, generatedAt: ctx.now(), entries, competitors,
      permissions: { write: ['owner', 'admin', 'editor'].includes(request.tenant.role) && !brand.archived_at },
      limits: { entries: 200, competitors: 100 }, competitorMethodology: 'Observações informadas pela equipe; sem coleta automática, verificação independente, ranking ou estimativas. Cada valor mantém sua fonte, data e janela de observação. Fontes e períodos diferentes podem não ser comparáveis.' } };
  });
  for (const spec of specs) {
    const route = `${prefix}/${spec.path}`;
    app.get(route, { preHandler: auth, schema: { querystring: object({ ...listQuery, archived: archivedSchema }) } }, request => {
      workspace(ctx, request);
      const { after, limit } = page(ctx, request.query);
      const rows = ctx.db.prepare(`SELECT * FROM ${spec.table} WHERE tenant_id=? AND workspace_id=? AND id>?${archivedWhere(request.query.archived)} ORDER BY id LIMIT ?`).all(...args(request), after, limit + 1);
      return paginated(rows, limit, spec.dto);
    });
    app.post(route, { preHandler: auth, schema: { body: object(spec.props, spec.required) } }, (request, reply) => {
      workspace(ctx, request, 'write');
      return mutation(ctx, request, reply, () => {
        authorizeWrite(ctx, request);
        const count = ctx.db.prepare(`SELECT count(*) AS n FROM ${spec.table} WHERE tenant_id=? AND workspace_id=?`).get(...args(request)).n;
        if (count >= spec.max) fail(ctx, 409, 'STRATEGY_LIMIT', `Esta marca atingiu o limite de ${spec.max} registros deste tipo, incluindo arquivados.`);
        const input = normalize(ctx, spec, { ...spec.defaults, ...request.body });
        const entityId = id(), now = ctx.now(), columns = Object.values(spec.fields), values = Object.keys(spec.fields).map(key => input[key]);
        ctx.db.prepare(`INSERT INTO ${spec.table}(tenant_id,workspace_id,id,${columns.join(',')},created_by,updated_by,created_at,updated_at) VALUES(${Array(7 + columns.length).fill('?').join(',')})`)
          .run(...args(request), entityId, ...values, request.user.id, request.user.id, now, now);
        const row = ctx.db.prepare(`SELECT * FROM ${spec.table} WHERE tenant_id=? AND workspace_id=? AND id=?`).get(...args(request), entityId);
        return { statusCode: 201, data: snapshot(ctx, request, spec, row, 'created') };
      }, { required: true });
    });
    app.get(`${route}/:id`, { preHandler: auth }, request => { workspace(ctx, request); return { data: spec.dto(rowFor(ctx, request, spec)) }; });
    app.patch(`${route}/:id`, { preHandler: auth, schema: { body: { ...object({ ...spec.props, expectedVersion: positive, archived: { type: 'boolean' } }, ['expectedVersion']), minProperties: 2 } } }, (request, reply) => {
      workspace(ctx, request); rowFor(ctx, request, spec);
      workspace(ctx, request, 'write');
      return mutation(ctx, request, reply, () => {
        authorizeWrite(ctx, request);
        const before = rowFor(ctx, request, spec);
        expected(ctx, before.version, request.body.expectedVersion, 'VERSION');
        const input = normalize(ctx, spec, { ...spec.dto(before), ...request.body });
        const archivedAt = request.body.archived === undefined ? before.archived_at : request.body.archived ? before.archived_at || ctx.now() : null;
        ctx.db.prepare(`UPDATE ${spec.table} SET ${Object.values(spec.fields).map(column => `${column}=?`).join(',')},archived_at=?,version=version+1,updated_by=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=? AND version=?`)
          .run(...Object.keys(spec.fields).map(key => input[key]), archivedAt, request.user.id, ctx.now(), ...args(request), before.id, before.version);
        const row = rowFor(ctx, request, spec);
        const action = before.archived_at === archivedAt ? 'updated' : archivedAt ? 'archived' : 'restored';
        return { statusCode: 200, data: snapshot(ctx, request, spec, row, action) };
      });
    });
    app.get(`${route}/:id/revisions`, { preHandler: auth, schema: { querystring: object(listQuery) } }, request => {
      workspace(ctx, request); rowFor(ctx, request, spec);
      const { after, limit } = page(ctx, request.query);
      if (after && !/^\d+$/.test(after)) fail(ctx, 422, 'INVALID_CURSOR', 'Cursor inválido.');
      const rows = ctx.db.prepare('SELECT version,actor_id,snapshot,created_at FROM strategy_revisions WHERE tenant_id=? AND workspace_id=? AND entity_type=? AND entity_id=? AND version>? ORDER BY version LIMIT ?').all(...args(request), spec.type, request.params.id, Number(after || 0), limit + 1);
      return paginated(rows, limit, row => ({ version: row.version, actorId: row.actor_id, snapshot: JSON.parse(row.snapshot), createdAt: row.created_at }), 'version');
    });
  }
}
