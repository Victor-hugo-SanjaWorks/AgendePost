import Fastify, {LogController} from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildConfig, isTrustedLoopback } from './config.mjs';
import { isIP } from 'node:net';
import { openDatabase } from './db.mjs';
import { errors } from './errors.mjs';
import { addSharedServices } from './context.mjs';
import { initializeAuth } from './auth/context.mjs';
import { initializeMail } from './mail.mjs';
import { registerAuth } from './auth/routes.mjs';
import { registerTenants } from './tenants/routes.mjs';
import { initializeCommercial,registerCommercial } from './commercial/index.mjs';
import { registerEditorial } from './editorial/index.mjs';
import { initializePublishing, registerPublishing } from './publishing/index.mjs';
import { registerStrategy } from './strategy/index.mjs';
import { initializeClientApprovals,registerClientApprovals } from './client-approvals/index.mjs';
import { initializeWhatsAppNotifications,registerWhatsAppNotifications } from './whatsapp-notifications/index.mjs';
import { initializeSocialMetrics } from './social-metrics/index.mjs';
import { initializeClientDashboard,registerClientDashboard } from './client-dashboard/index.mjs';
import { initializeSocialConnections, registerSocialConnections } from './social-connections/index.mjs';
export async function createApp(options={}) {
 const config=buildConfig(options);
 const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===24&&minor<19))throw new Error('NODE_VERSION_INCOMPATIBLE');
 const app=Fastify({bodyLimit:64*1024,trustProxy:config.trustProxy,requestTimeout:30000,connectionTimeout:15000,keepAliveTimeout:5000,routerOptions:{maxParamLength:200},
  logger:options.logger??(config.mode==='test'?false:{level:'info',redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]','password','token','secret'],serializers:{req(req){return {method:req.method,remoteAddress:req.ip};},res(reply){return {statusCode:reply.statusCode};},err(err){return {code:err.code||'INTERNAL'};}}}),
  genReqId:()=>randomUUID(),requestIdHeader:false,logController:new LogController({disableRequestLogging:true}),
 });
 const validators={body:new Ajv({removeAdditional:false,coerceTypes:false,useDefaults:false,allErrors:false,strict:false}),other:new Ajv({removeAdditional:false,coerceTypes:true,useDefaults:true,allErrors:false,strict:false})};
 app.setValidatorCompiler(({schema,httpPart})=>(httpPart==='body'?validators.body:validators.other).compile(schema));
 const {db,transaction,filename}=openDatabase(config,options.migrationsDir?{migrationsDir:options.migrationsDir}:{});
 const now=()=>{const d=options.clock?options.clock():Date.now();const date=d instanceof Date?d:new Date(d);if(!Number.isFinite(date.getTime()))throw new Error('INVALID_CLOCK');return date.toISOString();};
 const ctx={db,transaction,filename,now,config,errors,services:{},caps:{pilot:true,hostedPilot:config.hosted,publicRegistration:!config.hosted,emailDelivery:config.hosted?'operator_assisted':'operator_outbox',socialPublishing:false,billing:false,publicLaunchReady:false}};
 app.decorate('ctx',ctx);app.decorateRequest('user',null);app.decorateRequest('session',null);app.decorateRequest('tenant',null);
 if(config.hosted&&db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n){db.close();throw new Error('HOSTED_LEGACY_OUTBOX_FORBIDDEN: use a new hosted database, not development data.');}
 addSharedServices(ctx);initializeAuth(ctx);ctx.mail=initializeMail(ctx,options.mailAdapter);initializeCommercial(ctx,{billingAdapter:options.billingAdapter});initializeSocialConnections(ctx,options);initializePublishing(ctx,options);initializeSocialMetrics(ctx,options);initializeClientDashboard(ctx);initializeClientApprovals(ctx);initializeWhatsAppNotifications(ctx,options);
 app.addHook('onClose',async()=>{await ctx.services.socialMetrics?.stop();await ctx.services.publishing.worker.stop();db.close();});
 try{
 await app.register(cookie);
 await app.register(helmet,{global:true,contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],imgSrc:["'self'",'blob:','data:'],connectSrc:["'self'"],fontSrc:["'self'"],objectSrc:["'none'"],baseUri:["'self'"],frameAncestors:["'none'"],formAction:["'self'"],upgradeInsecureRequests:null}},crossOriginEmbedderPolicy:false,referrerPolicy:{policy:'no-referrer'},strictTransportSecurity:config.secureCookies?undefined:false});
 await app.register(rateLimit,{global:true,max:300,timeWindow:60000,keyGenerator:req=>req.ip,cache:10000,errorResponseBuilder:()=>errors.http(429,'RATE_LIMITED','Muitas solicitações. Tente novamente em instantes.')});
 app.addHook('onRequest',async(req,reply)=>{
  reply.header('x-request-id',req.id);
  if(req.url.startsWith('/api/')||req.url.startsWith('/health/')||req.url.startsWith('/client-dashboard')||req.url.startsWith('/approval'))reply.header('cache-control','no-store');
  if(req.url.startsWith('/client-dashboard')||req.url.startsWith('/approval'))reply.header('x-robots-tag','noindex, nofollow, noarchive').header('referrer-policy','no-referrer');
  const allowed=new Set([new URL(config.canonicalOrigin).host]);if(config.mode==='test'&&!config.hosted){allowed.add('localhost');allowed.add('localhost:80');}
  if(!allowed.has(req.headers.host))throw errors.http(400,'HOST_REJECTED','Host inválido.');
  if(config.hosted){
   // Exactly one local proxy hop. Reject client-supplied chains and alternative host headers.
   if(!isTrustedLoopback(req.raw.socket.remoteAddress)||req.headers['x-forwarded-proto']!=='https'||typeof req.headers['x-forwarded-for']!=='string'||!isIP(req.headers['x-forwarded-for'])||req.headers.forwarded!==undefined||req.headers['x-forwarded-host']!==undefined)throw errors.http(400,'PROXY_REJECTED','Proxy HTTPS inválido.');
   if(['/api/v1/auth/register','/api/v1/auth/email/resend','/api/v1/auth/password/forgot'].includes(req.routeOptions.url))throw errors.http(404,'NOT_FOUND','Recurso não encontrado.');
   reply.header('x-robots-tag','noindex, nofollow, noarchive');
  }

  // Unknown routes cannot mutate. Keep the disabled webhook indistinguishable from any absent endpoint.
  if(req.is404)return;
  await ctx.auth.guard(req,reply);
 });
 app.setErrorHandler((err,req,reply)=>{
  let status=err.isPublic?err.statusCode:err.validation?422:err.statusCode>=400&&err.statusCode<500?err.statusCode:500;
  let code=err.isPublic?err.code:err.validation?'VALIDATION_ERROR':status===413?'BODY_TOO_LARGE':status===429?'RATE_LIMITED':status===415?'UNSUPPORTED_MEDIA_TYPE':status===400?'BAD_REQUEST':'INTERNAL_ERROR';
  const message=err.isPublic?err.message:err.validation?'Dados inválidos ou campos não permitidos.':status===413?'Corpo da solicitação excede o limite.':status===429?'Muitas solicitações. Aguarde para tentar novamente.':status===415?'Formato da solicitação não permitido.':status===400?'Solicitação inválida.':'Não foi possível concluir a solicitação.';
  if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.user&&status<500){try{ctx.audit({tenantId:req.tenant?.id??null,actorId:req.user.id,action:'request.denied',targetType:'request',outcome:'denied',safeChanges:{method:req.method,route:req.routeOptions?.url||'unknown',code},requestId:req.id});}catch{}}
  if(status===500)app.log.error({code:err.code||'INTERNAL_ERROR',requestId:req.id},'Request failed');
  reply.code(status).header('cache-control','no-store').send({error:{code,message,...(err.isPublic&&err.fields?{fields:err.fields}:{})},requestId:req.id});
 });
 app.setNotFoundHandler((_req,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:'Recurso não encontrado.'},requestId:_req.id}));
 app.get('/health/live',async()=>({data:{status:'ok'}}));
 app.get('/health/ready',async()=>{db.prepare('SELECT 1').get();const p=ctx.services.publishing;if(config.hosted&&p.workerExpected&&(!p.adapter.enabled||!p.worker.running||!p.workerStatus().running))throw errors.http(503,'WORKER_UNAVAILABLE','Serviço de publicação indisponível.');return {data:{status:'ok'}};});
 await registerAuth(app,ctx);await registerSocialConnections(app,ctx);await registerCommercial(app,ctx);await registerTenants(app,ctx);await registerEditorial(app,ctx);await registerPublishing(app,ctx);await registerStrategy(app,ctx);await registerClientDashboard(app,ctx);await registerClientApprovals(app,ctx);await registerWhatsAppNotifications(app,ctx);
 await app.register(staticFiles,{root:resolve(config.root,'public'),prefix:'/',index:false,wildcard:false,decorateReply:true,cacheControl:false,dotfiles:'deny'});
 app.get('/',async(_req,reply)=>reply.header('cache-control','no-store').sendFile('index.html'));
 app.get('/app',async(_req,reply)=>reply.header('cache-control','no-store').sendFile('index.html'));
 await app.ready();ctx.services.publishing.startWorker();ctx.services.socialMetrics.start();return app;
 }catch(error){await app.close();throw error;}
}
