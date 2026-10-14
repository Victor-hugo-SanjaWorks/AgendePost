import { resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { realpathSync, existsSync, statSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)),'..');
function realFuturePath(path){let current=resolve(path),tail=[];while(!existsSync(current)){const parent=dirname(current);if(parent===current)throw new Error('INVALID_DATA_PATH');tail.unshift(basename(current));current=parent;}return resolve(realpathSync(current),...tail);}
function inside(root,path){const part=relative(root,path);return part===''||(part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part));}
export const isTrustedLoopback=(address,hop=0)=>hop===0&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
export function buildConfig(options={}) {
 for(const name of ['SOCIAL_SAAS_META_CONFIG_FILE','SOCIAL_SAAS_META_OAUTH_CONFIG_FILE','SOCIAL_SAAS_META_ENCRYPTION_KEY_FILE','SOCIAL_SAAS_WHATSAPP_CONFIG_FILE']){
  const filename=process.env[name];if(filename===undefined||filename==='')continue;
  try{if(!isAbsolute(filename)||inside(ROOT,resolve(filename))||inside(realFuturePath(ROOT),realFuturePath(filename))||(existsSync(filename)&&statSync(filename).nlink!==1))throw Error();}
  catch{throw new Error('PRIVATE_CREDENTIAL_PATH_FORBIDDEN');}
 }
 const mode=options.mode || process.env.NODE_ENV || 'development';
 const deployment=options.deployment??process.env.SOCIAL_SAAS_DEPLOYMENT??'local';
 if(!['local','hosted-pilot'].includes(deployment))throw new Error('INVALID_DEPLOYMENT_PROFILE');
 const hosted=deployment==='hosted-pilot';
 // Public production is still refused. The separate hosted profile is an operator-managed,
 // invite-only, one-process Linux pilot with all of the following checks mandatory.
 if(!['development','test'].includes(mode)&&!(mode==='production'&&hosted))throw new Error('PRODUCTION_NOT_READY: explicitly reviewed hosted-pilot configuration required; unrestricted public/commercial deployment is not supported.');
 if(hosted&&mode!=='production'&&mode!=='test')throw new Error('HOSTED_REQUIRES_PRODUCTION_MODE');
 if(hosted&&process.platform!=='linux')throw new Error('HOSTED_REQUIRES_LINUX');
 const host=options.host || process.env.SOCIAL_SAAS_HOST || '127.0.0.1';
 if(host!=='127.0.0.1' && host!=='::1')throw new Error('PILOT_LOOPBACK_ONLY');
 const port=Number(options.port??process.env.SOCIAL_SAAS_PORT??4180);
 if(!Number.isInteger(port)||port<0||port>65535||(port===0&&mode!=='test'))throw new Error('INVALID_PORT');
 const configuredOrigin=options.canonicalOrigin||process.env.SOCIAL_SAAS_ORIGIN;
 if(hosted&&!configuredOrigin)throw new Error('HOSTED_HTTPS_ORIGIN_REQUIRED');
 const canonicalOrigin=configuredOrigin||`http://${host==='::1'?'[::1]':host}:${port}`;
 const u=new URL(canonicalOrigin);
 if(u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw new Error(hosted?'INVALID_HOSTED_ORIGIN':'INVALID_LOOPBACK_ORIGIN');
 if(hosted){
  if(u.protocol!=='https:'||u.port||isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||!u.hostname.split('.').every(s=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(s))||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname))throw new Error('INVALID_HOSTED_ORIGIN');
 }else if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!['http:','https:'].includes(u.protocol))throw new Error('INVALID_LOOPBACK_ORIGIN');
 const trustedProxy=options.trustedProxy??process.env.SOCIAL_SAAS_TRUST_PROXY;
 if(hosted&&trustedProxy!=='loopback')throw new Error('HOSTED_EXPLICIT_LOOPBACK_PROXY_REQUIRED');
 if(!hosted&&trustedProxy)throw new Error('PROXY_REQUIRES_HOSTED_PROFILE');
 const suppliedDataDir=options.dataDir||process.env.SOCIAL_SAAS_DATA_DIR;
 if(hosted&&(!suppliedDataDir||!isAbsolute(suppliedDataDir)))throw new Error('HOSTED_PRIVATE_DATA_DIR_REQUIRED');
 const dataDir=resolve(suppliedDataDir||resolve(ROOT,'data'));
 const realData=realFuturePath(dataDir),publicDir=resolve(ROOT,'public');
 if(inside(publicDir,dataDir)||inside(realFuturePath(publicDir),realData))throw new Error('PUBLIC_DATABASE_PATH_FORBIDDEN');
 if([dataDir,realData].some(path=>/(^|[/\\])social_studio(?:_bootstrap)?([/\\]|$)/.test(path)))throw new Error('LEGACY_DATABASE_PATH_FORBIDDEN');
 if(hosted){
  if(inside(ROOT,dataDir)||inside(realFuturePath(ROOT),realData)||dataDir!==realData)throw new Error('HOSTED_DATA_PATH_UNSAFE');
  // Provision this directory explicitly; never create/chmod an arbitrary path in hosted mode.
  if(!existsSync(dataDir))throw new Error('HOSTED_PRIVATE_DATA_DIR_REQUIRED');
  const st=lstatSync(dataDir);
  if(!st.isDirectory()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.uid!==process.getuid())throw new Error('HOSTED_DATA_DIRECTORY_MUST_BE_PRIVATE_AND_OWNED');
  for(const marker of ['DO-NOT-START.txt','RESTORE-FAILED.txt']){try{lstatSync(resolve(dataDir,marker));throw new Error('HOSTED_RESTORE_REVIEW_REQUIRED');}catch(error){if(error.code!=='ENOENT')throw error;}}
  for(const filename of ['social-saas.sqlite','social-saas.sqlite-wal','social-saas.sqlite-shm']){
   const file=resolve(dataDir,filename);let f;try{f=lstatSync(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
   if(!f.isFile()||f.isSymbolicLink()||f.nlink!==1||(f.mode&0o077)!==0||f.uid!==process.getuid())throw new Error('HOSTED_DATABASE_FILE_UNSAFE');
  }
 }
 for(const [name,error]of [['mailAdapter','TEST_MAIL_ADAPTER_ONLY'],['publishingAdapter','TEST_PUBLISHING_ADAPTER_ONLY'],['publishingWorker','TEST_PUBLISHING_WORKER_OPTIONS_ONLY'],['billingAdapter','TEST_BILLING_ADAPTER_ONLY']])if(options[name]&&mode!=='test')throw new Error(error);
 return {root:ROOT,mode,deployment,hosted,trustProxy:hosted?isTrustedLoopback:false,publishingWorkerEnabled:mode!=='test'&&process.env.SOCIAL_SAAS_PUBLISHING_WORKER==='true',host,port,canonicalOrigin:u.origin,dataDir,secureCookies:u.protocol==='https:',sessionCookie:u.protocol==='https:'?'__Host-ss_session':'ss_dev_session',preauthCookie:u.protocol==='https:'?'__Host-ss_preauth':'ss_dev_preauth',sessionIdleMs:30*60e3,sessionAbsoluteMs:12*60*60e3,preauthMs:15*60e3,authRecentMs:10*60e3,maxTenantsPerUser:3};
}
