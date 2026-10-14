import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.mjs';
import { issueOperatorAccess } from '../src/operator-access.mjs';
import { domPage } from './qa-dom.mjs';
async function hosted(t){
 const dataDir=await mkdtemp(join(tmpdir(),'agendepost-dom-'));
 const app=await createApp({mode:'test',deployment:'hosted-pilot',trustedProxy:'loopback',canonicalOrigin:'https://agendepost.example',dataDir});
 t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});return {app,db:app.ctx.db,dataDir};
}
test('hosted DOM: AgendePost has invite-only login and no open signup/recovery/dev inbox',async t=>{
 const h=await hosted(t),page=await domPage(h,t);
 await page.wait(()=>page.$('#login-form'),'hosted login');
 assert.match(page.text(),/AgendePost/);assert.match(page.text(),/pessoas convidadas/);assert.doesNotMatch(page.text(),/caixa de saída|dev:mail|desenvolvimento verificadas/);
 await page.navigate('/register','.notice');await page.wait(()=>page.text().includes('Acesso controlado'),'invite guidance');
 assert.equal(page.$('#register-form'),null);assert.doesNotMatch(page.text(),/dev:mail/);
 await page.navigate('/forgot','.auth-card');await page.wait(()=>page.text().includes('Recuperar seu acesso'),'recovery guidance');assert.equal(page.$('#forgot-form'),null);
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM users').get().n,0);
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,0);
 assert.equal(page.errors.length,0);
});
test('hosted DOM: privately issued enrollment becomes real login and organization without dev email',async t=>{
 const h=await hosted(t),email='hosted-owner@example.test',password='Strong hosted pilot passphrase 2026!';
 const link=issueOperatorAccess(h.app.ctx.config,{purpose:'enroll',email,displayName:'Pilot owner'});
 const page=await domPage(h,t,{hash:new URL(link.url).hash.slice(1)});
 await page.wait(()=>page.$('#token-form'),'hosted enrollment');assert.equal(page.$('#resend-form'),null);assert.doesNotMatch(page.text(),/dev:mail/);
 page.fill('#token-password',password);page.fill('#token-confirm',password);page.submit('#token-form');
 await page.wait(()=>page.$('#login-form'),'verified login');
 await page.login({email,password});page.fill('#tenant-name','Hostinger pilot');page.submit('#tenant-form');
 await page.wait(()=>page.$('#tenant-select')?.selectedOptions[0]?.textContent==='Hostinger pilot','created organization');
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM tenants').get().n,1);
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n,0);
 assert.equal(page.window.localStorage.length,0);assert.equal(page.errors.length,0);
});
