import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import sharp from 'sharp';
import { harness, verified, QA_PASSWORD, invite, idempotency, route, multipart } from './qa-helpers.mjs';

async function availablePort(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function tcp(port,path,{method='GET',headers={},body}={}){return new Promise((resolve,reject)=>{const request=http.request({hostname:'127.0.0.1',port,path,method,headers},response=>{const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>{const raw=Buffer.concat(chunks);let json=null;try{json=JSON.parse(raw.toString());}catch{}resolve({status:response.statusCode,headers:response.headers,raw,body:raw.toString(),json});});});request.on('error',reject);request.end(body);});}
const cookieHeader = result => (result.headers['set-cookie']??[]).map(c=>c.split(';')[0]).join('; ');

test('QA HTTP: actual loopback listener, hardening headers, closed static roots, cookies, parser and proxy spoofing',async t=>{
  const port=await availablePort(),origin=`http://127.0.0.1:${port}`;
  const h=await harness(t,{port,canonicalOrigin:origin});
  await h.app.listen({port,host:'127.0.0.1'});
  assert.equal(h.app.server.address().address,'127.0.0.1');
  const home=await tcp(port,'/');assert.equal(home.status,200);assert.match(home.body,/<html lang="pt-BR">/);
  const csp=home.headers['content-security-policy'];assert.ok(csp);assert.match(csp,/script-src 'self'/);assert.match(csp,/frame-ancestors 'none'/);assert.doesNotMatch(csp,/unsafe-inline|unsafe-eval/);
  assert.equal(home.headers['x-content-type-options'],'nosniff');assert.equal(home.headers['referrer-policy'],'no-referrer');assert.ok(!home.headers['access-control-allow-origin']);
  for(const path of ['/app','/app.js','/styles.css','/mark.svg']) assert.equal((await tcp(port,path)).status,200,path);
  for(const path of ['/data/social-saas.sqlite','/api/v1/mail/outbox','/mail_outbox','/src/app.mjs','/package.json','/%2e%2e/package.json']) assert.equal((await tcp(port,path)).status,404,path);
  for(const path of ['/health/live','/health/ready']) {const result=await tcp(port,path);assert.equal(result.status,200);assert.deepEqual(result.json,{data:{status:'ok'}});assert.doesNotMatch(result.body,/sqlite|version|password|schema/i);}
  const poisonedHost=await tcp(port,'/health/live',{headers:{host:'evil.example','x-forwarded-host':new URL(origin).host,'x-forwarded-proto':'https','x-forwarded-for':'127.0.0.1'}});assert.equal(poisonedHost.status,400);
  const session=await tcp(port,'/api/v1/auth/session',{headers:{'x-forwarded-host':'evil.example','x-forwarded-proto':'https','x-forwarded-for':'203.0.113.10'}});
  assert.equal(session.status,200);assert.equal(session.json.data.user,null);assert.equal(session.headers['cache-control'],'no-store');
  const cookies=session.headers['set-cookie'];assert.equal(cookies.length,1);assert.match(cookies[0],/^ss_dev_preauth=/);assert.match(cookies[0],/HttpOnly/i);assert.match(cookies[0],/SameSite=Lax/i);assert.match(cookies[0],/Path=\//);assert.doesNotMatch(cookies[0],/Domain=|Secure/i);
  const authHeaders={origin,cookie:cookieHeader(session),'x-csrf-token':session.json.data.csrfToken,'content-type':'application/json'};
  assert.equal((await tcp(port,'/api/v1/auth/register',{method:'POST',headers:{...authHeaders,origin:'https://evil.example'},body:JSON.stringify({email:'http@example.test',displayName:'HTTP test'})})).status,403);
  assert.equal((await tcp(port,'/api/v1/auth/register',{method:'POST',headers:authHeaders,body:'{malformed'})).status,400);
  assert.equal((await tcp(port,'/api/v1/auth/register',{method:'POST',headers:authHeaders,body:JSON.stringify({email:'http@example.test',displayName:'x'.repeat(6000)})})).status,413);
  const health=await tcp(port,'/health/ready');assert.equal(health.status,200,'Malformed and oversized requests must not kill the process');
  const identity=await verified(h,'http-account');
  const logged=await tcp(port,'/api/v1/auth/login',{method:'POST',headers:authHeaders,body:JSON.stringify({email:identity.email,password:QA_PASSWORD})});assert.equal(logged.status,200,logged.body);
  assert.match(logged.headers['set-cookie'].find(c=>c.startsWith('ss_dev_session=')),/HttpOnly/);
  const authenticatedCookie=cookieHeader(logged),me=await tcp(port,'/api/v1/me',{headers:{cookie:authenticatedCookie}});assert.equal(me.status,200);assert.equal(me.json.data.id,identity.user.id);
  assert.doesNotMatch(me.body,/password_hash|csrf_token|token_hash|session_epoch/);
  const logout=await tcp(port,'/api/v1/auth/logout',{method:'POST',headers:{origin,cookie:authenticatedCookie,'x-csrf-token':logged.json.data.csrfToken,'content-type':'application/json'},body:'{}'});assert.equal(logout.status,200,logout.body);
  assert.equal((await tcp(port,'/api/v1/me',{headers:{cookie:authenticatedCookie}})).status,401);
});

test('QA HTTPS configuration: host-prefixed cookies are Secure/HttpOnly with no Domain',async t=>{
  const h=await harness(t,{canonicalOrigin:'https://127.0.0.1:4180'});
  const response=await h.app.inject({url:'/api/v1/auth/session',headers:{host:'127.0.0.1:4180'}});
  assert.equal(response.statusCode,200);const cookie=response.headers['set-cookie'];assert.match(cookie,/^__Host-ss_preauth=/);assert.match(cookie,/Secure/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Path=\//);assert.doesNotMatch(cookie,/Domain=/);
});

test('QA HTTP: chunked upload rejects excessive preamble and fresh revocation before byte commit',async t=>{
  const port=await availablePort(),origin=`http://127.0.0.1:${port}`,h=await harness(t,{port,canonicalOrigin:origin});
  await h.app.listen({port,host:'127.0.0.1'});
  const owner=await verified(h,'stream-owner'),editor=await verified(h,'stream-editor');
  const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Stream QA',slug:'stream-qa',timezone:'UTC'},idempotency());
  const workspace=await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/workspaces`,{name:'Stream brand'},idempotency());
  await invite(h,owner.client,tenant.id,editor,'editor',[workspace.id]);
  const bytes=await sharp({create:{width:64,height:64,channels:3,background:'#2255aa'}}).png().toBuffer(),form=multipart(bytes);
  const path=route(tenant,workspace,'/media');
  const requestHeaders={...form.headers,origin,cookie:editor.client.cookie,'x-csrf-token':editor.client.csrf,'idempotency-key':'stream-revoked-qa','transfer-encoding':'chunked'};
  let request;
  const responsePromise=new Promise((resolve,reject)=>{request=http.request({hostname:'127.0.0.1',port,path,method:'POST',headers:requestHeaders},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({status:response.statusCode,body:Buffer.concat(chunks).toString()}));});request.on('error',reject);});
  const split=form.payload.length-30;
  request.write(form.payload.subarray(0,split));
  await new Promise(resolve=>setTimeout(resolve,50));
  const membership=h.db.prepare('SELECT version FROM memberships WHERE tenant_id=? AND user_id=?').get(tenant.id,editor.user.id);
  await owner.client.ok('DELETE',`/api/v1/tenants/${tenant.id}/members/${editor.user.id}`,{expectedVersion:membership.version});
  request.end(form.payload.subarray(split));
  const denied=await responsePromise;assert.equal(denied.status,404,denied.body);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM media').get().n,0);assert.equal(h.db.prepare('SELECT count(*) AS n FROM media_blobs').get().n,0);
  const giant=Buffer.concat([Buffer.alloc(5*1024*1024+65537,120),Buffer.from('\r\n'),form.payload]);
  const oversized=await tcp(port,path,{method:'POST',headers:{...form.headers,origin,cookie:owner.client.cookie,'x-csrf-token':owner.client.csrf,'idempotency-key':'stream-overhead-qa','transfer-encoding':'chunked'},body:giant});
  assert.equal(oversized.status,413,oversized.body);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM media').get().n,0);assert.equal((await tcp(port,'/health/ready')).status,200);
});
