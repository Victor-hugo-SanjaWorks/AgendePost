import { base, object, string, identifier, positive, workspace, mutation } from '../editorial/shared.mjs';
import { createClientApprovalService } from './service.mjs';
export function initializeClientApprovals(ctx) {
 ctx.services.clientApprovals=createClientApprovalService(ctx);
 ctx.caps.clientApprovals=true;
 return ctx.services.clientApprovals;
}
export async function registerClientApprovals(app,ctx) {
 const service=ctx.services.clientApprovals,auth=[ctx.auth.requireUser,ctx.auth.requireTenant];
 app.get(`${base}/client-approvals`,{preHandler:auth,schema:{querystring:object({})}},req=>{
  workspace(ctx,req);
  return {data:ctx.db.prepare('SELECT * FROM client_approval_requests WHERE tenant_id=? AND workspace_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(req.params.tid,req.params.wid).map(service.dto),meta:{limit:200}};
 });
 app.get(`${base}/client-approvals/options`,{preHandler:auth,schema:{querystring:object({})}},req=>{
  const w=workspace(ctx,req),{tid,wid}=req.params;
  const posts=ctx.db.prepare("SELECT id,title,caption,revision,status,scheduled_at,scheduled_timezone FROM posts WHERE tenant_id=? AND workspace_id=? AND status IN ('approved','planned') AND approved_revision=revision AND format='image' ORDER BY updated_at DESC,id DESC LIMIT 200").all(tid,wid).filter(p=>ctx.db.prepare('SELECT count(*) n FROM post_media WHERE tenant_id=? AND workspace_id=? AND post_id=?').get(tid,wid,p.id).n===1).map(p=>({id:p.id,title:p.title,caption:p.caption,revision:p.revision,status:p.status,scheduledAt:p.scheduled_at,scheduledTimezone:p.scheduled_timezone,channelIds:ctx.db.prepare('SELECT channel_id FROM post_channels WHERE tenant_id=? AND workspace_id=? AND post_id=? ORDER BY position').all(tid,wid,p.id).map(c=>c.channel_id)}));
  const channels=ctx.db.prepare("SELECT * FROM channels WHERE tenant_id=? AND workspace_id=? AND archived_at IS NULL AND platform IN ('instagram','facebook') ORDER BY label,id").all(tid,wid).map(c=>{
   let r;try{r=ctx.services.publishing.adapter.readiness({tenantId:tid,workspaceId:wid,channelId:c.id,platform:c.platform,now:ctx.now()});}catch{r=null;}
   return {id:c.id,label:c.label,platform:c.platform,connectionVersion:r?.ready===true&&typeof r.connectionVersion==='string'?r.connectionVersion:null,destinationLabel:typeof r?.destinationLabel==='string'?r.destinationLabel.slice(0,120):null};
  });
  return {data:{posts,channels,timezone:ctx.db.prepare('SELECT timezone FROM tenants WHERE id=?').get(tid).timezone,internalPolicy:{requireIndependentApproval:!!ctx.db.prepare('SELECT require_independent_approval FROM tenants WHERE id=?').get(tid).require_independent_approval},canCreate:!w.archived_at&&['owner','admin','editor'].includes(req.tenant.role),readiness:ctx.services.publishing.readiness(tid,wid),notification:{status:'not_configured'}}};
 });
 app.post(`${base}/client-approvals`,{preHandler:auth,schema:{body:object({postId:identifier,expectedRevision:positive,channelIds:{type:'array',items:identifier,minItems:1,maxItems:6,uniqueItems:true},connectionVersions:{type:'object',minProperties:1,maxProperties:6,propertyNames:{type:'string',pattern:'^[A-Za-z0-9_-]{1,100}$'},additionalProperties:{anyOf:[string(200),{type:'null'}]}},scheduledAt:string(40),scheduledTimezone:string(100),expiresInHours:{type:'integer',minimum:1,maximum:168}},['postId','expectedRevision','channelIds','connectionVersions','scheduledAt','scheduledTimezone'])}},(req,reply)=>{
  workspace(ctx,req,'write');let raw=null;
  // Only the hash is persisted. An idempotency replay never recovers the bearer link.
  const result=ctx.idempotency(req,()=>{workspace(ctx,req,'write');const created=service.create(req);raw=created.raw;return {statusCode:201,data:created.request};},{required:true});
  return reply.code(result.statusCode).send({data:{...result.data,approvalUrl:raw?`${ctx.config.canonicalOrigin}/approval.html#${raw}`:null,linkAvailable:!!raw}});
 });
 for(const action of ['revoke','retry-scheduling'])app.post(`${base}/client-approvals/:aid/${action}`,{preHandler:auth,schema:{body:object({expectedVersion:positive},['expectedVersion'])}},(req,reply)=>{
  workspace(ctx,req,'write');return mutation(ctx,req,reply,()=>{workspace(ctx,req,'write');return {statusCode:200,data:service.mutate(req,action)};},{required:true});
 });
 const publicOptions={config:{rateLimit:{max:90,timeWindow:60000}},schema:{querystring:object({})}};
 app.get('/api/v1/client-approval',publicOptions,(req,reply)=>({data:service.preview(req,reply)}));
 app.get('/api/v1/client-approval/media',publicOptions,(req,reply)=>service.media(req,reply));
 app.post('/api/v1/client-approval/decision',{config:{rateLimit:{max:30,timeWindow:60000}},schema:{querystring:object({}),body:object({expectedVersion:positive,challenge:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},decision:{enum:['approve','request_changes']},feedback:string(2000,0)},['expectedVersion','challenge','decision'])}},req=>({data:service.decision(req)}));
}
