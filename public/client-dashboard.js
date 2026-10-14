(() => {
'use strict';
// The bearer secret never enters a query string, storage, a cookie or the DOM.
function captureLinkToken(){
  try {
    const match=/^#token=([A-Za-z0-9_-]{43})$/.exec(location.hash);
    history.replaceState(null,'',location.pathname);
    return match?match[1]:'';
  } catch { return ''; }
}
let token=captureLinkToken();
let root=null,snapshot=null,receivedAt=null,timer=null,timeout=null,controller=null,inFlight=false,stopped=false,epoch=0;
const visible=()=>document.visibilityState!=='hidden';
function cancel(){clearTimeout(timer);clearTimeout(timeout);timer=null;timeout=null;controller?.abort();controller=null;epoch++;inFlight=false;}
function erase(title,description){stopped=true;token='';snapshot=null;receivedAt=null;cancel();if(root){root.innerHTML=window.SocialResults.empty(title,description);root.setAttribute('aria-busy','false');}document.title='Resultados da marca · AgendePost';}
function leave(){erase('Reabra o link compartilhado','Por segurança, este acesso não fica salvo no navegador. Para continuar, abra novamente o link original que a equipe compartilhou com você.');}
function schedule(){clearTimeout(timer);timer=null;if(!stopped&&token&&visible())timer=setTimeout(refresh,60000);}
function displaySnapshot(stale=false){if(root&&snapshot&&!stopped){root.innerHTML=window.SocialResults.view(snapshot,{publicView:true,transportStale:stale,receivedAt});root.setAttribute('aria-busy','false');}}
async function refresh(){
  if(stopped||!token||inFlight||!visible())return;
  inFlight=true;clearTimeout(timer);const requestEpoch=++epoch;controller=new AbortController();const requestController=controller;
  timeout=setTimeout(()=>requestController.abort(),20000);
  const retry=root?.querySelector('[data-results-action="retry"]');if(retry)retry.disabled=true;
  try {
    const response=await fetch('/api/v1/public/dashboard',{method:'GET',credentials:'omit',cache:'no-store',mode:'same-origin',redirect:'error',referrerPolicy:'no-referrer',headers:{Accept:'application/json',Authorization:'Bearer '+token},signal:requestController.signal});
    if(stopped||requestEpoch!==epoch)return;
    if([401,403,404,410].includes(response.status)){erase('Este link não está disponível','O acesso pode ter expirado ou sido revogado. Peça um novo link à equipe responsável pela marca.');return;}
    if(!response.ok)throw new Error('Dashboard temporarily unavailable.');
    const payload=await response.json();
    if(stopped||requestEpoch!==epoch)return;
    if(!window.SocialResults.validateDashboard(payload?.data))throw new Error('Invalid dashboard response.');
    snapshot=payload.data;receivedAt=new Date().toISOString();displaySnapshot();
  } catch {
    if(stopped||requestEpoch!==epoch)return;
    if(snapshot)displaySnapshot(true);
    else if(root){root.innerHTML=window.SocialResults.empty('Não foi possível carregar os resultados','Verifique sua conexão. Você pode tentar novamente; nenhuma informação foi substituída por estimativas.',true);root.setAttribute('aria-busy','false');}
  } finally {
    if(requestEpoch===epoch){clearTimeout(timeout);timeout=null;controller=null;inFlight=false;schedule();}
  }
}
function visibility(){if(!visible()){cancel();}else if(!stopped&&token){refresh();}}
function boot(){
  root=document.getElementById('client-dashboard');
  if(!root||!window.SocialResults)return;
  document.getElementById('dashboard-skip')?.addEventListener('click',()=>document.getElementById('main')?.focus());
  root.addEventListener('click',event=>{if(event.target.closest('[data-results-action="retry"]'))refresh();});
  if(stopped){leave();return;}
  if(!token){erase('Abra o link original do dashboard','Este acesso não fica salvo no navegador. Abra novamente o link completo enviado pela equipe. Você não precisa de uma conta administrativa.');return;}
  root.innerHTML=window.SocialResults.loading();root.setAttribute('aria-busy','true');refresh();
}
// A cached page or a history transition must never restore a previous secret.
window.addEventListener('pagehide',leave);
window.addEventListener('popstate',leave);
window.addEventListener('hashchange',()=>{
  // Reopening an original link in this same tab is a new explicit capability.
  // Clear the old request and snapshot before authorizing the newly supplied link.
  const nextToken=captureLinkToken();leave();
  if(nextToken){token=nextToken;stopped=false;if(root){root.innerHTML=window.SocialResults.loading();root.setAttribute('aria-busy','true');refresh();}}
});
window.addEventListener('pageshow',event=>{if(event.persisted)leave();});
document.addEventListener('visibilitychange',visibility);
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
