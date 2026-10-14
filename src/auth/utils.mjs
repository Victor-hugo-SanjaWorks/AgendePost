import { createHash,randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { http } from '../errors.mjs';
export const id=()=>randomUUID();
export const token=()=>randomBytes(32).toString('base64url');
export const digest=(value)=>createHash('sha256').update(value).digest('hex');
export const plus=(iso,ms)=>new Date(Date.parse(iso)+ms).toISOString();
export function safeEqual(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
export function normalizeEmail(value){if(typeof value!=='string')throw http(422,'INVALID_EMAIL','Email inválido.');const raw=value.trim(),at=raw.lastIndexOf('@'),local=raw.slice(0,at),domain=domainToASCII(raw.slice(at+1)).toLowerCase();if(at<1||!domain.includes('.')||!local||local.length>64||/\s|[<>"(),;:@\\[\]]/.test(local)||local.startsWith('.')||local.endsWith('.')||local.includes('..')||!domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||domain.length>253||Buffer.byteLength(raw)>254)throw http(422,'INVALID_EMAIL','Email inválido.');return local.toLowerCase()+'@'+domain;}
export const publicUser=(row)=>({id:row.id,email:row.email_normalized,displayName:row.display_name,emailVerified:!!row.email_verified_at});
export const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
export const str=(minLength=1,maxLength=200)=>({type:'string',minLength,maxLength});
export const tokenSchema={type:'string',pattern:'^[A-Za-z0-9_-]{43}$'};
export const emailSchema=str(3,254);
export const passwordSchema=str(1,128);
export function timeZone(value){try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format();return value;}catch{throw http(422,'INVALID_TIMEZONE','Fuso horário IANA inválido.');}}
export function pagination(query={}) {let limit=query.limit===undefined?50:Number(query.limit);if(!Number.isInteger(limit)||limit<1||limit>100)throw http(422,'INVALID_PAGINATION','Limite inválido.');let after='';if(query.cursor){try{const decoded=Buffer.from(query.cursor,'base64url').toString();if(!/^[a-f0-9-]{36}$/.test(decoded)||Buffer.from(decoded).toString('base64url')!==query.cursor)throw 0;after=decoded;}catch{throw http(422,'INVALID_CURSOR','Cursor inválido.');}}return {limit,after};}
export const cursorFor=(value)=>Buffer.from(value).toString('base64url');
