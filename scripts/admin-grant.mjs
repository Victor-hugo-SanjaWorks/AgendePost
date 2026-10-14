import { buildConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { addSharedServices } from '../src/context.mjs';
import { normalizeEmail } from '../src/auth/utils.mjs';
const args=process.argv.slice(2),at=args.indexOf('--email');
if(at<0||!args[at+1]||!args.includes('--confirm-local-operator')){console.error('Usage: npm run admin:grant -- --email VERIFIED_EMAIL --confirm-local-operator\nGrants operational metadata access, not tenant/editorial access. No password, provider or worker is started.');process.exit(1);}
const config=buildConfig(),{db,transaction}=openDatabase(config),ctx={db,transaction,now:()=>new Date().toISOString()},email=normalizeEmail(args[at+1]);addSharedServices(ctx);
try{transaction(()=>{const u=db.prepare("SELECT id FROM users WHERE email_normalized=? AND status='active' AND email_verified_at IS NOT NULL").get(email);if(!u)throw new Error('A verified, active user is required.');db.prepare("INSERT INTO platform_admins(user_id,status,created_at,created_by) VALUES(?,'active',?,NULL) ON CONFLICT(user_id) DO UPDATE SET status='active'").run(u.id,ctx.now());ctx.audit({actorId:u.id,action:'platform_admin.operator_granted',targetType:'user',targetId:u.id,safeChanges:{source:'operator-cli'}});});console.log('Operator grant recorded. Public commercial launch is not enabled.');}finally{db.close();}
