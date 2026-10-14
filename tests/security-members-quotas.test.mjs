import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, verified, fixtureTeamPlan, invite, route, idempotency, assertDenied } from './qa-helpers.mjs';

test('security: invitation authority, last-seat accounting, expiry, token rotation and ownership races', async t => {
  let now = Date.now();
  const h=await harness(t,{clock:()=>new Date(now)});
  const owner=await verified(h,'membership-owner'), admin=await verified(h,'membership-admin'), coowner=await verified(h,'membership-coowner'), invitee=await verified(h,'membership-invitee');
  const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Membership QA',slug:'membership-qa',timezone:'UTC'},idempotency());
  fixtureTeamPlan(h,tenant.id);
  const workspace=await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/workspaces`,{name:'Membership brand'},idempotency());
  await invite(h,owner.client,tenant.id,admin,'admin');
  await invite(h,owner.client,tenant.id,coowner,'owner');
  await t.test('admins cannot invite or promote owner/admin, and invite tokens cannot cross identities',async()=>{
    for(const role of ['owner','admin']) assertDenied(await admin.client.request('POST',`/api/v1/tenants/${tenant.id}/invitations`,{email:invitee.email,role},idempotency()),403);
    const ownerMember=h.db.prepare('SELECT * FROM memberships WHERE tenant_id=? AND user_id=?').get(tenant.id,owner.user.id);
    assertDenied(await admin.client.request('PATCH',`/api/v1/tenants/${tenant.id}/members/${owner.user.id}`,{role:'editor',workspaceIds:[workspace.id],expectedVersion:ownerMember.version}),403);
    const invitation=await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/invitations`,{email:invitee.email,role:'reviewer',workspaceIds:[workspace.id]},idempotency());
    const token=h.messages.findLast(m=>m.to===invitee.email&&m.purpose==='invitation').token;
    assertDenied(await admin.client.request('POST','/api/v1/invitations/accept',{token}),422);
    const rows=await owner.client.ok('GET',`/api/v1/tenants/${tenant.id}/invitations`);
    assert.ok(!JSON.stringify(rows).includes(token));assert.ok(!JSON.stringify(rows).includes('token_hash'));
    now += 61 * 1000; // Respect the real invitation resend cooldown.
    await owner.client.ok('POST',`/api/v1/tenants/${tenant.id}/invitations/${invitation.id}/resend`,{},idempotency());
    const replacement=h.messages.findLast(m=>m.to===invitee.email&&m.purpose==='invitation').token;
    assert.notEqual(token,replacement);
    const invalid=await invitee.client.request('POST','/api/v1/invitations/accept',{token});assert.ok(invalid.status>=400&&invalid.status<500,invalid.body);
    const pair=await Promise.all([invitee.client.request('POST','/api/v1/invitations/accept',{token:replacement}),invitee.client.request('POST','/api/v1/invitations/accept',{token:replacement})]);
    assert.equal(pair.filter(r=>r.status>=200&&r.status<300).length,1,JSON.stringify(pair.map(r=>r.json)));
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM memberships WHERE tenant_id=? AND user_id=?').get(tenant.id,invitee.user.id).n,1);
  });
  await t.test('simultaneous owners cannot remove every owner',async()=>{
    const versions=new Map(h.db.prepare("SELECT user_id,version FROM memberships WHERE tenant_id=? AND role='owner'").all(tenant.id).map(row=>[row.user_id,row.version]));
    const pair=await Promise.all([
      owner.client.request('DELETE',`/api/v1/tenants/${tenant.id}/members/${coowner.user.id}`,{expectedVersion:versions.get(coowner.user.id)}),
      coowner.client.request('DELETE',`/api/v1/tenants/${tenant.id}/members/${owner.user.id}`,{expectedVersion:versions.get(owner.user.id)})
    ]);
    assert.equal(pair.filter(r=>r.status>=200&&r.status<300).length,1,JSON.stringify(pair.map(r=>r.json)));
    assert.equal(h.db.prepare("SELECT count(*) AS n FROM memberships WHERE tenant_id=? AND role='owner' AND status='active'").get(tenant.id).n,1);
  });
  const seatTenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Seat QA',slug:'seat-qa',timezone:'UTC'},idempotency());
  const seatBrand=await owner.client.ok('POST',`/api/v1/tenants/${seatTenant.id}/workspaces`,{name:'Seat brand'},idempotency());
  await t.test('valid pending invitations reserve seats, concurrent last seat yields one winner',async()=>{
    await owner.client.ok('POST',`/api/v1/tenants/${seatTenant.id}/invitations`,{email:'seat-first@example.test',role:'viewer',workspaceIds:[seatBrand.id]},idempotency());
    const pair=await Promise.all(['seat-second@example.test','seat-third@example.test'].map(email=>owner.client.request('POST',`/api/v1/tenants/${seatTenant.id}/invitations`,{email,role:'viewer',workspaceIds:[seatBrand.id]},idempotency())));
    assert.deepEqual(pair.map(r=>r.status>=200&&r.status<300?'success':r.status).sort(),[409,'success'].sort());
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM invitations WHERE tenant_id=? AND accepted_at IS NULL AND revoked_at IS NULL').get(seatTenant.id).n,2);
    const quota=await owner.client.ok('GET',`/api/v1/tenants/${seatTenant.id}/entitlements`);
    assert.ok(JSON.stringify(quota).includes('manual_trial'));
  });
  await t.test('expired invitations release seat count and cannot be accepted',async()=>{
    const expired=h.messages.findLast(m=>m.to==='seat-first@example.test'&&m.purpose==='invitation');
    now+=73*3600e3;
    await owner.client.login(owner.email);
    const next=await owner.client.ok('POST',`/api/v1/tenants/${seatTenant.id}/invitations`,{email:invitee.email,role:'viewer',workspaceIds:[seatBrand.id]},idempotency());assert.ok(next.id);
    await invitee.client.login(invitee.email);
    const expiredAttempt=await invitee.client.request('POST','/api/v1/invitations/accept',{token:expired.token});assert.ok(expiredAttempt.status>=400&&expiredAttempt.status<500,expiredAttempt.body);
    const reuseEmail=await owner.client.ok('POST',`/api/v1/tenants/${seatTenant.id}/invitations`,{email:'seat-first@example.test',role:'viewer',workspaceIds:[seatBrand.id]},idempotency());assert.ok(reuseEmail.id);
  });
});

test('security: workspace quotas and idempotency are transactional; over-limit downgrade preserves read/export',async t=>{
  const h=await harness(t),owner=await verified(h,'quota-owner');
  const tenant=await owner.client.ok('POST','/api/v1/tenants',{name:'Quota QA',slug:'quota-qa',timezone:'UTC'},idempotency());
  const path=`/api/v1/tenants/${tenant.id}/workspaces`;
  const first=await owner.client.ok('POST',path,{name:'First brand'},idempotency('same-workspace-key'));
  assert.equal((await owner.client.ok('POST',path,{name:'First brand'},idempotency('same-workspace-key'))).id,first.id);
  assertDenied(await owner.client.request('POST',path,{name:'Changed payload'},idempotency('same-workspace-key')),409);
  const pair=await Promise.all(['Second brand','Third brand'].map(name=>owner.client.request('POST',path,{name},idempotency())));
  assert.equal(pair.filter(r=>r.status>=200&&r.status<300).length,1);
  assert.equal(pair.filter(r=>r.status===409).length,1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM workspaces WHERE tenant_id=? AND archived_at IS NULL').get(tenant.id).n,2);
  fixtureTeamPlan(h,tenant.id);
  await owner.client.ok('POST',path,{name:'Above base plan'},idempotency());
  h.db.prepare("UPDATE tenant_entitlements SET plan_id='pilot_base',plan_version=1,version=version+1 WHERE tenant_id=?").run(tenant.id);
  assert.equal((await owner.client.ok('GET',path)).length,3);
  assertDenied(await owner.client.request('POST',path,{name:'Blocked fourth'},idempotency()),409);
  assert.equal((await owner.client.request('GET',`/api/v1/tenants/${tenant.id}/export/editorial`)).status,200);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM workspaces WHERE tenant_id=?').get(tenant.id).n,3);
});
