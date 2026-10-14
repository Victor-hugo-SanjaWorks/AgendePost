import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { harness, verified, route, idempotency, multipart, Client } from './qa-helpers.mjs';
import sharp from 'sharp';

async function temp(t) { const path = await mkdtemp(join(tmpdir(), 'saas-migration-qa-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('QA migrations: fresh/reapply, checksums, future-version refusal and rollback are real SQLite operations', async t => {
  const root = await temp(t), config = buildConfig({ mode: 'test', dataDir: join(root, 'fresh') });
  let store = openDatabase(config);
  const versions = store.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  assert.ok(versions.length >= 3); assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  store.db.close(); store = openDatabase(config);
  assert.deepEqual(store.db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), versions);
  store.db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=?').run('tampered', versions[0].version); store.db.close();
  assert.throws(() => openDatabase(config), /MIGRATION_CHECKSUM_MISMATCH/);
  const futureConfig = buildConfig({ mode: 'test', dataDir: join(root, 'future') });
  const future = openDatabase(futureConfig);
  future.db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(999999, '999999-future.sql', 'future', new Date().toISOString()); future.db.close();
  assert.throws(() => openDatabase(futureConfig), /DATABASE_NEWER_THAN_CODE/);
  const inspect = new DatabaseSync(join(futureConfig.dataDir, 'social-saas.sqlite'));
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=999999').get().n, 1); inspect.close();
  const migrationDir = join(root, 'broken-migrations'); await mkdir(migrationDir);
  await writeFile(join(migrationDir, '001-valid.sql'), 'CREATE TABLE sentinel(id INTEGER PRIMARY KEY); INSERT INTO sentinel VALUES(1);');
  await writeFile(join(migrationDir, '002-invalid.sql'), 'CREATE TABLE partial(id INTEGER); INSERT INTO nonexistent VALUES(1);');
  const brokenConfig = buildConfig({ mode: 'test', dataDir: join(root, 'broken') });
  assert.throws(() => openDatabase(brokenConfig, { migrationsDir: migrationDir }));
  const broken = new DatabaseSync(join(brokenConfig.dataDir, 'social-saas.sqlite'));
  assert.equal(broken.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('sentinel','partial','schema_migrations')").get().n, 0); broken.close();
  assert.equal((await stat(config.dataDir)).mode & 0o077, 0);
  assert.equal((await stat(join(config.dataDir, 'social-saas.sqlite'))).mode & 0o077, 0);
});

test('QA production gate: unsafe modes, public binding, legacy path and test adapters fail closed', () => {
  assert.throws(() => buildConfig({ mode: 'production' }), /PRODUCTION_NOT_READY/);
  assert.throws(() => buildConfig({ mode: 'development', host: '0.0.0.0' }), /PILOT_LOOPBACK_ONLY/);
  assert.throws(() => buildConfig({ mode: 'test', dataDir: '/tmp/social_studio/data' }), /LEGACY_DATABASE_PATH_FORBIDDEN/);
  assert.throws(() => buildConfig({ mode: 'development', mailAdapter: { send() {} } }), /TEST_MAIL_ADAPTER_ONLY/);
  assert.throws(() => buildConfig({ mode: 'development', billingAdapter: {} }), /TEST_BILLING_ADAPTER_ONLY/);
  assert.throws(() => buildConfig({ mode: 'test', canonicalOrigin: 'http://attacker.test' }), /INVALID_LOOPBACK_ORIGIN/);
  const secure = buildConfig({ mode: 'test', canonicalOrigin: 'https://127.0.0.1:4180' });
  assert.equal(secure.secureCookies, true); assert.equal(secure.sessionCookie, '__Host-ss_session');
});

test('QA persistence: authenticated posts and normalized private media survive restart and consistent backup restore', async t => {
  const root = await temp(t), dataDir = join(root, 'live');
  let h = await harness(null, { dataDir });
  t.after(() => h.app.close());
  const owner = await verified(h, 'persistent-owner'), client = owner.client;
  const tenant = await client.ok('POST', '/api/v1/tenants', { name: 'Persistent QA', slug: 'persistent-qa', timezone: 'America/Sao_Paulo' }, idempotency());
  const workspace = await client.ok('POST', `/api/v1/tenants/${tenant.id}/workspaces`, { name: 'Persistent brand', color: '#123456' }, idempotency());
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#336699' } }).png().toBuffer();
  const form = multipart(bytes);
  const media = await client.ok('POST', route(tenant, workspace, '/media'), form.payload, { headers: { ...form.headers, 'idempotency-key': 'persistent-media' } });
  const post = await client.ok('POST', route(tenant, workspace, '/posts'), { title: 'Persistence evidence', caption: 'Private content', mediaIds: [media.id] }, idempotency());
  const originalDownload = await client.request('GET', route(tenant, workspace, `/media/${media.id}/content`));
  assert.equal(originalDownload.status, 200);
  const savedCookie = client.cookie;
  const rowCounts = Object.fromEntries(['users','sessions','memberships','workspace_grants','posts','post_revisions','media','media_blobs','audit_events'].map(table => [table, h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));
  const restoredDir = join(root, 'restored'); await mkdir(restoredDir);
  await backup(h.db, join(restoredDir, 'social-saas.sqlite'));
  await h.app.close();
  h = await harness(null, { dataDir });
  const restarted = new Client(h); restarted.cookies = new Map(savedCookie.split('; ').map(item => item.split('=')));
  assert.equal((await restarted.ok('GET', route(tenant, workspace, `/posts/${post.id}`))).title, post.title);
  assert.deepEqual((await restarted.request('GET', route(tenant, workspace, `/media/${media.id}/content`))).raw, originalDownload.raw);
  await h.app.close();
  h = await harness(null, { dataDir: restoredDir });
  const restored = new Client(h); restored.cookies = new Map(savedCookie.split('; ').map(item => item.split('=')));
  assert.equal((await restored.ok('GET', route(tenant, workspace, `/posts/${post.id}`))).caption, 'Private content');
  for (const [table, expected] of Object.entries(rowCounts)) assert.equal(h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, expected, table);
  assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await restored.request('GET', route(tenant, workspace, `/media/${media.id}/content`))).status, 200);
});
