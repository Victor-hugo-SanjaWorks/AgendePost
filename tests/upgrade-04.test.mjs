import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db.mjs';
import {migrateOffline} from '../scripts/migrate.mjs';
const ROOT=resolve(import.meta.dirname,'..'),AT='2026-10-14T12:00:00.000Z';
function oldFixture(t){
 const dir=mkdtempSync(resolve(tmpdir(),'agendepost-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const old=resolve(dir,'migrations-03');mkdirSync(old);for(const name of readdirSync(resolve(ROOT,'migrations')))if(parseInt(name)<=60)cpSync(resolve(ROOT,'migrations',name),resolve(old,name));
 const dataDir=resolve(dir,'private-data'),opened=openDatabase({root:ROOT,dataDir},{migrationsDir:old}),db=opened.db;
 db.prepare("INSERT INTO users(id,email_normalized,display_name,password_hash,email_verified_at,status,created_at) VALUES('u','upgrade@example.test','Synthetic upgrade','synthetic-hash',?,'active',?)").run(AT,AT);
 db.prepare("INSERT INTO tenants(id,name,slug,timezone,created_at,updated_at) VALUES('t','Preserved tenant','upgrade-fixture','UTC',?,?)").run(AT,AT);
 db.prepare("INSERT INTO memberships(tenant_id,user_id,role,status,scope,created_at) VALUES('t','u','owner','active','organization',?)").run(AT);
 db.prepare("INSERT INTO workspaces(tenant_id,id,name,created_at,updated_at) VALUES('t','w','Preserved brand',?,?)").run(AT,AT);
 db.prepare("INSERT INTO channels(tenant_id,workspace_id,id,platform,label,created_at,updated_at) VALUES('t','w','c','facebook','Preserved channel',?,?)").run(AT,AT);
 db.prepare("INSERT INTO media(tenant_id,workspace_id,id,original_name,normalized_mime,size_bytes,width,height,digest,created_by,created_at) VALUES('t','w','m','private.jpg','image/jpeg',4,1,1,'fixture','u',?)").run(AT);db.prepare("INSERT INTO media_blobs VALUES('t','w','m',?)").run(Buffer.from('test'));
 db.prepare("INSERT INTO posts(tenant_id,workspace_id,id,title,caption,status,author_id,updated_by,created_at,updated_at) VALUES('t','w','p','Preserved title','Preserved copy','draft','u','u',?,?)").run(AT,AT);
 db.prepare("INSERT INTO social_connections(id,tenant_id,workspace_id,channel_id,platform,provider_user_id,account_id,page_id,destination_label,token_type,access_basis,permissions,page_tasks,encrypted_payload,status,expires_at,verified_at,authorization_version,connected_by,created_at,updated_at) VALUES('conn','t','w','c','facebook','1','2','2','Fixture','page','direct','[]','[]','synthetic-encrypted-not-real','active','2026-11-01T00:00:00.000Z',?,'old-version','u',?,?)").run(AT,AT,AT);
 const tables=['users','tenants','memberships','workspaces','channels','media','media_blobs','posts','social_connections'];
 const preserved=Object.fromEntries(tables.map(name=>[name,db.prepare('SELECT * FROM '+name).all()]));const before=db.prepare('SELECT * FROM schema_migrations').all();db.close();return {dir,old,dataDir,preserved,before};
}
test('0.3 to 0.4: offline migration preserves every existing tenant/content/blob/credential row and enables no external integration',t=>{
 const f=oldFixture(t);assert.throws(()=>migrateOffline({configOptions:{mode:'test',dataDir:f.dataDir}}),/CONFIRMATION_REQUIRED/);
 const result=migrateOffline({confirmedStopped:true,configOptions:{mode:'test',dataDir:f.dataDir}});assert.equal(result.networkStarted,false);assert.equal(result.workersStarted,false);
 const db=new DatabaseSync(resolve(f.dataDir,'social-saas.sqlite'));try{
  for(const [name,rows]of Object.entries(f.preserved))assert.deepEqual(db.prepare('SELECT * FROM '+name).all(),rows,name);
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=60').all(),f.before);
  for(const table of ['social_metrics_settings','client_dashboard_shares','client_approval_requests','approval_whatsapp_notifications'])assert.equal(db.prepare('SELECT count(*) n FROM '+table).get().n,0,table);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
 assert.equal(migrateOffline({confirmedStopped:true,configOptions:{mode:'test',dataDir:f.dataDir}}).migrations.length,result.migrations.length);
 assert.throws(()=>openDatabase({root:ROOT,dataDir:f.dataDir},{migrationsDir:f.old}),/DATABASE_NEWER_THAN_CODE/);
});
test('0.3 to 0.4: failing migration rolls back all added schema changes and preserves the original database',t=>{
 const f=oldFixture(t),bad=resolve(f.dir,'bad-migrations');cpSync(resolve(ROOT,'migrations'),bad,{recursive:true});writeFileSync(resolve(bad,'999-invalid.sql'),'CREATE TABLE partial_fixture(id TEXT); INVALID SQL;');
 assert.throws(()=>migrateOffline({confirmedStopped:true,configOptions:{mode:'test',dataDir:f.dataDir},migrationsDir:bad}));
 const {db}=openDatabase({root:ROOT,dataDir:f.dataDir},{migrationsDir:f.old});try{assert.deepEqual(db.prepare('SELECT * FROM schema_migrations').all(),f.before);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('client_approval_requests','partial_fixture')").get().n,0);assert.deepEqual(db.prepare('SELECT * FROM posts').all(),f.preserved.posts);}finally{db.close();}
});
