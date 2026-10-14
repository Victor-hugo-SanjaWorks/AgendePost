import { createApp } from './src/app.mjs';
const app=await createApp();
let watchdog,stopping=false;
async function stop(code=0){if(stopping)return;stopping=true;clearInterval(watchdog);try{await app.close();}finally{process.exit(code);}}
try{
 await app.listen({host:app.ctx.config.host,port:app.ctx.config.port});
 process.stdout.write(app.ctx.config.hosted?`AgendePost hosted pilot: ${app.ctx.config.canonicalOrigin}\nInvite-only. TLS proxy and operator setup required. Meta remains disabled until separately configured.\n`:`AgendePost local: ${app.ctx.config.canonicalOrigin}\nNão expor o perfil local à internet.\n`);
 if(app.ctx.config.hosted&&app.ctx.services.publishing.workerExpected){
  watchdog=setInterval(()=>{
   if(stopping)return;const p=app.ctx.services.publishing;let healthy=false;
   try{healthy=p.adapter.enabled&&p.worker.running&&p.workerStatus().running;}catch{}
   if(!healthy){app.log.error({code:'PUBLISHING_WATCHDOG_FAILED'},'Publishing service unavailable; exiting for supervisor restart');void stop(1).catch(()=>process.exit(1));}
  },10000);watchdog.unref();
 }
}catch(error){app.log.error({code:error.code||'STARTUP_FAILED'},'Startup failed');await app.close();process.exitCode=1;}
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void stop(0).catch(()=>process.exit(1));});
