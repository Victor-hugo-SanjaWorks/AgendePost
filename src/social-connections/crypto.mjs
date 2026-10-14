import { randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { OAuthError } from './config.mjs';
/** AAD binds ciphertext to record, session/tenant/brand/channel purpose; swapping rows fails authentication. */
export function encryptPayload(key,payload,binding){
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(binding));
 const ciphertext=Buffer.concat([cipher.update(JSON.stringify(payload),'utf8'),cipher.final()]);
 return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:ciphertext.toString('base64')});
}
export function decryptPayload(key,encrypted,binding){
 try{const e=JSON.parse(encrypted);if(e.v!==1||Object.keys(e).sort().join(',')!=='data,iv,tag,v')throw Error();const iv=Buffer.from(e.iv,'base64'),tag=Buffer.from(e.tag,'base64');if(iv.length!==12||tag.length!==16)throw Error();const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(binding));cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(Buffer.from(e.data,'base64')),cipher.final()]).toString('utf8'));}catch{throw new OAuthError('META_OAUTH_CREDENTIAL_UNAVAILABLE');}
}
export const pendingBinding=r=>JSON.stringify(['meta-pending-v1',r.id,r.tenant_id,r.workspace_id,r.channel_id,r.user_id,r.session_hash]);
export const connectionBinding=r=>JSON.stringify(['meta-connection-v1',r.id,r.tenant_id,r.workspace_id,r.channel_id,r.platform,r.account_id,r.page_id,r.authorization_version]);
