export const API_VERSION = 'v26.0';
export const ACCOUNT_KEYS = Object.freeze(['followers','reach','impressions','engagements','profileViews']);
export const POST_KEYS = Object.freeze(['reach','impressions','likes','comments','shares','saves','clicks','reactions']);
export const platformLabels = Object.freeze({ instagram:'Instagram', facebook:'Facebook', linkedin:'LinkedIn' });
const labels = {followers:'Seguidores',reach:'Alcance',impressions:'Impressões',engagements:'Interações',profileViews:'Visitas ao perfil',likes:'Curtidas',comments:'Comentários',shares:'Compartilhamentos',saves:'Salvamentos',clicks:'Cliques',reactions:'Reações'};
export const codes = Object.freeze({
 METRICS_RECENT_COVERAGE:'Inclui até 25 publicações retornadas por conta conectada e o histórico do AgendePost; não representa todo o histórico da rede.',
 METRICS_DISABLED:'A coleta automática está desativada pelo operador.',
 METRICS_PAUSED:'O proprietário ainda não ativou a coleta automática desta marca.',
 METRICS_PENDING:'A primeira coleta ainda não foi concluída.',
 METRICS_UNSUPPORTED:'Esta métrica não está disponível no adaptador atual.',
 METRICS_LINKEDIN_UNSUPPORTED:'LinkedIn ainda não possui conexão OAuth e adaptador de métricas neste piloto.',
 METRICS_SCOPE_MISSING:'Reconecte com as permissões necessárias para esta métrica.',
 METRICS_DISCONNECTED:'Conecte novamente a conta social para coletar métricas.',
 METRICS_AUTHORITY_LOST:'O responsável pela autorização ou pela coleta não possui mais acesso válido.',
 METRICS_CONNECTION_CHANGED:'A conexão mudou; uma nova coleta é necessária.',
 METRICS_STALE:'Os últimos números coletados estão desatualizados.',
 METRICS_RATE_LIMIT:'A plataforma limitou as consultas. A coleta aguardará antes de tentar novamente.',
 METRICS_TIMEOUT:'A plataforma não respondeu dentro do prazo. A coleta será tentada novamente.',
 METRICS_PROVIDER_ERROR:'Não foi possível consultar a plataforma. Os últimos números válidos foram preservados.',
 METRICS_RESPONSE_INVALID:'A plataforma retornou dados incompatíveis; nenhum número foi inventado.',
 METRICS_IDENTITY_MISMATCH:'O conteúdo ou a conta não corresponde à conexão autorizada.',
 METRICS_STOPPED:'A coleta foi interrompida com segurança.',
 METRICS_NOT_RETURNED:'A plataforma não retornou um valor para esta métrica.',
 METRICS_HISTORY_WINDOW:'Somente publicações dos últimos 90 dias entram na atualização automática.',
});
export class MetricsError extends Error {
 constructor(code='METRICS_PROVIDER_ERROR',retryAfterMs=0){super(code);this.name='MetricsError';this.code=Object.hasOwn(codes,code)?code:'METRICS_PROVIDER_ERROR';this.retryAfterMs=Number.isFinite(retryAfterMs)?Math.min(86400000,Math.max(0,retryAfterMs)):0;}
}
export const numeric = value => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0 ? value : null;
export const plus = (at,ms) => new Date(Date.parse(at)+ms).toISOString();
export function descriptor(key,{value=null,source=null,period=null,observedAt=null,state='unsupported',code='METRICS_UNSUPPORTED'}={}){
 return {key,label:labels[key]||key,value:numeric(value),unit:'count',period,source,observedAt,state,code};
}
export function emptyMetrics(kind,code='METRICS_UNSUPPORTED',state='unsupported') { return (kind==='account'?ACCOUNT_KEYS:POST_KEYS).map(key=>descriptor(key,{code,state})); }
export function observed(key,value,source,at,period='snapshot') { const n=numeric(value);return descriptor(key,{value:n,source,period,observedAt:at,state:n===null?'unavailable':'available',code:n===null?'METRICS_NOT_RETURNED':null}); }
export function safeMetrics(raw,kind){
 let parsed;try{parsed=typeof raw==='string'?JSON.parse(raw):raw;}catch{return emptyMetrics(kind);}
 const keys=kind==='account'?ACCOUNT_KEYS:POST_KEYS;
 return keys.map(key=>{const m=Array.isArray(parsed)?parsed.find(m=>m?.key===key):null;if(!m)return descriptor(key);return descriptor(key,{
  value:m.value,source:typeof m.source==='string'&&/^(?:instagram|facebook)\.[a-z_.]{1,90}$/.test(m.source)?m.source:null,
  period:['snapshot','lifetime'].includes(m.period)?m.period:null,
  observedAt:typeof m.observedAt==='string'&&Number.isFinite(Date.parse(m.observedAt))?new Date(m.observedAt).toISOString():null,
  state:['available','unavailable','unsupported','scope_missing','stale','error','disconnected','pending'].includes(m.state)?m.state:'unavailable',
  code:m.code===null?null:Object.hasOwn(codes,m.code)?m.code:'METRICS_UNSUPPORTED'
 });});
}
export function safePermalink(value,platform){
 if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020\u007f\\]/u.test(value))return null;
 try{const u=new URL(value),hosts=platform==='instagram'?['www.instagram.com','instagram.com']:platform==='facebook'?['www.facebook.com','facebook.com']:[];
  if(u.protocol!=='https:'||!hosts.includes(u.hostname)||u.username||u.password||u.port)return null;
  if(platform==='instagram'&&!/^\/(?:p|reel|tv)\/[A-Za-z0-9_-]{1,100}\/?$/.test(u.pathname))return null;
  if(platform==='facebook'&&!/^\/(?:[A-Za-z0-9._-]+\/posts\/[A-Za-z0-9._-]+|permalink\.php|photo\.php|[0-9]+)$/.test(u.pathname))return null;
  const clean=new URL(u.origin+u.pathname);if(platform==='facebook')for(const k of ['story_fbid','id','fbid']){const v=u.searchParams.get(k);if(v&&/^[0-9]{1,40}$/.test(v))clean.searchParams.set(k,v);}return clean.href;
 }catch{return null;}
}
