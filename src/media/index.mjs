import multipart from '@fastify/multipart';
import { id, object, listQuery, base, fail, role, workspace, writable, audit, mutation, page, paginated, mediaDTO } from '../editorial/shared.mjs';
import { normalizeRaster, safeFilename, digest, MAX_IMAGE_BYTES } from './normalize.mjs';

export async function registerMedia(app, ctx) {
  await app.register(multipart, { limits: { fieldNameSize: 32, fieldSize: 1, fields: 0, files: 1, parts: 1, fileSize: MAX_IMAGE_BYTES, headerPairs: 50 }, throwFileSizeLimit: true });
  let inFlight = 0;
  const auth = [ctx.auth.requireUser, ctx.auth.requireTenant];
  app.get(`${base}/media`, { preHandler: auth, schema: { querystring: object(listQuery) } }, request => {
    workspace(ctx, request);
    const { after, limit } = page(ctx, request.query);
    return paginated(ctx.db.prepare('SELECT * FROM media WHERE tenant_id=? AND workspace_id=? AND id>? ORDER BY id LIMIT ?').all(request.params.tid, request.params.wid, after, limit + 1), limit, mediaDTO);
  });
  app.post(`${base}/media`, { preHandler: auth, bodyLimit: MAX_IMAGE_BYTES + 65536 }, async (request, reply) => {
    workspace(ctx, request, 'media');
    role(ctx, request, ['owner', 'admin', 'editor']);
    if (!request.isMultipart()) fail(ctx, 422, 'MULTIPART_REQUIRED', 'Envie uma única imagem no campo file.');
    if (inFlight >= 2) fail(ctx, 429, 'IMAGE_PROCESSING_BUSY', 'Há outras imagens em processamento. Tente novamente em instantes.');
    inFlight++;
    try {
      let source, originalName, mime, totalBytes = 0, totalLimitError;
      // Multipart consumes request.raw directly. Count that stream, including boundaries and preamble.
      const countBytes = chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_IMAGE_BYTES + 65536 && !totalLimitError) {
          totalLimitError = ctx.errors.http(413, 'UPLOAD_TOO_LARGE', 'O upload excede o limite total permitido.');
          request.raw.emit('error', totalLimitError);
        }
      };
      request.raw.on('data', countBytes);
      request.raw.pause();
      try {
        for await (const part of request.parts()) {
          if (part.type !== 'file' || part.fieldname !== 'file' || source) {
            if (part.file) part.file.resume();
            fail(ctx, 422, 'INVALID_MULTIPART', 'Envie somente uma imagem no campo file.');
          }
          originalName = safeFilename(part.filename);
          mime = part.mimetype;
          source = await part.toBuffer();
          if (part.file.truncated) fail(ctx, 413, 'IMAGE_TOO_LARGE', 'A imagem excede 5 MiB.');
        }
        if (totalLimitError) throw totalLimitError;
      } catch (error) {
        if (totalLimitError) throw totalLimitError;
        if (['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT', 'FST_FIELDS_LIMIT'].includes(error.code)) fail(ctx, error.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 422, 'UPLOAD_LIMIT', 'Envie uma única imagem de até 5 MiB, sem campos adicionais.');
        if (error.statusCode) throw error;
        fail(ctx, 422, 'INVALID_MULTIPART', 'Upload inválido ou incompleto.');
      } finally {
        request.raw.removeListener('data', countBytes);
        if (totalLimitError) { reply.header('connection', 'close'); request.raw.resume(); }
      }
      if (!source) fail(ctx, 422, 'IMAGE_REQUIRED', 'Escolha uma imagem.');
      const normalized = await normalizeRaster(source, mime, ctx);
      // Recheck authority after async decoding. Revocation during an upload takes effect before commit.
      await ctx.auth.requireUser(request, reply);
      await ctx.auth.requireTenant(request, reply);
      workspace(ctx, request, 'media');
      role(ctx, request, ['owner', 'admin', 'editor']);
      const bodyHash = digest(Buffer.concat([Buffer.from(originalName + '\0' + mime + '\0'), source]));
      return mutation(ctx, request, reply, () => {
        const tid = request.params.tid, wid = request.params.wid, mid = id(), now = ctx.now();
        ctx.services.entitlements.assertCan(tid, 'mediaBytes', normalized.sizeBytes);
        ctx.db.prepare('INSERT INTO media(tenant_id,workspace_id,id,original_name,normalized_mime,size_bytes,width,height,digest,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
          .run(tid, wid, mid, originalName, normalized.mime, normalized.sizeBytes, normalized.width, normalized.height, normalized.digest, request.user.id, now);
        ctx.db.prepare('INSERT INTO media_blobs(tenant_id,workspace_id,media_id,bytes) VALUES(?,?,?,?)').run(tid, wid, mid, normalized.bytes);
        audit(ctx, request, 'media.created', 'media', mid, { mime: normalized.mime, sizeBytes: normalized.sizeBytes, width: normalized.width, height: normalized.height });
        return { statusCode: 201, data: mediaDTO(ctx.db.prepare('SELECT * FROM media WHERE tenant_id=? AND workspace_id=? AND id=?').get(tid, wid, mid)) };
      }, { bodyHash });
    } finally { inFlight--; }
  });
  app.get(`${base}/media/:mid/content`, { preHandler: auth }, (request, reply) => {
    workspace(ctx, request);
    const row = ctx.db.prepare('SELECT m.*,b.bytes FROM media m JOIN media_blobs b ON b.tenant_id=m.tenant_id AND b.workspace_id=m.workspace_id AND b.media_id=m.id WHERE m.tenant_id=? AND m.workspace_id=? AND m.id=?').get(request.params.tid, request.params.wid, request.params.mid);
    if (!row) fail(ctx, 404, 'NOT_FOUND', 'Imagem não encontrada.');
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[row.normalized_mime];
    return reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').header('Content-Security-Policy', "default-src 'none'; sandbox").header('Content-Disposition', `inline; filename="image.${extension}"`).type(row.normalized_mime).send(Buffer.from(row.bytes));
  });
  app.delete(`${base}/media/:mid`, { preHandler: auth }, (request, reply) => {
    workspace(ctx, request, 'media'); role(ctx, request, ['owner', 'admin', 'editor']);
    return mutation(ctx, request, reply, () => {
      writable(ctx, request);
      const args = [request.params.tid, request.params.wid, request.params.mid];
      const row = ctx.db.prepare('SELECT * FROM media WHERE tenant_id=? AND workspace_id=? AND id=?').get(...args);
      if (!row) fail(ctx, 404, 'NOT_FOUND', 'Imagem não encontrada.');
      for (const table of ['post_media', 'post_revision_media']) if (ctx.db.prepare(`SELECT 1 FROM ${table} WHERE tenant_id=? AND workspace_id=? AND media_id=? LIMIT 1`).get(...args)) fail(ctx, 409, 'MEDIA_REFERENCED', 'Esta imagem faz parte de uma peça ou de seu histórico e precisa ser preservada.');
      ctx.db.prepare('DELETE FROM media WHERE tenant_id=? AND workspace_id=? AND id=?').run(...args);
      audit(ctx, request, 'media.deleted', 'media', row.id, { sizeBytes: row.size_bytes });
      return { statusCode: 200, data: { id: row.id, deleted: true } };
    });
  });
}
