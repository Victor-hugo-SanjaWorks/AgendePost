import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { harness, verified, fixtureTeamPlan, invite, route, idempotency, multipart, assertDenied, Client } from './qa-helpers.mjs';

async function setup(t) {
  const h = await harness(t);
  const people = {};
  for (const role of ['owner','other','admin','editor','reviewer','viewer','brand2','platform']) people[role] = await verified(h, role);
  const a = await people.owner.client.ok('POST', '/api/v1/tenants', { name: 'QA tenant A', slug: 'qa-tenant-a', timezone: 'America/Sao_Paulo' }, idempotency());
  const b = await people.other.client.ok('POST', '/api/v1/tenants', { name: 'QA tenant B', slug: 'qa-tenant-b', timezone: 'UTC' }, idempotency());
  const c = await people.platform.client.ok('POST', '/api/v1/tenants', { name: 'QA tenant C', slug: 'qa-tenant-c', timezone: 'UTC' }, idempotency());
  fixtureTeamPlan(h, a.id);
  const a1 = await people.owner.client.ok('POST', `/api/v1/tenants/${a.id}/workspaces`, { name: 'A1 private brand', channels: [{ platform: 'instagram', label: 'A1 planning only' }] }, idempotency());
  const a2 = await people.owner.client.ok('POST', `/api/v1/tenants/${a.id}/workspaces`, { name: 'A2 private brand', channels: [{ platform: 'linkedin', label: 'A2 planning only' }] }, idempotency());
  const b1 = await people.other.client.ok('POST', `/api/v1/tenants/${b.id}/workspaces`, { name: 'B1 private brand', channels: [{ platform: 'instagram', label: 'B1 planning only' }] }, idempotency());
  for (const role of ['admin','editor','reviewer','viewer']) await invite(h, people.owner.client, a.id, people[role], role, role === 'admin' ? [] : [a1.id]);
  await invite(h, people.owner.client, a.id, people.brand2, 'editor', [a2.id]);
  await invite(h, people.other.client, b.id, people.editor, 'viewer', [b1.id]);
  h.db.prepare("INSERT INTO platform_admins(user_id,status,created_at) VALUES(?,'active',?)").run(people.platform.user.id, new Date().toISOString());
  const fixture = await sharp({ create: { width: 12, height: 9, channels: 3, background: '#ffcc33' } }).png().toBuffer();
  const media = {};
  for (const [key, identity, tenant, workspace] of [['a1',people.owner,a,a1],['a2',people.owner,a,a2],['b1',people.other,b,b1]]) {
    const form = multipart(fixture);
    media[key] = await identity.client.ok('POST', route(tenant, workspace, '/media'), form.payload, { headers: { ...form.headers, 'idempotency-key': randomUUID() } });
  }
  const channels = {};
  for (const [key, identity, tenant, workspace] of [['a1',people.owner,a,a1],['a2',people.owner,a,a2],['b1',people.other,b,b1]]) channels[key] = await identity.client.ok('GET', route(tenant, workspace, '/channels'));
  return { ...h, people, a, b, c, a1, a2, b1, media, channels };
}

test('security: three tenants, real role grants and exact-version editorial workflow', async t => {
  const h = await setup(t), { people:p, a,b,c,a1,a2,b1,media,channels } = h;
  let post;
  await t.test('RBAC matrix denies invisible tenants/brands and limits each role server-side', async () => {
    const a1path = route(a,a1), a2path = route(a,a2), b1path = route(b,b1);
    for (const role of ['owner','admin']) {
      assert.equal((await p[role].client.request('GET', a2path + '/posts')).status, 200);
      assert.equal((await p[role].client.request('GET', b1path + '/posts')).status, 404);
    }
    for (const role of ['editor','reviewer','viewer']) {
      assert.equal((await p[role].client.request('GET', a1path + '/posts')).status, 200);
      assertDenied(await p[role].client.request('GET', a2path + '/posts'));
      assertDenied(await p[role].client.request('GET', `/api/v1/tenants/${a.id}/members`), 403);
    }
    assert.equal((await p.editor.client.ok('GET', '/api/v1/me/tenants')).length, 2);
    assert.equal((await p.editor.client.request('GET', b1path + '/posts')).status, 200);
    assertDenied(await p.editor.client.request('POST', b1path + '/posts', { title: 'Viewer cannot create' }, idempotency()), 403);
    for (const role of ['reviewer','viewer']) assertDenied(await p[role].client.request('POST', a1path + '/posts', { title: 'Forbidden create' }, idempotency()), 403);
    assertDenied(await p.viewer.client.request('POST', a1path + '/channels', { platform:'instagram',label:'Forbidden channel' }, idempotency()), 403);
    assertDenied(await p.brand2.client.request('GET', a1path + '/media'));
    assertDenied(await p.platform.client.request('GET', a1path + '/posts'));
    assertDenied(await p.platform.client.request('GET', route(a,a1,`/media/${media.a1.id}/content`)));
    assertDenied(await p.owner.client.request('GET', '/api/v1/admin/tenants'), 403);
    assert.equal((await p.platform.client.request('GET', '/api/v1/admin/tenants')).status, 200);
    assertDenied(await p.owner.client.request('GET', `/api/v1/tenants/${c.id}`));
    const suppliedAuthority = await p.editor.client.request('POST', a1path + '/posts', { title:'Injected role', tenantId:b.id, authorId:p.owner.user.id, role:'owner',status:'approved' }, idempotency());
    assert.ok([400,422].includes(suppliedAuthority.status), suppliedAuthority.body);
    post = await p.editor.client.ok('POST', a1path + '/posts', { title:'Real editorial QA', caption:'First exact revision', mediaIds:[media.a1.id],channelIds:[channels.a1[0].id] }, idempotency());
    assert.equal(post.authorId,p.editor.user.id); assert.equal(post.revision,1); assert.equal(post.status,'draft');
  });
  await t.test('cross-tenant and same-tenant cross-brand references fail in HTTP and composite FKs', async () => {
    for (const foreign of [media.a2,media.b1]) {
      const result = await p.editor.client.request('PATCH', route(a,a1,`/posts/${post.id}`), { expectedRevision:post.revision,mediaIds:[foreign.id] });
      assert.ok([404,422].includes(result.status), result.body);
    }
    for (const foreign of [channels.a2[0],channels.b1[0]]) {
      const result = await p.editor.client.request('PATCH', route(a,a1,`/posts/${post.id}`), { expectedRevision:post.revision,channelIds:[foreign.id] });
      assert.ok([404,422].includes(result.status), result.body);
    }
    assert.throws(() => h.db.prepare('INSERT INTO post_media(tenant_id,workspace_id,post_id,media_id,position) VALUES(?,?,?,?,1)').run(a.id,a1.id,post.id,media.a2.id), /FOREIGN KEY/);
    assert.throws(() => h.db.prepare('INSERT INTO post_channels(tenant_id,workspace_id,post_id,channel_id,position) VALUES(?,?,?,?,1)').run(a.id,a1.id,post.id,channels.b1[0].id), /FOREIGN KEY/);
    assert.throws(() => h.db.prepare('INSERT INTO workspace_grants(tenant_id,workspace_id,user_id) VALUES(?,?,?)').run(a.id,b1.id,p.viewer.user.id), /FOREIGN KEY/);
    assert.throws(() => h.db.prepare('INSERT INTO media_blobs(tenant_id,workspace_id,media_id,bytes) VALUES(?,?,?,?)').run(null,a1.id,media.a1.id,Buffer.from('x')), /NOT NULL/);
    assertDenied(await p.owner.client.request('GET', route(a,a1,`/posts/${randomUUID()}`)));
    assertDenied(await p.other.client.request('GET', route(a,a1,`/posts/${post.id}`)));
  });
  await t.test('stale concurrent edits give one winner and reviewers cannot edit captions', async () => {
    const pair = await Promise.all(['winner-a','winner-b'].map(title => p.editor.client.request('PATCH', route(a,a1,`/posts/${post.id}`),{expectedRevision:post.revision,title})));
    assert.deepEqual(pair.map(r=>r.status).sort(),[200,409]);
    post = pair.find(r=>r.status===200).data;
    assert.equal(post.revision,2);
    assertDenied(await p.reviewer.client.request('PATCH',route(a,a1,`/posts/${post.id}`),{expectedRevision:post.revision,caption:'Reviewer cannot write'}),403);
  });
  await t.test('changes requests, independent reviewer approval and scheduling target exact revision', async () => {
    const transition = (identity,action,extra={}) => identity.client.request('POST',route(a,a1,`/posts/${post.id}/transitions`),{action,expectedRevision:post.revision,...extra},idempotency());
    post = (await transition(p.editor,'submit_review')).data;
    assertDenied(await transition(p.editor,'approve'),403);
    assertDenied(await transition(p.viewer,'request_changes',{reason:'Viewer cannot review'}),403);
    post = (await transition(p.reviewer,'request_changes',{reason:'Need a second sentence'})).data;
    assert.equal(post.status,'changes_requested');
    post = await p.editor.client.ok('PATCH',route(a,a1,`/posts/${post.id}`),{expectedRevision:post.revision,caption:'Revised exact content'});
    assert.equal(post.status,'draft');
    post = (await transition(p.editor,'submit_review')).data;
    post = (await transition(p.reviewer,'approve')).data;
    assert.equal(post.status,'approved'); assert.equal(post.approvedRevision,post.revision);
    const badDate = await transition(p.editor,'plan',{scheduledAt:'2026-12-03T10:00:00',scheduledTimezone:'America/Sao_Paulo'});
    assert.ok([400,422].includes(badDate.status),badDate.body);
    post = (await transition(p.editor,'plan',{scheduledAt:'2026-12-03T10:00:00-03:00',scheduledTimezone:'America/Sao_Paulo'})).data;
    assert.equal(post.status,'planned'); assert.equal(post.scheduledAt,'2026-12-03T13:00:00.000Z');
    const oldRevision=post.revision;
    post = await p.editor.client.ok('PATCH',route(a,a1,`/posts/${post.id}`),{expectedRevision:post.revision,caption:'Changed after approval'});
    assert.equal(post.status,'draft'); assert.equal(post.approvedRevision,null); assert.ok(post.revision>oldRevision);
    assertDenied(await p.reviewer.client.request('POST',route(a,a1,`/posts/${post.id}/transitions`),{action:'approve',expectedRevision:oldRevision},idempotency()),409);
    const invalidPlan=await transition(p.editor,'plan',{scheduledAt:'2026-12-03T10:00:00-03:00',scheduledTimezone:'America/Sao_Paulo'});
    assert.equal(invalidPlan.status,409,invalidPlan.body);
    const own=await p.owner.client.ok('POST',route(a,a1,'/posts'),{title:'Owner cannot self-approve'},idempotency());
    await p.owner.client.ok('POST',route(a,a1,`/posts/${own.id}/transitions`),{action:'submit_review',expectedRevision:own.revision},idempotency());
    assertDenied(await p.owner.client.request('POST',route(a,a1,`/posts/${own.id}/transitions`),{action:'approve',expectedRevision:own.revision},idempotency()),403);
  });
  await t.test('comments use authenticated author, reports and export filter scope, audit avoids content', async () => {
    const attack=await p.reviewer.client.request('POST',route(a,a1,`/posts/${post.id}/comments`),{body:'Forged author',authorId:p.owner.user.id},idempotency());
    assert.ok([400,422].includes(attack.status));
    const marker='<img src=x onerror="window.qaXss=true">';
    const comment=await p.reviewer.client.ok('POST',route(a,a1,`/posts/${post.id}/comments`),{body:marker},idempotency());
    assert.equal(comment.authorId,p.reviewer.user.id); assert.equal(comment.body,marker);
    assertDenied(await p.viewer.client.request('POST',route(a,a1,`/posts/${post.id}/comments`),{body:'Viewer no comments'},idempotency()),403);
    const report=await p.editor.client.ok('GET',`/api/v1/tenants/${a.id}/reports/editorial`);
    assert.equal(report.source,'editorial-only'); assert.ok(!JSON.stringify(report).includes(a2.id));
    assertDenied(await p.editor.client.request('GET',`/api/v1/tenants/${a.id}/export/editorial`),403);
    const exported=await p.owner.client.request('GET',`/api/v1/tenants/${a.id}/export/editorial`);
    assert.equal(exported.status,200); assert.doesNotMatch(exported.body,/password_hash|token_hash|csrf_token|billing_customers|B1 private brand/);
    const audit=JSON.stringify(h.db.prepare('SELECT * FROM audit_events').all());
    assert.ok(!audit.includes(marker)); assert.ok(!audit.includes('Changed after approval')); assert.ok(!audit.includes(p.owner.password));
    assert.ok(!h.messages.some(message=>audit.includes(message.token)));
    assert.throws(()=>h.db.prepare("UPDATE audit_events SET outcome='denied'").run(),/append-only/);
  });
  await t.test('idempotent duplicate strips approvals and history-referenced images cannot be deleted', async () => {
    const key=idempotency('duplicate-post-once');
    const first=await p.editor.client.ok('POST',route(a,a1,`/posts/${post.id}/duplicate`),{},key);
    const second=await p.editor.client.ok('POST',route(a,a1,`/posts/${post.id}/duplicate`),{},key);
    assert.equal(first.id,second.id); assert.notEqual(first.id,post.id); assert.equal(first.status,'draft');assert.equal(first.approvedRevision,null);
    assert.equal(first.scheduledAt,null);
    post=await p.editor.client.ok('PATCH',route(a,a1,`/posts/${post.id}`),{expectedRevision:post.revision,mediaIds:[]});
    assertDenied(await p.owner.client.request('DELETE',route(a,a1,`/media/${media.a1.id}`)),409);
    assert.ok(h.db.prepare('SELECT count(*) AS n FROM post_revision_media WHERE media_id=?').get(media.a1.id).n>0);
  });
  await t.test('revoking grants and memberships changes next request including already-known media URL', async () => {
    assert.equal((await p.viewer.client.request('GET',route(a,a1,`/media/${media.a1.id}/content`))).status,200);
    let membership=h.db.prepare('SELECT * FROM memberships WHERE tenant_id=? AND user_id=?').get(a.id,p.viewer.user.id);
    await p.owner.client.ok('PATCH',`/api/v1/tenants/${a.id}/members/${p.viewer.user.id}`,{workspaceIds:[a2.id],expectedVersion:membership.version});
    assertDenied(await p.viewer.client.request('GET',route(a,a1,`/media/${media.a1.id}/content`)));
    assert.equal((await p.viewer.client.request('GET',route(a,a2,'/posts'))).status,200);
    membership=h.db.prepare('SELECT * FROM memberships WHERE tenant_id=? AND user_id=?').get(a.id,p.viewer.user.id);
    await p.owner.client.ok('DELETE',`/api/v1/tenants/${a.id}/members/${p.viewer.user.id}`,{expectedVersion:membership.version});
    assertDenied(await p.viewer.client.request('GET',route(a,a2,'/posts')));
    assertDenied(await new Client(h).request('GET',route(a,a1,`/media/${media.a1.id}/content`)),401);
  });
});
