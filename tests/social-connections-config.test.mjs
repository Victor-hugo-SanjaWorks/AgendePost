import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,chmod,symlink,link,rm,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSocialConnectionConfig,CALLBACK_PATH } from '../src/social-connections/config.mjs';
const keys=['SOCIAL_SAAS_META_OAUTH_ENABLED','SOCIAL_SAAS_META_OAUTH_CONFIG_FILE','SOCIAL_SAAS_META_ENCRYPTION_KEY_FILE'];
test('operator OAuth reader requires private regular one-link files, separate valid AES key, and fixed HTTPS callback',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'oauth-config-')),saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));t.after(async()=>{for(const key of keys){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}await rm(directory,{recursive:true,force:true});});
 const root=join(directory,'repo'),configPath=join(directory,'config.json'),keyPath=join(directory,'key');await mkdir(root);
 const app={root,mode:'development',canonicalOrigin:'https://localhost:4180',secureCookies:true};
 const raw={enabled:true,apiVersion:'v26.0',appId:'10001',appSecret:'a'.repeat(32),redirectUri:app.canonicalOrigin+CALLBACK_PATH};
 await writeFile(configPath,JSON.stringify(raw),{mode:0o600});await writeFile(keyPath,Buffer.alloc(32,7).toString('base64'),{mode:0o600});
 process.env.SOCIAL_SAAS_META_OAUTH_ENABLED='true';process.env.SOCIAL_SAAS_META_OAUTH_CONFIG_FILE=configPath;process.env.SOCIAL_SAAS_META_ENCRYPTION_KEY_FILE=keyPath;
 assert.equal(buildSocialConnectionConfig(app).enabled,process.platform!=='win32');if(process.platform==='win32')return;
 await chmod(keyPath,0o644);assert.equal(buildSocialConnectionConfig(app).enabled,false);await chmod(keyPath,0o600);
 const alias=join(directory,'alias');await symlink(configPath,alias);process.env.SOCIAL_SAAS_META_OAUTH_CONFIG_FILE=alias;assert.equal(buildSocialConnectionConfig(app).enabled,false);process.env.SOCIAL_SAAS_META_OAUTH_CONFIG_FILE=configPath;
 const hardlink=join(root,'public-key');await link(keyPath,hardlink);assert.equal(buildSocialConnectionConfig(app).enabled,false);await rm(hardlink);
 await writeFile(keyPath,'invalid key',{mode:0o600});assert.equal(buildSocialConnectionConfig(app).enabled,false);await writeFile(keyPath,Buffer.alloc(32,7).toString('base64'));
 await writeFile(configPath,JSON.stringify({...raw,redirectUri:'https://attacker.example'+CALLBACK_PATH}));assert.equal(buildSocialConnectionConfig(app).enabled,false);
 await writeFile(configPath,JSON.stringify({...raw,redirectUri:app.canonicalOrigin+CALLBACK_PATH+'?next=https://attacker.example'}));assert.equal(buildSocialConnectionConfig(app).enabled,false);
 const misleading=join(root,'..private');await mkdir(misleading);const nested=join(misleading,'config.json');await writeFile(nested,JSON.stringify(raw),{mode:0o600});process.env.SOCIAL_SAAS_META_OAUTH_CONFIG_FILE=nested;assert.equal(buildSocialConnectionConfig(app).enabled,false);
});
test('inline OAuth configuration and injected HTTP are test-only; no development activation',()=>{
 const app={mode:'development',canonicalOrigin:'https://localhost:4180',secureCookies:true};
 const configuration={enabled:true,apiVersion:'v26.0',appId:'10001',appSecret:'a'.repeat(32),redirectUri:app.canonicalOrigin+CALLBACK_PATH,encryptionKey:Buffer.alloc(32,7)};
 assert.equal(buildSocialConnectionConfig(app,{metaOAuthConfig:configuration,metaOAuthFetch:()=>{throw Error('must never execute');}}).enabled,false);
});
