import { scrypt,randomBytes,timingSafeEqual } from 'node:crypto';
import { http } from '../errors.mjs';
const COST={N:131072,r:8,p:1,maxmem:256*1024*1024};
const PREFIX='scrypt$v1$131072$8$1$';
const DUMMY=PREFIX+'780f9a9c014b6d5be9c2c5504b991617$'+'b7'.repeat(64);
const COMMON=new Set(['passwordpassword','password123456789','123456789012345','1234567890123456','qwertyuiopasdfgh','senha123456789012','letmeinletmein123']);
export function validatePassword(password) {
 if(typeof password!=='string'||[...password].length<15||[...password].length>128||Buffer.byteLength(password,'utf8')>512||COMMON.has(password.toLowerCase()))throw http(422,'WEAK_PASSWORD','Use uma senha única de 15 a 128 caracteres.');
}
export function createPasswordHasher({concurrency=2,maxQueue=8}={}) {
 let active=0; const waiting=[];
 async function slot(fn){if(active>=concurrency){if(waiting.length>=maxQueue)throw http(429,'HASH_BUSY','Muitas tentativas. Tente novamente em instantes.');await new Promise(r=>waiting.push(r));}else active++;
  try{return await fn();}finally{const next=waiting.shift();if(next)next();else active--;}}
 const derive=(password,salt)=>slot(()=>new Promise((resolve,reject)=>scrypt(password,salt,64,COST,(err,key)=>err?reject(err):resolve(key))));
 return {async hash(password){validatePassword(password);const salt=randomBytes(16);const key=await derive(password,salt);return PREFIX+salt.toString('hex')+'$'+key.toString('hex');},
 async verify(password,serialized){if(typeof password!=='string'||Buffer.byteLength(password)>512)return false;const valid=typeof serialized==='string'&&/^scrypt\$v1\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(serialized);const parts=(valid?serialized:DUMMY).split('$');const key=await derive(password,Buffer.from(parts[5],'hex'));return timingSafeEqual(key,Buffer.from(parts[6],'hex'))&&valid;},
 stats(){return {active,queued:waiting.length,concurrency,maxQueue,cost:{...COST}};}};
}
export const passwords=createPasswordHasher();
