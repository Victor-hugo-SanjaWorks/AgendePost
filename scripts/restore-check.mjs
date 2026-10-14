import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateBackup } from '../src/backup.mjs';
import { openDatabase } from '../src/db.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const REVIEW_CODE = 'RESTORE_REVIEW_REQUIRED';
const inside = (root, file) => { const part = relative(root, file); return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)); };
const fail = code => { throw new Error(code); };
function requirePrivateOwned(path, directory = false) {
  const info = lstatSync(path);
  if (process.platform === 'win32') fail('RESTORE_REQUIRES_POSIX_PRIVATE_STORAGE');
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail('RESTORE_PRIVATE_REGULAR_PATH_REQUIRED');
  if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()) fail('RESTORE_PATH_MUST_BE_PRIVATE_AND_OWNED');
  return info;
}
async function sha256(file) { const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk); return digest.digest('hex'); }
function verify(db) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('RESTORE_INTEGRITY_FAILED');
}
function snapshotOnly(source, liveDataDir) {
  if (basename(source) === 'social-saas.sqlite' || source === resolve(liveDataDir, 'social-saas.sqlite')) fail('RESTORE_LIVE_DATABASE_FORBIDDEN');
  if (['-wal', '-shm', '-journal'].some(suffix => existsSync(source + suffix))) fail('RESTORE_SNAPSHOT_HAS_SIDECARS');
}

/** Offline recovery drill only. Never creates an app, starts a worker or contacts a provider. */
export async function restoreCheck({ source, targetDir, consistentSnapshotConfirmed = false, liveDataDir = process.env.SOCIAL_SAAS_DATA_DIR || resolve(ROOT, 'data'), migrationsDir } = {}) {
  if (!consistentSnapshotConfirmed) fail('RESTORE_CONSISTENT_SNAPSHOT_CONFIRMATION_REQUIRED');
  if (!isAbsolute(source || '') || !isAbsolute(targetDir || '')) fail('RESTORE_ABSOLUTE_PATHS_REQUIRED');
  const requestedSource = resolve(source), requestedTarget = resolve(targetDir);
  requirePrivateOwned(requestedSource);
  const snapshot = realpathSync(requestedSource);
  requirePrivateOwned(dirname(snapshot), true);
  const parent = realpathSync(dirname(requestedTarget));
  requirePrivateOwned(parent, true);
  const destination = resolve(parent, basename(requestedTarget));
  if ([snapshot, destination].some(path => inside(realpathSync(ROOT), path))) fail('RESTORE_REPOSITORY_PATH_FORBIDDEN');
  if (existsSync(requestedTarget) || (() => { try { lstatSync(requestedTarget); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } })()) fail('RESTORE_DESTINATION_MUST_BE_NEW');
  snapshotOnly(snapshot, liveDataDir);
  const before = statSync(snapshot), sourceDigest = await sha256(snapshot);
  // Verify a standalone, operator-created SQLite backup before creating a destination.
  const sourceDb = new DatabaseSync(snapshot, { readOnly: true, allowExtension: false });
  try { verify(sourceDb); } finally { sourceDb.close(); }
  snapshotOnly(snapshot, liveDataDir);
  mkdirSync(destination, { mode: 0o700 }); // No recursive creation and no existing directory reuse.
  let opened;
  try {
    // Install the startup interlock before copying/migrating anything. A process
    // interruption must not leave an apparently activatable partial restore.
    writeFileSync(resolve(destination, 'DO-NOT-START.txt'), 'Recovery in progress or offline drill only. Hosted startup refuses this directory while this marker exists. Never promote a copy with RESTORE-FAILED.txt. After successful completion, an operator must independently validate RESTORE-CHECK.json, reconcile all possibly published jobs, keep Meta/OAuth/worker disabled, and confirm the old instance is stopped. Only then may the operator explicitly rename this marker to RECOVERY-REVIEWED.txt. No automatic promotion or remote token revocation is performed.\n', { flag: 'wx', mode: 0o600 });
    await privateBackup(snapshot, resolve(destination, 'social-saas.sqlite'), { publicDir: resolve(ROOT, 'public') });
    opened = openDatabase({ root: ROOT, dataDir: destination }, migrationsDir ? { migrationsDir } : {});
    const { db, transaction } = opened;
    verify(db);
    const now = new Date().toISOString();
    const changes = transaction(() => {
      const result = {};
      // A restored snapshot can predate a successful external publish. Never replay it automatically.
      result.publicationJobsFrozen = db.prepare(`UPDATE publication_jobs SET status='needs_attention',error_code=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,version=version+1,updated_at=? WHERE status IN ('scheduled','leased','sending','retry_wait','needs_attention')`).run(REVIEW_CODE, now).changes;
      result.publicationAttemptsAmbiguous = db.prepare("UPDATE publication_attempts SET outcome='ambiguous',error_code=?,finished_at=? WHERE outcome='sending'").run(REVIEW_CODE, now).changes;
      db.prepare('UPDATE publication_workers SET stopped_at=? WHERE stopped_at IS NULL').run(now);
      result.oauthStatesRemoved = db.prepare('DELETE FROM social_oauth_states').run().changes;
      result.oauthPendingRemoved = db.prepare('DELETE FROM social_oauth_pending').run().changes;
      result.oauthConnectionsRevoked = db.prepare("UPDATE social_connections SET status='revoked',encrypted_payload=NULL,authorization_version=?,version=version+1,updated_at=?,disconnected_at=? WHERE status!='revoked' OR encrypted_payload IS NOT NULL").run('restore-' + randomUUID(), now, now).changes;
      result.dashboardSharesRevoked = db.prepare('UPDATE client_dashboard_shares SET revoked_at=?,version=version+1 WHERE revoked_at IS NULL').run(now).changes;
      result.clientApprovalsRevoked = db.prepare("UPDATE client_approval_requests SET status='revoked',scheduling_status='blocked',scheduling_code=?,revoked_at=?,version=version+1,updated_at=? WHERE status IN ('pending','approved')").run(REVIEW_CODE,now,now).changes;
      result.clientApprovalChallengesRemoved = db.prepare('DELETE FROM client_approval_challenges').run().changes;
      result.metricsSettingsDisabled = db.prepare('UPDATE social_metrics_settings SET enabled=0,version=version+1,updated_at=? WHERE enabled=1').run(now).changes;
      result.metricLeasesRemoved = db.prepare('DELETE FROM social_metrics_sync').run().changes;
      result.whatsappAttemptsAmbiguous = db.prepare("UPDATE approval_whatsapp_notifications SET status='unknown',error_code=?,updated_at=? WHERE status='sending'").run(REVIEW_CODE,now).changes;
      result.sessionsRemoved = db.prepare('DELETE FROM sessions').run().changes;
      result.preauthSessionsRemoved = db.prepare('DELETE FROM preauth_sessions').run().changes;
      result.authTokensRemoved = db.prepare('DELETE FROM auth_tokens').run().changes;
      result.userEpochsAdvanced = db.prepare('UPDATE users SET session_epoch=session_epoch+1').run().changes;
      result.invitationsRevoked = db.prepare('UPDATE invitations SET revoked_at=? WHERE accepted_at IS NULL AND revoked_at IS NULL').run(now).changes;
      result.outboxMessagesRemoved = db.prepare('DELETE FROM mail_outbox').run().changes;
      result.idempotencyKeysRemoved = db.prepare('DELETE FROM idempotency_keys').run().changes;
      result.billingJobsFrozen = db.prepare("UPDATE jobs SET state='failed',lease_token=NULL,lease_until=NULL,last_error_code=?,completed_at=? WHERE state IN ('queued','processing','retry')").run(REVIEW_CODE, now).changes;
      result.billingEventsQuarantined = db.prepare("UPDATE billing_events SET state='quarantined',error_code=? WHERE state IN ('queued','processing')").run(REVIEW_CODE).changes;
      db.prepare('DELETE FROM billing_reconciliation_locks').run();
      db.prepare("INSERT INTO audit_events(id,action,target_type,outcome,safe_changes,created_at) VALUES(?,'recovery.restore_checked','database','success',?,?)").run(randomUUID(), JSON.stringify({ code: REVIEW_CODE, ...result }), now);
      return result;
    });
    verify(db);
    const migrations = db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all();
    const content = {
      users: db.prepare('SELECT COUNT(*) AS total FROM users').get().total,
      tenants: db.prepare('SELECT COUNT(*) AS total FROM tenants').get().total,
      mediaBlobs: db.prepare('SELECT COUNT(*) AS total FROM media_blobs').get().total,
      mediaBytes: db.prepare('SELECT COALESCE(SUM(length(bytes)),0) AS total FROM media_blobs').get().total,
    };
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close(); opened = null;
    const after = statSync(snapshot);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || sourceDigest !== await sha256(snapshot)) fail('RESTORE_SOURCE_CHANGED');
    snapshotOnly(snapshot, liveDataDir);
    const report = { format: 1, checkedAt: now, result: 'verified_offline_only', sourceSha256: sourceDigest, targetDir: destination, integrityCheck: 'ok', foreignKeyCheck: 'ok', migrations, content, changes, requiresManualReview: true, workerMustRemainDisabled: true, providerRevocationPerformed: false };
    writeFileSync(resolve(destination, 'RESTORE-CHECK.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) {
    opened?.db.close();
    try { writeFileSync(resolve(destination, 'RESTORE-FAILED.txt'), 'Restore check did not complete. Do not start this directory. Preserve for operator investigation; retry only with a new destination.\n', { flag: 'wx', mode: 0o600 }); } catch {}
    throw error;
  }
}

const usage = 'Usage: npm run restore:check -- --source /PRIVATE/BACKUPS/snapshot.sqlite --target-dir /PRIVATE/RESTORES/new-drill --confirm-consistent-snapshot\nSource must come from the SQLite backup command, never a hot file copy. Target must not exist. Creates an offline copy; does not activate it.';
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== '--source' || args[2] !== '--target-dir' || args[4] !== '--confirm-consistent-snapshot') { console.error(usage); process.exitCode = 1; return; }
  try {
    const report = await restoreCheck({ source: args[1], targetDir: args[3], consistentSnapshotConfirmed: true });
    console.log(JSON.stringify({ result: report.result, targetDir: report.targetDir, sourceSha256: report.sourceSha256, changes: report.changes, workerMustRemainDisabled: true }, null, 2));
  } catch (error) { console.error(`Restore check failed: ${/^RESTORE_|^MIGRATION_|^DATABASE_|^BACKUP_|^NO_MIGRATIONS$/.test(error.message) ? error.message : error.code || 'RESTORE_CHECK_FAILED'}. Do not start the target directory.`); process.exitCode = 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
