import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { buildConfig } from '../src/config.mjs';
import { privateBackup } from '../src/backup.mjs';
import { restoreCheck } from '../scripts/restore-check.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const NOW = '2026-10-14T12:00:00.000Z';
const LATER = '2026-10-15T12:00:00.000Z';
const BYTES = Buffer.from('synthetic private media backup fixture');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function fixture(t, { populated = false } = {}) {
  const dir = mkdtempSync(resolve(tmpdir(), 'agendepost-recovery-'));
  chmodSync(dir, 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = resolve(dir, 'live');
  const opened = openDatabase({ root: ROOT, dataDir: live });
  const { db } = opened;
  if (populated) {
    db.prepare("INSERT INTO users(id,email_normalized,display_name,password_hash,email_verified_at,status,created_at) VALUES('u','synthetic@example.test','Synthetic user','fixture-only',?,'active',?)").run(NOW, NOW);
    db.prepare("INSERT INTO tenants(id,name,slug,timezone,created_at,updated_at) VALUES('t','Synthetic tenant','synthetic','UTC',?,?)").run(NOW, NOW);
    db.prepare("INSERT INTO memberships(tenant_id,user_id,role,status,scope,created_at) VALUES('t','u','owner','active','organization',?)").run(NOW);
    db.prepare("INSERT INTO workspaces(tenant_id,id,name,created_at,updated_at) VALUES('t','w','Synthetic workspace',?,?)").run(NOW, NOW);
    db.prepare("INSERT INTO channels(tenant_id,workspace_id,id,platform,label,created_at,updated_at) VALUES('t','w','c','facebook','Synthetic channel',?,?)").run(NOW, NOW);
    db.prepare("INSERT INTO media(tenant_id,workspace_id,id,original_name,normalized_mime,size_bytes,width,height,digest,created_by,created_at) VALUES('t','w','m','fixture.png','image/png',?,1,1,'fixture','u',?)").run(BYTES.length, NOW);
    db.prepare("INSERT INTO media_blobs VALUES('t','w','m',?)").run(BYTES);
    db.prepare("INSERT INTO sessions VALUES('session','u','csrf',?,?,?,?,NULL,?,0)").run(NOW, NOW, LATER, LATER, NOW);
    db.prepare("INSERT INTO preauth_sessions VALUES('preauth','csrf',?,?)").run(NOW, LATER);
    db.prepare("INSERT INTO auth_tokens VALUES('auth','u','password_reset',?,?,NULL)").run(NOW, LATER);
    db.prepare("INSERT INTO mail_outbox VALUES('mail','synthetic@example.test','password_reset','{}',?,?)").run(NOW, LATER);
    db.prepare("INSERT INTO invitations(id,tenant_id,email_normalized,role,scope,token_hash,expires_at,invited_by,created_at) VALUES('inv','t','invite@example.test','viewer','workspaces','invite-token',?,'u',?)").run(LATER, NOW);
    db.prepare("INSERT INTO social_oauth_states VALUES('state','t','w','c',1,'facebook','u','session','direct',?,?,NULL,NULL)").run(NOW, LATER);
    db.prepare("INSERT INTO social_oauth_pending VALUES('pending','t','w','c',1,'facebook','u','session','synthetic-provider-user','direct','synthetic-ciphertext',?,?,NULL)").run(NOW, LATER);
    db.prepare("INSERT INTO social_connections(id,tenant_id,workspace_id,channel_id,platform,provider_user_id,account_id,page_id,destination_label,token_type,access_basis,permissions,page_tasks,encrypted_payload,status,expires_at,verified_at,authorization_version,connected_by,created_at,updated_at) VALUES('connection','t','w','c','facebook','synthetic-provider-user','synthetic-account','synthetic-page','Synthetic destination','page','direct','[]','[]','synthetic-ciphertext','active',?,?,'synthetic-version','u',?,?)").run(LATER, NOW, NOW, NOW);
    for (const status of ['scheduled','leased','sending','retry_wait','needs_attention','published','cancelled','failed','blocked']) {
      const post = 'p-' + status, job = 'j-' + status;
      db.prepare("INSERT INTO posts(tenant_id,workspace_id,id,title,status,author_id,updated_by,created_at,updated_at) VALUES('t','w',?,'Synthetic post','draft','u','u',?,?)").run(post, NOW, NOW);
      db.prepare("INSERT INTO post_revisions VALUES('t','w',?,1,'u','{}',?)").run(post, NOW);
      const leased = ['leased','sending'].includes(status), published = status === 'published';
      db.prepare("INSERT INTO publication_jobs(tenant_id,workspace_id,id,post_id,channel_id,platform,revision,actor_id,connection_version,status,scheduled_at,scheduled_timezone,next_attempt_at,expires_at,lease_token,lease_owner,lease_until,remote_id,published_at,created_at,updated_at) VALUES('t','w',?,?,'c','facebook',1,'u','synthetic-version',?,?,'UTC',?,?,?,?,?,?,?, ?,?)").run(job, post, status, NOW, NOW, LATER, leased ? 'lease' : null, leased ? 'worker' : null, leased ? LATER : null, published ? 'remote-synthetic' : null, published ? NOW : null, NOW, NOW);
      if (status === 'sending') db.prepare("INSERT INTO publication_attempts VALUES('t','w','attempt',?,1,'lease','sending',NULL,?,NULL)").run(job, NOW);
    }
    db.prepare("INSERT INTO publication_workers VALUES('worker',?,?,NULL)").run(NOW, NOW);
    db.prepare("INSERT INTO client_dashboard_shares(tenant_id,workspace_id,id,token_hash,request_key_hash,label,created_by,created_at,expires_at) VALUES('t','w','share',?,?,'Synthetic share','u',?,?)").run('a'.repeat(64),'b'.repeat(64),NOW,LATER);
    db.prepare("INSERT INTO client_approval_requests(tenant_id,workspace_id,id,post_id,revision,requester_id,token_hash,snapshot_digest,preview_json,channel_ids_json,connection_versions_json,scheduled_at,scheduled_timezone,created_at,expires_at,updated_at) VALUES('t','w','approval','p-scheduled',1,'u',?,?,'{}','[]','{}',?,'UTC',?,?,?)").run('c'.repeat(64),'d'.repeat(64),LATER,NOW,LATER,NOW);
    db.prepare("INSERT INTO client_approval_challenges VALUES(?,'t','w','approval',?,1,?)").run('e'.repeat(64),'c'.repeat(64),LATER);
    db.prepare("INSERT INTO social_metrics_settings(tenant_id,workspace_id,enabled,enabled_by,updated_at) VALUES('t','w',1,'u',?)").run(NOW);
    db.prepare("INSERT INTO approval_whatsapp_notifications(tenant_id,workspace_id,approval_id,id,request_key_hash,request_hash,actor_id,recipient_hash,recipient_last4,status,created_at,updated_at) VALUES('t','w','approval','notification',?,?,'u',?,'1234','sending',?,?)").run('f'.repeat(64),'1'.repeat(64),'2'.repeat(64),NOW,NOW);

    for (const state of ['queued','processing','retry']) {
      const event = 'event-' + state;
      db.prepare("INSERT INTO billing_events(id,provider,account_scope,event_id,tenant_id,object_id,event_type,subscription_id,customer_id,received_at,body_digest,state) VALUES(?,'stripe','synthetic',?,'t','synthetic','synthetic','synthetic','synthetic',?,'synthetic',?)").run(event, event, NOW, state === 'retry' ? 'processed' : state);
      db.prepare("INSERT INTO jobs(id,tenant_id,type,dedupe_key,payload_ref,run_at,state,lease_until,lease_token,created_at) VALUES(?,'t','billing.reconcile',?,?,?,?,?,'lease',?)").run('billing-' + state, 'dedupe-' + state, event, NOW, state, LATER, NOW);
    }
    db.prepare("INSERT INTO billing_reconciliation_locks VALUES('stripe','synthetic','synthetic','lease',?)").run(LATER);
  }
  db.close();
  const snapshot = resolve(dir, 'snapshot.sqlite');
  return { dir, live, snapshot, source: resolve(live, 'social-saas.sqlite'), targetDir: resolve(dir, 'new-restored') };
}
const backupFixture = async (t, options) => { const f = fixture(t, options); await privateBackup(f.source, f.snapshot); return f; };
const run = f => restoreCheck({ source: f.snapshot, targetDir: f.targetDir, consistentSnapshotConfirmed: true, liveDataDir: f.live });

test('hosted backup: verified offline recovery preserves content, invalidates credentials and freezes every pending queue', async t => {
  const f = await backupFixture(t, { populated: true });
  const before = hash(f.snapshot);
  const report = await run(f);
  assert.equal(report.result, 'verified_offline_only');
  assert.equal(report.sourceSha256, before);
  assert.equal(hash(f.snapshot), before, 'the original snapshot remains unchanged');
  assert.equal(report.workerMustRemainDisabled, true);
  assert.equal(report.providerRevocationPerformed, false);
  assert.equal(report.changes.publicationJobsFrozen, 5);
  assert.equal(report.changes.billingJobsFrozen, 3);
  assert.equal(report.changes.dashboardSharesRevoked, 1);
  assert.equal(report.changes.clientApprovalsRevoked, 1);
  assert.equal(report.changes.clientApprovalChallengesRemoved, 1);
  assert.equal(report.changes.metricsSettingsDisabled, 1);
  assert.equal(report.changes.whatsappAttemptsAmbiguous, 1);

  assert.equal(report.content.mediaBytes, BYTES.length);
  assert.equal(statSync(f.targetDir).mode & 0o777, 0o700);
  for (const name of ['social-saas.sqlite','RESTORE-CHECK.json','DO-NOT-START.txt']) assert.equal(statSync(resolve(f.targetDir, name)).mode & 0o777, 0o600);
  const db = new DatabaseSync(resolve(f.targetDir, 'social-saas.sqlite'), { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM media_blobs').get().bytes), BYTES);
  assert.equal(db.prepare('SELECT session_epoch FROM users').get().session_epoch, 1);
  for (const table of ['sessions','preauth_sessions','auth_tokens','social_oauth_states','social_oauth_pending','mail_outbox','billing_reconciliation_locks']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  assert.equal(db.prepare('SELECT status FROM social_connections').get().status, 'revoked');
  assert.equal(db.prepare('SELECT encrypted_payload FROM social_connections').get().encrypted_payload, null);
  assert.ok(db.prepare('SELECT revoked_at FROM invitations').get().revoked_at);
  assert.ok(db.prepare('SELECT revoked_at FROM client_dashboard_shares').get().revoked_at);
  assert.equal(db.prepare('SELECT status FROM client_approval_requests').get().status,'revoked');
  assert.equal(db.prepare('SELECT scheduling_code FROM client_approval_requests').get().scheduling_code,'RESTORE_REVIEW_REQUIRED');
  assert.equal(db.prepare('SELECT count(*) n FROM client_approval_challenges').get().n,0);
  assert.equal(db.prepare('SELECT enabled FROM social_metrics_settings').get().enabled,0);
  assert.equal(db.prepare('SELECT status FROM approval_whatsapp_notifications').get().status,'unknown');

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM publication_jobs WHERE status='needs_attention' AND error_code='RESTORE_REVIEW_REQUIRED' AND lease_token IS NULL").get().n, 5);
  assert.equal(db.prepare("SELECT status FROM publication_jobs WHERE id='j-published'").get().status, 'published');
  assert.equal(db.prepare("SELECT remote_id FROM publication_jobs WHERE id='j-published'").get().remote_id, 'remote-synthetic');
  assert.equal(db.prepare('SELECT outcome FROM publication_attempts').get().outcome, 'ambiguous');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state='failed' AND last_error_code='RESTORE_REVIEW_REQUIRED'").get().n, 3);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const original = new DatabaseSync(f.snapshot, { readOnly: true });
  try { assert.equal(original.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1); } finally { original.close(); }
});

test('hosted backup: refuses unconfirmed snapshots, live database input, sidecars, and destination reuse', async t => {
  const f = await backupFixture(t);
  await assert.rejects(restoreCheck({ source: f.snapshot, targetDir: f.targetDir }), /CONSISTENT_SNAPSHOT_CONFIRMATION_REQUIRED/);
  await assert.rejects(restoreCheck({ source: f.source, targetDir: f.targetDir, consistentSnapshotConfirmed: true }), /LIVE_DATABASE_FORBIDDEN/);
  writeFileSync(f.snapshot + '-wal', 'not a standalone snapshot');
  await assert.rejects(run(f), /SNAPSHOT_HAS_SIDECARS/);
  rmSync(f.snapshot + '-wal');
  mkdirSync(f.targetDir, { mode: 0o700 });
  writeFileSync(resolve(f.targetDir, 'sentinel'), 'preserve');
  await assert.rejects(run(f), /DESTINATION_MUST_BE_NEW/);
  assert.equal(readFileSync(resolve(f.targetDir, 'sentinel'), 'utf8'), 'preserve');
});

test('hosted backup: refuses symlinked input, unsafe permissions, repository targets, and dangling destination links', async t => {
  const f = await backupFixture(t);
  const linked = resolve(f.dir, 'symlink.sqlite'); symlinkSync(f.snapshot, linked);
  await assert.rejects(restoreCheck({ source: linked, targetDir: f.targetDir, consistentSnapshotConfirmed: true }), /PRIVATE_REGULAR_PATH_REQUIRED/);
  chmodSync(f.snapshot, 0o644); await assert.rejects(run(f), /PATH_MUST_BE_PRIVATE_AND_OWNED/); chmodSync(f.snapshot, 0o600);
  chmodSync(f.dir, 0o755); await assert.rejects(run(f), /PATH_MUST_BE_PRIVATE_AND_OWNED/); chmodSync(f.dir, 0o700);
  symlinkSync(resolve(f.dir, 'missing'), f.targetDir);
  await assert.rejects(run(f), /DESTINATION_MUST_BE_NEW/);
  rmSync(f.targetDir);
  await assert.rejects(restoreCheck({ source: f.snapshot, targetDir: resolve(ROOT, 'never-create-restore-fixture'), consistentSnapshotConfirmed: true }), /PATH_MUST_BE_PRIVATE_AND_OWNED|REPOSITORY_PATH_FORBIDDEN/);
  assert.equal(existsSync(resolve(ROOT, 'never-create-restore-fixture')), false);
});

test('hosted backup: corrupt input creates no output directory', async t => {
  const f = fixture(t); writeFileSync(f.snapshot, 'not SQLite', { mode: 0o600 });
  await assert.rejects(run(f)); assert.equal(existsSync(f.targetDir), false);
});

test('hosted backup: validates migration fingerprints, leaves failed copies marked, and refuses newer schema', async t => {
  const f = await backupFixture(t);
  const db = new DatabaseSync(f.snapshot); db.exec("UPDATE schema_migrations SET checksum='tampered' WHERE version=(SELECT MIN(version) FROM schema_migrations)"); db.close();
  await assert.rejects(run(f), /MIGRATION_CHECKSUM_MISMATCH/);
  assert.equal(existsSync(resolve(f.targetDir, 'RESTORE-CHECK.json')), false);
  assert.equal(existsSync(resolve(f.targetDir, 'RESTORE-FAILED.txt')), true);
  assert.equal(existsSync(resolve(f.targetDir, 'DO-NOT-START.txt')), true, 'The startup interlock is installed before copying or migrations');
  const other = await backupFixture(t);
  const newer = new DatabaseSync(other.snapshot); newer.prepare('INSERT INTO schema_migrations VALUES(9999,?,?,?)').run('9999-future.sql', 'future', NOW); newer.close();
  await assert.rejects(run(other), /DATABASE_NEWER_THAN_CODE/);
});

test('hosted backup: applies reviewed pending migrations only to the new copy', async t => {
  const f = await backupFixture(t);
  const migrationsDir = resolve(f.dir, 'reviewed-migrations'); cpSync(resolve(ROOT, 'migrations'), migrationsDir, { recursive: true });
  const newest = Math.max(...readdirSync(migrationsDir).filter(name => /^\d+[-_].+\.sql$/.test(name)).map(name => parseInt(name)));
  writeFileSync(resolve(migrationsDir, `${newest + 1}-restore-fixture.sql`), 'CREATE TABLE restore_fixture(id INTEGER PRIMARY KEY) STRICT;');
  const report = await restoreCheck({ source: f.snapshot, targetDir: f.targetDir, consistentSnapshotConfirmed: true, migrationsDir });
  assert.equal(report.migrations.at(-1).version, newest + 1);
  const original = new DatabaseSync(f.snapshot, { readOnly: true });
  try { assert.equal(original.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='restore_fixture'").get().n, 0); } finally { original.close(); }
});

test('hosted backup: standalone snapshot captures committed WAL data without changing the live journal', async t => {
  const f = fixture(t);
  const live = openDatabase({ root: ROOT, dataDir: f.live });
  t.after(() => live.db.close());
  live.db.prepare("INSERT INTO users(id,email_normalized,display_name,status,created_at) VALUES('wal-user','wal@example.test','WAL fixture','pending',?)").run(NOW);
  assert.equal(live.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  await privateBackup(live.filename, f.snapshot);
  assert.equal(live.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  for (const suffix of ['-wal','-shm','-journal']) assert.equal(existsSync(f.snapshot + suffix), false);
  const copy = new DatabaseSync(f.snapshot, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
    assert.equal(copy.prepare("SELECT display_name FROM users WHERE id='wal-user'").get().display_name, 'WAL fixture');
  } finally { copy.close(); }
  const report = await run(f); assert.equal(report.content.users, 1);
});

test('hosted deployment: templates preserve same-host proxy and disabled publishing defaults', () => {
  const nginx = readFileSync(resolve(ROOT, 'deploy/nginx-agendepost.conf'), 'utf8');
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:4180;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto https;/);
  assert.match(nginx, /proxy_set_header Host agendepost\.com\.br;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Host "";/);
  assert.match(nginx, /proxy_set_header Forwarded "";/);
  assert.match(nginx, /ssl_reject_handshake on;/);
  assert.match(nginx, /access_log off;/);
  assert.doesNotMatch(nginx, /^\s*(?:proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for|real_ip_header|set_real_ip_from)/m);
  const env = readFileSync(resolve(ROOT, 'deploy/agendepost.env.example'), 'utf8');
  for (const flag of ['SOCIAL_SAAS_META_ENABLED','SOCIAL_SAAS_META_OAUTH_ENABLED','SOCIAL_SAAS_PUBLISHING_WORKER']) assert.match(env, new RegExp(`^${flag}=false$`, 'm'));
  const unit = readFileSync(resolve(ROOT, 'deploy/agendepost.service'), 'utf8');
  assert.match(unit, /^User=agendepost$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/agendepost$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
});

test('hosted backup: public-directory descendants starting with two dots remain forbidden', async t => {
  const f = fixture(t);
  const publicDir = resolve(f.dir, 'public'), disguised = resolve(publicDir, '..private');
  mkdirSync(publicDir, { mode: 0o700 }); mkdirSync(disguised, { mode: 0o700 });
  await assert.rejects(privateBackup(f.source, resolve(disguised, 'backup.sqlite'), { publicDir }), /BACKUP_PUBLIC_DIRECTORY_FORBIDDEN/);
  assert.equal(existsSync(resolve(disguised, 'backup.sqlite')), false);
});

test('hosted recovery: startup refuses successful and failed restore markers until explicit successful-copy review', async t => {
  const f = await backupFixture(t);
  await run(f);
  const hosted = dataDir => buildConfig({ mode: 'production', deployment: 'hosted-pilot', trustedProxy: 'loopback', canonicalOrigin: 'https://agendepost.com.br', dataDir });
  assert.throws(() => hosted(f.targetDir), /HOSTED_RESTORE_REVIEW_REQUIRED/, 'Offline restore copies cannot start before operator review');
  assert.equal(JSON.parse(readFileSync(resolve(f.targetDir, 'RESTORE-CHECK.json'), 'utf8')).result, 'verified_offline_only');
  assert.equal(existsSync(resolve(f.targetDir, 'RESTORE-FAILED.txt')), false);
  // Simulates only the documented operator marker rename, after reviewing this synthetic copy.
  renameSync(resolve(f.targetDir, 'DO-NOT-START.txt'), resolve(f.targetDir, 'RECOVERY-REVIEWED.txt'));
  assert.equal(hosted(f.targetDir).hosted, true);
  const failed = await backupFixture(t);
  const db = new DatabaseSync(failed.snapshot);
  db.exec("UPDATE schema_migrations SET checksum='synthetic-invalid' WHERE version=(SELECT MIN(version) FROM schema_migrations)"); db.close();
  await assert.rejects(run(failed), /MIGRATION_CHECKSUM_MISMATCH/);
  assert.equal(existsSync(resolve(failed.targetDir, 'RESTORE-FAILED.txt')), true);
  assert.throws(() => hosted(failed.targetDir), /HOSTED_RESTORE_REVIEW_REQUIRED/, 'A failed restore must never be promoted');
  // A misleading reviewed marker cannot bypass the failed-copy interlock.
  writeFileSync(resolve(failed.targetDir, 'RECOVERY-REVIEWED.txt'), 'synthetic misleading marker', { mode: 0o600 });
  assert.throws(() => hosted(failed.targetDir), /HOSTED_RESTORE_REVIEW_REQUIRED/);
});
