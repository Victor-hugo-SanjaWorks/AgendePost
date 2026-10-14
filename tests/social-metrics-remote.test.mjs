import test from 'node:test';
import assert from 'node:assert/strict';
import { metricsFixture } from './social-metrics-helpers.mjs';
import { OAUTH_FIXTURE } from './social-connections-helpers.mjs';
import { parseProviderTimestamp } from '../src/social-metrics/meta.mjs';
const isList=u=>/\/(?:published_posts|media)$/.test(u.pathname);
const metric=(p,key)=>p.metrics.find(m=>m.key===key);
function fbRow(f,id='70007'){return {id:`${OAUTH_FIXTURE.pageId}_${id}`,from:{id:OAUTH_FIXTURE.pageId},created_time:new Date(f.now()-60000).toISOString(),likes:{summary:{total_count:11}},comments:{summary:{total_count:2}},shares:{count:1},reactions:{summary:{total_count:12}},permalink_url:`https://www.facebook.com/${OAUTH_FIXTURE.pageId}/posts/${id}`};}
function igRow(f,id='90009'){return {id,owner:{id:OAUTH_FIXTURE.igId},timestamp:new Date(f.now()-120000).toISOString(),like_count:8,comments_count:0,permalink:`https://www.instagram.com/p/fixture_${id}/`};}

test('remote published posts and media appear without any local publishing record, with safe bounded coverage',async t=>{
 const f=await metricsFixture(t);for(const c of f.channels)await f.connect(c);f.configure();
 f.transport.setIntercept(u=>isList(u)?f.transport.respond({data:[{...(u.pathname.endsWith('/media')?igRow(f):fbRow(f)),caption:'PRIVATE_PROVIDER_CAPTION',message:'PRIVATE_PROVIDER_MESSAGE',access_token:'NO_STORE',comments:{data:[{from:{id:'PRIVATE_USER'}}],summary:{total_count:2}}}],paging:{next:'https://evil.example/next?access_token=NO_FETCH'}}):undefined);
 await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM publication_jobs').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,2);
 const view=f.summary();for(const a of view.accounts){assert.equal(a.posts.length,1);assert.equal(a.coverage.limit,25);assert.equal(a.coverage.pages,1);assert.equal(a.coverage.fullHistory,false);assert.equal(a.coverage.hasMore,true);assert.equal(a.coverage.returnedCount,1);assert.ok(a.posts[0].id.startsWith('remote:'));assert.equal(a.posts[0].status,'partial');}
 assert.equal(metric(view.accounts.find(a=>a.platform==='facebook').posts[0],'likes').value,11);assert.equal(metric(view.accounts.find(a=>a.platform==='instagram').posts[0],'comments').value,0);
 for(const call of f.transport.calls){const u=new URL(call.url);assert.equal(u.origin,'https://graph.facebook.com');assert.equal(call.options.method,'GET');assert.doesNotMatch(u.searchParams.get('fields')??'',/caption|message|media_url|children|username|profile_picture/);if(isList(u)){assert.equal(u.searchParams.get('limit'),'25');assert.equal(u.searchParams.has('after'),false);}}
 const stored=JSON.stringify({summary:view,rows:f.db.prepare('SELECT * FROM social_metrics_remote_posts').all(),discovery:f.db.prepare('SELECT * FROM social_metrics_discovery').all()});assert.doesNotMatch(stored,/PRIVATE_PROVIDER|PRIVATE_USER|NO_FETCH|NO_STORE|evil.example|access_token|SYNTHETIC_.*TOKEN/);
 const ids=view.accounts.flatMap(a=>a.posts.map(p=>p.id));assert.deepEqual(f.summary().accounts.flatMap(a=>a.posts.map(p=>p.id)),ids);
});
test('same remote publication is deduplicated against AgendePost history and collected once',async t=>{
 const f=await metricsFixture(t),fb=f.channels.find(c=>c.platform==='facebook');await f.connect(fb);const local=await f.published(fb);f.configure();f.transport.setIntercept(u=>isList(u)?f.transport.respond({data:[fbRow(f,'60006')]}):undefined);
 await f.service.tick();const a=f.summary().accounts.find(a=>a.platform==='facebook');assert.equal(a.posts.length,1);assert.equal(a.posts[0].id,local.id);assert.equal(metric(a.posts[0],'likes').value,11);assert.equal(f.transport.calls.length,3);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_posts').get().n,1);
});
test('remote batch cap is enforced and each successful first page replaces its bounded window',async t=>{
 const f=await metricsFixture(t);await f.connect();f.configure();let rows=Array.from({length:25},(_,i)=>fbRow(f,String(100000+i)));
 f.transport.setIntercept(u=>isList(u)?f.transport.respond({data:rows}):undefined);await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,25);assert.equal(f.summary().accounts.find(a=>a.platform==='facebook').coverage.hasMore,true);
 f.advance(15*60000);rows=[fbRow(f,'80008')];await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,1);
 const at=f.db.prepare('SELECT observed_at FROM social_metrics_discovery').get().observed_at;f.advance(15*60000);rows=Array.from({length:26},(_,i)=>fbRow(f,String(100000+i)));await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,1);assert.equal(f.db.prepare('SELECT observed_at FROM social_metrics_discovery').get().observed_at,at);assert.equal(f.summary().accounts.find(a=>a.platform==='facebook').posts[0].status,'stale');
});
test('foreign ownership, duplicates and invalid timestamps reject the entire remote batch',async t=>{
 for(const make of [f=>[{...fbRow(f),from:{id:'999999'}}],f=>[fbRow(f),fbRow(f)],f=>[{...fbRow(f),created_time:'not-a-date'}],f=>[{...fbRow(f),created_time:'2026-02-30T12:00:00Z'}],f=>[{...fbRow(f),id:'https://evil.example/path'}],f=>[{...fbRow(f),created_time:new Date(f.now()+86400000).toISOString()}]]){
  const f=await metricsFixture(t);await f.connect();f.configure();f.transport.setIntercept(u=>isList(u)?f.transport.respond({data:make(f)}):undefined);await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,0);assert.ok(['METRICS_IDENTITY_MISMATCH','METRICS_RESPONSE_INVALID'].includes(f.db.prepare('SELECT code FROM social_metrics_discovery').get().code));
 }
});
test('disconnect during discovery fences remote rows; reconnect removes persisted discovery and remote snapshots',async t=>{
 const f=await metricsFixture(t),connection=await f.connect();f.configure();let entered,release;const arrived=new Promise(r=>entered=r),pending=new Promise(r=>release=r);
 f.transport.setIntercept(async u=>{if(isList(u)){entered();await pending;return f.transport.respond({data:[fbRow(f)]});}});const tick=f.service.tick();await arrived;
 await f.owner.client.ok('POST',`${f.base}/${connection.id}/disconnect`,{expectedVersion:connection.version});release();await tick;assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_discovery').get().n,0);
 await f.connect();f.transport.setIntercept(u=>isList(u)?f.transport.respond({data:[fbRow(f)]}):undefined);await f.service.tick();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,1);await f.connect();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_remote_posts').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_metrics_discovery').get().n,0);
});
test('remote discovery permission rejection hides prior remote data and never requests new authorization',async t=>{
 const f=await metricsFixture(t);await f.connect();f.configure();f.transport.setIntercept(u=>isList(u)?f.transport.respond({data:[fbRow(f)]}):undefined);await f.service.tick();f.advance(15*60000);
 f.transport.setIntercept(u=>isList(u)?f.transport.respond({error:{code:200,message:'PRIVATE_PERMISSION_DETAILS'}},403):undefined);await f.service.tick();const a=f.summary().accounts.find(a=>a.platform==='facebook');assert.equal(a.status,'scope_missing');assert.equal(a.posts.length,0);assert.doesNotMatch(JSON.stringify(f.summary()),/PRIVATE_PERMISSION_DETAILS/);assert.ok(f.transport.calls.every(c=>c.options.method==='GET'));
});


test('provider timestamps reject impossible calendar dates and preserve valid offset/leap-day instants',()=>{
 const at='2026-10-14T12:00:00.000Z';
 for(const invalid of ['2026-02-30T12:00:00Z','2025-02-29T12:00:00Z','2026-04-31T12:00:00Z','2026-01-00T12:00:00Z','2026-13-01T12:00:00Z','2026-01-01T24:00:00Z','2026-01-01T12:60:00Z','2026-01-01T12:00:60Z','2026-01-01T12:00:00+2460','2026-01-01T12:00:00','2026-01-01T12:00:00Zjunk','2026-10-14T12:01:01Z'])assert.equal(parseProviderTimestamp(invalid,at),null,invalid);
 assert.equal(parseProviderTimestamp('2024-02-29T12:00:00+0000',at),'2024-02-29T12:00:00.000Z');
 assert.equal(parseProviderTimestamp('2026-10-14T09:00:00-03:00',at),at);
 assert.equal(parseProviderTimestamp('2026-10-14T12:00:00.12Z',at),'2026-10-14T12:00:00.120Z');
});
