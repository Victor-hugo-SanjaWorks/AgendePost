import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';

// Offline schema upgrade only: no application, timer, credential resolver or transport.
export function migrateOffline({ confirmedStopped = false, configOptions = {}, migrationsDir } = {}) {
 if (!confirmedStopped) throw new Error('MIGRATION_STOPPED_SERVICE_CONFIRMATION_REQUIRED');
 const config=buildConfig(configOptions);
 const {db}=openDatabase(config,migrationsDir?{migrationsDir}:{});
 try {
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||integrity[0].integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('MIGRATION_INTEGRITY_FAILED');
  return {result:'migrated_offline',migrations:db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all(),networkStarted:false,workersStarted:false};
 } finally {db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length!==1||args[0]!=='--confirm-service-stopped'){console.error('Usage: node --env-file=/etc/agendepost/agendepost.env scripts/migrate.mjs --confirm-service-stopped\nStop the only app instance and verify a fresh consistent backup first. This flag is the operator attestation, not process detection.');process.exitCode=1;}
 else try{console.log(JSON.stringify(migrateOffline({confirmedStopped:true}),null,2));}catch(error){console.error(/^MIGRATION_|^DATABASE_|^HOSTED_|^PRIVATE_|^PRODUCTION_|^NO_MIGRATIONS$/.test(error.message)?error.message:'OFFLINE_MIGRATION_FAILED');process.exitCode=1;}
}
