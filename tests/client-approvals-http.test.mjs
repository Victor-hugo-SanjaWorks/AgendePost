import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { publicationFixture } from './qa-publication-helpers.mjs';
import { Client } from './qa-helpers.mjs';
import { domPage } from './qa-dom.mjs';

// Real application HTML, registered assets, navigation, CSRF and SQLite APIs.
// The publication adapter and every request remain entirely offline/loopback.
test('client approval full-app DOM: editor navigation, scoped one-time link, external decision and automatic queue',async t=>{
 const h=await publicationFixture(t),post=await h.approve(await h.post());
 const page=await domPage(h,t);await page.login(h.people.editor);
 assert.ok(page.$('a[href="#/app/approvals"]'),'Dedicated approvals navigation is present');
 await page.navigate('/app/approvals','[data-approval-action="new"]');
 assert.match(page.text(),/Aprovações/);assert.match(page.text(),new RegExp(h.workspace.name));
 assert.match(page.text(),/outra pessoa autorizada precisa aprovar/);
 page.click('[data-approval-action="new"]');await page.wait(()=>page.$('[data-approval-form="create"]'),'create dialog');
 page.change('[name="postId"]',post.id);
 const plannedLocal=new Date(h.now()+7200000).toISOString().slice(0,16);
 page.fill('[name="scheduledTimezone"]','UTC');page.fill('[name="date"]',plannedLocal);
 assert.equal(page.$('[name="offset"]').value,'+00:00');
 assert.equal(page.document.querySelectorAll('[name="channelIds"]:checked').length,2);
 page.$('[name="confirm"]').checked=true;
 const submit=page.$('[data-approval-form="create"] button[type="submit"]');submit.click();submit.click();
 await page.wait(()=>page.$('.client-approval-link'),'one-time approval link');
 const url=new URL(page.$('.client-approval-link').value);assert.equal(url.origin,h.app.ctx.config.canonicalOrigin);assert.equal(url.pathname,'/approval.html');assert.match(url.hash,/^#[A-Za-z0-9_-]{43}$/);
 const raw=url.hash.slice(1),rows=h.db.prepare('SELECT * FROM client_approval_requests').all();assert.equal(rows.length,1);const row=rows[0];
 assert.equal(row.tenant_id,h.tenant.id);assert.equal(row.workspace_id,h.workspace.id);assert.equal(row.post_id,post.id);assert.equal(row.revision,post.revision);assert.equal(row.requester_id,h.people.editor.user.id);assert.equal(row.status,'pending');assert.equal(row.scheduled_at,plannedLocal+':00.000Z');assert.equal(row.scheduled_timezone,'UTC');
 assert.deepEqual(JSON.parse(row.channel_ids_json).sort(),h.channels.map(c=>c.id).sort());assert.equal(row.token_hash,createHash('sha256').update(raw).digest('hex'));assert.ok(!JSON.stringify(row).includes(raw));assert.equal((await h.jobs(post)).length,0);
 assert.equal(page.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/client-approvals')).length,1);
 const client=new Client(h),headers={authorization:'Bearer '+raw},view=await client.ok('GET','/api/v1/client-approval',undefined,{headers});
 assert.equal(view.preview.caption,post.caption);assert.equal(view.scheduledAt,row.scheduled_at);
 const decision=await client.ok('POST','/api/v1/client-approval/decision',{expectedVersion:view.version,challenge:view.challenge,decision:'approve'},{headers});assert.equal(decision.status,'approved');assert.equal(decision.scheduling.status,'scheduled');
 const jobs=await h.jobs(post);assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.status==='scheduled'&&j.revision===post.revision&&j.scheduledAt===row.scheduled_at));assert.equal(h.adapter.calls.length,0);
 page.click('.client-approval-dialog [data-approval-action="close"]');assert.equal(page.$('.client-approval-link'),null);
 page.click('[data-approval-action="refresh"]');await page.wait(()=>page.text().includes('Cliente aprovou'),'real API decision in internal tab');assert.match(page.text(),/Incluído na fila/);assert.ok(page.$('a[href="#/app/publishing"]'));assert.equal(page.errors.length,0);
 assert.equal(page.window.localStorage.length,0);assert.equal(page.window.sessionStorage.length,0);
});
