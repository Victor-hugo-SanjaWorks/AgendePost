import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createMetaPublishingAdapterFromEnv, META_API_VERSION } from '../src/publishing/providers/meta.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const secretNames=['SOCIAL_SAAS_META_CONFIG_FILE','SOCIAL_SAAS_META_OAUTH_CONFIG_FILE','SOCIAL_SAAS_META_ENCRYPTION_KEY_FILE'];
const enableNames=['SOCIAL_SAAS_META_ENABLED','SOCIAL_SAAS_META_OAUTH_ENABLED'];

test('security publishing config: startup refuses repository secret paths even with integrations disabled', async t => {
 const old=Object.fromEntries([...secretNames,...enableNames].map(name=>[name,process.env[name]]));
 const external=await mkdtemp(join(dirname(root),'security-private-config-'));
 const repository=await mkdtemp(join(root,'security-private-config-'));
 const webroot=await mkdtemp(join(root,'public','security-private-config-'));
 t.after(async()=>{for(const [name,value] of Object.entries(old)){if(value===undefined)delete process.env[name];else process.env[name]=value;}await Promise.all([external,repository,webroot].map(path=>rm(path,{recursive:true,force:true})));});
 for(const name of [...secretNames,...enableNames])delete process.env[name];
 const config={enabled:true,apiVersion:META_API_VERSION,assetHosts:['assets.example.com'],assets:[],connections:[],testMarker:'FAKE_SECURITY_TEST_ONLY_NEVER_A_REAL_SECRET'};
 const outside=join(external,'safe.json'),repoFile=join(repository,'private.json'),publicFile=join(webroot,'private.json');
 for(const file of [outside,repoFile,publicFile])await writeFile(file,JSON.stringify(config),{mode:0o600});
 await symlink(repository,join(external,'repo-alias'),'dir');
 await symlink(webroot,join(external,'public-alias'),'dir');
 await symlink(outside,join(webroot,'outside-file.json'),'file');
 const candidates=[publicFile,repoFile,join(external,'repo-alias','private.json'),join(external,'public-alias','private.json'),join(webroot,'outside-file.json'),relative(process.cwd(),publicFile),join(webroot,'not-created-yet.json'),join(root,'..private-not-created','key.json')];
 for(const name of secretNames){
  for(const candidate of candidates){
   process.env[name]=candidate;
   assert.throws(()=>buildConfig({mode:'test'}),error=>error.message==='PRIVATE_CREDENTIAL_PATH_FORBIDDEN',`${name} must reject lexical/physical private placement before HTTP setup`);
   await assert.rejects(createApp({mode:'test',dataDir:join(external,'data')}),error=>error.message==='PRIVATE_CREDENTIAL_PATH_FORBIDDEN');
  }
  process.env[name]=outside;
  assert.equal(buildConfig({mode:'test'}).mode,'test','A private absolute external path remains usable');
  delete process.env[name];
 }

 const hardlink=join(webroot,'hardlinked-private.json');await link(outside,hardlink);
 for(const name of secretNames){process.env[name]=outside;assert.throws(()=>buildConfig({mode:'test'}),error=>error.message==='PRIVATE_CREDENTIAL_PATH_FORBIDDEN','External private files hardlinked into the webroot must prevent startup');delete process.env[name];}
 assert.equal(createMetaPublishingAdapterFromEnv({env:{SOCIAL_SAAS_META_ENABLED:'true',SOCIAL_SAAS_META_CONFIG_FILE:outside}}).enabled,false,'Standalone loader rejects multiple-link credentials');
 await unlink(hardlink);
 assert.equal(createMetaPublishingAdapterFromEnv({env:{SOCIAL_SAAS_META_ENABLED:'true',SOCIAL_SAAS_META_CONFIG_FILE:outside}}).enabled,process.platform!=='win32');
 for(const candidate of candidates)assert.equal(createMetaPublishingAdapterFromEnv({env:{SOCIAL_SAAS_META_ENABLED:'true',SOCIAL_SAAS_META_CONFIG_FILE:candidate}}).enabled,false,'Standalone loader also rejects unsafe and relative paths');
});
