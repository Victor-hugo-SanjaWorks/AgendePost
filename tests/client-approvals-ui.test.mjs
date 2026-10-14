import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
const publicScript=await readFile(new URL('../public/approval.js',import.meta.url),'utf8');
const internalScript=await readFile(new URL('../public/approvals.js',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,15));
const raw='x'.repeat(43),time='2030-05-03T12:00:00.000Z';
const preview={id:'request-a',revision:1,status:'pending',version:1,scheduledAt:time,scheduledTimezone:'UTC',expiresAt:time,csrfToken:'csrf-fixture',challenge:'y'.repeat(43),identityNotice:'Quem possui este link pode decidir.',preview:{title:'<img src=x onerror=alert(1)>',caption:'<script>window.injected=true</script>',channels:[{id:'channel-a',label:'Canal seguro',platform:'instagram'}]},scheduling:{status:'awaiting_client',message:'Aguardando cliente.',publications:[]}};

test('client approval public UI: fragment is removed, data is text escaped, image fetch uses bearer header only',async t=>{
 const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,calls=[];
 w.URL.createObjectURL=()=> 'blob:fixture-preview';w.URL.revokeObjectURL=()=>{};
 w.fetch=async(path,options)=>{calls.push({path,options});return path.endsWith('/media')?{ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob(['fixture'])}:{ok:true,json:async()=>({data:preview})};};
 w.eval(publicScript);await tick();
 assert.equal(w.location.hash,'');assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);assert.equal(w.injected,undefined);assert.equal(w.document.querySelectorAll('script').length,0);assert.match(w.document.body.textContent,/<script>window.injected=true<\/script>/);
 assert.equal(w.document.querySelector('#approval-image').src,'blob:fixture-preview');assert.equal(calls.length,2);
 for(const call of calls){assert.ok(!call.path.includes(raw));assert.equal(call.options.headers.authorization,'Bearer '+raw);assert.equal(call.options.cache,'no-store');assert.equal(call.options.referrerPolicy,'no-referrer');}
});

test('client approval public UI: explicit POST includes challenge and CSRF; blocked consent never says scheduled',async t=>{
 const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,calls=[];
 w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=()=>{};
 w.fetch=async(path,options)=>{calls.push({path,options});if(path.endsWith('/media'))return {ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob(['fixture'])};return {ok:true,json:async()=>({data:path.endsWith('/decision')?{...preview,status:'approved',scheduling:{status:'blocked',code:'WORKER_UNAVAILABLE',message:'Nenhum agendamento foi criado.'}}:preview})};};
 w.eval(publicScript);await tick();assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
 const form=w.document.querySelector('form'),button=form.querySelector('[value="approve"]');form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:button}));await tick();
 const post=calls.find(c=>c.options.method==='POST');assert.ok(post);assert.equal(post.options.headers['x-csrf-token'],'csrf-fixture');const body=JSON.parse(post.options.body);assert.equal(body.decision,'approve');assert.equal(body.challenge,preview.challenge);assert.equal(body.expectedVersion,1);
 assert.match(w.document.body.textContent,/Aprovado; agendamento pendente/);assert.match(w.document.body.textContent,/Nenhum agendamento foi criado/);assert.doesNotMatch(w.document.body.textContent,/Aprovado e incluído na fila/);
});

test('client approval public UI: invalid token and missing image cannot submit decisions',async t=>{
 const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#invalid',runScripts:'outside-only'});t.after(()=>dom.window.close());let calls=0;dom.window.fetch=async()=>{calls++;};dom.window.eval(publicScript);await tick();assert.equal(calls,0);assert.match(dom.window.document.body.textContent,/Link incompleto/);
 const broken=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>broken.window.close());broken.window.fetch=async path=>path.endsWith('/media')?{ok:false}:{ok:true,json:async()=>({data:preview})};broken.window.eval(publicScript);await tick();assert.ok([...broken.window.document.querySelectorAll('button')].every(b=>b.disabled));assert.match(broken.window.document.body.textContent,/arte não pôde ser carregada/);
});

test('client approval internal UI: separate tab renders escaped records and cleanup fences stale results',async t=>{
 const dom=new JSDOM('<main id="root"></main>',{url:'http://127.0.0.1:8787/app',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.eval(internalScript);
 const row={...preview,postId:'post-a',notification:{status:'not_configured'},feedback:'<svg onload=alert(1)>',scheduling:{status:'blocked',message:'Aguardando servidor.',code:'WORKER_UNAVAILABLE',publications:[]}};
 const info={posts:[],channels:[],timezone:'UTC',canCreate:true,readiness:{enabled:false,message:'Servidor inativo.'}};
 const api=async path=>({data:path.endsWith('/options')?info:[row]});
 await w.ClientApprovals.render({root:w.document.getElementById('root'),api,basePath:'/tenants/t/workspaces/w',workspace:{name:'Marca A'},canWrite:true});
 assert.match(w.document.body.textContent,/Aprovações/);assert.match(w.document.body.textContent,/conclua a aprovação interna/i);assert.equal(w.document.querySelectorAll('svg').length,0);assert.match(w.document.body.textContent,/<svg onload=alert\(1\)>/);
 w.document.querySelector('[data-approval-action="new"]').click();assert.match(w.document.querySelector('dialog').textContent,/Nenhuma peça elegível/);w.ClientApprovals.cleanup();assert.equal(w.document.querySelector('dialog'),null);
 let release;const pending=new Promise(r=>release=r);const render=w.ClientApprovals.render({root:w.document.getElementById('root'),api:()=>pending,basePath:'/tenants/t/workspaces/w'});w.ClientApprovals.cleanup();w.document.getElementById('root').textContent='Nova marca';release({data:[]});await render;assert.equal(w.document.getElementById('root').textContent,'Nova marca');
});

test('client approval internal UI: creation stays separate, generated links remain only in current dialog',async t=>{
 const dom=new JSDOM('<main id="root"></main>',{url:'http://127.0.0.1:8787/app',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.eval(internalScript);const calls=[];
 const info={posts:[{id:'post-a',title:'Post pronto',caption:'Legenda',revision:3,channelIds:['channel-a']}],channels:[{id:'channel-a',label:'Instagram da marca',platform:'instagram',connectionVersion:'version-1'}],timezone:'UTC',canCreate:true,readiness:{enabled:true}};
 const api=async(path,options)=>{calls.push({path,options});if(path.endsWith('/options'))return {data:info};if(path.endsWith('whatsapp-notification-status'))return {data:{configured:false}};if(options?.method==='POST')return {data:{id:'request-a',approvalUrl:'http://127.0.0.1:8787/approval.html#'+raw}};return {data:[]};};
 await w.ClientApprovals.render({root:w.document.getElementById('root'),api,basePath:'/tenants/t/workspaces/w',canWrite:true});w.document.querySelector('[data-approval-action="new"]').click();
 const select=w.document.querySelector('[name="postId"]');select.value='post-a';select.dispatchEvent(new w.Event('change',{bubbles:true}));const form=w.document.querySelector('form');form.elements.confirm.checked=true;
 form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('[type="submit"]')}));await tick();
 const created=calls.find(c=>c.options?.method==='POST');assert.equal(created.path,'/tenants/t/workspaces/w/client-approvals');assert.equal(created.options.body.expectedRevision,3);assert.equal(created.options.body.connectionVersions['channel-a'],'version-1');assert.equal(created.options.idempotent,true);
 assert.equal(w.document.querySelector('.client-approval-link').value,'http://127.0.0.1:8787/approval.html#'+raw);assert.match(w.document.querySelector('dialog').textContent,/WhatsApp não configurado/);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);w.ClientApprovals.cleanup();assert.equal(w.document.querySelector('.client-approval-link'),null);
});

test('client approval internal UI: WhatsApp explicit confirmation uses private per-attempt key and never generic mutation cache',async t=>{
 const dom=new JSDOM('<main id="root"></main>',{url:'http://127.0.0.1:8787/app',runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.eval(internalScript);const calls=[];
 const info={posts:[{id:'post-a',title:'Post pronto',caption:'Legenda',revision:3,channelIds:['channel-a']}],channels:[{id:'channel-a',label:'Instagram',platform:'instagram',connectionVersion:'version-1'}],timezone:'UTC',canCreate:true,readiness:{enabled:true}};
 const api=async(path,options)=>{calls.push({path,options});if(path.endsWith('/options'))return {data:info};if(path.endsWith('whatsapp-notification-status'))return {data:{configured:true,senderLabel:'Remetente oficial'}};if(path.endsWith('notify-whatsapp'))return {data:{status:'accepted',message:'API aceitou; entrega não confirmada.'}};if(options?.method==='POST')return {data:{id:'request-a',approvalUrl:'http://127.0.0.1:8787/approval.html#'+raw}};return {data:[]};};
 await w.ClientApprovals.render({root:w.document.getElementById('root'),api,basePath:'/tenants/t/workspaces/w',canWrite:true});w.document.querySelector('[data-approval-action="new"]').click();const select=w.document.querySelector('[name="postId"]');select.value='post-a';select.dispatchEvent(new w.Event('change',{bubbles:true}));let form=w.document.querySelector('form');form.elements.confirm.checked=true;form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('[type="submit"]')}));await tick();
 assert.equal(calls.filter(c=>c.path.endsWith('notify-whatsapp')).length,0);form=w.document.querySelector('[data-approval-form="whatsapp"]');form.elements.recipientPhone.value='+5511999999999';form.elements.consent.checked=true;const button=form.querySelector('[type="submit"]');form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:button}));await tick();
 const sent=calls.find(c=>c.path.endsWith('notify-whatsapp'));assert.equal(sent.options.idempotent,undefined);assert.match(sent.options.headers['Idempotency-Key'],/^[a-f0-9-]{36}$/);assert.equal(sent.options.body.token,raw);assert.equal(sent.options.body.recipientConsented,true);assert.equal(sent.options.body.confirmSend,true);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);assert.equal(button.disabled,true);button.click();await tick();assert.equal(calls.filter(c=>c.path.endsWith('notify-whatsapp')).length,1);assert.match(form.textContent,/entrega não confirmada/);
});

test('client approval public UI: revocation during review clears protected preview and leaves no actionable form',async t=>{
 const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;let revoked=0;w.URL.createObjectURL=()=> 'blob:fixture';w.URL.revokeObjectURL=()=>revoked++;
 w.fetch=async(path)=>path.endsWith('/media')?{ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob(['fixture'])}:path.endsWith('/decision')?{ok:false,status:404,json:async()=>({error:{code:'CLIENT_LINK_UNAVAILABLE',message:'Link indisponível, expirado ou revogado.'}})}:{ok:true,json:async()=>({data:preview})};
 w.eval(publicScript);await tick();const form=w.document.querySelector('form');form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('[value="approve"]')}));await tick();assert.match(w.document.body.textContent,/revogado/);assert.equal(w.document.querySelector('form'),null);assert.equal(w.document.querySelector('img'),null);assert.doesNotMatch(w.document.body.textContent,/window.injected/);assert.equal(revoked,1);
});

for(const phase of ['preview-fetch','preview-body','media-fetch','media-body','decision-fetch','decision-body'])test(`client approval lifecycle: late ${phase} cannot restore protected content after pagehide/BFCache`,async t=>{
 const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,calls=[];let resolve,created=0,revoked=0;
 const late=new Promise(r=>resolve=r),previewResponse={ok:true,json:async()=>({data:preview})},mediaResponse={ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob(['fixture'])},decisionResponse={ok:true,json:async()=>({data:{...preview,status:'approved',scheduling:{status:'scheduled',message:'Incluído na fila.',publications:[]}}})};
 w.URL.createObjectURL=()=>{created++;return 'blob:lifecycle-fixture';};w.URL.revokeObjectURL=()=>revoked++;
 w.fetch=async(path,options)=>{calls.push({path,options});if(path.endsWith('/decision'))return phase==='decision-fetch'?late:phase==='decision-body'?{...decisionResponse,json:()=>late}:decisionResponse;if(path.endsWith('/media'))return phase==='media-fetch'?late:phase==='media-body'?{...mediaResponse,blob:()=>late}:mediaResponse;return phase==='preview-fetch'?late:phase==='preview-body'?{...previewResponse,json:()=>late}:previewResponse;};
 w.eval(publicScript);await tick();
 if(phase.startsWith('decision')){const form=w.document.querySelector('form');assert.ok(form);form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('[value="approve"]')}));await tick();}
 assert.ok(calls.at(-1).options.signal,'Each request has an abort signal');const pending=calls.at(-1).options.signal;
 w.dispatchEvent(new w.PageTransitionEvent('pagehide',{persisted:true}));assert.equal(pending.aborted,true);assert.equal(w.document.querySelector('form'),null);assert.equal(w.document.querySelector('img'),null);assert.doesNotMatch(w.document.body.textContent,/window.injected/);assert.match(w.document.body.textContent,/prévia foi encerrada/);
 const result=phase==='preview-fetch'?previewResponse:phase==='preview-body'?{data:preview}:phase==='media-fetch'?mediaResponse:phase==='media-body'?new Blob(['late image']):phase==='decision-fetch'?decisionResponse:{data:{...preview,status:'approved',scheduling:{status:'scheduled',message:'Incluído na fila.',publications:[]}}};resolve(result);await tick();
 w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));await tick();
 assert.equal(w.document.querySelector('form'),null);assert.equal(w.document.querySelector('img'),null);assert.doesNotMatch(w.document.body.textContent,/window.injected|Incluído na fila/);assert.match(w.document.body.textContent,/nova aba/);assert.equal(w.location.hash,'');assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
 if(phase.startsWith('preview'))assert.equal(calls.length,1,'Late preview never starts media retrieval');if(phase.startsWith('media'))assert.equal(created,0,'Late blob never receives a reusable URL');if(phase.startsWith('decision'))assert.equal(revoked,1,'The visible image is revoked exactly once');
});

test('client approval lifecycle: navigation and persisted pageshow erase the preview without restarting a link',async t=>{
 for(const event of ['popstate','malformed-hash','fresh-hash','persisted-pageshow']){
  const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;let calls=0,revoked=0;w.URL.createObjectURL=()=> 'blob:navigation';w.URL.revokeObjectURL=()=>revoked++;w.fetch=async path=>{calls++;return path.endsWith('/media')?{ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob(['image'])}:{ok:true,json:async()=>({data:preview})};};w.eval(publicScript);await tick();assert.ok(w.document.querySelector('img'));
  if(event==='popstate')w.dispatchEvent(new w.PopStateEvent('popstate'));else if(event==='persisted-pageshow')w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));else w.location.hash=event==='fresh-hash'?'z'.repeat(43):'invalid-link';await tick();
  assert.equal(w.document.querySelector('img'),null);assert.equal(w.document.querySelector('form'),null);assert.equal(calls,2);assert.equal(revoked,1);assert.equal(w.location.hash,'');assert.match(w.document.body.textContent,/nova aba/);
 }
});

test('client approval lifecycle: decision timeout aborts the request and preserves uncertainty without retry',async t=>{
 const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window,calls=[],deadlines=[];const realSetTimeout=w.setTimeout.bind(w);w.setTimeout=(fn,delay,...args)=>{if(delay===20000){deadlines.push(fn);return realSetTimeout(()=>{},100000);}return realSetTimeout(fn,delay,...args);};w.URL.createObjectURL=()=> 'blob:timeout';w.URL.revokeObjectURL=()=>{};
 let resolve;const late=new Promise(r=>resolve=r);w.fetch=async(path,options)=>{calls.push({path,options});return path.endsWith('/decision')?late:path.endsWith('/media')?{ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob(['image'])}:{ok:true,json:async()=>({data:preview})};};w.eval(publicScript);await tick();const form=w.document.querySelector('form');form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('[value="approve"]')}));await tick();deadlines.at(-1)();await tick();
 assert.equal(calls.at(-1).options.signal.aborted,true);assert.match(w.document.body.textContent,/resultado da decisão não foi confirmado/);assert.equal(w.document.querySelector('form'),null);resolve({ok:true,json:async()=>({data:{...preview,status:'approved'}})});await tick();assert.equal(calls.filter(c=>c.path.endsWith('/decision')).length,1);assert.doesNotMatch(w.document.body.textContent,/Aprovado e incluído/);assert.equal(w.document.querySelector('img'),null);
});

test('client approval public UI: published, cancelled and uncertain sends have explicit truthful headlines',async t=>{
 for(const [status,headline] of [['published','Aprovado e publicado.'],['cancelled','Aprovado; envios cancelados.'],['attention','Aprovado; resultado do envio exige atenção.']]){
  const dom=new JSDOM('<main id="approval-root"></main>',{url:'http://127.0.0.1:8787/approval.html#'+raw,runScripts:'outside-only'});t.after(()=>dom.window.close());const w=dom.window;w.URL.createObjectURL=()=> 'blob:state';w.URL.revokeObjectURL=()=>{};w.fetch=async path=>path.endsWith('/media')?{ok:true,headers:{get:()=> 'image/jpeg'},blob:async()=>new Blob(['image'])}:{ok:true,json:async()=>({data:{...preview,status:'approved',scheduling:{status,message:'Resultado registrado na fila.',publications:[]}}})};w.eval(publicScript);await tick();assert.ok(w.document.body.textContent.includes(headline));assert.doesNotMatch(w.document.body.textContent,/agendamento pendente/);assert.equal(w.document.querySelector('form'),null);
 }
});
