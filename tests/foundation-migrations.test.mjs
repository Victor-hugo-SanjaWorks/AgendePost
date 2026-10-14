import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync,symlinkSync}from'node:fs';
import{resolve}from'node:path';
import{DatabaseSync,backup}from'node:sqlite';
import{openDatabase}from'../src/db.mjs';
import{buildConfig}from'../src/config.mjs';
import{safeEqual,normalizeEmail}from'../src/auth/utils.mjs';
function fixture(t){const root=mkdtempSync('/tmp/saas-migrate-'),dataDir=resolve(root,'data'),migrationsDir=resolve(root,'migrations');mkdirSync(migrationsDir);t.after(()=>rmSync(root,{recursive:true,force:true}));const config=buildConfig({mode:'test',dataDir});return{root,dataDir,migrationsDir,config};}
test('foundation: migrations checksum, unknown version and failed migration never reset data',t=>{
 const f=fixture(t);writeFileSync(resolve(f.migrationsDir,'001-base.sql'),'CREATE TABLE sentinel(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;');
 let d=openDatabase(f.config,f);d.db.prepare('INSERT INTO sentinel VALUES(?,?)').run(1,'preserved');const original=d.db.prepare('SELECT checksum FROM schema_migrations').get().checksum;d.db.close();
 d=openDatabase(f.config,f);assert.equal(d.db.prepare('SELECT value FROM sentinel').get().value,'preserved');assert.equal(d.db.prepare('SELECT checksum FROM schema_migrations').get().checksum,original);d.db.close();
 writeFileSync(resolve(f.migrationsDir,'001-base.sql'),'CREATE TABLE sentinel(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT; -- changed');
 assert.throws(()=>openDatabase(f.config,f),/MIGRATION_CHECKSUM_MISMATCH/);
 writeFileSync(resolve(f.migrationsDir,'001-base.sql'),'CREATE TABLE sentinel(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;');
 writeFileSync(resolve(f.migrationsDir,'002-broken.sql'),'CREATE TABLE partial(id INTEGER); INSERT INTO missing_table VALUES(1);');
 assert.throws(()=>openDatabase(f.config,f));const raw=new DatabaseSync(resolve(f.dataDir,'social-saas.sqlite'));assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='partial'").get().n,0);assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n,1);assert.equal(raw.prepare('SELECT value FROM sentinel').get().value,'preserved');raw.prepare('INSERT INTO schema_migrations VALUES(999,?,?,?)').run('999-future.sql','checksum',new Date().toISOString());raw.close();assert.throws(()=>openDatabase(f.config,f),/DATABASE_NEWER_THAN_CODE/);
});
test('foundation: full migration and transactions enforce constraints and reject asynchronous callbacks',t=>{
 const f=fixture(t);const d=openDatabase(f.config);t.after(()=>d.db.close());assert.deepEqual(d.db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(d.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(d.db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(d.db.prepare('PRAGMA synchronous').get().synchronous,2);
 assert.throws(()=>d.transaction(async()=>1),/ASYNC_TRANSACTION_FORBIDDEN/);assert.equal(d.db.isTransaction,false);
 const at=new Date().toISOString();assert.throws(()=>d.transaction(()=>{d.db.prepare("INSERT INTO tenants(id,name,slug,timezone,created_at,updated_at) VALUES('t','T','t','UTC',?,?)").run(at,at);throw new Error('rollback');}),/rollback/);assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,0);
 assert.throws(()=>d.db.prepare('INSERT INTO workspace_grants VALUES(?,?,?)').run(null,'no-workspace','no-user'));
 assert.equal(statSync(f.dataDir).mode&0o777,0o700);assert.equal(statSync(d.filename).mode&0o777,0o600);
});
test('foundation: consistent SQLite backup restores real rows and migration fingerprints',async t=>{
 const f=fixture(t),d=openDatabase(f.config);t.after(()=>d.db.close());const at=new Date().toISOString();d.db.prepare("INSERT INTO users(id,email_normalized,display_name,status,created_at) VALUES('u','u@example.test','User','pending',?)").run(at);const destination=resolve(f.root,'restored.sqlite');await backup(d.db,destination);const restored=new DatabaseSync(destination,{readOnly:true});try{assert.equal(restored.prepare('SELECT display_name FROM users').get().display_name,'User');assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);assert.deepEqual(restored.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(),d.db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all());}finally{restored.close();}
});
test('foundation: config denies production, public binds, provider injection and legacy database directories',()=>{
 assert.throws(()=>buildConfig({mode:'production'}),/PRODUCTION_NOT_READY/);assert.throws(()=>buildConfig({mode:'test',host:'0.0.0.0'}),/PILOT_LOOPBACK_ONLY/);assert.throws(()=>buildConfig({mode:'development',mailAdapter:{send(){}}}),/TEST_MAIL_ADAPTER_ONLY/);assert.throws(()=>buildConfig({mode:'development',billingAdapter:{}}),/TEST_BILLING_ADAPTER_ONLY/);assert.throws(()=>buildConfig({mode:'test',dataDir:'/tmp/social_studio/data'}),/LEGACY_DATABASE_PATH_FORBIDDEN/);assert.throws(()=>buildConfig({mode:'test',canonicalOrigin:'https://evil.example'}),/INVALID_LOOPBACK_ORIGIN/);assert.equal(buildConfig({mode:'test',canonicalOrigin:'https://localhost:4180'}).sessionCookie,'__Host-ss_session');
});
test('foundation: canonical email and constant-time comparison handle malformed Unicode safely',()=>{
 assert.equal(normalizeEmail('  Alice+News@EXAMPLE.TEST '),'alice+news@example.test');assert.equal(normalizeEmail('a.b@example.test'),'a.b@example.test');assert.equal(safeEqual('é'.repeat(43),'x'.repeat(43)),false);assert.equal(safeEqual('abc','abc'),true);assert.equal(safeEqual(undefined,'x'),false);assert.throws(()=>normalizeEmail('bad@example.test<script>'));assert.throws(()=>normalizeEmail('bad@@example.test'));
});
test('foundation: sensitive backup is private before first page, refuses overwrite and public roots',async t=>{
 const {privateBackup}=await import('../src/backup.mjs');const f=fixture(t),d=openDatabase(f.config);t.after(()=>d.db.close());const secretDir=resolve(f.root,'private'),publicDir=resolve(f.root,'public');mkdirSync(secretDir,{mode:0o700});mkdirSync(publicDir,{mode:0o700});const output=resolve(secretDir,'backup.sqlite');d.db.exec('CREATE TABLE big_fixture(data BLOB)');d.db.prepare('INSERT INTO big_fixture VALUES(?)').run(Buffer.alloc(1024*1024,7));let observations=0;
 await privateBackup(d.filename,output,{publicDir,onProgress(){observations++;assert.equal(statSync(output).mode&0o777,0o600);}});assert.ok(observations>0);assert.equal(statSync(output).mode&0o777,0o600);await assert.rejects(privateBackup(d.filename,output,{publicDir}),/EEXIST/);await assert.rejects(privateBackup(d.filename,resolve(publicDir,'public.sqlite'),{publicDir}),/BACKUP_PUBLIC_DIRECTORY_FORBIDDEN/);
});

test('foundation: private data cannot be configured under public assets or their symlink aliases',t=>{const f=fixture(t),publicDir=resolve(import.meta.dirname,'../public');assert.throws(()=>buildConfig({mode:'test',dataDir:resolve(publicDir,'private-data')}),/PUBLIC_DATABASE_PATH_FORBIDDEN/);const alias=resolve(f.root,'public-alias');symlinkSync(publicDir,alias,'dir');assert.throws(()=>buildConfig({mode:'test',dataDir:resolve(alias,'private-data')}),/PUBLIC_DATABASE_PATH_FORBIDDEN/);});
