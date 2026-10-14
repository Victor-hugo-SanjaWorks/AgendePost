import { registerMedia } from '../media/index.mjs';
import { id, statuses, platforms, formats, string, object, identifier, positive, listQuery, base, fail, role, workspace, writable, audit, mutation, page, paginated, workspaceDTO, channelDTO, mediaDTO, postRow, postDTO, expected, notBlank, validateSchedule } from './shared.mjs';

const root = '/api/v1/tenants/:tid';
const arrayOf = (items, maxItems) => ({ type: 'array', items, maxItems, uniqueItems: true });
const channelsInput = { type: 'array', maxItems: 6, items: object({ platform: { enum: platforms }, label: string(120) }, ['platform', 'label']) };
const contentProps = { title: string(180), caption: string(10000, 0), format: { enum: formats }, tags: arrayOf(string(60), 20), channelIds: arrayOf(identifier, 6), mediaIds: arrayOf(identifier, 10) };
const scheduleProps = { scheduledAt: { anyOf: [string(40), { type: 'null' }] }, scheduledTimezone: { anyOf: [string(100), { type: 'null' }] } };
const querySchema = extra => object({ ...listQuery, ...extra });

function validateReferences(ctx, tid, wid, body) {
  for (const [field, table] of [['channelIds', 'channels'], ['mediaIds', 'media']]) {
    if (body[field] === undefined) continue;
    for (const target of body[field]) {
      const row = ctx.db.prepare(`SELECT * FROM ${table} WHERE tenant_id=? AND workspace_id=? AND id=?`).get(tid, wid, target);
      if (!row) fail(ctx, 404, 'NOT_FOUND', 'Um dos recursos vinculados não foi encontrado.');
      if (table === 'channels' && row.archived_at) fail(ctx, 409, 'CHANNEL_ARCHIVED', 'O alvo editorial está arquivado.');
    }
  }
  if (body.tags) {
    body.tags = body.tags.map(tag => notBlank(ctx, tag, 'Tag'));
    if (new Set(body.tags).size !== body.tags.length) fail(ctx, 422, 'DUPLICATE_TAG', 'Tags repetidas não são permitidas.');
  }
}
function setRelations(ctx, tid, wid, pid, body) {
  for (const [field, table, column] of [['channelIds', 'post_channels', 'channel_id'], ['mediaIds', 'post_media', 'media_id'], ['tags', 'post_tags', 'tag']]) {
    if (body[field] === undefined) continue;
    ctx.db.prepare(`DELETE FROM ${table} WHERE tenant_id=? AND workspace_id=? AND post_id=?`).run(tid, wid, pid);
    const insert = ctx.db.prepare(`INSERT INTO ${table}(tenant_id,workspace_id,post_id,${column},position) VALUES(?,?,?,?,?)`);
    body[field].forEach((value, position) => insert.run(tid, wid, pid, value, position));
  }
}
function snapshot(ctx, request, row) {
  const dto = postDTO(ctx, row);
  const content = { title: dto.title, caption: dto.caption, format: dto.format, tags: dto.tags,
    channelIds: dto.channelIds, mediaIds: dto.mediaIds, scheduledAt: dto.scheduledAt, scheduledTimezone: dto.scheduledTimezone };
  ctx.db.prepare('INSERT INTO post_revisions(tenant_id,workspace_id,post_id,revision,actor_id,content_snapshot,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(row.tenant_id, row.workspace_id, row.id, row.revision, request.user.id, JSON.stringify(content), ctx.now());
  for (const mid of dto.mediaIds) ctx.db.prepare('INSERT INTO post_revision_media(tenant_id,workspace_id,post_id,revision,media_id) VALUES(?,?,?,?,?)').run(row.tenant_id, row.workspace_id, row.id, row.revision, mid);
}
function event(ctx, request, row, action, from, reason = null) {
  ctx.db.prepare('INSERT INTO post_events(tenant_id,workspace_id,id,post_id,revision,actor_id,action,from_status,to_status,reason,scheduled_at,scheduled_timezone,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(row.tenant_id, row.workspace_id, id(), row.id, row.revision, request.user.id, action, from, row.status, reason, row.scheduled_at, row.scheduled_timezone, ctx.now());
}
function insertPost(ctx, request, input, action = 'post.created') {
  const tid = request.params.tid, wid = request.params.wid, pid = id(), now = ctx.now();
  ctx.services.entitlements.assertCan(tid, 'posts', 1);
  validateReferences(ctx, tid, wid, input);
  ctx.db.prepare('INSERT INTO posts(tenant_id,workspace_id,id,title,caption,format,status,revision,author_id,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,\'draft\',1,?,?,?,?)')
    .run(tid, wid, pid, notBlank(ctx, input.title, 'Título'), input.caption || '', input.format || 'image', request.user.id, request.user.id, now, now);
  setRelations(ctx, tid, wid, pid, input);
  const row = ctx.db.prepare('SELECT * FROM posts WHERE tenant_id=? AND workspace_id=? AND id=?').get(tid, wid, pid);
  snapshot(ctx, request, row);
  event(ctx, request, row, action, null);
  audit(ctx, request, action, 'post', pid, { revision: 1 });
  return postDTO(ctx, row);
}
function visibleClause(request, alias = 'w') {
  return ['owner', 'admin'].includes(request.tenant.role)
    ? { sql: '', args: [] }
    : { sql: ` AND EXISTS(SELECT 1 FROM workspace_grants g WHERE g.tenant_id=${alias}.tenant_id AND g.workspace_id=${alias}.id AND g.user_id=?)`, args: [request.user.id] };
}

export async function registerEditorial(app, ctx) {
  const auth = [ctx.auth.requireUser, ctx.auth.requireTenant];
  app.get(`${root}/workspaces`, { preHandler: auth, schema: { querystring: querySchema({ archived: { enum: ['true', 'false', 'all'] } }) } }, request => {
    const { after, limit } = page(ctx, request.query), visibility = visibleClause(request);
    const filter = request.query.archived === 'all' ? '' : request.query.archived === 'true' ? ' AND w.archived_at IS NOT NULL' : ' AND w.archived_at IS NULL';
    const rows = ctx.db.prepare(`SELECT w.* FROM workspaces w WHERE w.tenant_id=? AND w.id>?${filter}${visibility.sql} ORDER BY w.id LIMIT ?`).all(request.params.tid, after, ...visibility.args, limit + 1);
    return paginated(rows, limit, workspaceDTO);
  });
  app.post(`${root}/workspaces`, { preHandler: auth, schema: { body: object({ name: string(120), color: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }, channels: channelsInput }, ['name']) } }, (request, reply) => {
    role(ctx, request, ['owner', 'admin']);
    return mutation(ctx, request, reply, () => {
      const tid = request.params.tid, wid = id(), now = ctx.now();
      ctx.services.entitlements.assertCan(tid, 'workspaces', 1);
      ctx.db.prepare('INSERT INTO workspaces(tenant_id,id,name,color,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(tid, wid, notBlank(ctx, request.body.name, 'Nome'), request.body.color || '#635BFF', now, now);
      for (const channel of request.body.channels || []) ctx.db.prepare('INSERT INTO channels(tenant_id,workspace_id,id,platform,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(tid, wid, id(), channel.platform, notBlank(ctx, channel.label, 'Nome do alvo'), now, now);
      audit(ctx, request, 'workspace.created', 'workspace', wid, { channelCount: request.body.channels?.length || 0 });
      return { statusCode: 201, data: workspaceDTO(ctx.db.prepare('SELECT * FROM workspaces WHERE tenant_id=? AND id=?').get(tid, wid)) };
    });
  });
  app.patch(base, { preHandler: auth, schema: { body: { ...object({ expectedVersion: positive, name: string(120), color: { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' }, archived: { type: 'boolean' } }, ['expectedVersion']), minProperties: 2 } } }, (request, reply) => {
    workspace(ctx, request, 'manage', true);
    return mutation(ctx, request, reply, () => {
      const row = workspace(ctx, request, 'manage', true), body = request.body;
      expected(ctx, row.version, body.expectedVersion, 'VERSION');
      ctx.services.entitlements.assertCan(request.params.tid, 'workspaces', row.archived_at && body.archived === false ? 1 : 0);
      const archived = body.archived === true ? row.archived_at || ctx.now() : body.archived === false ? null : row.archived_at;
      ctx.db.prepare('UPDATE workspaces SET name=?,color=?,archived_at=?,version=version+1,updated_at=? WHERE tenant_id=? AND id=?')
        .run(body.name === undefined ? row.name : notBlank(ctx, body.name, 'Nome'), body.color || row.color, archived, ctx.now(), row.tenant_id, row.id);
      audit(ctx, request, 'workspace.updated', 'workspace', row.id, { version: row.version + 1, archived: Boolean(archived), changedFields: Object.keys(body).filter(k => k !== 'expectedVersion') });
      return { statusCode: 200, data: workspaceDTO(ctx.db.prepare('SELECT * FROM workspaces WHERE tenant_id=? AND id=?').get(row.tenant_id, row.id)) };
    });
  });
  app.get(`${base}/channels`, { preHandler: auth, schema: { querystring: querySchema({ archived: { enum: ['true', 'false', 'all'] } }) } }, request => {
    workspace(ctx, request);
    const { after, limit } = page(ctx, request.query);
    const archived = request.query.archived === 'all' ? '' : request.query.archived === 'true' ? ' AND archived_at IS NOT NULL' : ' AND archived_at IS NULL';
    return paginated(ctx.db.prepare(`SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND id>?${archived} ORDER BY id LIMIT ?`).all(request.params.tid, request.params.wid, after, limit + 1), limit, channelDTO);
  });
  app.post(`${base}/channels`, { preHandler: auth, schema: { body: object({ platform: { enum: platforms }, label: string(120) }, ['platform', 'label']) } }, (request, reply) => {
    workspace(ctx, request, 'manage');
    return mutation(ctx, request, reply, () => {
      writable(ctx, request);
      const tid = request.params.tid, wid = request.params.wid, cid = id(), now = ctx.now();
      if (ctx.db.prepare('SELECT count(*) AS n FROM channels WHERE tenant_id=? AND workspace_id=?').get(tid, wid).n >= 100) fail(ctx, 409, 'CHANNEL_LIMIT', 'O piloto aceita até 100 alvos por marca, incluindo os arquivados.');
      ctx.db.prepare('INSERT INTO channels(tenant_id,workspace_id,id,platform,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(tid, wid, cid, request.body.platform, notBlank(ctx, request.body.label, 'Nome do alvo'), now, now);
      audit(ctx, request, 'channel.created', 'channel', cid, { platform: request.body.platform, connectionStatus: 'not_connected' });
      return { statusCode: 201, data: channelDTO(ctx.db.prepare('SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND id=?').get(tid, wid, cid)) };
    });
  });
  app.patch(`${base}/channels/:cid`, { preHandler: auth, schema: { body: { ...object({ expectedVersion: positive, label: string(120), archived: { type: 'boolean' } }, ['expectedVersion']), minProperties: 2 } } }, (request, reply) => {
    workspace(ctx, request, 'manage');
    return mutation(ctx, request, reply, () => {
      writable(ctx, request);
      const tid = request.params.tid, wid = request.params.wid, cid = request.params.cid;
      const row = ctx.db.prepare('SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND id=?').get(tid, wid, cid);
      if (!row) fail(ctx, 404, 'NOT_FOUND', 'Alvo editorial não encontrado.');
      expected(ctx, row.version, request.body.expectedVersion, 'VERSION');
      if (request.body.archived === true && ctx.db.prepare("SELECT 1 FROM post_channels pc JOIN posts p ON p.tenant_id=pc.tenant_id AND p.workspace_id=pc.workspace_id AND p.id=pc.post_id WHERE pc.tenant_id=? AND pc.workspace_id=? AND pc.channel_id=? AND p.status!='archived' LIMIT 1").get(tid, wid, cid)) fail(ctx, 409, 'CHANNEL_IN_USE', 'Remova o alvo das peças ativas antes de arquivá-lo.');
      const archived = request.body.archived === true ? row.archived_at || ctx.now() : request.body.archived === false ? null : row.archived_at;
      ctx.db.prepare('UPDATE channels SET label=?,archived_at=?,version=version+1,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?').run(request.body.label === undefined ? row.label : notBlank(ctx, request.body.label, 'Nome do alvo'), archived, ctx.now(), tid, wid, cid);
      audit(ctx, request, 'channel.updated', 'channel', cid, { version: row.version + 1, archived: Boolean(archived) });
      return { statusCode: 200, data: channelDTO(ctx.db.prepare('SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND id=?').get(tid, wid, cid)) };
    });
  });
  app.get(`${base}/posts`, { preHandler: auth, schema: { querystring: querySchema({ status: { enum: statuses }, from: string(40), to: string(40), channelId: identifier }) } }, request => {
    workspace(ctx, request);
    const { after, limit } = page(ctx, request.query), args = [request.params.tid, request.params.wid, after];
    let where = 'p.tenant_id=? AND p.workspace_id=? AND p.id>?';
    if (request.query.status) { where += ' AND p.status=?'; args.push(request.query.status); }
    else where += " AND p.status!='archived'";
    for (const [key, operator] of [['from', '>='], ['to', '<=']]) if (request.query[key]) {
      const parsed = Date.parse(request.query[key]);
      if (!Number.isFinite(parsed) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(request.query[key])) fail(ctx, 422, 'INVALID_DATE_FILTER', 'Filtro de data precisa de instante ISO com offset.');
      where += ` AND p.scheduled_at${operator}?`; args.push(new Date(parsed).toISOString());
    }
    if (request.query.channelId) {
      if (!ctx.db.prepare('SELECT 1 FROM channels WHERE tenant_id=? AND workspace_id=? AND id=?').get(request.params.tid, request.params.wid, request.query.channelId)) fail(ctx, 404, 'NOT_FOUND', 'Alvo editorial não encontrado.');
      where += ' AND EXISTS(SELECT 1 FROM post_channels pc WHERE pc.tenant_id=p.tenant_id AND pc.workspace_id=p.workspace_id AND pc.post_id=p.id AND pc.channel_id=?)'; args.push(request.query.channelId);
    }
    return paginated(ctx.db.prepare(`SELECT p.* FROM posts p WHERE ${where} ORDER BY p.id LIMIT ?`).all(...args, limit + 1), limit, row => postDTO(ctx, row));
  });
  app.post(`${base}/posts`, { preHandler: auth, schema: { body: object(contentProps, ['title']) } }, (request, reply) => {
    workspace(ctx, request, 'write');
    return mutation(ctx, request, reply, () => ({ statusCode: 201, data: insertPost(ctx, request, { ...request.body }) }));
  });
  app.get(`${base}/posts/:pid`, { preHandler: auth }, request => { workspace(ctx, request); return { data: postDTO(ctx, postRow(ctx, request)) }; });
  app.patch(`${base}/posts/:pid`, { preHandler: auth, schema: { body: { ...object({ ...contentProps, ...scheduleProps, expectedRevision: positive }, ['expectedRevision']), minProperties: 2 } } }, (request, reply) => {
    workspace(ctx, request); postRow(ctx, request); workspace(ctx, request, 'write');
    return mutation(ctx, request, reply, () => {
      writable(ctx, request);
      const row = postRow(ctx, request), body = { ...request.body };
      ctx.services.publishing?.assertPostMutable(row.tenant_id, row.workspace_id, row.id);
      expected(ctx, row.revision, body.expectedRevision);
      if (row.status === 'archived') fail(ctx, 409, 'POST_ARCHIVED', 'Restaure a peça antes de editá-la.');
      validateReferences(ctx, row.tenant_id, row.workspace_id, body);
      let scheduledAt = row.scheduled_at, scheduledTimezone = row.scheduled_timezone;
      if ('scheduledAt' in body || 'scheduledTimezone' in body) {
        if (!('scheduledAt' in body && 'scheduledTimezone' in body)) fail(ctx, 422, 'INVALID_SCHEDULE', 'Data e fuso devem ser enviados juntos.');
        if (body.scheduledAt === null && body.scheduledTimezone === null) { scheduledAt = null; scheduledTimezone = null; }
        else ({ scheduledAt, scheduledTimezone } = validateSchedule(ctx, body.scheduledAt, body.scheduledTimezone));
      }
      ctx.db.prepare("UPDATE posts SET title=?,caption=?,format=?,status='draft',revision=revision+1,approved_revision=NULL,scheduled_at=?,scheduled_timezone=?,updated_by=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?")
        .run(body.title === undefined ? row.title : notBlank(ctx, body.title, 'Título'), body.caption ?? row.caption, body.format || row.format, scheduledAt, scheduledTimezone, request.user.id, ctx.now(), row.tenant_id, row.workspace_id, row.id);
      setRelations(ctx, row.tenant_id, row.workspace_id, row.id, body);
      const updated = postRow(ctx, request);
      snapshot(ctx, request, updated); event(ctx, request, updated, 'content_changed', row.status);
      audit(ctx, request, 'post.updated', 'post', row.id, { revision: updated.revision, approvalInvalidated: row.approved_revision !== null, changedFields: Object.keys(body).filter(k => k !== 'expectedRevision') });
      return { statusCode: 200, data: postDTO(ctx, updated) };
    });
  });
  app.post(`${base}/posts/:pid/transitions`, { preHandler: auth, schema: { body: object({ action: { enum: ['submit_review', 'approve', 'request_changes', 'plan', 'archive', 'restore'] }, expectedRevision: positive, reason: string(2000), scheduledAt: string(40), scheduledTimezone: string(100) }, ['action', 'expectedRevision']) } }, (request, reply) => {
    const reviewing = ['approve', 'request_changes'].includes(request.body.action);
    workspace(ctx, request); postRow(ctx, request);
    workspace(ctx, request, reviewing ? 'review' : 'write');
    return mutation(ctx, request, reply, () => {
      writable(ctx, request);
      const row = postRow(ctx, request), body = request.body;
      ctx.services.publishing?.assertPostMutable(row.tenant_id, row.workspace_id, row.id);
      expected(ctx, row.revision, body.expectedRevision);
      let status, revision = row.revision, approvedRevision = row.approved_revision, scheduledAt = row.scheduled_at, scheduledTimezone = row.scheduled_timezone;
      const invalid = () => fail(ctx, 409, 'INVALID_TRANSITION', 'Esta ação não é permitida no estado atual da peça.');
      if (body.action !== 'plan' && ('scheduledAt' in body || 'scheduledTimezone' in body)) fail(ctx, 422, 'INVALID_TRANSITION_FIELDS', 'Data e fuso só podem acompanhar a ação de planejar.');
      if (body.action === 'submit_review') {
        if (!['draft', 'changes_requested'].includes(row.status)) invalid();
        status = 'in_review'; approvedRevision = null;
      } else if (reviewing) {
        if (row.status !== 'in_review') invalid();
        const tenant = ctx.db.prepare('SELECT require_independent_approval FROM tenants WHERE id=?').get(row.tenant_id);
        const author = ctx.db.prepare('SELECT actor_id FROM post_revisions WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=?').get(row.tenant_id, row.workspace_id, row.id, row.revision);
        if (body.action === 'approve' && tenant.require_independent_approval && author.actor_id === request.user.id) fail(ctx, 403, 'INDEPENDENT_APPROVAL_REQUIRED', 'Outra pessoa precisa aprovar esta revisão.');
        if (body.action === 'request_changes' && !body.reason?.trim()) fail(ctx, 422, 'REASON_REQUIRED', 'Explique quais alterações são necessárias.');
        status = body.action === 'approve' ? 'approved' : 'changes_requested';
        approvedRevision = status === 'approved' ? row.revision : null;
        ctx.db.prepare('INSERT INTO approvals(tenant_id,workspace_id,id,post_id,revision,reviewer_id,decision,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row.tenant_id, row.workspace_id, id(), row.id, row.revision, request.user.id, status, body.reason?.trim() || null, ctx.now());
      } else if (body.action === 'plan') {
        if (row.status !== 'approved' || row.approved_revision !== row.revision) invalid();
        if (!ctx.db.prepare("SELECT 1 FROM approvals WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=? AND decision='approved' LIMIT 1").get(row.tenant_id, row.workspace_id, row.id, row.revision)) invalid();
        ({ scheduledAt, scheduledTimezone } = validateSchedule(ctx, body.scheduledAt, body.scheduledTimezone, { future: true }));
        status = 'planned';
      } else if (body.action === 'archive') {
        if (row.status === 'archived') invalid(); status = 'archived'; approvedRevision = null;
      } else if (body.action === 'restore') {
        if (row.status !== 'archived') invalid(); ctx.services.entitlements.assertCan(row.tenant_id, 'posts', 1);
        status = 'draft'; revision++; approvedRevision = null; scheduledAt = null; scheduledTimezone = null;
      }
      ctx.db.prepare('UPDATE posts SET status=?,revision=?,approved_revision=?,scheduled_at=?,scheduled_timezone=?,updated_by=?,updated_at=? WHERE tenant_id=? AND workspace_id=? AND id=?')
        .run(status, revision, approvedRevision, scheduledAt, scheduledTimezone, request.user.id, ctx.now(), row.tenant_id, row.workspace_id, row.id);
      const updated = postRow(ctx, request);
      if (body.action === 'restore') snapshot(ctx, request, updated);
      event(ctx, request, updated, body.action, row.status, body.reason?.trim() || null);
      audit(ctx, request, `post.${body.action}`, 'post', row.id, { from: row.status, to: status, revision });
      return { statusCode: 200, data: postDTO(ctx, updated) };
    });
  });
  app.post(`${base}/posts/:pid/duplicate`, { preHandler: auth, schema: { body: object({}) } }, (request, reply) => {
    workspace(ctx, request); postRow(ctx, request); workspace(ctx, request, 'write');
    return mutation(ctx, request, reply, () => {
      const source = postDTO(ctx, postRow(ctx, request));
      const input = { title: `${source.title.slice(0, 172)} (cópia)`, caption: source.caption, format: source.format, tags: source.tags, mediaIds: source.mediaIds, channelIds: source.channels.filter(c => !c.archivedAt).map(c => c.id) };
      return { statusCode: 201, data: insertPost(ctx, request, input, 'post.duplicated') };
    }, { required: true });
  });
  app.get(`${base}/posts/:pid/revisions`, { preHandler: auth, schema: { querystring: querySchema({}) } }, request => {
    workspace(ctx, request); postRow(ctx, request);
    const { after, limit } = page(ctx, request.query);
    if (after && !/^\d+$/.test(after)) fail(ctx, 422, 'INVALID_CURSOR', 'Cursor inválido.');
    const rows = ctx.db.prepare('SELECT * FROM post_revisions WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision>? ORDER BY revision LIMIT ?').all(request.params.tid, request.params.wid, request.params.pid, Number(after || 0), limit + 1);
    return paginated(rows, limit, r => ({ revision: r.revision, actorId: r.actor_id, createdAt: r.created_at, content: JSON.parse(r.content_snapshot), approvals: ctx.db.prepare('SELECT id,reviewer_id,decision,reason,created_at FROM approvals WHERE tenant_id=? AND workspace_id=? AND post_id=? AND revision=? ORDER BY created_at,id').all(r.tenant_id, r.workspace_id, r.post_id, r.revision).map(a => ({ id: a.id, reviewerId: a.reviewer_id, decision: a.decision, reason: a.reason, createdAt: a.created_at })) }), 'revision');
  });
  app.get(`${base}/posts/:pid/history`, { preHandler: auth, schema: { querystring: querySchema({}) } }, request => {
    workspace(ctx, request); postRow(ctx, request); const { after, limit } = page(ctx, request.query);
    return paginated(ctx.db.prepare('SELECT * FROM post_events WHERE tenant_id=? AND workspace_id=? AND post_id=? AND id>? ORDER BY id LIMIT ?').all(request.params.tid, request.params.wid, request.params.pid, after, limit + 1), limit, r => ({ id: r.id, revision: r.revision, actorId: r.actor_id, action: r.action, fromStatus: r.from_status, toStatus: r.to_status, reason: r.reason, scheduledAt: r.scheduled_at, scheduledTimezone: r.scheduled_timezone, createdAt: r.created_at }));
  });
  app.get(`${base}/posts/:pid/comments`, { preHandler: auth, schema: { querystring: querySchema({}) } }, request => {
    workspace(ctx, request); postRow(ctx, request); const { after, limit } = page(ctx, request.query);
    return paginated(ctx.db.prepare('SELECT * FROM comments WHERE tenant_id=? AND workspace_id=? AND post_id=? AND id>? ORDER BY id LIMIT ?').all(request.params.tid, request.params.wid, request.params.pid, after, limit + 1), limit, r => ({ id: r.id, postId: r.post_id, authorId: r.author_id, body: r.body, createdAt: r.created_at }));
  });
  app.post(`${base}/posts/:pid/comments`, { preHandler: auth, schema: { body: object({ body: string(5000) }, ['body']) } }, (request, reply) => {
    workspace(ctx, request); postRow(ctx, request); role(ctx, request, ['owner', 'admin', 'editor', 'reviewer']);
    return mutation(ctx, request, reply, () => {
      writable(ctx, request); const wid = workspace(ctx, request);
      if (wid.archived_at || postRow(ctx, request).status === 'archived') fail(ctx, 409, 'POST_ARCHIVED', 'Restaure a peça e a marca antes de comentar.');
      const cid = id(), now = ctx.now(), body = notBlank(ctx, request.body.body, 'Comentário');
      ctx.db.prepare('INSERT INTO comments(tenant_id,workspace_id,id,post_id,author_id,body,created_at) VALUES(?,?,?,?,?,?,?)').run(request.params.tid, request.params.wid, cid, request.params.pid, request.user.id, body, now);
      audit(ctx, request, 'comment.created', 'comment', cid, { postId: request.params.pid });
      return { statusCode: 201, data: { id: cid, postId: request.params.pid, authorId: request.user.id, body, createdAt: now } };
    });
  });
  app.get(`${root}/reports/editorial`, { preHandler: auth, schema: { querystring: object({}) } }, request => {
    const visibility = visibleClause(request);
    const rows = ctx.db.prepare(`SELECT p.status,count(*) AS count FROM posts p JOIN workspaces w ON w.tenant_id=p.tenant_id AND w.id=p.workspace_id WHERE p.tenant_id=?${visibility.sql} GROUP BY p.status`).all(request.params.tid, ...visibility.args);
    const counts = Object.fromEntries(statuses.map(status => [status, 0]));
    for (const row of rows) counts[row.status] = row.count;
    const workspaces = ctx.db.prepare(`SELECT w.id,w.name,w.archived_at FROM workspaces w WHERE w.tenant_id=?${visibility.sql} ORDER BY w.name`).all(request.params.tid, ...visibility.args);
    return { data: { source: 'editorial-only', generatedAt: ctx.now(), totalPosts: Object.values(counts).reduce((a, b) => a + b, 0), counts, workspaces: workspaces.map(w => ({ id: w.id, name: w.name, archivedAt: w.archived_at })) } };
  });
  app.get(`${root}/export/editorial`, { preHandler: auth, schema: { querystring: object({}) } }, (request, reply) => {
    role(ctx, request, ['owner', 'admin']);
    const result = ctx.transaction(() => {
      const tid = request.params.tid, limit = 5000;
      const counts = {};
      for (const table of ['posts', 'workspaces', 'channels', 'media', 'comments', 'post_revisions', 'approvals', 'post_events']) {
        counts[table] = ctx.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE tenant_id=?`).get(tid).n;
        if (counts[table] > limit) fail(ctx, 409, 'EXPORT_LIMIT', `A exportação do piloto aceita até ${limit} registros por categoria. Solicite uma exportação operacional acima desse limite.`);
      }
      const storedTextBytes = ctx.db.prepare('SELECT coalesce(sum(length(CAST(content_snapshot AS BLOB))),0) AS n FROM post_revisions WHERE tenant_id=?').get(tid).n
        + ctx.db.prepare('SELECT coalesce(sum(length(CAST(body AS BLOB))),0) AS n FROM comments WHERE tenant_id=?').get(tid).n
        + ctx.db.prepare('SELECT coalesce(sum(length(CAST(title AS BLOB))+length(CAST(caption AS BLOB))),0) AS n FROM posts WHERE tenant_id=?').get(tid).n;
      if (storedTextBytes > 20 * 1024 * 1024) fail(ctx, 409, 'EXPORT_LIMIT', 'A exportação excede o limite de 20 MiB do piloto.');
      const workspaces = ctx.db.prepare('SELECT * FROM workspaces WHERE tenant_id=? ORDER BY id').all(tid).map(workspaceDTO);
      const channels = ctx.db.prepare('SELECT * FROM channels WHERE tenant_id=? ORDER BY workspace_id,id').all(tid).map(channelDTO);
      const media = ctx.db.prepare('SELECT * FROM media WHERE tenant_id=? ORDER BY workspace_id,id').all(tid).map(mediaDTO);
      const posts = ctx.db.prepare('SELECT * FROM posts WHERE tenant_id=? ORDER BY workspace_id,id').all(tid).map(row => {
        const p = postDTO(ctx, row); delete p.authorId; delete p.updatedBy;
        return p;
      });
      const comments = ctx.db.prepare('SELECT * FROM comments WHERE tenant_id=? ORDER BY workspace_id,post_id,created_at,id').all(tid).map(r => ({ id: r.id, workspaceId: r.workspace_id, postId: r.post_id, body: r.body, createdAt: r.created_at }));
      const revisions = ctx.db.prepare('SELECT * FROM post_revisions WHERE tenant_id=? ORDER BY workspace_id,post_id,revision').all(tid).map(r => ({ workspaceId: r.workspace_id, postId: r.post_id, revision: r.revision, content: JSON.parse(r.content_snapshot), createdAt: r.created_at }));
      const approvals = ctx.db.prepare('SELECT * FROM approvals WHERE tenant_id=? ORDER BY workspace_id,post_id,created_at,id').all(tid).map(r => ({ id: r.id, workspaceId: r.workspace_id, postId: r.post_id, revision: r.revision, decision: r.decision, reason: r.reason, createdAt: r.created_at }));
      const history = ctx.db.prepare('SELECT * FROM post_events WHERE tenant_id=? ORDER BY workspace_id,post_id,created_at,id').all(tid).map(r => ({ id: r.id, workspaceId: r.workspace_id, postId: r.post_id, revision: r.revision, action: r.action, fromStatus: r.from_status, toStatus: r.to_status, reason: r.reason, scheduledAt: r.scheduled_at, scheduledTimezone: r.scheduled_timezone, createdAt: r.created_at }));
      const data = { schemaVersion: 1, source: 'editorial-only', generatedAt: ctx.now(), mediaBytesIncluded: false, workspaces, channels, media, posts, comments, revisions, approvals, history };
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json) > 20 * 1024 * 1024) fail(ctx, 409, 'EXPORT_LIMIT', 'A exportação excede o limite de 20 MiB do piloto.');
      audit(ctx, request, 'editorial.exported', 'tenant', tid, { postCount: counts.posts, workspaceCount: workspaces.length });
      return json;
    });
    return reply.header('Cache-Control', 'private, no-store').header('Content-Disposition', 'attachment; filename="editorial-export.json"').type('application/json; charset=utf-8').send(result);
  });
  await registerMedia(app, ctx);
}
