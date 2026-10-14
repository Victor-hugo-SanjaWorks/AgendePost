import { id } from './auth/utils.mjs';
export function initializeMail(ctx,adapter) {
 if(ctx.config.hosted)return {mode:'operator_assisted',enqueue(message){if(message.purpose!=='invitation')throw new Error('HOSTED_PUBLIC_TOKEN_ISSUANCE_FORBIDDEN');return id();},async flush(){}};
 let delivered=new Set();
 return { enqueue({to,purpose,token,url,expiresAt,tenantId}){const message={id:id(),to,purpose,token,url,createdAt:ctx.now(),expiresAt,...(tenantId?{tenantId}:{})};ctx.db.prepare('DELETE FROM mail_outbox WHERE expires_at<=?').run(ctx.now());if(ctx.db.prepare('SELECT COUNT(*) AS n FROM mail_outbox').get().n>=10000)throw ctx.errors.http(429,'OUTBOX_CAPACITY','Aguarde e tente novamente.');ctx.db.prepare('INSERT INTO mail_outbox VALUES(?,?,?,?,?,?)').run(message.id,to,purpose,JSON.stringify(message),message.createdAt,expiresAt);return message.id;},
 async flush(){if(!adapter)return;const rows=ctx.db.prepare('SELECT id,payload_json FROM mail_outbox ORDER BY created_at,id').all();for(const row of rows){if(delivered.has(row.id))continue;const msg=JSON.parse(row.payload_json);if(typeof adapter==='function')await adapter(msg);else if(typeof adapter.send==='function')await adapter.send(msg);else throw new Error('INVALID_TEST_MAIL_ADAPTER');delivered.add(row.id);}},
 mode:'operator_outbox'};
}
