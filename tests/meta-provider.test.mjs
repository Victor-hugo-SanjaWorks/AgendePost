import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createMetaPublishingAdapter, createMetaPublishingAdapterFromEnv, META_API_VERSION } from '../src/publishing/providers/meta.mjs';
import { isPublicAddress } from '../src/publishing/providers/transport.mjs';

const NOW = '2026-10-14T10:00:00.000Z';
const TOKEN = 'FAKE_TEST_ONLY_META_TOKEN_NEVER_REAL_1234567890';
const bytes = await sharp({ create:{ width:640,height:640,channels:3,background:'#abcdef' } }).jpeg().toBuffer();
const digest = createHash('sha256').update(bytes).digest('hex');
const json = (data,status = 200,headers = {}) => new Response(JSON.stringify(data),{ status,headers:{ 'content-type':'application/json',...headers } });
function fixture(platform = 'instagram', responses = [], overrides = {}) {
  const config = { enabled:true,apiVersion:META_API_VERSION,assetHosts:['assets.example.com'],requestTimeoutMs:100,
    connections:[{ tenantId:'tenant1',workspaceId:'workspace1',channelId:'channel1',platform,accountId:platform === 'instagram' ? '17840000000000001' : '12345678',linkedPageId:'12345678',tokenType:'page',accessToken:TOKEN,expiresAt:'2026-11-01T00:00:00Z',verifiedAt:'2026-10-14T09:00:00Z',businessManagerGrant:false,permissions:['instagram_basic','instagram_content_publish','pages_read_engagement','pages_show_list','pages_manage_posts'],pageTasks:['CREATE_CONTENT'] }],
    assets:[{ tenantId:'tenant1',workspaceId:'workspace1',digest,url:`https://assets.example.com/approved/${digest}.jpg`,expiresAt:'2026-10-16T00:00:00Z' }] };
  overrides.configure?.(config);
  const calls = [], checkpoints = [], assetCalls = [];
  const dependencies = {
    clock:() => Date.parse(NOW),
    fetchImpl:async (url,options) => {
      const request = { url,options,parameters:Object.fromEntries(options.body || new URL(url).searchParams),checkpoint:checkpoints.at(-1) };
      calls.push(request);
      const item = responses.shift();
      if (item instanceof Error) throw item;
      if (typeof item === 'function') return item(request);
      if (item === undefined) throw new Error('Unexpected test HTTP request');
      return item;
    },
    assetFetchImpl:async (url,options) => { assetCalls.push({url,options}); return overrides.assetResponse?.() || new Response(bytes,{ headers:{'content-type':'image/jpeg'} }); },
    ...overrides.dependencies
  };
  const adapter = createMetaPublishingAdapter(config,dependencies);
  const input = { jobId:'job1',attemptId:'attempt1',tenantId:'tenant1',workspaceId:'workspace1',postId:'post1',channelId:'channel1',platform,revision:7,caption:'  Café ☕\nExact #caption\n\n',format:'image',media:{ id:'media1',mime:'image/jpeg',width:640,height:640,sizeBytes:bytes.length,digest,bytes },now:NOW,saveProviderState:async state => checkpoints.push(structuredClone(state)) };
  input.connectionVersion = adapter.readiness(input).connectionVersion;
  return { adapter,input,config,dependencies,calls,checkpoints,assetCalls };
}

test('Instagram performs exact real Graph create, poll, publish sequence and persists fence',async () => {
  const f = fixture('instagram',[json({id:'180000001'}),json({status_code:'FINISHED'}),json({id:'179000001'})]);
  assert.equal(f.adapter.validate(f.input).ready,true);
  assert.deepEqual(await f.adapter.publish(f.input),{ outcome:'published',remoteId:'179000001' });
  assert.deepEqual(f.calls.map(c => new URL(c.url).pathname),['/v26.0/17840000000000001/media','/v26.0/180000001','/v26.0/17840000000000001/media_publish']);
  assert.equal(f.calls[0].parameters.caption,f.input.caption);
  assert.equal(f.calls[0].parameters.image_url,f.config.assets[0].url);
  assert.equal(f.calls[1].parameters.fields,'status_code,status');
  assert.equal(f.calls[2].parameters.creation_id,'180000001');
  assert.equal(f.calls[2].checkpoint.stage,'publishing');
  assert.deepEqual(f.checkpoints.map(s => s.stage),['prepared','ready','publishing']);
  for (const call of f.calls) { assert.equal(call.options.headers.Authorization,`Bearer ${TOKEN}`); assert.equal(new URL(call.url).hostname,'graph.facebook.com'); assert.equal(call.options.redirect,'error'); assert.ok(!call.url.includes(TOKEN)); }
  assert.ok(!JSON.stringify(f.adapter).includes(TOKEN));
});

test('Facebook stages unpublished photo then publishes one feed post with exact caption',async () => {
  const f = fixture('facebook',[json({id:'45000001'}),json({id:'12345678_99000001'})]);
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'published',remoteId:'12345678_99000001'});
  assert.equal(new URL(f.calls[0].url).pathname,'/v26.0/12345678/photos');
  assert.equal(f.calls[0].parameters.published,'false');
  assert.equal(new URL(f.calls[1].url).pathname,'/v26.0/12345678/feed');
  assert.equal(f.calls[1].parameters.message,f.input.caption);
  assert.deepEqual(JSON.parse(f.calls[1].parameters.attached_media),[{media_fbid:'45000001'}]);
  assert.equal(f.calls[1].checkpoint.stage,'publishing');
});

test('container processing is a safe delayed retry, never success, and reuses persisted ID',async () => {
  const f = fixture('instagram',[json({id:'180000001'}),json({status_code:'IN_PROGRESS'}),json({status_code:'FINISHED'}),json({id:'179000001'})]);
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'retry',code:'META_CONTAINER_PROCESSING',safeToRetry:true,retryAfterMs:60000});
  f.input.providerState = f.checkpoints.at(-1);
  assert.equal((await f.adapter.publish(f.input)).outcome,'published');
  assert.equal(f.calls.filter(c => new URL(c.url).pathname.endsWith('/media')).length,1);
});

test('known container error or expiration fails without media_publish',async t => {
  for (const status of ['ERROR','EXPIRED']) await t.test(status,async () => {
    const f = fixture('instagram',[json({id:'180000001'}),json({status_code:status})]);
    assert.deepEqual(await f.adapter.publish(f.input),{outcome:'failed',code:`META_CONTAINER_${status}`});
    assert.equal(f.calls.length,2);
  });
});

test('lost publishing response is ambiguous and persisted publishing fence prevents replay',async () => {
  const f = fixture('instagram',[json({id:'180000001'}),json({status_code:'FINISHED'}),new Error(`Connection lost secret ${TOKEN}`)]);
  const outcome = await f.adapter.publish(f.input);
  assert.deepEqual(outcome,{outcome:'ambiguous',code:'PROVIDER_NETWORK_ERROR'});
  assert.ok(!JSON.stringify(outcome).includes(TOKEN));
  f.input.providerState = f.checkpoints.at(-1);
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'ambiguous',code:'PUBLISH_RECONCILIATION_REQUIRED'});
  assert.equal(f.calls.length,3); assert.equal(f.assetCalls.length,1);
});

test('prepare timeout/network loss may retry but a publish HTTP 500 remains ambiguous',async () => {
  const f = fixture('instagram',[new Error('network')]);
  assert.equal((await f.adapter.publish(f.input)).safeToRetry,true);
  assert.equal(f.checkpoints.length,0);
  const g = fixture('facebook',[json({id:'45000001'}),json({error:{code:2,message:TOKEN}},500)]);
  assert.deepEqual(await g.adapter.publish(g.input),{outcome:'ambiguous',code:'META_UNAVAILABLE'});
});

test('Meta rate rejection uses Retry-After, resets fence, and safely reuses staged image',async () => {
  const f = fixture('facebook',[json({id:'45000001'}),json({error:{code:4,message:TOKEN}},429,{'retry-after':'120'}),json({id:'12345678_99000001'})]);
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'retry',code:'META_RATE_LIMIT',safeToRetry:true,retryAfterMs:120000});
  assert.equal(f.checkpoints.at(-1).stage,'publishing');
  // Simulate the scheduler's atomic safe-retry commit, not an adapter checkpoint rollback.
  f.input.providerState = {...f.checkpoints.at(-1),stage:'ready'};
  assert.equal((await f.adapter.publish(f.input)).outcome,'published');
  assert.equal(f.calls.filter(c => new URL(c.url).pathname.endsWith('/photos')).length,1);
});

test('unknown 429 without a valid Graph error is ambiguous after publishing',async () => {
  const f = fixture('facebook',[json({id:'45000001'}),json({message:'upstream'},429)]);
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'ambiguous',code:'META_REQUEST_FAILED'});
});

test('authentication and permission errors are sanitized terminal failures',async t => {
  for (const [code,expected] of [[190,'META_AUTH_EXPIRED'],[200,'META_PERMISSION_DENIED']]) await t.test(String(code),async () => {
    const f = fixture('instagram',[json({error:{code,message:TOKEN}},400)]);
    assert.deepEqual(await f.adapter.publish(f.input),{outcome:'failed',code:expected});
  });
});

test('invalid or wrong-account remote IDs never report success',async t => {
  for (const id of [undefined,'12345678','99999999_99000001','12345678_/../../secret']) await t.test(String(id),async () => {
    const f = fixture('facebook',[json({id:'45000001'}),json({id})]);
    assert.equal((await f.adapter.publish(f.input)).outcome,'ambiguous');
  });
});

test('checkpoint persistence failure prevents the irreversible HTTP publish',async () => {
  const f = fixture('facebook',[json({id:'45000001'})]);
  f.input.saveProviderState = async state => { if (state.stage === 'publishing') throw new Error('lease cancelled'); f.checkpoints.push(state); };
  assert.equal((await f.adapter.publish(f.input)).outcome,'ambiguous');
  assert.equal(f.calls.length,1);
});

test('public JPEG response must match exact source bytes, size, MIME and no redirect',async t => {
  const cases = [
    ['changed',() => new Response(Buffer.from([255,216,255,2]),{headers:{'content-type':'image/jpeg'}}),'PUBLIC_ASSET_DIGEST_MISMATCH'],
    ['html',() => new Response(bytes,{headers:{'content-type':'text/html'}}),'PUBLIC_ASSET_TYPE_INVALID'],
    ['redirect',() => new Response(null,{status:302,headers:{location:'http://127.0.0.1/'}}),'PUBLIC_ASSET_UNAVAILABLE'],
    ['compressed',() => new Response(bytes,{headers:{'content-type':'image/jpeg','content-encoding':'gzip'}}),'PUBLIC_ASSET_TYPE_INVALID']
  ];
  for (const [name,assetResponse,code] of cases) await t.test(name,async () => {
    const f = fixture('instagram',[],{assetResponse});
    assert.deepEqual(await f.adapter.publish(f.input),{outcome:'failed',code});
    assert.equal(f.calls.length,0);
  });
});

test('connection or asset scope cannot cross tenant/workspace/channel boundaries',() => {
  const f = fixture();
  for (const field of ['tenantId','workspaceId','channelId']) assert.equal(f.adapter.validate({...f.input,[field]:'other'}).ready,false);
  assert.equal(f.adapter.validate({...f.input,media:{...f.input.media,digest:'a'.repeat(64)}}).code,'IMAGE_INVALID');
  const noAsset = fixture('instagram',[],{configure:c => c.assets=[]});
  assert.equal(noAsset.adapter.validate(noAsset.input).code,'PUBLIC_ASSET_MISSING');
});

test('expired/missing permissions and changed credentials are fail-closed',async () => {
  const f = fixture('instagram',[],{configure:c => c.connections[0].expiresAt='2026-10-13T00:00:00Z'});
  assert.equal(f.adapter.readiness(f.input).code,'META_AUTH_EXPIRED');
  const g = fixture('instagram',[],{configure:c => c.connections[0].permissions=[]});
  assert.equal(g.adapter.validate(g.input).code,'META_PERMISSION_DENIED');
  const h = fixture('instagram',[],{configure:c => c.connections[0].businessManagerGrant=true});
  assert.equal(h.adapter.validate(h.input).code,'META_PERMISSION_DENIED');
  const a = fixture(), b = fixture('instagram',[],{configure:c => c.connections[0].accessToken=TOKEN+'CHANGED'});
  assert.notEqual(a.input.connectionVersion,b.input.connectionVersion);
  b.input.connectionVersion = a.input.connectionVersion;
  assert.deepEqual(await b.adapter.publish(b.input),{outcome:'failed',code:'META_CONNECTION_CHANGED'});
});

test('JPEG dimensions, exact caption limits and stale public asset are validated before enqueue',() => {
  const f = fixture();
  const check = patch => f.adapter.validate({...f.input,...patch}).code;
  assert.equal(check({media:{...f.input.media,mime:'image/png'}}),'IMAGE_JPEG_REQUIRED');
  assert.equal(check({media:{...f.input.media,width:200}}),'IMAGE_DIMENSIONS');
  assert.equal(check({caption:'x'.repeat(2201)}),'CAPTION_INVALID');
  assert.equal(check({caption:'☕'.repeat(2200)}),undefined);
  assert.equal(check({caption:'a\ud800'}),'CAPTION_INVALID');
  assert.equal(check({caption:Array(31).fill('#tag').join(' ')}),'CAPTION_INVALID');
  assert.equal(check({format:'video'}),'FORMAT_UNSUPPORTED');
  const g = fixture('instagram',[],{configure:c => c.assets[0].expiresAt='2026-10-14T10:05:00Z'});
  assert.equal(g.adapter.validate(g.input).code,'PUBLIC_ASSET_EXPIRED');
});

test('strict version, remote IDs, host allowlist, URL protocol and tokens reject malformed configuration',() => {
  for (const configure of [
    c => c.apiVersion='v999.0', c => c.connections[0].accountId='me', c => c.connections[0].accountId='../me',
    c => c.connections[0].accessToken='invalid\nheader', c => c.assets[0].url='http://assets.example.com/x.jpg',
    c => c.assets[0].url='https://assets.example.com@evil.com/x.jpg', c => c.assets[0].url='https://evil.com/x.jpg',
    c => c.assets[0].url='https://assets.example.com:8443/x.jpg', c => c.assetHosts=['localhost'],
    c => c.assetHosts=['127.0.0.1'], c => c.connections.push({...c.connections[0]}), c => c.assets.push({...c.assets[0]})
  ]) assert.throws(() => fixture('instagram',[],{configure}),/META_CONFIG_INVALID/);
});

test('DNS boundary rejects private, reserved, link-local and mapped IP destinations',() => {
  for (const address of ['127.0.0.1','10.1.1.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','198.18.1.1','224.0.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2001:10::1','2002:7f00:1::1','3fff::1']) assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('8.8.8.8'),true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});

test('oversized or malformed provider responses are bounded and cannot become publication success',async () => {
  const f = fixture('facebook',[json({id:'45000001'}),new Response('x'.repeat(128*1024+1))]);
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'ambiguous',code:'PROVIDER_RESPONSE_TOO_LARGE'});
  const g = fixture('facebook',[json({id:'45000001'}),new Response('not-json')]);
  assert.deepEqual(await g.adapter.publish(g.input),{outcome:'ambiguous',code:'PROVIDER_RESPONSE_INVALID'});
});

test('unresponsive graph and public asset transports time out without hanging',async () => {
  const f = fixture('facebook',[json({id:'45000001'}),() => new Promise(() => {})]);
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'ambiguous',code:'PROVIDER_TIMEOUT'});
  const g = fixture('instagram',[],{dependencies:{assetFetchImpl:() => new Promise(() => {})}});
  assert.equal((await g.adapter.publish(g.input)).code,'PUBLIC_ASSET_TIMEOUT');
  assert.equal(g.calls.length,0);
});

test('read-only reconciliation never auto-republishes or invents an ID',async () => {
  const f = fixture('instagram',[json({status_code:'PUBLISHED'})]);
  f.input.providerState={containerId:'180000001',stage:'publishing'};
  assert.deepEqual(await f.adapter.reconcile(f.input),{outcome:'ambiguous',code:'META_PUBLISHED_ID_UNRESOLVED'});
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].options.method,'GET'); assert.equal(f.assetCalls.length,0);
});

test('environment config is disabled by default, private-owner-only and never leaks secrets',async t => {
  const dir = await mkdtemp(join(tmpdir(),'meta-provider-')); t.after(() => rm(dir,{recursive:true,force:true}));
  const file = join(dir,'meta.json'), link = join(dir,'link.json'), f = fixture();
  await writeFile(file,JSON.stringify(f.config),{mode:0o600});
  assert.equal(createMetaPublishingAdapterFromEnv({env:{}}).enabled,false);
  const env = {SOCIAL_SAAS_META_ENABLED:'true',SOCIAL_SAAS_META_CONFIG_FILE:file};
  assert.equal(createMetaPublishingAdapterFromEnv({env,...f.dependencies}).enabled,true);
  await chmod(file,0o644);
  if (process.platform !== 'win32') assert.equal(createMetaPublishingAdapterFromEnv({env}).enabled,false);
  await chmod(file,0o600); await symlink(file,link);
  if (process.platform !== 'win32') assert.equal(createMetaPublishingAdapterFromEnv({env:{...env,SOCIAL_SAAS_META_CONFIG_FILE:link}}).enabled,false);
  await writeFile(file,'{ "accessToken": "'+TOKEN+'"');
  const disabled = createMetaPublishingAdapterFromEnv({env});
  assert.equal(disabled.enabled,false); assert.ok(!JSON.stringify(disabled).includes(TOKEN));
});

test('dynamic resolver is authoritative for existing bindings and tombstones, only undefined permits static fallback',async t => {
  for (const [name,resolver,expected] of [
    ['no prior row',() => undefined,true],['revoked tombstone',() => null,false],
    ['resolver error',() => {throw new Error(TOKEN);},false],['accidental async resolver',async () => undefined,false]
  ]) await t.test(name,() => {
    const f=fixture('instagram',[],{dependencies:{resolveConnection:resolver}});
    assert.equal(f.adapter.readiness(f.input).ready,expected);
    assert.ok(!JSON.stringify(f.adapter.readiness(f.input)).includes(TOKEN));
  });
});

test('dynamic verified credentials support empty static connections and canonical binding versions',() => {
  const baseline=fixture().config.connections[0];
  let binding={...baseline,connectionVersion:'authorization-1'};
  const f=fixture('instagram',[],{configure:c=>c.connections=[],dependencies:{resolveConnection:()=>binding}});
  assert.equal(f.adapter.validate(f.input).ready,true);
  const version=f.input.connectionVersion;
  binding=Object.fromEntries(Object.entries(binding).reverse());
  assert.equal(f.adapter.readiness(f.input).connectionVersion,version);
  binding={...binding,connectionVersion:'authorization-2'};
  assert.notEqual(f.adapter.readiness(f.input).connectionVersion,version);
  assert.equal(f.adapter.validate(f.input).code,'META_CONNECTION_CHANGED');
  binding={...binding,tenantId:'other-tenant'};
  assert.equal(f.adapter.readiness(f.input).ready,false);
});

test('disconnect while hosted-asset verification is awaiting prevents every Meta mutation',async () => {
  let binding={...fixture().config.connections[0],connectionVersion:'authorization-1'};
  const f=fixture('instagram',[],{dependencies:{resolveConnection:()=>binding,assetFetchImpl:async()=>{
    binding=null;
    return new Response(bytes,{headers:{'content-type':'image/jpeg'}});
  }}});
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'failed',code:'META_CONNECTION_MISSING'});
  assert.equal(f.calls.length,0);
});

test('reconnect while preparation is awaiting never sends another mutation using cached credentials',async () => {
  let binding={...fixture().config.connections[0],connectionVersion:'authorization-1'};
  const f=fixture('instagram',[()=>{
    binding={...binding,accessToken:TOKEN+'NEW',connectionVersion:'authorization-2'};
    return json({id:'180000001'});
  }],{dependencies:{resolveConnection:()=>binding}});
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'failed',code:'META_CONNECTION_CHANGED'});
  assert.equal(f.calls.length,1);assert.equal(f.checkpoints.at(-1).stage,'prepared');
});

test('disconnect immediately after publishing checkpoint prevents the final external POST',async () => {
  let binding={...fixture('facebook').config.connections[0],connectionVersion:'authorization-1'};
  const f=fixture('facebook',[json({id:'45000001'})],{dependencies:{resolveConnection:()=>binding}});
  f.input.saveProviderState=async state=>{f.checkpoints.push(state);if(state.stage==='publishing')binding=null;};
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'failed',code:'META_CONNECTION_MISSING'});
  assert.equal(f.calls.length,1);assert.equal(f.checkpoints.at(-1).stage,'publishing');
});

test('old auth error requests revocation only of original authorization, preserving concurrent reconnect',async () => {
  let binding={...fixture('facebook').config.connections[0],connectionVersion:'authorization-1'};
  const revocations=[];
  const f=fixture('facebook',[json({id:'45000001'}),()=>{
    binding={...binding,accessToken:TOKEN+'NEW',connectionVersion:'authorization-2'};
    return json({error:{code:190,message:TOKEN}},400);
  }],{dependencies:{resolveConnection:()=>binding,onConnectionRevoked:input=>{
    revocations.push(input);
    if (binding?.connectionVersion===input.connectionVersion) binding=null;
  }}});
  assert.deepEqual(await f.adapter.publish(f.input),{outcome:'failed',code:'META_AUTH_EXPIRED'});
  assert.equal(revocations.length,1);assert.equal(revocations[0].connectionVersion,'authorization-1');
  assert.equal(binding.connectionVersion,'authorization-2');assert.ok(!JSON.stringify(revocations).includes(TOKEN));
  assert.equal(f.adapter.readiness(f.input).ready,true);
  assert.notEqual(f.adapter.readiness(f.input).connectionVersion,f.input.connectionVersion);
});


test('private config cannot be in a repository dot-prefixed directory or hard-linked into the web root',async t => {
  const repository=new URL('../',import.meta.url).pathname;
  const dir=await mkdtemp(join(repository,'..private-meta-'));
  const external=await mkdtemp(join(new URL('../../',import.meta.url).pathname,'meta-private-outside-'));
  const webroot=await mkdtemp(join(repository,'public','meta-hardlink-'));
  t.after(async()=>{await Promise.all([dir,external,webroot].map(path=>rm(path,{recursive:true,force:true})));});
  const insideFile=join(dir,'config.json'), outsideFile=join(external,'config.json');
  const f=fixture();
  for(const file of [insideFile,outsideFile])await writeFile(file,JSON.stringify(f.config),{mode:0o600});
  const load=file=>createMetaPublishingAdapterFromEnv({env:{SOCIAL_SAAS_META_ENABLED:'true',SOCIAL_SAAS_META_CONFIG_FILE:file},...f.dependencies});
  assert.equal(load(insideFile).enabled,false);
  await link(outsideFile,join(webroot,'secret.json'));
  assert.equal(load(outsideFile).enabled,false);
});


test('app secret proof stays server-only and accompanies every real Graph request',async () => {
  const proof='a'.repeat(64);
  const f=fixture('instagram',[json({id:'180000001'}),json({status_code:'FINISHED'}),json({id:'179000001'})],{configure:c=>c.connections[0].appSecretProof=proof});
  assert.equal((await f.adapter.publish(f.input)).outcome,'published');
  for (const request of f.calls) assert.equal(request.parameters.appsecret_proof,proof);
  assert.ok(!JSON.stringify(f.adapter).includes(proof));
  assert.ok(!JSON.stringify(f.adapter.readiness(f.input)).includes(proof));
  assert.throws(()=>fixture('instagram',[],{configure:c=>c.connections[0].appSecretProof='invalid-proof'}),/META_CONFIG_INVALID/);
});
