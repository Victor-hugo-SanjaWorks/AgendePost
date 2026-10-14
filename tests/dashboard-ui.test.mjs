import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const renderer=await readFile(new URL('../public/social-results.js',import.meta.url),'utf8');
const viewer=await readFile(new URL('../public/client-dashboard.js',import.meta.url),'utf8');
const TOKEN='a'.repeat(43),ORIGIN='https://agendepost.example';
const sharedURL=ORIGIN+'/client-dashboard#token='+TOKEN;
const dto=(overrides={})=>({brand:{name:'Marca de teste'},generatedAt:'2026-10-14T12:00:00.000Z',lastSyncedAt:null,stale:false,collection:{enabled:false,status:'disabled'},accounts:[],posts:[],management:{canManage:true,canConfigureMetrics:true,metricsSettings:{enabled:false,version:1,cadenceMinutes:15}},...overrides});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function eventually(check,label='condition'){for(let i=0;i<100;i++){if(check())return;await tick();}throw new Error('Not reached: '+label);}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function dom(t,url=ORIGIN+'/app#/app/social-results'){
  const d=new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>',{url,pretendToBeVisual:true,runScripts:'outside-only'});
  const w=d.window;w.eval(renderer);w.HTMLElement.prototype.scrollIntoView=()=>{};t.after(()=>{w.SocialResults.cleanup();w.close();});return w;
}
function formSubmit(w,form){form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));}
async function internal(t,{data=dto(),apiOverride,canManage=true}={}){
  const w=dom(t),calls=[],shares=[],basePath='/tenants/tenant/workspaces/workspace';
  const api=async(path,options={})=>{
    calls.push({path,...options});const custom=apiOverride?.(path,options);if(custom!==undefined)return custom;
    if(path.endsWith('/client-dashboard'))return {data};
    if(path.endsWith('/dashboard-shares')&&options.method==='POST'){const row={id:'share-id',label:options.body.label,createdAt:'2026-10-14T12:00:00.000Z',expiresAt:'2099-11-14T12:00:00.000Z',revokedAt:null,version:1};shares.push(row);return {data:{...row,url:sharedURL}};}
    if(path.endsWith('/dashboard-shares'))return {data:shares};
    if(path.endsWith('/revoke')){shares[0].revokedAt='2026-10-14T12:10:00.000Z';shares[0].version++;return {data:shares[0]};}
    if(path.endsWith('/social-metrics/settings')){data.management.metricsSettings={...data.management.metricsSettings,enabled:options.body.enabled,version:2};return {data:data.management.metricsSettings};}
    throw new Error('Unexpected path '+path);
  };
  await w.SocialResults.render({root:w.document.querySelector('#root'),api,basePath,workspace:{name:data.brand.name},canManage,renderId:1,isCurrent:()=>true});await tick();return {w,calls,shares,data,api,basePath,$:s=>w.document.querySelector(s)};
}
async function publicPage(t,{data=dto(),fetch:fetchOverride,token=TOKEN}={}){
  const w=dom(t,ORIGIN+'/client-dashboard'+(token?'#token='+token:''));w.document.querySelector('#root').id='client-dashboard';
  const calls=[],timers=new Map();let nextTimer=1,visible=true;
  Object.defineProperty(w.document,'visibilityState',{get:()=>visible?'visible':'hidden'});
  Object.defineProperty(w.document,'hidden',{get:()=>!visible});
  w.setTimeout=(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,ms});return id;};w.clearTimeout=id=>timers.delete(id);
  w.fetch=async(path,options)=>{calls.push({path,options,hash:w.location.hash});return fetchOverride?fetchOverride(path,options):{ok:true,status:200,json:async()=>({data})};};
  w.eval(viewer);w.document.dispatchEvent(new w.Event('DOMContentLoaded'));await tick();
  return {w,calls,timers,$:s=>w.document.querySelector(s),setVisible:value=>{visible=value;w.document.dispatchEvent(new w.Event('visibilitychange'));},poll:()=>{const timer=[...timers.entries()].find(([,v])=>v.ms===60000);assert.ok(timer,'60 second poll scheduled');timers.delete(timer[0]);timer[1].fn();}};
}
test('dashboard UI: manager creates once, confirms exact brand and duration, copies only new link and clears on Close',async t=>{
  const p=await internal(t),{w,calls}=p;let copied=[];Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async value=>copied.push(value)}});
  p.$('[data-results-action="share"]').click();const form=p.$('[data-results-form="share"]');
  assert.match(form.textContent,/qualquer pessoa com este link/);assert.match(form.textContent,/Marca de teste/);assert.equal(form.elements.expiresInDays.value,'30');
  formSubmit(w,form);assert.equal(calls.filter(c=>c.method==='POST').length,0,'explicit bearer acknowledgment required');
  form.elements.acknowledgeBearerAccess.checked=true;formSubmit(w,form);formSubmit(w,form);
  await eventually(()=>p.$('#sr-created-url'),'created URL');const creation=calls.filter(c=>c.method==='POST');assert.equal(creation.length,1);assert.equal(creation[0].body.expiresInDays,30);assert.equal(creation[0].body.acknowledgeBearerAccess,true);assert.match(creation[0].headers['Idempotency-Key'],/^[a-z0-9-]{36}$/);assert.equal(p.$('#sr-created-url').value,sharedURL);
  p.$('[data-results-copy]').click();p.$('[data-results-copy]').click();await tick();assert.deepEqual(copied,[sharedURL]);
  p.$('[data-results-close]').click();assert.equal(p.$('.sr-dialog'),null);assert.equal(w.document.body.innerHTML.includes(TOKEN),false);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
  p.$('[data-results-action="share"]').click();assert.equal(p.$('#sr-created-url'),null,'old link never reopens');p.$('[data-results-close]').click();
});
test('dashboard UI: revoke is confirmed once, sends optimistic version, and removes active action',async t=>{
  const p=await internal(t),{w,calls}=p;
  p.$('[data-results-action="share"]').click();const form=p.$('[data-results-form="share"]');form.elements.acknowledgeBearerAccess.checked=true;formSubmit(w,form);await eventually(()=>p.$('#sr-created-url'));p.$('[data-results-close]').click();await eventually(()=>p.$('[data-results-action="revoke"]'));
  p.$('[data-results-action="revoke"]').click();p.$('[data-results-close]').click();assert.equal(calls.filter(c=>c.path.endsWith('/revoke')).length,0);
  p.$('[data-results-action="revoke"]').click();p.$('[data-results-confirm-revoke]').click();p.$('[data-results-confirm-revoke]').click();await eventually(()=>!p.$('.sr-dialog'));await tick();
  const revokes=calls.filter(c=>c.path.endsWith('/revoke'));assert.equal(revokes.length,1);assert.equal(revokes[0].body.expectedVersion,1);assert.match(p.$('#root').textContent,/Revogado/);assert.equal(p.$('[data-results-action="revoke"]'),null);
});
test('dashboard UI: owner explicitly enables metrics; admin can share but cannot configure collection',async t=>{
  const p=await internal(t);p.$('[data-results-action="metrics"]').click();assert.equal(p.calls.filter(c=>c.path.endsWith('/social-metrics/settings')).length,0);p.$('[data-results-confirm-metrics]').click();p.$('[data-results-confirm-metrics]').click();await eventually(()=>!p.$('.sr-dialog'));
  const calls=p.calls.filter(c=>c.path.endsWith('/social-metrics/settings'));assert.equal(calls.length,1);assert.equal(calls[0].body.enabled,true);assert.equal(calls[0].body.expectedVersion,1);assert.equal(calls[0].body.cadenceMinutes,15);
  const admin=await internal(t,{data:dto({management:{canManage:true,canConfigureMetrics:false,metricsSettings:{enabled:false,version:1,cadenceMinutes:15}}})});assert.ok(admin.$('[data-results-action="share"]'));assert.equal(admin.$('[data-results-action="metrics"]'),null);
  const viewer=await internal(t,{canManage:false,data:dto({management:{canManage:false,canConfigureMetrics:false,metricsSettings:{enabled:false,version:1,cadenceMinutes:15}}})});assert.equal(viewer.$('[data-results-action="share"]'),null);assert.equal(viewer.calls.some(c=>c.path.endsWith('/dashboard-shares')),false);
});
test('dashboard UI: navigating away or bfcache never resurrects a pending secret dialog',async t=>{
  const pending=deferred();const p=await internal(t,{apiOverride:(path,options)=>path.endsWith('/dashboard-shares')&&options.method==='POST'?pending.promise:undefined});
  p.$('[data-results-action="share"]').click();const form=p.$('[data-results-form="share"]');form.elements.acknowledgeBearerAccess.checked=true;formSubmit(p.w,form);
  p.w.dispatchEvent(new p.w.PageTransitionEvent('pagehide',{persisted:true}));assert.equal(p.$('.sr-dialog'),null);pending.resolve({data:{id:'share',url:sharedURL,expiresAt:'2099-01-01T00:00:00Z'}});await tick();assert.equal(p.$('#sr-created-url'),null);assert.equal(p.w.document.body.innerHTML.includes(TOKEN),false);
  p.w.dispatchEvent(new p.w.PageTransitionEvent('pageshow',{persisted:true}));await tick();assert.equal(p.$('#sr-created-url'),null);
  p.$('[data-results-action="share"]').click();p.w.SocialResults.cleanup();assert.equal(p.$('.sr-dialog'),null);
});
test('dashboard UI: create error retains idempotency key on retry, close does not recreate dialog',async t=>{
  let attempts=0;const pending=deferred();const p=await internal(t,{apiOverride:(path,options)=>{if(path.endsWith('/dashboard-shares')&&options.method==='POST'){attempts++;return attempts===1?Promise.reject(new Error('Conexão interrompida')):pending.promise;}}});
  p.$('[data-results-action="share"]').click();const form=p.$('[data-results-form="share"]');form.elements.acknowledgeBearerAccess.checked=true;formSubmit(p.w,form);await eventually(()=>p.$('.sr-dialog-error').textContent);formSubmit(p.w,form);const posts=p.calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].headers['Idempotency-Key'],posts[1].headers['Idempotency-Key']);p.$('[data-results-close]').click();pending.resolve({data:{id:'share',url:sharedURL,expiresAt:'2099-01-01T00:00:00Z'}});await tick();assert.equal(p.$('.sr-dialog'),null);
});
test('dashboard UI: redacted renderer shows zero honestly, unavailable/unsupported separately and no editorial fields',async t=>{
  const p=await publicPage(t,{data:dto({brand:{name:'<img src=x onerror=alert(1)> Marca'},accounts:[{id:'acct',platform:'linkedin',displayName:'<b>Marca</b>',status:'unsupported',connectionStatus:'connected',metrics:{followers:null,reach:null,impressions:0},metricSources:{followers:{state:'unsupported'},impressions:{state:'available',period:'day',source:'Official API'}}}],posts:[{id:'post',platform:'instagram',title:'PRIVATE TITLE',caption:'PRIVATE CAPTION',publishedAt:'2026-10-14T00:00:00Z',permalink:'javascript:alert(1)',metrics:{likes:0,comments:null}}],fofa:'PRIVATE FOFA'})});
  assert.ok(p.$('.sr-dashboard'));assert.equal(p.$('img'),null);assert.equal(p.$('b'),null);assert.match(p.$('.sr-dashboard').textContent,/Não integrado/);assert.match(p.$('.sr-dashboard').textContent,/Não disponível/);assert.match(p.$('.sr-dashboard').textContent,/Janela diária/);assert.ok([...p.w.document.querySelectorAll('.sr-account dd span')].some(node=>node.textContent==='0')); assert.equal(p.$('.sr-dashboard').textContent.includes('PRIVATE'),false);assert.equal(p.$('a[href^="javascript"]'),null);assert.equal(p.$('[data-results-action="share"]'),null);assert.equal(p.calls[0].hash,'');assert.equal(p.calls[0].options.credentials,'omit');assert.equal(p.w.localStorage.length,0);
});
test('dashboard UI: public polling waits 60 seconds, pauses while hidden, never overlaps and shows stale snapshot on failure',async t=>{
  let count=0;const pending=deferred();const p=await publicPage(t,{fetch:async()=>{count++;if(count===2)return pending.promise;if(count===3)throw new Error('offline');return {ok:true,status:200,json:async()=>({data:dto({lastSyncedAt:'2026-10-14T11:00:00Z'})})};}});
  assert.equal(count,1);p.poll();await tick();assert.equal(count,2);p.w.document.dispatchEvent(new p.w.Event('visibilitychange'));await tick();assert.equal(count,2,'in-flight requests must not overlap');pending.resolve({ok:true,status:200,json:async()=>({data:dto({lastSyncedAt:'2026-10-14T11:00:00Z'})})});await tick();p.setVisible(false);assert.equal([...p.timers.values()].some(v=>v.ms===60000),false);p.setVisible(true);await tick();assert.equal(count,3);assert.match(p.$('#client-dashboard').textContent,/Não foi possível buscar uma nova atualização/);assert.match(p.$('#client-dashboard').textContent,/14\/10\/2026, 11:00 UTC/);assert.match(p.$('#client-dashboard').textContent,/Marca de teste/);
});
test('dashboard UI: revocation clears all data permanently and no reload token is retained',async t=>{
  let revoked=false;const p=await publicPage(t,{fetch:async()=>revoked?{ok:false,status:404,json:async()=>({error:{message:'secret error'}})}:{ok:true,status:200,json:async()=>({data:dto()})}});
  assert.ok(p.$('.sr-dashboard'));revoked=true;p.poll();await tick();assert.equal(p.$('.sr-dashboard'),null);assert.match(p.$('#client-dashboard').textContent,/Este link não está disponível/);assert.equal(p.$('#client-dashboard').textContent.includes('Marca de teste'),false);p.setVisible(false);p.setVisible(true);await tick();assert.equal(p.calls.length,2);assert.equal(p.timers.size,0);
  const reload=await publicPage(t,{token:''});assert.equal(reload.calls.length,0);assert.match(reload.$('#client-dashboard').textContent,/link original/);
});
test('dashboard UI: history navigation aborts public request and late success cannot restore data',async t=>{
  for(const eventType of ['pagehide','popstate','hashchange']){
    const pending=deferred(),p=await publicPage(t,{fetch:()=>pending.promise});assert.equal(p.calls.length,1);const signal=p.calls[0].options.signal;
    p.w.dispatchEvent(new p.w.Event(eventType));assert.equal(signal.aborted,true);pending.resolve({ok:true,status:200,json:async()=>({data:dto()})});await tick();assert.equal(p.$('.sr-dashboard'),null);assert.match(p.$('#client-dashboard').textContent,/Reabra o link/);p.w.dispatchEvent(new p.w.PageTransitionEvent('pageshow',{persisted:true}));p.setVisible(false);p.setVisible(true);await tick();assert.equal(p.calls.length,1);assert.equal(p.w.document.body.textContent.includes('Marca de teste'),false);
  }
});
test('dashboard UI: recent-auth challenge closes token dialog and requests identity confirmation without resending',async t=>{
  const w=dom(t),root=w.document.querySelector('#root'),calls=[];let reauth=0;
  const api=async(path,options={})=>{calls.push({path,...options});if(options.method==='POST'){const error=new Error('Confirme sua identidade.');error.code='REAUTH_REQUIRED';error.status=403;throw error;}return {data:path.endsWith('/client-dashboard')?dto():[]};};
  await w.SocialResults.render({root,api,basePath:'/tenants/t/workspaces/w',canManage:true,isCurrent:()=>true,onReauthenticate:()=>reauth++});await tick();
  root.querySelector('[data-results-action="share"]').click();const form=w.document.querySelector('form');form.elements.acknowledgeBearerAccess.checked=true;formSubmit(w,form);await eventually(()=>w.document.querySelector('[data-results-reauthenticate]'));
  w.document.querySelector('[data-results-reauthenticate]').click();assert.equal(reauth,1);assert.equal(w.document.querySelector('.sr-dialog'),null);assert.equal(calls.filter(c=>c.method==='POST').length,1);
});
test('dashboard UI: revoked internal permission clears data and pending read signal is aborted on cleanup',async t=>{
  const w=dom(t),root=w.document.querySelector('#root');let requested,denied=false;
  const api=async(path,options={})=>{if(path.endsWith('/dashboard-shares'))return {data:[]};requested=options.signal;if(denied){const error=new Error('No access');error.status=403;throw error;}return {data:dto()};};
  await w.SocialResults.render({root,api,basePath:'/tenants/t/workspaces/w',canManage:true,isCurrent:()=>true});await tick();denied=true;root.querySelector('[data-results-action="retry"]').click();await eventually(()=>!root.querySelector('.sr-dashboard'));assert.equal(root.textContent.includes('Marca de teste'),false);assert.match(root.textContent,/Resultados indisponíveis/);w.SocialResults.cleanup();
  const pending=deferred();let signal;
  const promise=w.SocialResults.render({root,api:async(path,options)=>{signal=options.signal;return pending.promise;},basePath:'/tenants/t/workspaces/w',canManage:true,isCurrent:()=>true});w.SocialResults.cleanup();assert.equal(signal.aborted,true);root.textContent='Nova página';pending.resolve({data:dto()});await promise;assert.equal(root.textContent,'Nova página');
});
test('dashboard UI: reopening original link in the same tab accepts only the newly supplied secret',async t=>{
  let first=true;const oldRequest=deferred();
  const p=await publicPage(t,{fetch:async()=>{if(first){first=false;return oldRequest.promise;}return {ok:true,status:200,json:async()=>({data:dto({brand:{name:'Nova marca autorizada'}})})};}});
  const oldSignal=p.calls[0].options.signal;const nextToken='b'.repeat(43);
  p.w.history.replaceState(null,'','/client-dashboard#token='+nextToken);p.w.dispatchEvent(new p.w.HashChangeEvent('hashchange'));
  await tick();assert.equal(oldSignal.aborted,true);assert.equal(p.calls.length,2);assert.equal(p.calls[1].options.headers.Authorization,'Bearer '+nextToken);assert.equal(p.w.location.hash,'');assert.match(p.$('#client-dashboard').textContent,/Nova marca autorizada/);
  oldRequest.resolve({ok:true,status:200,json:async()=>({data:dto({brand:{name:'ANTIGA MARCA'}})})});await tick();assert.equal(p.$('#client-dashboard').textContent.includes('ANTIGA MARCA'),false);assert.equal(p.w.localStorage.length,0);
  p.w.history.replaceState(null,'','/client-dashboard#token=invalid');p.w.dispatchEvent(new p.w.HashChangeEvent('hashchange'));await tick();assert.equal(p.calls.length,2);assert.equal(p.$('.sr-dashboard'),null);assert.equal(p.w.location.hash,'');
});
