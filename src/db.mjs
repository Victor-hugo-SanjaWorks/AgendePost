import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync,readdirSync,readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export function openDatabase(config,{migrationsDir=resolve(config.root,'migrations')}={}) {
 mkdirSync(config.dataDir,{recursive:true,mode:0o700});chmodSync(config.dataDir,0o700);
 const filename=resolve(config.dataDir,'social-saas.sqlite');
 const db=new DatabaseSync(filename,{enableForeignKeyConstraints:true,allowExtension:false});chmodSync(filename,0o600);
 db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2500;');
 let depth=0;
 function transaction(fn) {
   if(fn?.constructor?.name==='AsyncFunction')throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
   if(depth) { const nested=fn(); if(nested?.then)throw new Error('ASYNC_TRANSACTION_FORBIDDEN'); return nested; }
   db.exec('BEGIN IMMEDIATE');depth++;
   try{const result=fn();if(result?.then)throw new Error('ASYNC_TRANSACTION_FORBIDDEN');db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}finally{depth--;}
 }
 try {
 transaction(()=>{
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT');
  const files=readdirSync(migrationsDir).filter(f=>/^\d+[-_].+\.sql$/.test(f)).sort((a,b)=>parseInt(a)-parseInt(b));
  if(!files.length)throw new Error('NO_MIGRATIONS');
  const known=new Map();
  for(const name of files){const version=parseInt(name),sql=readFileSync(resolve(migrationsDir,name),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');if(known.has(version))throw new Error('DUPLICATE_MIGRATION');known.set(version,{name,sql,checksum});}
  const applied=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  for(const row of applied){const file=known.get(row.version);if(!file)throw new Error('DATABASE_NEWER_THAN_CODE');if(file.checksum!==row.checksum||file.name!==row.name)throw new Error('MIGRATION_CHECKSUM_MISMATCH');}
  const done=new Set(applied.map(x=>x.version));
  for(const [version,file]of known){if(done.has(version))continue;if(applied.some(x=>x.version>version))throw new Error('MIGRATION_ORDER_MISMATCH');db.exec(file.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(version,file.name,file.checksum,new Date().toISOString());}
  const foreign=db.prepare('PRAGMA foreign_key_check').all();if(foreign.length)throw new Error('MIGRATION_FOREIGN_KEY_FAILURE');
 });
 }catch(e){db.close();throw e;}
 return {db,transaction,filename};
}
