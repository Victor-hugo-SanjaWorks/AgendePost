(() => {
 'use strict';
 const root=document.getElementById('approval-root');
 let bearer=location.hash.slice(1),data=null,objectUrl=null,busy=false,stopped=false,epoch=0;
 const requests=new Set();
 const reopen='Por segurança, esta prévia foi encerrada. Abra o link original em uma nova aba para continuar.';
 const current=expected=>!stopped&&expected===epoch;
 const aborted=()=>Object.assign(new Error('Prévia encerrada.'),{name:'AbortError'});
 // Keep the capability only in this page's memory, never URLs, storage, analytics or referrers.
 history.replaceState(null,'',location.pathname);
 const valid=/^[A-Za-z0-9_-]{43}$/.test(bearer);
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=(value,zone)=>new Intl.DateTimeFormat('pt-BR',{dateStyle:'full',timeStyle:'short',timeZone:zone}).format(new Date(value));
 async function readResponse(path,options,decode,expected) {
  if(!current(expected))throw aborted();
  const controller=new AbortController(),pending={controller,timer:null};let timedOut=false;
  const cancelled=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(timedOut?Object.assign(new Error('O servidor não respondeu no prazo. Reabra o link original.'),{code:'REQUEST_TIMEOUT'}):aborted()),{once:true});});
  pending.timer=setTimeout(()=>{timedOut=true;controller.abort();},20000);requests.add(pending);
  try {
   return await Promise.race([(async()=>{
    const response=await fetch(path,{...options,signal:controller.signal,credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',headers:{authorization:'Bearer '+bearer,...(options.body?{'content-type':'application/json'}:{}),...options.headers}});
    if(!current(expected))throw aborted();
    const result=await decode(response);if(!current(expected))throw aborted();return result;
   })(),cancelled]);
  }finally{clearTimeout(pending.timer);requests.delete(pending);}
 }
 async function request(path,options={},expected=epoch) {
  return readResponse(path,options,async response=>{const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error?.message||'Não foi possível concluir. Reabra o link original.'),{status:response.status,code:result.error?.code});return result.data;},expected);
 }
 function unavailable(message){
  stopped=true;epoch++;busy=false;bearer='';data=null;
  for(const pending of requests){clearTimeout(pending.timer);pending.controller.abort();}requests.clear();
  if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;
  root.replaceChildren();const p=document.createElement('p');p.className='approval-message';p.textContent=message;root.append(p);
 }
 function leave(){if(location.hash)history.replaceState(null,'',location.pathname);unavailable(reopen);}
 function statusMarkup(d) {
  if(d.status==='pending')return '<div class="approval-notice">Confira a arte, a legenda, os canais e o horário. Aprovar autoriza o agendamento deste conteúdo quando os requisitos de publicação estiverem válidos.</div>';
  if(d.status==='changes_requested')return '<div class="approval-notice">Ajustes solicitados. Sua observação foi registrada e nenhum envio foi agendado por este pedido.</div>';
  if(d.status==='approved'){const headline={scheduled:'Aprovado e incluído na fila de envio.',published:'Aprovado e publicado.',cancelled:'Aprovado; envios cancelados.',attention:'Aprovado; resultado do envio exige atenção.'}[d.scheduling.status]||'Aprovado; agendamento pendente.';return `<div class="approval-notice ${['scheduled','published'].includes(d.scheduling.status)?'success':'warning'}"><strong>${headline}</strong><p>${esc(d.scheduling.message)}</p>${d.scheduling.code?`<small>Motivo: ${esc(d.scheduling.code)}</small>`:''}</div>`;}
  return '<div class="approval-notice warning">Este pedido não está mais disponível para decisões.</div>';
 }
 function render(d,expected=epoch) {
  if(!current(expected))return;
  root.innerHTML=`<div class="approval-intro"><span class="approval-eyebrow">SUA PRÓXIMA PUBLICAÇÃO</span><h1>Uma última olhada.<br>Depois, pode ir.</h1><p>Revise o conteúdo preparado para a sua marca.</p></div><section class="approval-card"><div class="approval-art"><img id="approval-image" alt="Arte da revisão enviada para aprovação" hidden><span id="approval-image-state">Carregando a arte…</span></div><div class="approval-details"><span class="approval-eyebrow">REVISÃO ${d.revision}</span><h2>${esc(d.preview.title)}</h2><div class="approval-channels">${d.preview.channels.map(c=>`<span>${esc(c.platform==='instagram'?'Instagram':'Facebook')} · ${esc(c.label)}${c.destinationLabel?' · '+esc(c.destinationLabel):''}</span>`).join('')}</div><div class="approval-time"><span>Horário planejado</span><strong>${esc(date(d.scheduledAt,d.scheduledTimezone))}</strong><small>${esc(d.scheduledTimezone)}</small></div><h3>Legenda</h3><p class="approval-caption">${esc(d.preview.caption||'Sem legenda.')}</p></div></section><section class="approval-decision">${statusMarkup(d)}${d.status==='pending'?`<form id="approval-decision-form"><label for="approval-feedback">Ajustes ou observações <span>(obrigatório ao pedir ajustes)</span></label><textarea id="approval-feedback" name="feedback" rows="3" maxlength="2000" placeholder="Conte à equipe o que precisa mudar…"></textarea><div class="approval-actions"><button type="submit" name="decision" value="request_changes" class="approval-button secondary">Pedir ajustes</button><button type="submit" name="decision" value="approve" class="approval-button primary">Aprovar e autorizar agendamento</button></div><p class="approval-error" role="alert"></p></form>`:d.feedback?`<p class="approval-caption"><strong>Observação registrada:</strong> ${esc(d.feedback)}</p>`:''}<p class="approval-identity">${esc(d.identityNotice)}</p><p class="approval-expiry">Link válido até ${esc(date(d.expiresAt,d.scheduledTimezone))}. Uma edição da peça ou do planejamento exige nova aprovação.</p></section>`;
  if(objectUrl){const img=document.getElementById('approval-image');img.src=objectUrl;img.hidden=false;document.getElementById('approval-image-state').hidden=true;}
 }
 root.addEventListener('submit',async event=>{
  if(event.target.id!=='approval-decision-form')return;event.preventDefault();if(stopped||busy||!data||data.status!=='pending')return;
  const expected=epoch;
  const form=event.target,decision=event.submitter?.value,feedback=String(new FormData(form).get('feedback')||'').trim();
  if(!['approve','request_changes'].includes(decision))return;
  if(decision==='request_changes'&&!feedback){form.querySelector('.approval-error').textContent='Descreva os ajustes necessários.';return;}
  if(!objectUrl){form.querySelector('.approval-error').textContent='A arte precisa carregar antes de registrar sua decisão. Reabra o link original.';return;}
  busy=true;form.querySelectorAll('button').forEach(b=>b.disabled=true);
  try {const result=await request('/api/v1/client-approval/decision',{method:'POST',headers:{'x-csrf-token':data.csrfToken},body:JSON.stringify({expectedVersion:data.version,challenge:data.challenge,decision,feedback})},expected);if(!current(expected))return;data=result;render(data,expected);}
  catch(error){
   if(!current(expected)||!form.isConnected)return;
   if(error.status===404||['CLIENT_APPROVAL_STALE','AUTHORIZATION_REVOKED','TENANT_SUSPENDED','WORKSPACE_ARCHIVED'].includes(error.code))unavailable(error.message);
   else if(error.status===401||['CSRF_INVALID','CLIENT_CHALLENGE_INVALID'].includes(error.code))unavailable('Sua sessão de revisão expirou. Abra o link original de aprovação em uma nova aba para continuar.');
   else if(error.code==='REQUEST_TIMEOUT')unavailable('O resultado da decisão não foi confirmado. Abra o link original em uma nova aba para conferir antes de tentar novamente.');
   else{form.querySelector('.approval-error').textContent=error.message;form.querySelectorAll('button').forEach(b=>b.disabled=false);}
  }finally{if(current(expected))busy=false;}
 });
 window.addEventListener('pagehide',leave);
 window.addEventListener('popstate',leave);
 window.addEventListener('hashchange',leave);
 window.addEventListener('pageshow',event=>{if(event.persisted)leave();});
 async function start(expected=epoch){
  if(!valid)throw new Error('Link incompleto. Abra o link original que a equipe enviou.');
  const result=await request('/api/v1/client-approval',{},expected);if(!current(expected))return;data=result;render(data,expected);
  try{
   const blob=await readResponse('/api/v1/client-approval/media',{},async response=>{if(!response.ok||!['image/jpeg','image/png','image/webp'].includes(response.headers.get('content-type')?.split(';')[0]))throw new Error('Imagem indisponível.');return response.blob();},expected);
   if(!current(expected))return;
   const created=URL.createObjectURL(blob);if(!current(expected)){URL.revokeObjectURL(created);return;}objectUrl=created;render(data,expected);
  }catch(error){
   if(!current(expected))return;
   if(error.code==='REQUEST_TIMEOUT'){unavailable('A arte não respondeu no prazo. Abra o link original em uma nova aba para continuar.');return;}
   const message=document.getElementById('approval-image-state');if(message)message.textContent='A arte não pôde ser carregada. Reabra o link original ou fale com a equipe.';root.querySelectorAll('button').forEach(b=>b.disabled=true);
  }
 }
 const initialEpoch=epoch;start(initialEpoch).catch(error=>{if(current(initialEpoch))unavailable(error.message);});
})();
