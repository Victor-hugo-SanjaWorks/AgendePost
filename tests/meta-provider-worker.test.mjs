import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetaPublishingAdapter, META_API_VERSION } from '../src/publishing/providers/meta.mjs';
import { publicationFixture } from './qa-publication-helpers.mjs';

const TOKEN = 'FAKE_INTEGRATION_TEST_TOKEN_NEVER_REAL_1234567890';
const response = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','retry-after':'60'}});

async function actualAdapterFixture(t, responses) {
  const h = await publicationFixture(t), calls=[];
  const row = h.db.prepare('SELECT m.*,b.bytes FROM media m JOIN media_blobs b ON b.tenant_id=m.tenant_id AND b.workspace_id=m.workspace_id AND b.media_id=m.id WHERE m.id=?').get(h.media.id);
  const bytes = Buffer.from(row.bytes);
  const adapter = createMetaPublishingAdapter({ enabled:true,apiVersion:META_API_VERSION,requestTimeoutMs:1000,assetHosts:['assets.example.com'],
    connections:h.channels.map(channel => ({ tenantId:h.tenant.id,workspaceId:h.workspace.id,channelId:channel.id,platform:channel.platform,accountId:channel.platform==='instagram'?'17840000000000001':'12345678',linkedPageId:'12345678',tokenType:'page',accessToken:TOKEN,expiresAt:new Date(h.now()+3*86400000).toISOString(),verifiedAt:new Date(h.now()-60000).toISOString(),businessManagerGrant:false,permissions:['instagram_basic','instagram_content_publish','pages_read_engagement','pages_show_list','pages_manage_posts'],pageTasks:['CREATE_CONTENT'] })),
    assets:[{tenantId:h.tenant.id,workspaceId:h.workspace.id,digest:row.digest,url:`https://assets.example.com/${row.digest}.jpg`,expiresAt:new Date(h.now()+2*86400000).toISOString()}]
  },{
    clock:h.now,
    assetFetchImpl:async () => new Response(bytes,{headers:{'content-type':'image/jpeg'}}),
    fetchImpl:async (url,options) => {
      const call={url,options,parameters:Object.fromEntries(options.body||new URL(url).searchParams)};calls.push(call);
      if (new URL(url).pathname.endsWith('/feed') || new URL(url).pathname.endsWith('/media_publish')) {
        const job=h.db.prepare("SELECT * FROM publication_jobs WHERE status='sending'").get();
        assert.equal(JSON.parse(job.provider_state).stage,'publishing','irreversible request requires real durable publishing checkpoint');
      }
      const next=responses.shift();assert.ok(next,'unexpected real-adapter HTTP request in offline test');
      return next;
    }
  });
  // The service retains this fixture object, so replace only its methods with actual adapter logic.
  h.adapter.kind=adapter.kind;
  for (const method of ['readiness','validate','publish']) h.adapter[method]=adapter[method];
  return {...h,calls,realAdapter:adapter};
}

test('actual Meta adapter + durable worker safely commits rate retry and reuses staged FB photo',async t => {
  const h=await actualAdapterFixture(t,[response({id:'45000001'}),response({error:{code:4,message:TOKEN}},429),response({id:'12345678_99000001'})]);
  const post=await h.approve(await h.post()), facebook=h.channels.find(c=>c.platform==='facebook');
  const [job]=await h.scheduled(post,{channelIds:[facebook.id]});h.advance(60001);
  await h.app.ctx.services.publishing.worker.tick();
  let row=h.db.prepare('SELECT * FROM publication_jobs WHERE id=?').get(job.id);
  assert.equal(row.status,'retry_wait');assert.equal(row.error_code,'META_RATE_LIMIT');assert.equal(row.attempt_count,1);
  assert.deepEqual(JSON.parse(row.provider_state),{containerId:'45000001',stage:'ready'});
  assert.equal(h.calls.length,2);
  h.setTime(Date.parse(row.next_attempt_at)+1);await h.app.ctx.services.publishing.worker.tick();
  row=h.db.prepare('SELECT * FROM publication_jobs WHERE id=?').get(job.id);
  assert.equal(row.status,'published');assert.equal(row.remote_id,'12345678_99000001');assert.equal(row.attempt_count,2);
  assert.equal(h.calls.filter(c=>new URL(c.url).pathname.endsWith('/photos')).length,1);
  assert.equal(h.calls.filter(c=>new URL(c.url).pathname.endsWith('/feed')).length,2);
  assert.equal(h.calls.at(-1).parameters.message,post.caption);
  assert.ok(!JSON.stringify(await h.jobs(post)).includes(TOKEN));
});

test('actual Meta wrong-page response becomes needs_attention and worker never replays it',async t => {
  const h=await actualAdapterFixture(t,[response({id:'45000001'}),response({id:'99999999_99000001'})]);
  const post=await h.approve(await h.post()), facebook=h.channels.find(c=>c.platform==='facebook');
  const [job]=await h.scheduled(post,{channelIds:[facebook.id]});h.advance(60001);
  await h.app.ctx.services.publishing.worker.tick();
  const row=h.db.prepare('SELECT * FROM publication_jobs WHERE id=?').get(job.id);
  assert.equal(row.status,'needs_attention');assert.equal(row.remote_id,null);assert.equal(row.error_code,'PUBLISH_RESPONSE_ID_MISSING');
  assert.equal(JSON.parse(row.provider_state).stage,'publishing');
  h.advance(180000);await h.app.ctx.services.publishing.worker.tick();
  assert.equal(h.calls.length,2);assert.equal((await h.jobs(post))[0].status,'needs_attention');
});

test('actual Instagram processing state survives worker retry without another container creation',async t => {
  const h=await actualAdapterFixture(t,[response({id:'180000001'}),response({status_code:'IN_PROGRESS'}),response({status_code:'FINISHED'}),response({id:'179000001'})]);
  const post=await h.approve(await h.post()), instagram=h.channels.find(c=>c.platform==='instagram');
  const [job]=await h.scheduled(post,{channelIds:[instagram.id]});h.advance(60001);
  await h.app.ctx.services.publishing.worker.tick();
  let row=h.db.prepare('SELECT * FROM publication_jobs WHERE id=?').get(job.id);
  assert.equal(row.status,'retry_wait');assert.equal(row.remote_id,null);
  assert.deepEqual(JSON.parse(row.provider_state),{containerId:'180000001',stage:'processing'});
  h.setTime(Date.parse(row.next_attempt_at)+1);await h.app.ctx.services.publishing.worker.tick();
  row=h.db.prepare('SELECT * FROM publication_jobs WHERE id=?').get(job.id);
  assert.equal(row.status,'published');assert.equal(row.remote_id,'179000001');
  assert.equal(h.calls.filter(c=>new URL(c.url).pathname.endsWith('/media')).length,1);
  assert.equal(h.calls.filter(c=>new URL(c.url).pathname.endsWith('/media_publish')).length,1);
});
