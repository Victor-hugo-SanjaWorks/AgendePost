> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Real Meta publishing adapter: secure activation and limitations

Verified documentation: 14 October 2026. Graph API **v26.0** is pinned explicitly. This is implemented HTTP integration, not a simulated provider. Verification performed for this delivery uses mocked transports only; **no account has been connected, token granted, asset uploaded or live post sent by this work**.

The application remains a **loopback-only local pilot**. Its production deployment restriction remains in place. The local durable worker runs only while the application and computer are running. This is not a hosted, always-on SaaS service.

## Supported first format

- One approved, normalized **JPEG** image, maximum **5 MiB**, matching the bytes stored by this application. This pilot limit is deliberately stricter than Meta's 8 MB Instagram limit.
- Instagram **Business or Creator professional accounts**, using the Facebook Login integration and a linked Facebook Page. Personal Instagram profiles are unsupported.
- Facebook **Pages**, not personal profiles.
- Exact approved caption: whitespace, Unicode and line breaks are preserved. No rewriting, hashtag insertion, hidden crops, flattening or conversion occurs after approval.
- Instagram width 320–1440 pixels and aspect ratio 4:5–1.91:1, caption at most 2,200 Unicode code points, 30 hashtags and 20 mentions. Local validation intentionally rejects dimensions rather than relying on Meta's resizing. Images have already been normalized to sRGB by the upload pipeline.
- PNG/WebP, videos, Reels, Stories, carousels, text-only posts and other platforms remain unsupported for real publication. A PNG/WebP upload is still usable editorially, but publishing returns `IMAGE_JPEG_REQUIRED`. Prepare and upload a JPEG, inspect its preview, and approve the resulting revision.

## Activation prerequisites

Activation requires an authorized operator to have:

1. A Meta app configured for the required products, approved permissions/access level for the intended audience, and the relevant professional account/Page. Merely possessing an app ID does not establish usable permission or access to an account.
2. Verified the actual token's identity, Page, Instagram linkage, permission grants, token expiry and the user's Page tasks through Meta's official setup. Use a **Page access token** for this adapter. Store its type explicitly as `tokenType: "page"`. Existing operator-supplied configuration represents this independently verified result. The implemented OAuth path can instead discover, validate and encrypt account credentials as described in [META-OAUTH.md](META-OAUTH.md).
3. Explicit authorization to publish the approved content to these exact accounts, and to make the exact approved JPEG available to Meta on the configured public media host.
4. Externally reachable HTTPS image hosting. The local application's private image route and database are **not** public hosting and must not be exposed to satisfy this requirement.
5. A private, server-only connection configuration. Do not paste tokens, passwords, app secrets or authorization codes into chat, frontend fields, source code, public files, screenshots or issue reports.

### Required permissions and tasks

- Instagram Facebook Login flow: `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`, `pages_show_list`. If the Page role was granted through Business Manager, the verified setup must also include `ads_read` or `ads_management`; record `businessManagerGrant: true`.
- Facebook Page posting: `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`, with the user's verified Page `CREATE_CONTENT` task.
- `businessManagerGrant` is an explicit boolean. The operator must not assume `false` without verifying how access was granted.
- An expiry timestamp is mandatory. Never invent a far-future expiry for an unknown/expired token. Non-expiring-token support is intentionally not inferred.

Meta's integrated Instagram guide and official Postman examples use a Page token. Some older endpoint reference pages say User token. This adapter deliberately chooses the Facebook Login/Page-token flow; an authorized account smoke test is still required before describing a connection as proven operational. Automatic token refresh is not implemented. The companion [OAuth connection flow](META-OAUTH.md) implements server-side login/callback verification and explicit destination selection; no real app grant is created by offline tests or deployment alone.

## Server configuration

Set these variables only in the server process after reviewing the prerequisites:

```sh
SOCIAL_SAAS_META_ENABLED=true
SOCIAL_SAAS_META_CONFIG_FILE=/absolute/private/path/meta-publishing.json
```

A missing enable flag leaves publishing disabled. Missing, malformed, insecure or unsupported configuration fails closed with a sanitized error. The static configuration and asset map are read at application startup; restart after an authorized update. OAuth credentials are resolved from their encrypted store on each validation and immediately before each external request. Changes to either connection source generate a new `connectionVersion`, blocking jobs bound to the old connection instead of silently switching their destination or credentials. For OAuth-only credentials, retain the approved asset settings and use an empty `connections` array.

On POSIX systems the file must be an absolute-path regular file, with no symlinks or additional hard links, owned by the server user, with no group/other access (`0600`). Physical aliases and dot-prefixed subdirectories inside the repository are also rejected. Put its parent directory outside the repository, web root and synced folders, with `0700` permissions. The private credential-file loader is disabled on Windows because POSIX mode bits cannot establish NTFS ACL safety; a reviewed Windows secret-store backend is required before activating this integration there. The existing Windows launcher still runs the offline editorial pilot. Do not commit a real config to Git. The pilot reads a private local file; production must use a reviewed secret manager/encryption-at-rest design rather than relying on a development plaintext file.

Illustrative JSON schema, with placeholders that must be replaced by independently verified values:

```json
{
  "enabled": true,
  "apiVersion": "v26.0",
  "requestTimeoutMs": 15000,
  "assetHosts": ["assets.your-owned-domain.com"],
  "connections": [
    {
      "tenantId": "LOCAL_TENANT_ID",
      "workspaceId": "LOCAL_WORKSPACE_ID",
      "channelId": "LOCAL_INSTAGRAM_CHANNEL_ID",
      "platform": "instagram",
      "accountId": "VERIFIED_NUMERIC_IG_PROFESSIONAL_ID",
      "linkedPageId": "VERIFIED_NUMERIC_LINKED_PAGE_ID",
      "tokenType": "page",
      "accessToken": "ENTER_ONLY_IN_PRIVATE_OPERATOR_CONFIG",
      "expiresAt": "VERIFIED_TOKEN_EXPIRY_ISO_TIMESTAMP",
      "verifiedAt": "ACTUAL_VERIFICATION_ISO_TIMESTAMP",
      "businessManagerGrant": false,
      "permissions": ["instagram_basic", "instagram_content_publish", "pages_read_engagement", "pages_show_list"]
    },
    {
      "tenantId": "LOCAL_TENANT_ID",
      "workspaceId": "LOCAL_WORKSPACE_ID",
      "channelId": "LOCAL_FACEBOOK_CHANNEL_ID",
      "platform": "facebook",
      "accountId": "VERIFIED_NUMERIC_PAGE_ID",
      "tokenType": "page",
      "accessToken": "ENTER_ONLY_IN_PRIVATE_OPERATOR_CONFIG",
      "expiresAt": "VERIFIED_TOKEN_EXPIRY_ISO_TIMESTAMP",
      "verifiedAt": "ACTUAL_VERIFICATION_ISO_TIMESTAMP",
      "businessManagerGrant": false,
      "permissions": ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
      "pageTasks": ["CREATE_CONTENT"]
    }
  ],
  "assets": [
    {
      "tenantId": "LOCAL_TENANT_ID",
      "workspaceId": "LOCAL_WORKSPACE_ID",
      "digest": "SHA256_OF_THE_EXACT_APPROVED_NORMALIZED_JPEG_BYTES",
      "url": "https://assets.your-owned-domain.com/immutable/APPROVED_DIGEST.jpg",
      "expiresAt": "ACTUAL_IMAGE_AVAILABILITY_EXPIRY_ISO_TIMESTAMP"
    }
  ]
}
```

These placeholders intentionally do not constitute valid activated credentials or account IDs. Account IDs are decimal strings, not handles, usernames, profile URLs or the string `me`. Local IDs come from the application's tenant/workspace/channel records. No general credential-accepting HTTP route is provided.

## Public JPEG delivery protocol

The asset map binds **tenant + workspace + exact approved-media SHA-256 digest** to a specific HTTPS URL and an availability expiry. No URL is constructed merely because a digest exists. No upload is performed by the adapter.

For an authorized operator preparing an asset:

1. Obtain the already-normalized, approved JPEG bytes through the application's authenticated media content endpoint. Do not substitute the original upload, which may have different metadata or encoding.
2. Compute and confirm the SHA-256 against the application's normalized media digest.
3. Upload those exact bytes to the authorized host using an immutable object path. The host must respond directly with status 200, `Content-Type: image/jpeg`, no content transformation or compression, no redirects, and no login/cookies. Restrict other permissions to the minimum needed. A long random/object-key path or a time-limited signed URL can reduce discoverability but is still public to anyone with that URL.
4. Map only that exact digest and URL in the private configuration. Keep the object available until Meta finishes retrieval/publication and reconciliation. The adapter requires at least ten minutes of remaining availability at dispatch; provision enough lifetime for the full intended retry window.
5. Do not overwrite an existing object's bytes. A changed image requires a new approved revision and digest. This immutability requirement matters because the host could otherwise change between our verification GET and Meta's later retrieval.

Before any Meta mutation on each attempt, the adapter fetches the configured URL, verifies JPEG MIME, JPEG signature, exact length and SHA-256 against the approved bytes. The request uses the explicit host allowlist, HTTPS, verified-and-pinned public DNS addresses, no redirects, no cookies/credentials, bounded response bytes and a timeout. Private, loopback, link-local, mapped IPv4 and reserved destinations fail closed. Asset responses and URLs are never included in user-facing error messages. Meta credentials are never sent to the image host.

This verifies the exact hosted content at dispatch, not a guarantee of future host availability. Missing, expired, changed or unreachable images block or safely delay publication. Do not expose the pilot server or private media route publicly as a workaround.

## HTTP sequence and restart safety

The adapter implements actual HTTP requests to `https://graph.facebook.com/v26.0/` with access tokens in an Authorization header. No unversioned endpoints or arbitrary API hosts are accepted. The OAuth resolver computes `appsecret_proof` server-side from the already-configured app secret and Page token, and supplies it on every Graph request for apps enforcing that security setting. Static connections may supply the matching optional 64-character lowercase hexadecimal `appSecretProof`; it must be regenerated when the token changes. Neither the app secret nor its proof is exposed in application DTOs. Outbound proxy/APM logging must redact sensitive Graph query parameters, including the proof.

**Instagram:** create `/{ig-user-id}/media` using `image_url` and exact `caption`; persist the returned container ID; read `/{container-id}?fields=status_code,status`; wait for `FINISHED`; persist a `publishing` checkpoint; call `/{ig-user-id}/media_publish` using `creation_id`. `IN_PROGRESS` returns a safe retry at least one minute later rather than tight polling. Containers expire after 24 hours, so creation happens near scheduled dispatch. An unpublished container is never counted as a published post.

**Facebook:** create `/{page-id}/photos` with `url` and `published=false`; persist the returned photo ID; persist a `publishing` checkpoint; create `/{page-id}/feed` with the exact `message`, `attached_media=[{"media_fbid":"PHOTO_ID"}]` and `published=true`. Only a returned Page-prefixed post ID is publication success. Unused unpublished photos may be deleted by Meta after roughly 24 hours. This application uses its own durable scheduler; it does not claim Meta-native scheduled-post creation.

`saveProviderState({containerId,stage})` is awaited after preparation and immediately before the irreversible request. The worker must durably commit that checkpoint with lease fencing and recheck actor/approver/connection authorization before returning from the callback. Stages are `prepared`, `processing`, `ready`, `publishing`.

- `published` requires an actual publication response with a valid remote post/media ID.
- A positively identified Meta rate-limit rejection returns a bounded retry delay; the worker atomically resets the checkpoint to `ready` when committing that safe-retry result because the request was rejected. The adapter never rolls back its own durable publication fence. A bare upstream HTTP 429 without a verified Graph error is not sufficient proof after the publication request.
- A failed preparation/image GET has not published anything and can be safely retried where classified transient. An orphaned unpublished container/photo may remain after a lost preparation response; it is not a duplicate published post.
- A timeout, network loss, malformed/oversized success response, unknown final error or server error after final dispatch is **ambiguous**. Do not automatically resend.
- A persisted `publishing` checkpoint refuses replay. The app moves the job to `needs_attention`; human/account verification is required.
- Read-only `reconcile` can inspect Instagram's container status. `PUBLISHED` demonstrates publication but does **not** provide a reliably recovered media ID here, so the job remains `META_PUBLISHED_ID_UNRESOLVED`. No caption/time fuzzy match, fabricated ID or optimistic success is used. The adapter does not automate Facebook reconciliation.
- This is conservative duplicate prevention, **not** a claim of Meta exactly-once semantics. Meta's `client_mutation_id` is not used as an assumed idempotency guarantee.

## Safe failure and observability

Readiness is local configuration eligibility, not proof that Meta accepted a post. Server-side validation repeats before dispatch. Expired authorization, missing permissions, wrong tenant/workspace/channel, changed credentials/destination, image mismatch and unsupported formats fail closed. Rate limits and revoked credentials can still change after configuration; actual Graph errors are interpreted on each request.

Errors return stable codes only. Raw provider error bodies, access tokens, signed asset URLs and exception causes never appear in UI DTOs. Requests are bounded (15 seconds by default, up to 30 seconds configurable; Graph bodies at most 128 KiB). The worker also imposes an overall attempt deadline and finite retry budget. No automatic requests are made to discover/repair permissions or expand access.

Run offline adapter verification with:

```sh
node --test tests/meta-provider*.test.mjs
```

These tests inject HTTP responses around the actual adapter logic, not an entire fake publishing provider. No test contacts Meta or an image host. A user-authorized live smoke test, with the final content and exact social destinations reviewed, remains a separate activation step.

## Implemented OAuth connection flow

See [META-OAUTH.md](META-OAUTH.md) for the implemented tenant-admin, recent-auth + CSRF flow, single-use session/tenant/brand/channel state, fixed HTTPS callback, encrypted token storage, explicit verified destination choice and disconnect/rebind invalidation. OAuth remains disabled without an authorized operator configuration and external Meta app. The Windows launcher cannot activate the POSIX-only private-secret backend, and the local loopback pilot does not supply public HTTPS hosting.

Publishing resolves the active OAuth binding dynamically before dispatch and external mutations. A known disconnected/revoked/expired OAuth binding never falls back to an older static connection. Static operator entries remain available only for channels that have never been OAuth-bound. Account creation, persistent consent, approved live content, accessible media, App Review and commercial deployment are separate external prerequisites.

## Official sources

- [Graph API changelog, v26.0](https://developers.facebook.com/docs/graph-api/changelog/) (introduced July 29, 2026).
- [Instagram content publishing with Facebook Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing/).
- [Instagram media creation reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/).
- [Instagram media publishing reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish/).
- [Facebook Page photos, unpublished and attached-media flow](https://developers.facebook.com/docs/graph-api/reference/page/photos/).
- [Facebook Page feed publishing](https://developers.facebook.com/docs/graph-api/reference/page/feed/).
- [Meta permissions reference](https://developers.facebook.com/docs/permissions/).
- [Official Meta Business SDK version configuration](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/apiconfig.py).

Meta's Instagram quota documentation has conflicting daily totals in different sections. This adapter does not hard-code or promise an account's remaining publication quota; it handles actual rate-limit responses, and activation should check the account's live limits through supported official tooling.
