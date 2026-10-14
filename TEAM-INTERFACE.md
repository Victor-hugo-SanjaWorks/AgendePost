# Implementation coordination v0.1

Read CONTRACT.md and docs/ARCHITECTURE.md as product/security specification. This file only allocates module ownership and shared interfaces. No private credentials, external account actions or deployment.

## Ownership
- Foundation/auth owner: package.json + lockfile; src/app.mjs, server.mjs, src/db.mjs, src/errors.mjs, src/config.mjs, src/auth/**, src/tenants/**, scripts/**, primary migrations and auth tests. Install exact compatible npm dependencies; no changes to prior social_studio.
- Editorial owner: src/editorial/**, src/media/**, migrations/020-editorial.sql, own tests/editorial*. No editing base auth files without agreement.
- Billing/admin owner: src/commercial/**, migrations/030-commercial.sql, own tests/commercial*. No real outbound provider calls; disabled runtime by default.
- Frontend owner: public/** and user-facing workflow guide. No backend edits without agreement.
- QA/security owner: tests/qa-*, tests/security-*, docs/QA-REPORT.md; send fixes to owners.

## Shared runtime
Node24, ES modules, Fastify5 + official compatible plugins. SQL parameterized via node:sqlite. createApp(options={dataDir,mode:'development'|'test',clock?,mailAdapter?,billingAdapter?}) is async and returns Fastify instance; .inject works for all tests. Production startup must refuse until documented launch gates implemented. Default127.0.0.1, no public binding. Every real app route /api/v1; GET /health/live and /health/ready minimal. Static landing / and app /app, same-origin. Frontend external-dependency-free.

Foundation creates ctx = {db, transaction, now, auth, policy, audit, mail, errors, config, services, caps}. db is DatabaseSync; transaction(fn) wraps synchronous BEGIN IMMEDIATE/COMMIT/ROLLBACK (no async inside). now() returns ISO UTC; clock defaults real.

ctx.auth.requireUser(request,reply): preHandler establishes request.user sanitized identity and request.session. It rejects inactive/expired/revoked sessions. Mutation CSRF/Origin enforcement globally applies incl preauth. ctx.auth.requireTenant(request,reply) runs after requireUser, reads params.tid and fresh membership, establishes request.tenant = {id,role,scope,status,userId}. All service queries still constrain tid.
ctx.auth.requirePlatformAdmin(request,reply): runs after requireUser and checks platform_admins. Never grants editorial access.
ctx.auth.requireRecentAuth(request): <=10min or typed403 REAUTH_REQUIRED.
ctx.policy.workspace(request,wid,action): verifies tenant/workspace and explicit grants, throws404 invisible or403 denied. action enum read|write|review|manage|media|members|billing. Returns workspace row. Owner/admin organization-wide; editor/reviewer/viewer explicit brand grants.
ctx.audit({tenantId?,actorId?,action,targetType,targetId?,outcome:'success'|'denied'|'failure',safeChanges?,requestId?}) writes safe append-only record using currenttransaction when present.
ctx.errors.http(status,code,message,fields?) creates typed error caught by foundation; no stack/SQL leaked.

Module files export async registerEditorial(app,ctx) and registerCommercial(app,ctx). Foundation loads migrations in numeric order with checksums before registering routes. Modules may export own policy helpers but no global auth bypass. Until modules exist use explicit import files only once agreed; no fake implementation returned as success.

Quota service owned commercial: ctx.services.entitlements = {get(tid), assertCan(tid,resource,delta=1)}; resources workspaces,members,posts,mediaBytes. Caller calls assertCan INSIDE same transaction immediately before insert. Defaults preset technical pilot_base, no price or revenue. Foundation registers commercial service initialization before tenants/editorial routes need it; service may query later-created tables after migrations. Founder creates tenant then defaults entitlement atomically. If dependency not yet ready, coordinate directly rather than implement divergent quota copies.

Frontend initialization GET /api/v1/auth/session returns {data:{user:null|user,csrfToken,mode,capabilities,tenants?}}. cookies HttpOnly; fetch credentials same-origin, X-CSRF-Token all mutations; refresh csrf after login/logout. All successful JSON {data,meta?}; errors {error:{code,message,fields?},requestId}. Dates ISO UTC plus timezoneIANA. List data array, meta pagination. Follow CONTRACT endpoint names.

Development email outbox only operator CLI; no HTTP email token endpoint. docs explain 'nenhum email externo enviado'. Registration requests email/name; verify token + password creates verified development identity, then user logs in. HTML fragment token handled by verification/reset/invitation pages, removed before POST. Tests consume injected mailAdapter/outbox programmatically. No secrets in package/logs/user-visible content. CLI dev-mail explicit local operator command can show test links with clear label. No real email/Meta/Stripe calls.

All mutations invalidate stale approvals as specified; no fabricated published status. Marketing landing says pilot/under development until real integrations enabled. Plans show technical presets and 'preços a definir', not purchasable fake subscriptions. Billing checkout/portal503. Review/audit/two-tenant isolation are REAL.

Each owner sends interface changes immediately to parent and other owners. Functional evidence must distinguish implemented from planned. User deadline09BRT referred deliveredlocalMVP, not completecommercialSaaS. Workthroughnight within authorizedscope; no purchases/publichosting/authgrant.
