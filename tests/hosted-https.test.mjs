import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { issueOperatorAccess } from '../src/operator-access.mjs';
test('real loopback HTTPS proxy: trusted certificate, secure session, operator enrollment and canonical-origin CSRF',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'agendepost-https-')),key=join(dir,'test-key.pem'),cert=join(dir,'test-cert.pem');
 const app=await createApp({mode:'test',deployment:'hosted-pilot',trustedProxy:'loopback',canonicalOrigin:'https://agendepost.example',dataDir:dir,port:0});
 let proxy;t.after(async()=>{await new Promise(resolve=>proxy?proxy.close(resolve):resolve());await app.close();await rm(dir,{recursive:true,force:true});});
 // Test-only ephemeral certificate, explicitly trusted by this client; never installed in OS trust.
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=agendepost.example','-addext','subjectAltName=DNS:agendepost.example'],{stdio:'ignore'});
 const ca=await readFile(cert);await app.listen({host:'127.0.0.1',port:0});
 proxy=https.createServer({key:await readFile(key),cert:ca},(req,res)=>{
  const headers={...req.headers,host:'agendepost.example','x-forwarded-for':req.socket.remoteAddress,'x-forwarded-proto':'https'};delete headers.forwarded;delete headers['x-forwarded-host'];
  const upstream=http.request({host:'127.0.0.1',port:app.server.address().port,method:req.method,path:req.url,headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);
 });await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 const jar=new Map();let csrf;
 async function request(method,path,body,overrides={}){
  const payload=body===undefined?null:JSON.stringify(body);
  const headers={host:'agendepost.example',origin:'https://agendepost.example',...(csrf?{'x-csrf-token':csrf}:{}),cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...overrides};
  return new Promise((resolve,reject)=>{const req=https.request({hostname:'127.0.0.1',servername:'agendepost.example',port:proxy.address().port,ca,method,path,headers,agent:false},res=>{let text='';res.setEncoding('utf8');res.on('data',x=>text+=x);res.on('end',()=>{for(const value of res.headers['set-cookie']??[]){const [k,v]=value.split(';')[0].split('=');if(v)jar.set(k,v);else jar.delete(k);}let json;try{json=JSON.parse(text);}catch{}if(json?.data?.csrfToken)csrf=json.data.csrfToken;resolve({status:res.statusCode,headers:res.headers,json,text});});});req.on('error',reject);if(payload)req.write(payload);req.end();});
 }
 const bootstrap=await request('GET','/api/v1/auth/session');assert.equal(bootstrap.status,200);assert.match(bootstrap.headers['set-cookie'].join(' '),/__Host-ss_preauth=.*Secure/);assert.equal(bootstrap.json.data.capabilities.hostedPilot,true);
 const link=issueOperatorAccess(app.ctx.config,{purpose:'enroll',email:'tls-owner@example.test',displayName:'TLS Owner'}),token=new URLSearchParams(new URL(link.url).hash.split('?')[1]).get('token'),password='Real HTTPS pilot passphrase 2026!';
 assert.equal((await request('POST','/api/v1/auth/email/verify',{token,password})).status,200);
 const login=await request('POST','/api/v1/auth/login',{email:'tls-owner@example.test',password});assert.equal(login.status,200);assert.match(login.headers['set-cookie'].join(' '),/__Host-ss_session=.*HttpOnly.*Secure/);
 assert.equal((await request('GET','/api/v1/me')).status,200);
 assert.equal((await request('POST','/api/v1/auth/logout',{}, {origin:'https://evil.example'})).status,403);
 assert.equal((await request('POST','/api/v1/auth/logout',{}, {'x-csrf-token':'wrong'})).status,403);
 // Internet client headers cannot control upstream host/proto/address through the model proxy.
 assert.equal((await request('GET','/api/v1/me',undefined,{'x-forwarded-for':'1.1.1.1, 127.0.0.1','x-forwarded-proto':'http','x-forwarded-host':'evil.example',forwarded:'host=evil.example'})).status,200);
 assert.equal((await request('POST','/api/v1/auth/logout',{})).status,200);assert.equal((await request('GET','/api/v1/me')).status,401);
});
