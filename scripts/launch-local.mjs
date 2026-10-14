import{spawn}from'node:child_process';import{createApp}from'../src/app.mjs';
const app=await createApp();await app.listen({host:app.ctx.config.host,port:app.ctx.config.port});const url=app.ctx.config.canonicalOrigin;console.log(`\nPiloto pronto em ${url}\nMantenha esta janela aberta. Ctrl+C encerra o servidor.\nNenhum email externo, pagamento ou publicação social.\n`);
if(process.platform==='win32'){const child=spawn('cmd.exe',['/d','/c','start','',url],{stdio:'ignore',windowsHide:true});child.on('error',()=>console.log(`Abra manualmente ${url}`));child.unref();}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>app.close().then(()=>process.exit(0)));
