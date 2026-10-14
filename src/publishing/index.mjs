import { base, object, string, identifier, positive, workspace, mutation, postRow } from '../editorial/shared.mjs';
import { statuses, publicationDTO, disabledAdapter } from './shared.mjs';
import { createPublishingService } from './service.mjs';
import { createPublicationWorker } from './worker.mjs';
import { createMetaPublishingAdapterFromEnv } from './providers/meta.mjs';

export function initializePublishing(ctx,options={}) {
 const adapter=options.publishingAdapter??(ctx.config.mode==='test'?disabledAdapter:createMetaPublishingAdapterFromEnv({resolveConnection:ctx.services.socialConnections?.resolveBinding,onConnectionRevoked:ctx.services.socialConnections?.revokeBinding}));
 if(typeof adapter?.readiness!=='function'||typeof adapter?.validate!=='function'||typeof adapter?.publish!=='function')throw new Error('INVALID_PUBLISHING_ADAPTER');
 const service=createPublishingService(ctx,adapter);service.worker=createPublicationWorker(ctx,service,options.publishingWorker);
 service.workerExpected=options.publishingWorker?.enabled===true||ctx.config.publishingWorkerEnabled;
 service.startWorker=()=>{if(service.workerExpected)service.worker.start({timer:options.publishingWorker?.autoStart!==false});ctx.caps.socialPublishing=service.workerStatus().running&&adapter.enabled===true;};
 ctx.services.publishing=service;ctx.caps.socialPublishing=false;ctx.caps.publicationScheduling=true;ctx.caps.publishingMode=ctx.config.hosted?'hosted-pilot':'local';
 return service;
}
const schedule={scheduledAt:string(40),scheduledTimezone:string(100)};
export async function registerPublishing(app,ctx) {
 const service=ctx.services.publishing,auth=[ctx.auth.requireUser,ctx.auth.requireTenant];
 app.get(`${base}/publishing/readiness`,{preHandler:auth,schema:{querystring:object({})}},req=>{workspace(ctx,req);return {data:service.readiness(req.params.tid,req.params.wid)};});
 app.get(`${base}/posts/:pid/publications`,{preHandler:auth,schema:{querystring:object({})}},req=>{workspace(ctx,req);postRow(ctx,req);return {data:ctx.db.prepare('SELECT * FROM publication_jobs WHERE tenant_id=? AND workspace_id=? AND post_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(req.params.tid,req.params.wid,req.params.pid).map(publicationDTO)};});
 app.get(`${base}/publications`,{preHandler:auth,schema:{querystring:object({limit:{type:'integer',minimum:1,maximum:100},cursor:string(512),status:{enum:statuses}})}},req=>{
  workspace(ctx,req);let cursor=null;
  if(req.query.cursor){try{cursor=JSON.parse(Buffer.from(req.query.cursor,'base64url').toString('utf8'));if(!cursor||Object.keys(cursor).sort().join(',')!=='at,id'||typeof cursor.at!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(cursor.at)||typeof cursor.id!=='string'||!/^[\w-]{1,100}$/.test(cursor.id))throw Error();}catch{throw ctx.errors.http(422,'INVALID_CURSOR','Cursor inválido.');}}
  const args=[req.params.tid,req.params.wid],filters=[];if(req.query.status){filters.push('status=?');args.push(req.query.status);}if(cursor){filters.push('(created_at<? OR (created_at=? AND id<?))');args.push(cursor.at,cursor.at,cursor.id);}
  const limit=req.query.limit||50,rows=ctx.db.prepare(`SELECT * FROM publication_jobs WHERE tenant_id=? AND workspace_id=?${filters.length?' AND '+filters.join(' AND '):''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...args,limit+1),kept=rows.slice(0,limit),last=kept.at(-1);
  return {data:kept.map(publicationDTO),meta:{nextCursor:rows.length>limit?Buffer.from(JSON.stringify({at:last.created_at,id:last.id})).toString('base64url'):null}};
 });
 app.post(`${base}/posts/:pid/publications`,{preHandler:auth,schema:{body:object({expectedRevision:positive,connectionVersions:{type:'object',minProperties:1,maxProperties:6,propertyNames:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'},additionalProperties:string(200)},channelIds:{type:'array',items:identifier,minItems:1,maxItems:6,uniqueItems:true},...schedule},['expectedRevision','channelIds','connectionVersions','scheduledAt','scheduledTimezone'])}},(req,reply)=>{
  workspace(ctx,req,'write');postRow(ctx,req);
  return mutation(ctx,req,reply,()=>{workspace(ctx,req,'write');return {statusCode:201,data:service.enqueue(req)};},{required:true});
 });
 for(const action of ['cancel','reschedule'])app.post(`${base}/publications/:jid/${action}`,{preHandler:auth,schema:{body:object({expectedVersion:positive,...(action==='reschedule'?schedule:{})},['expectedVersion',...(action==='reschedule'?['scheduledAt','scheduledTimezone']:[])])}},(req,reply)=>{
  workspace(ctx,req,'write');return mutation(ctx,req,reply,()=>{workspace(ctx,req,'write');return {statusCode:200,data:service.mutate(req,action)};},{required:true});
 });
}
