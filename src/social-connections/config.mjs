import { constants,openSync,fstatSync,readSync,closeSync,realpathSync } from 'node:fs';
import { isAbsolute,relative,sep } from 'node:path';
export const API_VERSION='v26.0';
export const CALLBACK_PATH='/api/v1/social-connections/meta/callback';
export class OAuthError extends Error { constructor(code='META_OAUTH_FAILED'){super(code);this.code=code;} }
const invalid=()=>{throw new OAuthError('META_OAUTH_CONFIG_INVALID');};
const inside=(root,path)=>{const r=relative(root,path);return r===''||(r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r));};
/** Private regular file, no symlinks, restrictive owner-only permissions. Never read through HTTP. */
function readPrivate(filename,maxBytes,config){
 if(typeof filename!=='string'||!isAbsolute(filename)||filename.length>4096)invalid();
 let fd;
 try{
  const real=realpathSync(filename);if(config.root&&inside(realpathSync(config.root),real))invalid();
  fd=openSync(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const st=fstatSync(fd);
  // POSIX mode bits do not attest NTFS ACLs: fail closed on Windows until a reviewed secret-store backend exists.
  if(process.platform==='win32'||!st.isFile()||st.nlink!==1||st.size<1||st.size>maxBytes||(st.mode&0o077)||typeof process.getuid==='function'&&st.uid!==process.getuid())invalid();
  const b=Buffer.alloc(maxBytes+1);let n=0,r;do{r=readSync(fd,b,n,b.length-n,null);n+=r;}while(r&&n<b.length);if(n>maxBytes)invalid();return b.subarray(0,n).toString('utf8');
 }catch{invalid();}finally{if(fd!==undefined)closeSync(fd);}
}
function validate(raw,key,appConfig){
 if(!raw||raw.enabled!==true||raw.apiVersion!==API_VERSION||typeof raw.appId!=='string'||!/^\d{1,40}$/.test(raw.appId)||typeof raw.appSecret!=='string'||!/^[a-fA-F0-9]{32,128}$/.test(raw.appSecret)||!Buffer.isBuffer(key)||key.length!==32)invalid();
 if(raw.loginConfigId!==undefined&&(typeof raw.loginConfigId!=='string'||!(/^[1-9][0-9]{0,39}$/).test(raw.loginConfigId)))invalid();
 if(raw.tokenFlow!==undefined&&raw.tokenFlow!=='user')invalid();
 let u;try{u=new URL(raw.redirectUri);}catch{invalid();}
 if(u.protocol!=='https:'||u.pathname!==CALLBACK_PATH||u.search||u.hash||u.username||u.password||u.origin!==appConfig.canonicalOrigin||!appConfig.secureCookies)invalid();
 if(raw.requestTimeoutMs!==undefined&&(!Number.isInteger(raw.requestTimeoutMs)||raw.requestTimeoutMs<100||raw.requestTimeoutMs>30000))invalid();
 return Object.freeze({enabled:true,apiVersion:API_VERSION,...(raw.loginConfigId?{loginConfigId:raw.loginConfigId}:{}),tokenFlow:'user',appId:raw.appId,appSecret:raw.appSecret,redirectUri:u.href,key:Buffer.from(key),requestTimeoutMs:raw.requestTimeoutMs??15000});
}
/** Inline config and injected transport are test-only. No generated fallback key or persistent credentials. */
export function buildSocialConnectionConfig(appConfig,options={}){
 try{
  if(options.metaOAuthConfig!==undefined||options.metaOAuthFetch!==undefined){
   if(appConfig.mode!=='test')invalid();
   if(options.metaOAuthConfig===undefined)return {enabled:false,code:'META_OAUTH_NOT_CONFIGURED'};
   return validate(options.metaOAuthConfig,options.metaOAuthConfig.encryptionKey,appConfig);
  }
  const env=process.env;if(env.SOCIAL_SAAS_META_OAUTH_ENABLED!=='true')return {enabled:false,code:'META_OAUTH_NOT_CONFIGURED'};
  const raw=JSON.parse(readPrivate(env.SOCIAL_SAAS_META_OAUTH_CONFIG_FILE,16384,appConfig));
  const encoded=readPrivate(env.SOCIAL_SAAS_META_ENCRYPTION_KEY_FILE,256,appConfig).trim();
  if(!/^[A-Za-z0-9+/]{43}=$/.test(encoded))invalid();
  return validate(raw,Buffer.from(encoded,'base64'),appConfig);
 }catch{return {enabled:false,code:'META_OAUTH_CONFIG_INVALID'};}
}
