import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import sharp from 'sharp';
import { harness, verified, route, idempotency, multipart, QA_ORIGIN } from './qa-helpers.mjs';

async function streamRequest(port, path, headers, bytes) {
  return new Promise((resolve, reject) => {
    let complete = false;
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: { host: new URL(QA_ORIGIN).host, origin: QA_ORIGIN, 'transfer-encoding': 'chunked', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { complete = true; resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }); });
      response.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Streaming upload timed out')));
    req.on('error', error => { if (!complete) reject(error); });
    (async () => {
      try {
        for (let offset = 0; offset < bytes.length && !complete && !req.destroyed; offset += 32768) {
          if (!req.write(bytes.subarray(offset, offset + 32768))) await once(req, 'drain');
          await new Promise(resolve => setImmediate(resolve));
        }
        if (!complete && !req.destroyed) req.end();
      } catch (error) { if (!complete) reject(error); }
    })();
  });
}

test('editorial TCP streaming: actual chunked bytes are bounded without Content-Length and failed upload persists nothing', async t => {
  const h = await harness(t), owner = await verified(h, 'stream-owner');
  const tenant = await owner.client.ok('POST', '/api/v1/tenants', { name: 'Streaming fixture', slug: 'streaming-fixture', timezone: 'UTC' }, idempotency());
  const brand = await owner.client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Streaming brand' }, idempotency());
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const port = h.app.server.address().port, path = route(tenant, brand, '/media');
  const png = await sharp({ create: { width: 50, height: 30, channels: 3, background: '#556677' } }).png().toBuffer();
  const valid = multipart(png), sessionHeaders = { cookie: owner.client.cookie, 'x-csrf-token': owner.client.csrf };
  const uploaded = await streamRequest(port, path, { ...sessionHeaders, ...valid.headers }, valid.payload);
  assert.equal(uploaded.status, 201, uploaded.body);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM media').get().n, 1);
  const oversized = Buffer.concat([Buffer.alloc(5 * 1024 * 1024 + 65537, 32), valid.payload]);
  const refused = await streamRequest(port, path, { ...sessionHeaders, ...valid.headers }, oversized);
  assert.equal(refused.status, 413, refused.body);
  assert.equal(JSON.parse(refused.body).error.code, 'UPLOAD_TOO_LARGE');
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM media').get().n, 1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM media_blobs').get().n, 1);
  assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), []);
});
