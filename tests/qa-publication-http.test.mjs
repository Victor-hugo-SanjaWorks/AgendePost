import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { publicationFixture } from './qa-publication-helpers.mjs';

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve,reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port;
}
function tcp(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve,reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks=[]; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString(); let json; try { json = JSON.parse(text); } catch {} resolve({ status:response.statusCode, headers:response.headers, body:text, json, data:json?.data }); });
    }); request.on('error',reject); request.end(body);
  });
}

test('QA publication actual TCP: authenticated scheduling, CSRF and worker result round-trip', async t => {
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const h = await publicationFixture(t, { port, canonicalOrigin: origin });
  await h.app.listen({ port, host: '127.0.0.1' });
  const post = await h.approve(await h.post()), client = h.people.editor.client;
  const path = h.path(`/posts/${post.id}/publications`);
  const headers = { origin, cookie: client.cookie, 'x-csrf-token': client.csrf, 'content-type': 'application/json', 'idempotency-key': 'real-tcp-publication-schedule' };
  const body = JSON.stringify({ expectedRevision: post.revision, channelIds: h.channels.map(c => c.id), connectionVersions: Object.fromEntries(h.channels.map(c => [c.id, 'qa-connection-v1'])), scheduledAt: new Date(h.now() + 60000).toISOString(), scheduledTimezone: 'UTC' });
  assert.equal((await tcp(port, path, { method:'POST', headers:{ ...headers, origin:'https://untrusted.example' }, body })).status, 403);
  assert.equal((await tcp(port, path, { method:'POST', headers:{ ...headers, 'x-csrf-token':'wrong' }, body })).status, 403);
  assert.equal((await tcp(port, path, { method:'POST', headers:{ ...headers, cookie:'' }, body })).status, 401);
  const first = await tcp(port, path, { method:'POST', headers, body });
  assert.equal(first.status, 201, first.body); assert.equal(first.data.length, 2);
  assert.equal(first.headers['cache-control'], 'no-store');
  const repeat = await tcp(port, path, { method:'POST', headers, body });
  assert.equal(repeat.status, 201, repeat.body);
  assert.deepEqual(repeat.data.map(j => j.id), first.data.map(j => j.id));
  h.advance(61_000); await h.app.ctx.services.publishing.worker.tick();
  const published = await tcp(port, path, { headers:{ cookie:client.cookie } });
  assert.equal(published.status, 200, published.body);
  assert.ok(published.data.every(j => j.status === 'published' && j.remoteId));
  assert.equal(h.adapter.calls.length, 2);
  assert.doesNotMatch(published.body, /accessToken|connectionVersion|lease_token|password_hash|"bytes"/);
  assert.equal(h.app.server.address().address, '127.0.0.1');
});
