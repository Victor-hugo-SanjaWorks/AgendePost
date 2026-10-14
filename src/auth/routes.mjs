import { passwords,validatePassword } from './passwords.mjs';
import { id,token,digest,plus,normalizeEmail,publicUser,object,str,emailSchema,passwordSchema,tokenSchema } from './utils.mjs';
export async function registerAuth(app,ctx){
 const {db,auth,errors,config,now}=ctx;
 const authBody=(properties,required)=>({bodyLimit:4096,schema:{body:object(properties,required)}});
 const buckets=new Map();
 function throttle(req,email,group='auth'){
  const time=Date.parse(now());for(const [key,v]of buckets)if(v.end<=time)buckets.delete(key);
  if(buckets.size>10000)throw errors.http(429,'RATE_LIMITED','Muitas tentativas. Aguarde para tentar novamente.');
  for(const [key,max,ttl]of [[`${group}:ip:${req.ip}`,30,60000],[`${group}:email:${digest(email)}`,10,15*60000]]){
   let b=buckets.get(key);if(!b||b.end<=time){b={count:0,end:time+ttl};buckets.set(key,b);}if(++b.count>max)throw errors.http(429,'RATE_LIMITED','Muitas tentativas. Aguarde para tentar novamente.');
  }
 }
 const generic=()=>({data:{ok:true,emailDelivery:'operator_outbox',message:'Se os dados forem elegíveis, um link de teste estará no terminal do operador. Nenhum email externo foi enviado.'}});
 function issueToken(user,purpose){const raw=token(),at=now(),expiresAt=plus(at,purpose==='email_verify'?24*60*60e3:60*60e3);db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE user_id=? AND purpose=? AND consumed_at IS NULL').run(at,user.id,purpose);db.prepare('INSERT INTO auth_tokens(token_hash,user_id,purpose,created_at,expires_at) VALUES(?,?,?,?,?)').run(digest(raw),user.id,purpose,at,expiresAt);ctx.mail.enqueue({to:user.email_normalized,purpose,token:raw,url:`${config.canonicalOrigin}/app#${purpose==='email_verify'?'verify':'reset'}?token=${raw}`,expiresAt});}
 function memberships(userId){return db.prepare("SELECT t.id,t.name,t.slug,t.timezone,m.role,m.scope FROM memberships m JOIN tenants t ON t.id=m.tenant_id WHERE m.user_id=? AND m.status='active' ORDER BY t.name,t.id").all(userId);}
 app.get('/api/v1/auth/session',async(req,reply)=>{
  reply.header('cache-control','no-store');const s=req.session||auth.createPreauth(req,reply);
  return {data:{user:req.user||null,csrfToken:s.csrf_token,mode:config.mode,capabilities:{...ctx.caps,platformAdmin:!!req.user&&!!db.prepare("SELECT user_id FROM platform_admins WHERE user_id=? AND status='active'").get(req.user.id)},tenants:req.user?memberships(req.user.id):[]}};
 });
 if(!config.hosted)app.post('/api/v1/auth/register',authBody({email:emailSchema,displayName:str(1,100)},['email','displayName']),async(req)=>{
  const email=normalizeEmail(req.body.email),name=req.body.displayName.trim();if(!name)throw errors.http(422,'INVALID_NAME','Informe seu nome.');throttle(req,email,'mail');
  ctx.transaction(()=>{const found=db.prepare('SELECT id FROM users WHERE email_normalized=?').get(email);if(found)return;if(db.prepare("SELECT COUNT(*) AS n FROM users WHERE status='pending'").get().n>=10000)throw errors.http(429,'REGISTRATION_CAPACITY','Aguarde para tentar novamente.');const user={id:id(),email_normalized:email};db.prepare("INSERT INTO users(id,email_normalized,display_name,status,created_at) VALUES(?,?,?,'pending',?)").run(user.id,email,name,now());issueToken(user,'email_verify');ctx.audit({actorId:user.id,action:'auth.register',targetType:'user',targetId:user.id,requestId:req.id});});await ctx.mail.flush();return generic();
 });
 if(!config.hosted)app.post('/api/v1/auth/email/resend',authBody({email:emailSchema},['email']),async(req)=>{const email=normalizeEmail(req.body.email);throttle(req,email,'mail');ctx.transaction(()=>{const user=db.prepare("SELECT * FROM users WHERE email_normalized=? AND status='pending'").get(email);if(user)issueToken(user,'email_verify');});await ctx.mail.flush();return generic();});
 app.post('/api/v1/auth/email/verify',authBody({token:tokenSchema,password:passwordSchema},['token','password']),async(req)=>{
  throttle(req,digest(req.body.token),'verify');validatePassword(req.body.password);
  const hash=await passwords.hash(req.body.password);
  ctx.transaction(()=>{const at=now(),t=db.prepare("SELECT t.*,u.status FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose='email_verify' AND t.consumed_at IS NULL AND t.expires_at>?").get(digest(req.body.token),at);if(!t||t.status!=='pending')throw errors.http(422,'INVALID_TOKEN','Link inválido, expirado ou já utilizado.');const changed=db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(at,t.token_hash);if(changed.changes!==1)throw errors.http(422,'INVALID_TOKEN','Link inválido, expirado ou já utilizado.');db.prepare("UPDATE users SET password_hash=?,email_verified_at=?,status='active',session_epoch=session_epoch+1 WHERE id=? AND status='pending'").run(hash,at,t.user_id);db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL').run(at,t.user_id);ctx.audit({actorId:t.user_id,action:'auth.email_verified',targetType:'user',targetId:t.user_id,requestId:req.id});});
  return {data:{ok:true,message:'Conta verificada no piloto. Entre com sua senha.'}};
 });
 app.post('/api/v1/auth/login',authBody({email:emailSchema,password:passwordSchema},['email','password']),async(req,reply)=>{
  const email=normalizeEmail(req.body.email);throttle(req,email,'login');const user=db.prepare('SELECT * FROM users WHERE email_normalized=?').get(email);const valid=await passwords.verify(req.body.password,user?.password_hash);
  if(!valid||user?.status!=='active'||!user?.email_verified_at){ctx.audit({action:'auth.login_failed',targetType:'session',outcome:'denied',requestId:req.id});throw errors.http(401,'INVALID_CREDENTIALS','Email ou senha inválidos.');}
  const result=ctx.transaction(()=>{const fresh=db.prepare("SELECT * FROM users WHERE id=? AND status='active' AND password_hash=? AND session_epoch=?").get(user.id,user.password_hash,user.session_epoch);if(!fresh)throw errors.http(401,'INVALID_CREDENTIALS','Email ou senha inválidos.');const result=auth.newSession(fresh,req);ctx.audit({actorId:user.id,action:'auth.login',targetType:'session',requestId:req.id});return result;});auth.setSessionCookie(reply,result.raw);return {data:{user:publicUser(user),csrfToken:result.csrfToken}};
 });
 app.post('/api/v1/auth/logout',{...authBody({},[])},async(req,reply)=>{
  if(req.session)ctx.transaction(()=>{db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(now(),req.session.token_hash);ctx.audit({actorId:req.user.id,action:'auth.logout',targetType:'session',requestId:req.id});});auth.clearSessionCookie(reply);const pre=auth.createPreauth(req,reply,{rotate:true});return {data:{ok:true,csrfToken:pre.csrf_token}};
 });
 app.post('/api/v1/auth/logout-all',{...authBody({},[]),preHandler:auth.requireUser},async(req,reply)=>{
  ctx.transaction(()=>{auth.requireFresh(req);auth.revokeUser(req.user.id);ctx.audit({actorId:req.user.id,action:'auth.logout_all',targetType:'user',targetId:req.user.id,requestId:req.id});});auth.clearSessionCookie(reply);const pre=auth.createPreauth(req,reply,{rotate:true});return {data:{ok:true,csrfToken:pre.csrf_token}};
 });
 app.post('/api/v1/auth/reauthenticate',{...authBody({password:passwordSchema},['password']),preHandler:auth.requireUser},async(req)=>{
  throttle(req,req.user.email,'reauth');const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);const valid=await passwords.verify(req.body.password,user.password_hash);if(!valid)throw errors.http(401,'INVALID_CREDENTIALS','Senha inválida.');ctx.transaction(()=>{auth.requireFresh(req);const fresh=db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);if(fresh.password_hash!==user.password_hash)throw errors.http(401,'AUTH_REQUIRED','Entre novamente.');db.prepare('UPDATE sessions SET auth_at=? WHERE token_hash=?').run(now(),req.session.token_hash);ctx.audit({actorId:user.id,action:'auth.reauthenticated',targetType:'session',requestId:req.id});});return {data:{ok:true}};
 });
 if(!config.hosted)app.post('/api/v1/auth/password/forgot',authBody({email:emailSchema},['email']),async(req)=>{
  const email=normalizeEmail(req.body.email);throttle(req,email,'mail');ctx.transaction(()=>{const user=db.prepare("SELECT * FROM users WHERE email_normalized=? AND status='active'").get(email);if(user)issueToken(user,'password_reset');});await ctx.mail.flush();return generic();
 });
 app.post('/api/v1/auth/password/reset',authBody({token:tokenSchema,password:passwordSchema},['token','password']),async(req,reply)=>{
  throttle(req,digest(req.body.token),'reset');validatePassword(req.body.password);const hash=await passwords.hash(req.body.password);
  ctx.transaction(()=>{const at=now(),t=db.prepare("SELECT t.* FROM auth_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.purpose='password_reset' AND t.consumed_at IS NULL AND t.expires_at>? AND u.status='active'").get(digest(req.body.token),at);if(!t)throw errors.http(422,'INVALID_TOKEN','Link inválido, expirado ou já utilizado.');const consumed=db.prepare('UPDATE auth_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(at,t.token_hash);if(consumed.changes!==1)throw errors.http(422,'INVALID_TOKEN','Link inválido, expirado ou já utilizado.');db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,t.user_id);auth.revokeUser(t.user_id);ctx.audit({actorId:t.user_id,action:'auth.password_reset',targetType:'user',targetId:t.user_id,requestId:req.id});});auth.clearSessionCookie(reply);const pre=auth.createPreauth(req,reply,{rotate:true});return {data:{ok:true,csrfToken:pre.csrf_token}};
 });
 app.post('/api/v1/auth/password/change',{...authBody({currentPassword:passwordSchema,password:passwordSchema},['currentPassword','password']),preHandler:auth.requireUser},async(req,reply)=>{
  throttle(req,req.user.email,'password');validatePassword(req.body.password);const user=db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);if(!await passwords.verify(req.body.currentPassword,user.password_hash))throw errors.http(401,'INVALID_CREDENTIALS','Senha atual inválida.');const hash=await passwords.hash(req.body.password);
  ctx.transaction(()=>{auth.requireFresh(req);const changed=db.prepare('UPDATE users SET password_hash=? WHERE id=? AND password_hash=? AND session_epoch=?').run(hash,user.id,user.password_hash,user.session_epoch);if(changed.changes!==1)throw errors.http(401,'AUTH_REQUIRED','Entre novamente.');auth.revokeUser(user.id);ctx.audit({actorId:user.id,action:'auth.password_changed',targetType:'user',targetId:user.id,requestId:req.id});});auth.clearSessionCookie(reply);const pre=auth.createPreauth(req,reply,{rotate:true});return {data:{ok:true,csrfToken:pre.csrf_token}};
 });
 app.get('/api/v1/me',{preHandler:auth.requireUser},async(req)=>({data:req.user}));
 app.get('/api/v1/me/tenants',{preHandler:auth.requireUser},async(req)=>({data:memberships(req.user.id)}));
}
