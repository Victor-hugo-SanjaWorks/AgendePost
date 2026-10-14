import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verified,Client,invite,idempotency,route } from './qa-helpers.mjs';
import { oauthFixture,OAUTH_FIXTURE,OAUTH_ORIGIN } from './social-connections-helpers.mjs';
import { encryptPayload,decryptPayload } from '../src/social-connections/crypto.mjs';
const noSecrets=s=>{for(const secret of [OAUTH_FIXTURE.appSecret,OAUTH_FIXTURE.shortToken,OAUTH_FIXTURE.userToken,OAUTH_FIXTURE.pageToken,'OFFLINE_AUTHORIZATION_CODE'])assert.ok(!s.includes(secret),`Unexpected secret exposed`);};
test('actual OAuth HTTP flow validates, selects exact destination and stores only encrypted tokens',async t=>{
 const f=await oauthFixture(t),started=await f.start();const u=new URL(started.authorizationUrl);
 assert.equal(u.origin,'https://www.facebook.com');assert.equal(u.pathname,'/v26.0/dialog/oauth');assert.equal(u.searchParams.get('redirect_uri'),f.config.redirectUri);assert.equal(u.searchParams.get('response_type'),'code');assert.match(started.state,/^[\w-]{43}$/);assert.ok(!u.searchParams.get('scope').includes('ads_'));
 const state=f.db.prepare('SELECT * FROM social_oauth_states').get();assert.notEqual(state.state_hash,started.state);assert.equal(state.channel_id,f.channels.find(c=>c.platform==='facebook').id);
 const callback=await f.callback(started);assert.equal(callback.status,302,callback.body);assert.equal(callback.headers.location,`/#/app/connections/${f.tenant.id}/${f.workspace.id}`);noSecrets(callback.body+JSON.stringify(callback.headers));assert.equal(callback.headers['referrer-policy'],'no-referrer');
 const data=await f.owner.client.ok('GET',f.base+'/meta');noSecrets(JSON.stringify(data));assert.equal(data.pending.length,1);assert.equal(data.connections.length,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_connections').get().n,0);
 const p=data.pending[0];assert.equal(p.candidates[0].accountId,OAUTH_FIXTURE.pageId);
 const connected=await f.owner.client.ok('POST',f.base+'/meta/select',{pendingId:p.id,candidateId:p.candidates[0].id,channelId:p.channelId,expectedChannelVersion:p.channelVersion});assert.equal(connected.status,'active');assert.equal(connected.accountId,OAUTH_FIXTURE.pageId);noSecrets(JSON.stringify(connected));
 const stored=f.db.prepare('SELECT * FROM social_connections').get();noSecrets(JSON.stringify(stored));assert.ok(stored.encrypted_payload.includes('"tag"'));
 const binding=f.app.ctx.services.socialConnections.resolveBinding({tenantId:f.tenant.id,workspaceId:f.workspace.id,channelId:p.channelId,platform:'facebook'});assert.equal(binding.accessToken,OAUTH_FIXTURE.pageToken);assert.equal(binding.tokenType,'page');assert.equal(binding.accountId,OAUTH_FIXTURE.pageId);
 const rows=JSON.stringify({state:f.db.prepare('SELECT * FROM social_oauth_states').all(),pending:f.db.prepare('SELECT * FROM social_oauth_pending').all(),connections:f.db.prepare('SELECT * FROM social_connections').all(),audit:f.db.prepare('SELECT * FROM audit_events').all(),idempotency:f.db.prepare('SELECT * FROM idempotency_keys').all()});noSecrets(rows);
 assert.ok(f.mock.calls.length>=12);for(const c of f.mock.calls){assert.equal(c.options.redirect,'error');assert.ok(c.options.signal);assert.equal(new URL(c.url).origin,'https://graph.facebook.com');}
});
test('state is session-bound, single-use and cannot initiate OAuth via GET or missing CSRF',async t=>{
 const f=await oauthFixture(t),s=await f.start();const second=new Client(f);await second.login(f.owner.email);
 const swapped=await f.callback(s,second);assert.equal(swapped.status,400);assert.equal(f.mock.calls.length,0);
 const ok=await f.callback(s);assert.equal(ok.status,302);const count=f.mock.calls.length;const replay=await f.callback(s);assert.equal(replay.status,400);assert.equal(f.mock.calls.length,count);
 assert.equal((await f.owner.client.request('GET',f.base+'/meta/start')).status,404);
 assert.equal((await f.owner.client.request('POST',f.base+'/meta/start',{channelId:f.channels[0].id,accessBasis:'direct'},{headers:{'x-csrf-token':''}})).status,403);
});
test('state expiry, denial, forbidden role and stale channel all fail closed',async t=>{
 const f=await oauthFixture(t);let s=await f.start();f.advance(10*60*1000+1);assert.equal((await f.callback(s)).status,403);assert.equal(f.mock.calls.length,0);
 // Restore recent authentication without changing the session identity for the subsequent new flow.
 f.db.prepare('UPDATE sessions SET auth_at=?').run(new Date(f.now()).toISOString());s=await f.start();assert.equal((await f.callback(s,undefined,'error=access_denied&error_description=untrusted')).status,302);assert.equal((await f.owner.client.ok('GET',f.base+'/meta')).lastResult.code,'META_OAUTH_DENIED');assert.equal(f.mock.calls.length,0);
 s=await f.start();f.db.prepare('UPDATE channels SET version=version+1 WHERE id=?').run(f.channels.find(c=>c.platform==='facebook').id);assert.equal((await f.callback(s)).status,409);
 const editor=await verified(f,'oauth-editor');await invite(f,f.owner.client,f.tenant.id,editor,'editor',[f.workspace.id]);assert.equal((await editor.client.request('POST',f.base+'/meta/start',{channelId:f.channels[0].id,accessBasis:'direct'})).status,403);assert.equal((await editor.client.request('GET',f.base+'/meta')).status,403);
});
test('pending destination cannot bind another brand, channel, user or fabricated account',async t=>{
 const f=await oauthFixture(t),s=await f.start();await f.callback(s);const p=await f.pending();
 const body={pendingId:p.id,candidateId:p.candidates[0].id,channelId:p.channelId,expectedChannelVersion:p.channelVersion};
 const other=await f.owner.client.ok('POST',`/api/v1/tenants/${f.tenant.id}/workspaces`,{name:'Second isolated brand',channels:[{platform:'facebook',label:'Another channel'}]},idempotency());const second=await f.owner.client.ok('GET',route(f.tenant,other,'/channels'));
 const cross=await f.owner.client.request('POST',route(f.tenant,other,'/social-connections/meta/select'),{...body,channelId:second[0].id,expectedChannelVersion:second[0].version});assert.equal(cross.status,400);
 assert.equal((await f.owner.client.request('POST',f.base+'/meta/select',{...body,candidateId:'99999999'})).status,422);
 const session=new Client(f);await session.login(f.owner.email);assert.equal((await session.request('POST',f.base+'/meta/select',body)).status,400);
 const connected=await f.owner.client.ok('POST',f.base+'/meta/select',body);assert.equal(connected.accountId,OAUTH_FIXTURE.pageId);
 assert.equal(f.app.ctx.services.socialConnections.resolveBinding({tenantId:f.tenant.id,workspaceId:other.id,channelId:p.channelId,platform:'facebook'}),undefined);
});
test('explicit Instagram Business Manager selection requests conditional scope and verifies professional linkage',async t=>{
 const f=await oauthFixture(t),ig=f.channels.find(c=>c.platform==='instagram'),s=await f.start(ig,'business_manager');assert.ok(new URL(s.authorizationUrl).searchParams.get('scope').split(',').includes('ads_read'));await f.callback(s);const p=await f.pending();assert.equal(p.candidates[0].accountId,OAUTH_FIXTURE.igId);
 const result=await f.owner.client.ok('POST',f.base+'/meta/select',{pendingId:p.id,candidateId:p.candidates[0].id,channelId:ig.id,expectedChannelVersion:ig.version});assert.equal(result.accountId,OAUTH_FIXTURE.igId);const binding=f.app.ctx.services.socialConnections.resolveBinding({tenantId:f.tenant.id,workspaceId:f.workspace.id,channelId:ig.id,platform:'instagram'});assert.equal(binding.businessManagerGrant,true);assert.equal(binding.linkedPageId,OAUTH_FIXTURE.pageId);
});
test('disconnect and server revocation destroy encrypted credentials and resolver access',async t=>{
 const f=await oauthFixture(t),connection=await f.connect();const d=await f.owner.client.ok('POST',`${f.base}/${connection.id}/disconnect`,{expectedVersion:connection.version});assert.equal(d.status,'disconnected');assert.equal(f.db.prepare('SELECT encrypted_payload FROM social_connections').get().encrypted_payload,null);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_oauth_pending').get().n,0);
 const input={tenantId:f.tenant.id,workspaceId:f.workspace.id,channelId:connection.channelId,platform:'facebook'};assert.equal(f.app.ctx.services.socialConnections.resolveBinding(input),null);
 const second=await f.connect();assert.ok(second.version>d.version);f.app.ctx.services.socialConnections.revokeBinding({...input,connectionVersion:f.app.ctx.services.socialConnections.resolveBinding(input).connectionVersion});assert.equal(f.db.prepare('SELECT status FROM social_connections').get().status,'revoked');assert.equal(f.app.ctx.services.socialConnections.resolveBinding(input),null);
});
test('provider identity mismatch is sanitized; no callback grant or unvalidated account survives',async t=>{
 const f=await oauthFixture(t);f.mock.setIntercept(u=>u.pathname.endsWith('/debug_token')?f.mock.respond({data:{is_valid:true,app_id:'99999',type:'USER',user_id:OAUTH_FIXTURE.userId,scopes:f.mock.scopes,expires_at:Math.floor(f.now()/1000)+3600}}):undefined);
 const s=await f.start();assert.equal((await f.callback(s)).status,302);const data=await f.owner.client.ok('GET',f.base+'/meta');assert.equal(data.lastResult.code,'META_OAUTH_IDENTITY_INVALID');assert.equal(data.pending.length,0);noSecrets(JSON.stringify(data));
});
test('AES-GCM payload tampering and row/AAD swapping fail authentication',()=>{
 const key=Buffer.alloc(32,7),ciphertext=encryptPayload(key,{accessToken:OAUTH_FIXTURE.pageToken},'tenant-a/channel-a');assert.equal(decryptPayload(key,ciphertext,'tenant-a/channel-a').accessToken,OAUTH_FIXTURE.pageToken);assert.throws(()=>decryptPayload(key,ciphertext,'tenant-b/channel-b'),/META_OAUTH_CREDENTIAL_UNAVAILABLE/);const e=JSON.parse(ciphertext);e.data=Buffer.alloc(40).toString('base64');assert.throws(()=>decryptPayload(key,JSON.stringify(e),'tenant-a/channel-a'),/META_OAUTH_CREDENTIAL_UNAVAILABLE/);
});
test('not configured and HTTP callback stay disabled without outbound calls or secret-input route',async t=>{
 const f=await oauthFixture(t,{metaOAuthConfig:undefined});assert.equal((await f.owner.client.ok('GET',f.base+'/meta')).configured,false);assert.equal((await f.owner.client.request('POST',f.base+'/meta/start',{channelId:f.channels[0].id,accessBasis:'direct'})).status,503);assert.equal(f.mock.calls.length,0);
 assert.equal((await f.owner.client.request('POST',f.base+'/meta/credentials',{accessToken:OAUTH_FIXTURE.pageToken})).status,404);
 const bad=await oauthFixture(t,{canonicalOrigin:'http://127.0.0.1:8787'});assert.equal((await bad.owner.client.ok('GET',bad.base+'/meta')).configured,false);
});
