import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { domPage } from './qa-dom.mjs';
import { idempotency, route } from './qa-helpers.mjs';
import { publicationFixture, offlinePublicationAdapter } from './qa-publication-helpers.mjs';

// These synthetic credentials are consumed only by the injected, offline Graph stub.
const USER_TOKEN='DOM_SYNTHETIC_META_USER_TOKEN_NOT_REAL_012345';
const PAGE_TOKEN='DOM_SYNTHETIC_META_PAGE_TOKEN_NOT_REAL_543210';
const permissions=['pages_show_list','pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish','ads_read'];
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
async function fixture(t){
 const origin='https://127.0.0.1:8787',calls=[],adapter=offlinePublicationAdapter();adapter.enabled=false;
 let h;
 const page={id:'308001',name:'Offline UI Meta Page',access_token:PAGE_TOKEN,tasks:['CREATE_CONTENT'],instagram_business_account:{id:'408001',username:'offline_ui_professional',account_type:'BUSINESS'}};
 const metaOAuthFetch=async(raw,options)=>{
  const url=new URL(raw),path=url.pathname.replace('/v26.0/','');calls.push(path);
  assert.equal(url.origin,'https://graph.facebook.com');assert.equal(options.redirect,'error');
  if(path==='oauth/access_token')return json({access_token:USER_TOKEN,expires_in:7200});
  if(path==='debug_token')return json({data:{is_valid:true,app_id:'108001',type:url.searchParams.get('input_token')===PAGE_TOKEN?'PAGE':'USER',user_id:'208001',scopes:permissions,expires_at:Math.floor(h.now()/1000)+7200,data_access_expires_at:Math.floor(h.now()/1000)+7200}});
  if(path==='me/permissions')return json({data:permissions.map(permission=>({permission,status:'granted'}))});
  if(path==='me')return json(options.headers.authorization===`Bearer ${PAGE_TOKEN}`?{id:page.id,name:page.name,instagram_business_account:page.instagram_business_account}:{id:'208001'});
  if(path==='208001/accounts')return json({data:[page]});
  throw new Error('Unexpected offline Graph path: '+path);
 };
 h=await publicationFixture(t,{publishingAdapter:adapter,canonicalOrigin:origin,metaOAuthConfig:{enabled:true,apiVersion:'v26.0',appId:'108001',appSecret:'b'.repeat(32),redirectUri:origin+'/api/v1/social-connections/meta/callback',encryptionKey:Buffer.alloc(32,9)},metaOAuthFetch});
 const other=await h.people.owner.client.ok('POST',`/api/v1/tenants/${h.tenant.id}/workspaces`,{name:'OAuth UI second brand',channels:[{platform:'instagram',label:'Second brand professional account'}]},idempotency());
 const channel=(await h.people.owner.client.ok('GET',route(h.tenant,other,'/channels')))[0];
 return {...h,other,channel,calls};
}

test('publication OAuth DOM: explicit access basis, protected return scope, destination confirmation and local disconnect',async t=>{
 const h=await fixture(t),page=await domPage(h,t);await page.login(h.people.owner);
 await page.navigate(`/app/connections/${h.tenant.id}/${h.workspace.id}`,'#meta-connection-manager');
 assert.equal(page.$('#brand-select').value,h.workspace.id,'Start on the other brand regardless of UUID list ordering');
 const priorManager=page.$('#meta-connection-manager');
 page.change('#brand-select',h.other.id);
 await page.wait(()=>page.$('#meta-connection-manager')!==priorManager&&page.$('#brand-select')?.value===h.other.id&&page.$(`[data-publishing-action="connect"][data-channel-id="${h.channel.id}"]`),'newly rendered second brand connections');
 assert.match(page.text(),/Publicação automática indisponível/,'OAuth configuration is distinct from publication readiness');
 const connect=`[data-publishing-action="connect"][data-channel-id="${h.channel.id}"]`;
 assert.equal(page.$(connect).disabled,false);
 page.click(connect);await page.wait(()=>page.$('#publication-connect-form'),'start authorization form');
 assert.equal(page.$('#meta-access-basis').value,'','Business Manager scope cannot be silently selected');
 const initialStarts=page.requests.filter(r=>r.path.endsWith('/meta/start')).length;
 page.click('#publication-connect-form button[type="submit"]');
 assert.equal(page.requests.filter(r=>r.path.endsWith('/meta/start')).length,initialStarts,'Incomplete access-basis selection must not start OAuth');
 page.change('#meta-access-basis','business_manager');page.click('#publication-connect-form button[type="submit"]');
 await page.wait(()=>page.$('#meta-authorization-link'),'official provider link');
 const authorization=new URL(page.$('#meta-authorization-link').href);
 assert.equal(authorization.origin,'https://www.facebook.com');assert.ok(authorization.pathname.endsWith('/dialog/oauth'));
 assert.ok(authorization.searchParams.get('scope').split(',').includes('ads_read'));
 assert.doesNotMatch(authorization.href,/client_secret|access_token/);
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM social_connections').get().n,0,'Preparing authorization does not connect a destination');
 assert.equal(h.calls.length,0,'Preparing the browser handoff does not contact Graph');
 const callback=await page.window.fetch('/api/v1/social-connections/meta/callback?state='+encodeURIComponent(authorization.searchParams.get('state'))+'&code=DOM_SYNTHETIC_AUTH_CODE');
 assert.equal(callback.status,302);const returnUrl=new URL(callback.headers.get('location'),h.app.ctx.config.canonicalOrigin);
 assert.equal(returnUrl.hash,`#/app/connections/${h.tenant.id}/${h.other.id}`);
 assert.doesNotMatch(returnUrl.href,/code=|state=|token|secret/);
 const returned=await domPage(h,t,{hash:returnUrl.hash.slice(1),jar:page.jar});
 await returned.wait(()=>returned.$('[data-publishing-action="select-destination"]'),'pending account selection after full page return');
 assert.equal(returned.$('#brand-select').value,h.other.id,'OAuth callback must restore its exact authorized brand');
 assert.equal(returned.window.location.hash,'#/app/connections','Callback routing identifiers are cleaned after verified restoration');
 returned.click('[data-publishing-action="select-destination"]');await returned.wait(()=>returned.$('#publication-destination-form'),'destination form');
 assert.equal(returned.$('#meta-destination').value,'','No remote account is silently preselected');
 returned.click('#publication-destination-form button[type="submit"]');
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM social_connections').get().n,0);
 returned.change('#meta-destination','408001');
 assert.match(returned.$('#meta-destination-preview').textContent,/408001/);
 returned.click('#publication-destination-form button[type="submit"]');
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM social_connections').get().n,0,'Explicit destination confirmation is required');
 returned.$('input[name="confirmDestination"]').checked=true;
 returned.click('#publication-destination-form button[type="submit"]');
 await returned.wait(()=>!returned.$('#publication-destination-form')&&returned.text().includes('Autorização conectada'),'server-confirmed connection');
 const connection=h.db.prepare('SELECT * FROM social_connections WHERE channel_id=?').get(h.channel.id);
 assert.equal(connection.workspace_id,h.other.id);assert.equal(connection.account_id,'408001');assert.equal(connection.status,'active');
 assert.match(returned.text(),/Publicação automática indisponível/,'An authorized account alone cannot imply publication readiness');
 assert.equal(h.db.prepare('SELECT count(*) AS n FROM publication_jobs').get().n,0);
 assert.ok(!returned.document.documentElement.outerHTML.includes(USER_TOKEN));assert.ok(!returned.document.documentElement.outerHTML.includes(PAGE_TOKEN));
 assert.equal(returned.$('input[type="password"]'),null);
 returned.click(`[data-publishing-action="disconnect"][data-connection-id="${connection.id}"]`);
 await returned.wait(()=>returned.$('#publication-disconnect-form'),'local-disconnect confirmation');
 assert.match(returned.$('#publication-disconnect-form').textContent,/envio já iniciado pode concluir/);
 assert.match(returned.$('#publication-disconnect-form').textContent,/outras marcas e canais/);
 returned.click('#publication-disconnect-form button[type="submit"]');
 await returned.wait(()=>!returned.$('#publication-disconnect-form')&&returned.text().includes('Desconectado'),'verified local disconnect');
 const disconnected=h.db.prepare('SELECT * FROM social_connections WHERE id=?').get(connection.id);
 assert.equal(disconnected.status,'disconnected');assert.equal(disconnected.encrypted_payload,null);
 assert.equal(page.errors.length,0);assert.equal(returned.errors.length,0);
});

test('publication OAuth DOM: return deep link survives sign-in and inaccessible brand never falls back silently',async t=>{
 const h=await fixture(t),deep=`/app/connections/${h.tenant.id}/${h.other.id}`;
 const page=await domPage(h,t,{hash:deep});await page.login(h.people.owner);
 await page.wait(()=>page.$('#meta-connection-manager'),'connection page after sign-in');
 assert.equal(page.$('#brand-select').value,h.other.id);assert.equal(page.window.location.hash,'#/app/connections');
 const denied=await domPage(h,t,{hash:`/app/connections/${h.tenant.id}/${randomUUID()}`,jar:page.jar});
 await denied.wait(()=>denied.$('.forbidden'),'invalid callback brand denied');
 assert.match(denied.text(),/marca desta autorização não está disponível/);
 assert.equal(denied.$('#meta-connection-manager'),null);
 const tenantDenied=await domPage(h,t,{hash:`/app/connections/${randomUUID()}/${h.other.id}`,jar:page.jar});
 await tenantDenied.wait(()=>tenantDenied.$('.forbidden'),'invalid callback organization denied');
 assert.match(tenantDenied.text(),/não tem acesso à organização/);
 assert.equal(tenantDenied.$('#meta-connection-manager'),null);
 assert.equal(page.errors.length,0);assert.equal(denied.errors.length,0);assert.equal(tenantDenied.errors.length,0);
});

test('publication OAuth DOM: unchanged context selections cannot discard an opened authorization form',async t=>{
 const h=await fixture(t),page=await domPage(h,t,{hash:`/app/connections/${h.tenant.id}/${h.other.id}`});await page.login(h.people.owner);
 await page.wait(()=>page.$('#meta-connection-manager'),'verified target brand connections');
 assert.equal(page.$('#brand-select').value,h.other.id);
 page.click(`[data-publishing-action="connect"][data-channel-id="${h.channel.id}"]`);
 await page.wait(()=>page.$('#publication-connect-form'),'authorization form');
 page.change('#meta-access-basis','business_manager');
 const requestCount=page.requests.length;
 // Redundant notifications can come from integrations/accessibility tooling. They
 // must not trigger a context refresh or discard a form when the value is unchanged.
 page.change('#brand-select',h.other.id);
 assert.ok(page.$('#publication-connect-form'),'An unchanged brand must preserve the open form');
 page.change('#tenant-select',h.tenant.id);
 assert.ok(page.$('#publication-connect-form'),'An unchanged organization must preserve the open form');
 assert.equal(page.$('#meta-access-basis').value,'business_manager');
 await new Promise(resolve=>setTimeout(resolve,40));
 assert.equal(page.requests.length,requestCount,'Unchanged context must not refetch session, brand or readiness');
 assert.equal(page.$('#brand-select').value,h.other.id);
 assert.equal(page.errors.length,0);
});
