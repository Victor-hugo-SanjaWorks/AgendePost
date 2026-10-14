import { openDatabase } from './db.mjs';
import { addSharedServices } from './context.mjs';
import { id,token,digest,plus,normalizeEmail } from './auth/utils.mjs';
/** Operator-side issuance only. Does not initialize the HTTP server, provider, or worker.
 * The caller must verify the recipient's identity/address through a trusted channel.
 * Returned URL is a bearer credential: deliver privately; never log or save it. */
export function issueOperatorAccess(config,{email,displayName,purpose,invitationId},clock=()=>Date.now()){
 if(!config.hosted)throw new Error('HOSTED_OPERATOR_PROFILE_REQUIRED');
 if(!['enroll','reset','invitation'].includes(purpose))throw new Error('INVALID_OPERATOR_PURPOSE');
 const normalized=normalizeEmail(email),at=new Date(clock()).toISOString();
 const {db,transaction}=openDatabase(config);
 const ctx={db,transaction,now:()=>at};addSharedServices(ctx);
 try{return transaction(()=>{
  if(db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n)throw new Error('HOSTED_LEGACY_OUTBOX_FORBIDDEN');
  const raw=token();
  if(purpose==='invitation'){
   if(typeof invitationId!=='string'||!invitationId)throw new Error('INVITATION_ID_REQUIRED');
   const row=db.prepare("SELECT i.*,t.status AS tenant_status FROM invitations i JOIN tenants t ON t.id=i.tenant_id WHERE i.id=? AND i.email_normalized=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>?").get(invitationId,normalized,at);
   if(!row||row.tenant_status!=='active')throw new Error('ACTIVE_MATCHING_INVITATION_REQUIRED');
   const inviter=db.prepare("SELECT m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active'").get(row.tenant_id,row.invited_by);
   if(!inviter||!['owner','admin'].includes(inviter.role)||(inviter.role==='admin'&&['owner','admin'].includes(row.role)))throw new Error('INVITER_AUTHORITY_CHANGED');
   const expiresAt=[row.expires_at,plus(at,60*60e3)].sort()[0];
   db.prepare('UPDATE invitations SET token_hash=?,expires_at=? WHERE id=?').run(digest(raw),expiresAt,row.id);
   ctx.audit({tenantId:row.tenant_id,action:'invitation.operator_link_issued',targetType:'invitation',targetId:row.id,safeChanges:{source:'operator-cli'}});
   return {purpose,email:normalized,expiresAt,url:`${config.canonicalOrigin}/app#invitation?token=${raw}`};
  }
  let user=db.prepare('SELECT * FROM users WHERE email_normalized=?').get(normalized);
  if(purpose==='enroll'){
   if(user&&user.status!=='pending')throw new Error('ACCOUNT_ALREADY_ACTIVE_OR_BLOCKED');
   if(typeof displayName!=='string'||!displayName.trim()||displayName.trim().length>100)throw new Error('DISPLAY_NAME_REQUIRED');
   if(!user){
    if(db.prepare('SELECT count(*) AS n FROM users').get().n>=50)throw new Error('HOSTED_PILOT_ACCOUNT_LIMIT');
    user={id:id(),email_normalized:normalized};
    db.prepare("INSERT INTO users(id,email_normalized,display_name,status,created_at) VALUES(?,?,?,'pending',?)").run(user.id,normalized,displayName.trim(),at);
   }
  }else if(!user||user.status!=='active'||!user.email_verified_at)throw new Error('VERIFIED_ACTIVE_ACCOUNT_REQUIRED');
  const tokenPurpose=purpose==='enroll'?'email_verify':'password_reset',expiresAt=plus(at,purpose==='enroll'?60*60e3:30*60e3);
  db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE user_id=? AND purpose=? AND consumed_at IS NULL').run(at,user.id,tokenPurpose);
  db.prepare('INSERT INTO auth_tokens(token_hash,user_id,purpose,created_at,expires_at) VALUES(?,?,?,?,?)').run(digest(raw),user.id,tokenPurpose,at,expiresAt);
  ctx.audit({action:`auth.operator_${purpose}_issued`,targetType:'user',targetId:user.id,safeChanges:{source:'operator-cli'}});
  return {purpose,email:normalized,expiresAt,url:`${config.canonicalOrigin}/app#${purpose==='enroll'?'verify':'reset'}?token=${raw}`};
 });}finally{db.close();}
}
