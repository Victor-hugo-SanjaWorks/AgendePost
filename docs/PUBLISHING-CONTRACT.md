> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Publishing contract v0.2

This supplements the historical v0.1 contract. Editorial `planned` remains an internal plan. Publication state is stored separately, per channel, and never inferred from editorial status. No live provider calls in tests or delivery verification.

## Routes
Prefix `/api/v1/tenants/:tid/workspaces/:wid`. Existing session, CSRF, tenant/workspace policies apply. All writes require `Idempotency-Key`; all write DTOs reject additional fields.

- `GET /publishing/readiness`: `{data:{enabled,worker:{running,mode:"local",lastHeartbeatAt,warning},maxLatenessMinutes:15,supportedFormats:["image"],channels:[{channelId,platform,ready,code,message,connectionVersion,destinationId,destinationLabel}],message}}`. `enabled` means configured adapter plus healthy worker, not account authorization or successful delivery. Connections/media may separately block a job. No secrets are returned.
- `GET /posts/:pid/publications`: `{data:[Publication]}` scoped read. Newest first, maximum 100.
- `POST /posts/:pid/publications`: `{expectedRevision,channelIds:[...],connectionVersions:{channelId:readinessVersion},scheduledAt,scheduledTimezone}`. 201 `{data:[Publication]}`. Requires exact current approved revision, future ISO datetime with explicit offset matching IANA timezone, all requested channels already attached to post, all target readiness, image-only single-media, active connection and current membership/grants. All targets enqueue atomically or none. connectionVersions must contain exactly the selected channel IDs and match readiness; a changed destination/credential/grant fails with CONNECTION_CHANGED.
- `POST /publications/:jid/cancel`: `{expectedVersion}`. 200 Publication. Queued/retry jobs cancel atomically. Leased jobs can cancel before send-start. Sending jobs return 409 `PUBLICATION_IN_FLIGHT`; this does not claim a remote cancellation.
- `POST /publications/:jid/reschedule`: `{expectedVersion,scheduledAt,scheduledTimezone}`. 200 Publication. Queued/retry/leased before send-start only, all enqueue authorization/readiness rechecked. Lease invalidated atomically. Does not change editorial approval/content revision.

There is deliberately no blind `retry` endpoint for `needs_attention`, failed or ambiguous sends. They require verification of the remote account; ambiguous rows continue to block another job for the same post/channel, even after content is edited and approved as a new revision. Automatic retry is allowed only when the adapter explicitly proves no publication happened.

Publication DTO: `{id,postId,channelId,platform,revision,status,scheduledAt,scheduledTimezone,nextAttemptAt,attemptCount,maxAttempts,version,remoteId,remoteUrl,publishedAt,errorCode,errorMessage,createdAt,updatedAt}`. Status enum: `scheduled`, `leased`, `sending`, `retry_wait`, `published`, `failed`, `blocked`, `cancelled`, `needs_attention`. `published` requires a provider response containing a remote ID. Internal lease/token/credential/material data never appear. Error messages are sanitized stable product messages, not provider payloads.

- `GET /publications?limit=50&cursor=...&status=...`: workspace-scoped queue, `{data:[Publication],meta:{nextCursor}}`, newest first.

## Provider adapter
`createApp({publishingAdapter,publishingWorker})`: injection allowed only in test mode. Production deployment remains forbidden by foundation gates. Development real adapter is created exclusively from separately documented server-side operator configuration, never through HTTP/API/body credential input.

Adapter object:
- `enabled: boolean`, `kind: "meta"|"test"`
- `readiness({tenantId,workspaceId,channelId,platform,now})` synchronous, no network. Returns `{ready:boolean,code?,message?,connectionVersion?:string}`. Must fail closed for missing/expired/unverified permissions, destination, asset or config. No token in result.
- `validate({tenantId,workspaceId,channelId,platform,revision,caption,format,media:{id,mime,width,height,sizeBytes,digest,bytes},now})` synchronous. Returns `{ready:boolean,code?,message?,connectionVersion?:string}`. Must validate destination and byte/media delivery suitability. Must not initiate HTTP requests. Worker revalidates immediately before dispatch.
- `publish({jobId,attemptId,tenantId,workspaceId,postId,channelId,platform,revision,caption,format,media:{id,mime,width,height,sizeBytes,digest,bytes},connectionVersion,now,signal})` async. One invocation is a single bounded attempt. Returns one of:
  - `{outcome:"published",remoteId:string}` only upon confirmed actual remote publication.
  - `{outcome:"retry",code:string,safeToRetry:true,retryAfterMs?:number}` only with positive proof no remote post was made.
  - `{outcome:"failed",code:string}` for definite terminal non-publication.
  - `{outcome:"ambiguous",code:string}` when remote publication might have happened.

Thrown error, malformed outcome, timeout, shutdown, lost lease, or process crash after durable `sending` mark is ambiguous unless a persisted safe checkpoint proves the irreversible publication step never began. Never replay it automatically. Instagram container preparation/polling may happen inside one bounded publish attempt; container creation alone is never success. No provider request occurs before worker durably marks send-start. Safe retries are bounded to 5 attempts and a fixed 15-minute lateness deadline after scheduledAt; overdue work fails visibly instead of publishing the next day. Worker heartbeats/leases are durable; fencing tokens protect all final writes. Lease expiration before sending may recover safely; after sending, only prepared/processing/ready checkpoints can safely resume. Publishing or missing checkpoints move to needs_attention.

## Operational honesty
Default disabled. No account connection, live test, provider post, grant, hosting or credential collection is authorized by building this code. Local worker runs only while application is running and its computer is awake; this is not a hosted 24/7 SaaS. Scheduler jobs persist across normal restarts. Any unreviewed production gate remains enabled. Videos/reels/carousels/story/text and other networks are visibly unsupported.

Checkpoint extension: publish receives providerState and awaitable saveProviderState(state). Persist only {containerId,stage:prepared|processing|ready|publishing}. The publishing checkpoint revalidates authority and must be awaited before the irreversible HTTP request. Only an explicit safeToRetry outcome may reset a publishing checkpoint; checkpoints cannot regress on their own.
