import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, verified, route, idempotency } from './qa-helpers.mjs';

const NOW='2026-10-14T12:00:00.000Z';
async function fixture(t) {
  const h=await harness(t,{clock:()=>NOW}),owner=await verified(h,'strategy-owner');
  const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Strategy fixture',timezone:'UTC'},idempotency());
  const brand=await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/workspaces`,{name:'Strategy brand',channels:[{label:'Instagram target',platform:'instagram'},{label:'LinkedIn target',platform:'linkedin'}]},idempotency());
  const path=suffix=>route(tenant,brand,'/strategy'+suffix);
  return {h,owner,tenant,brand,path};
}
test('strategy dashboard is zero based, period scoped and transparent about editorial origin',async t=>{
  const {h,owner,tenant,brand,path}=await fixture(t);
  const empty=await owner.client.ok('GET',path('/dashboard'));
  assert.equal(empty.metrics.totalPosts,0);assert.equal(empty.metrics.approvalRate,null);assert.equal(empty.socialMetrics,null);
  assert.deepEqual(empty.derivedEntries,[]);assert.deepEqual(empty.entries,[]);assert.deepEqual(empty.competitors,[]);
  assert.equal(empty.metrics.trend.length,30);assert.equal(empty.methodology.externalDataFetched,false);
  const channels=await owner.client.ok('GET',route(tenant,brand,'/channels'));
  await owner.client.ok('POST',route(tenant,brand,'/posts'),{title:'Real incomplete draft'},idempotency());
  await owner.client.ok('POST',route(tenant,brand,'/posts'),{title:'Complete editorial draft',caption:'Caption',format:'carousel',channelIds:channels.map(c=>c.id)},idempotency());
  const dashboard=await owner.client.ok('GET',path('/dashboard?from=2026-10-14&to=2026-10-14'));
  assert.equal(dashboard.metrics.totalPosts,2);assert.equal(dashboard.metrics.counts.draft,2);
  assert.equal(dashboard.metrics.missingCaption,1);assert.equal(dashboard.metrics.missingChannels,1);
  assert.equal(dashboard.metrics.trend[0].count,2);assert.equal(dashboard.metrics.channelMix.length,2);
  assert.equal(dashboard.derivedEntries.length,3);assert.ok(dashboard.derivedEntries.every(e=>e.classification==='evidence'&&e.readOnly));
  assert.equal(dashboard.derivedEntries.filter(e=>['opportunity','threat'].includes(e.quadrant)).length,0);
  const previous=await owner.client.ok('GET',path('/dashboard?from=2026-10-01&to=2026-10-13'));assert.equal(previous.metrics.totalPosts,0);
  for(const query of ['from=2026-10-01','from=2026-02-30&to=2026-10-14','from=2024-01-01&to=2026-10-14','from=2026-10-15&to=2026-10-15'])assert.equal((await owner.client.request('GET',path('/dashboard?'+query))).status,422);
  assert.equal((await owner.client.ok('GET',`/api/v1/tenants/${tenant.id}/reports/editorial`)).totalPosts,2,'Legacy reports remain compatible');
  assert.equal(h.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('strategy persisted versioned CRUD preserves sources, archives and audit history',async t=>{
  const {h,owner,path}=await fixture(t);
  const payload={quadrant:'opportunity',title:'Test a focused format',classification:'hypothesis',description:'A testable possibility'};
  const key=idempotency();let entry=await owner.client.ok('POST',path('/entries'),payload,key);
  assert.equal((await owner.client.ok('POST',path('/entries'),payload,key)).id,entry.id);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM strategy_entries').get().n,1);
  assert.equal((await owner.client.request('POST',path('/entries'),payload)).status,422);
  assert.equal((await owner.client.request('PATCH',path('/entries/'+entry.id),{expectedVersion:1,classification:'evidence'})).status,422);
  entry=await owner.client.ok('PATCH',path('/entries/'+entry.id),{expectedVersion:1,classification:'evidence',sourceType:'public_source',sourceUrl:'https://example.com/research',observedOn:'2026-10-13',sourceNotes:'Team observed the source.'});
  assert.equal(entry.version,2);assert.equal(entry.verification,'user_entered');
  assert.equal((await owner.client.request('PATCH',path('/entries/'+entry.id),{expectedVersion:1,title:'Stale mutation'})).status,409);
  entry=await owner.client.ok('PATCH',path('/entries/'+entry.id),{expectedVersion:2,archived:true});assert.ok(entry.archivedAt);
  assert.deepEqual(await owner.client.ok('GET',path('/entries')),[]);
  assert.equal((await owner.client.ok('GET',path('/entries?archived=true'))).length,1);
  assert.equal((await owner.client.ok('GET',path('/dashboard?archived=all'))).entries.length,1);
  entry=await owner.client.ok('PATCH',path('/entries/'+entry.id),{expectedVersion:3,archived:false});assert.equal(entry.archivedAt,null);
  const history=await owner.client.request('GET',path('/entries/'+entry.id+'/revisions?limit=2'));
  assert.equal(history.data.length,2);assert.equal(history.data[0].snapshot.title,payload.title);assert.ok(history.json.meta.nextCursor);
  const next=await owner.client.ok('GET',path('/entries/'+entry.id+'/revisions?limit=2&cursor='+history.json.meta.nextCursor));assert.deepEqual(next.map(r=>r.version),[3,4]);
  const audits=h.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'strategy.entry.%' ORDER BY rowid").all().map(r=>r.action);
  assert.deepEqual(audits,['strategy.entry.created','strategy.entry.updated','strategy.entry.archived','strategy.entry.restored']);
});
test('competitor comparison uses sourced nullable observations and transparent frequency',async t=>{
  const {owner,path}=await fixture(t);
  const payload={name:'Reference company',platform:'instagram',sourceType:'public_source',sourceUrl:'https://example.com/profile',sourceNotes:'Counted by our team on public profile.',observedOn:'2026-10-12'};
  let competitor=await owner.client.ok('POST',path('/competitors'),payload,idempotency());
  assert.equal(competitor.followers,null);assert.equal(competitor.postsPerWeek,null);
  assert.equal((await owner.client.request('PATCH',path('/competitors/'+competitor.id),{expectedVersion:1,postsObserved:3})).status,422);
  competitor=await owner.client.ok('PATCH',path('/competitors/'+competitor.id),{expectedVersion:1,followers:0,postsObserved:6,observationDays:14});
  assert.equal(competitor.followers,0);assert.equal(competitor.postsPerWeek,3);
  assert.equal((await owner.client.ok('GET',path('/dashboard'))).competitors[0].postsPerWeek,3);
  competitor=await owner.client.ok('PATCH',path('/competitors/'+competitor.id),{expectedVersion:2,postsObserved:null,observationDays:null});assert.equal(competitor.postsPerWeek,null);
  assert.equal((await owner.client.ok('GET',path('/competitors/'+competitor.id+'/revisions'))).length,3);
});

test('strategy rows, snapshots and sources survive a complete application restart',async t=>{
  const {h,owner,path}=await fixture(t);
  const entry=await owner.client.ok('POST',path('/entries'),{quadrant:'threat',title:'Persisted hypothesis',classification:'hypothesis',sourceNotes:'Context retained after restart.'},idempotency());
  const competitor=await owner.client.ok('POST',path('/competitors'),{name:'Persisted reference',sourceType:'user_provided',observedOn:'2026-10-13',sourceNotes:'User-provided observation.',followers:0},idempotency());
  const migrationBefore=h.db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
  await h.app.close();
  const reopened=await harness(null,{dataDir:h.dataDir,clock:()=>NOW});
  try{
    owner.client.h=reopened;
    const dashboard=await owner.client.ok('GET',path('/dashboard'));
    assert.equal(dashboard.entries[0].id,entry.id);assert.equal(dashboard.entries[0].sourceNotes,'Context retained after restart.');
    assert.equal(dashboard.competitors[0].id,competitor.id);assert.equal(dashboard.competitors[0].followers,0);
    assert.equal((await owner.client.ok('GET',path('/entries/'+entry.id+'/revisions'))).length,1);
    assert.deepEqual(reopened.db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(),migrationBefore);
    assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await reopened.app.close();}
});

test('strategy composite scope and foreign keys prevent cross-tenant transplantation',async t=>{
  const {h,owner,tenant,brand,path}=await fixture(t);
  const entry=await owner.client.ok('POST',path('/entries'),{quadrant:'strength',title:'Only first tenant',classification:'hypothesis'},idempotency());
  const other=await owner.client.ok('POST','/api/v1/tenants',{name:'Other dashboard tenant',timezone:'UTC'},idempotency());
  const otherBrand=await owner.client.ok('POST',`/api/v1/tenants/${other.id}/workspaces`,{name:'Other dashboard brand'},idempotency());
  for(const suffix of ['/entries/'+entry.id,'/entries/'+entry.id+'/revisions'])assert.equal((await owner.client.request('GET',route(other,otherBrand,'/strategy'+suffix))).status,404);
  assert.equal((await owner.client.ok('GET',route(other,otherBrand,'/strategy/dashboard'))).entries.length,0);
  const wrongPath=route(other,brand,'/strategy/entries');
  assert.equal((await owner.client.request('POST',wrongPath,{quadrant:'threat',title:'Illegal move',classification:'hypothesis'},idempotency())).status,404);
  assert.throws(()=>h.db.prepare('UPDATE strategy_entries SET tenant_id=? WHERE tenant_id=? AND workspace_id=? AND id=?').run(other.id,tenant.id,brand.id,entry.id),/FOREIGN KEY/);
  assert.equal((await owner.client.ok('GET',path('/entries/'+entry.id))).title,'Only first tenant');
});
