import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSocialConnectionConfig,CALLBACK_PATH } from '../src/social-connections/config.mjs';
import { oauthFixture } from './social-connections-helpers.mjs';
const base={enabled:true,apiVersion:'v26.0',appId:'10001',appSecret:'a'.repeat(32),redirectUri:'https://127.0.0.1:8787'+CALLBACK_PATH,encryptionKey:Buffer.alloc(32,7)};
const app={mode:'test',canonicalOrigin:'https://127.0.0.1:8787',secureCookies:true};
test('optional Meta business configuration is operator-only numeric passthrough and USER-token contract',()=>{
 for(const loginConfigId of ['0','123&scope=admin','https://evil.example',' 123','',123])assert.equal(buildSocialConnectionConfig(app,{metaOAuthConfig:{...base,loginConfigId}}).enabled,false);
 for(const tokenFlow of ['system_user','business','page'])assert.equal(buildSocialConnectionConfig(app,{metaOAuthConfig:{...base,tokenFlow}}).enabled,false);
 const valid=buildSocialConnectionConfig(app,{metaOAuthConfig:{...base,tokenFlow:'user',loginConfigId:'987654321'}});assert.equal(valid.enabled,true);assert.equal(valid.loginConfigId,'987654321');assert.equal(valid.tokenFlow,'user');
});
test('optional config_id composes a fixed official authorization URL without exposing secrets or changing state safeguards',async t=>{
 const f=await oauthFixture(t,{metaOAuthConfig:{...base,loginConfigId:'987654321',tokenFlow:'user'}}),started=await f.start(),u=new URL(started.authorizationUrl);
 assert.equal(u.origin,'https://www.facebook.com');assert.equal(u.searchParams.get('config_id'),'987654321');assert.equal(u.searchParams.get('response_type'),'code');assert.equal(u.searchParams.get('redirect_uri'),base.redirectUri);assert.equal(u.searchParams.get('scope'),'pages_show_list,pages_read_engagement,pages_manage_posts');assert.equal(u.searchParams.get('state').length,43);
 assert.doesNotMatch(started.authorizationUrl,/appSecret|client_secret|encryptionKey/);assert.equal(f.mock.calls.length,0);
});
