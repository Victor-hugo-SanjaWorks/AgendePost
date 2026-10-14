> Base histórica do piloto local 0.2, preservada para referência técnica. Para instalar o AgendePost 0.3 na VPS, use HOSTINGER-DEPLOY.md, HOSTED-OPERATIONS.md e META-SETUP-HOSTED.md. As antigas restrições operacionais de perfil local não descrevem o opt-in hospedado; os controles de isolamento e publicação permanecem válidos.

# Meta publishing integration research

Checked: 14 October 2026 (UTC). Scope: real, scheduled organic Instagram and Facebook Page publications for a multi-tenant SaaS. This document separates verified platform behavior from implementation recommendations. No accounts were connected, credentials created, media uploaded, or publications made during this research.

## 1. Recommended first release

Use Facebook Login for Business to connect Facebook Pages and their linked Instagram professional accounts. Ship a deliberately narrow first capability: one JPEG image plus caption, with independent Facebook and Instagram publication jobs. A Facebook post does not itself publish the Instagram post.

Keep the schedule in a durable server-side job queue and execute each provider's publishing API near its due time. The due-time worker is essential for Instagram; its documented container/publish flow has no native future-publication field. Do not use a browser timer or a process-local timeout. Distinguish these states in storage and UI:

- `scheduled`: our durable queue accepted the requested instant
- `processing`: media preparation or provider processing is underway
- `provider_scheduled`: Meta accepted a native future schedule and returned its object ID, if this optional path is implemented
- `published`: a provider publication ID or authoritative published state was observed
- `needs_attention`: uncertain publication outcome, expired authorization, rejected media, or an unresolvable blocker

A created container or uploaded photo is not a published post. UI wording must not claim successful publication from local queue acceptance.

## 2. API version

The official Graph API changelog currently identifies **v26.0** as the latest version, introduced **29 July 2026**. Pin an explicit configurable version, initially `v26.0`, in API requests. The same version is in Meta's current official Python SDK configuration. Do not auto-upgrade without contract tests and a deployment review.

Sources: [Graph API changelog](https://developers.facebook.com/docs/graph-api/changelog/), [Meta SDK configuration](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/apiconfig.py).

## 3. Supported identities and permissions

### Facebook Login for Business, recommended combined connection

- Facebook publication targets are **Pages**, not personal Facebook profiles.
- Instagram publication requires a **professional Business or Creator account linked to a Facebook Page**. Personal Instagram accounts are not supported.
- For the publishing user, verify the relevant Page content task, such as `CREATE_CONTENT`, rather than assuming every returned Page is publishable.
- Minimum combined image-publication scope set: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`.
- `pages_manage_posts` depends on `pages_read_engagement` and `pages_show_list`. `instagram_content_publish` depends on `instagram_basic`, `pages_read_engagement`, and `pages_show_list`.
- Meta's Instagram reference additionally requires **one of `ads_read` or `ads_management`** when the app user's Page role was granted through Business Manager. Detect/explain this conditional requirement; do not silently request broad advertising access for every user. Do not add `business_management`, messaging, comments, insights, or ad-management scopes merely because a broad tutorial lists them.
- Resolve assets with `GET /{user-id}/accounts?fields=id,name,access_token,tasks,instagram_business_account`. Present the actual returned Page and linked Instagram identity for selection. Store their IDs separately, tenant-bound.

Facebook publishing uses a **Page access token**. Meta's combined Instagram publishing guide and official Postman example also use a Facebook Page token for Instagram. Some individual Instagram endpoint references instead describe a Facebook User token. Keep token types explicit and preserve the appropriate encrypted token for each endpoint; validate the selected path in an authorized live test rather than assuming all tokens are interchangeable.

Sources: [Page Feed publishing requirements](https://developers.facebook.com/docs/graph-api/reference/page/feed/), [Page Photos requirements](https://developers.facebook.com/docs/graph-api/reference/page/photos/), [Permissions reference](https://developers.facebook.com/docs/permissions/), [Instagram publishing guide](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Meta's Page and IG discovery example](https://www.postman.com/meta/instagram/request/lpx8lul/get-access-tokens-of-pages-you-manage).

### Instagram Login, optional separate connection

Instagram Login supports professional Business/Creator accounts without a linked Facebook Page. It uses `graph.instagram.com`, an Instagram User token, and `instagram_business_basic` plus `instagram_business_content_publish`. It does not provide Facebook Page publication; that needs its own Facebook authorization. Do not mix these scope names with the Facebook Login scope family.

Sources: [Instagram overview](https://developers.facebook.com/docs/instagram-platform/overview/), [Business Login for Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/), [Publishing requirements](https://developers.facebook.com/docs/instagram-platform/content-publishing/).

### Access level and review

Standard Access is suitable for development and accounts owned/managed by app-role users. A customer-facing SaaS serving professional accounts outside that scope needs **Advanced Access**, **App Review**, and **Business Verification**. Development-mode success is not evidence that external customer accounts can connect.

Prepare a functioning reviewer-accessible login-to-publication flow, specific scope use cases, and screencasts showing consent, selecting a real target, composing a photo/caption, and the resulting publication on the target account. The permissions reference specifies distinct demonstrations for Page publishing and Instagram publishing. A private/inaccessible application cannot rely on the Instagram private-app exception to obtain publishing permission.

Sources: [Instagram overview: access levels and private apps](https://developers.facebook.com/docs/instagram-platform/overview/), [Permissions reference: review evidence](https://developers.facebook.com/docs/permissions/).

## 4. Publishing flows and constraints

### Instagram single image

1. `POST /{ig-user-id}/media` with `image_url` and `caption`; retain the returned container ID immediately.
2. Read `GET /{container-id}?fields=status_code,status` and wait for publish eligibility.
3. `POST /{ig-user-id}/media_publish` with `creation_id={container-id}`; retain the returned Instagram media ID.
4. Read the published media's `id,permalink,timestamp` when available before presenting the final link.

Image requirements: **JPEG only**, maximum **8 MB**, aspect ratio **4:5 through 1.91:1**, sRGB. The reference currently specifies minimum width 320 and maximum width **1440**, with automatic scaling outside those width bounds. Do not perpetuate older 1080px limits as current. Caption maximum is **2,200 characters, 30 hashtags, and 20 @ mentions**. Per-image alt text is supported up to 1,000 characters.

Containers expire after **24 hours**; an account may create **400 containers in a rolling 24 hours**. Prepare shortly before the planned publication rather than when a schedule is created weeks ahead.

Source: [IG User Media reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/).

### Instagram carousel and video/Reels, later capabilities

- Carousels support up to **10** images/videos, including mixed carousels. Create child containers with `is_carousel_item=true`, then a `CAROUSEL` parent with ordered `children`; publish the parent. Caption belongs to the parent. Reels cannot be carousel children. Images are cropped according to the first image, with default square behavior.
- For a standalone Reel create `media_type=REELS`; `share_to_feed` controls feed inclusion. Do not treat all video types as interchangeable.
- Current Reel reference: MOV/MP4, HEVC/H.264 progressive scan and closed GOP, 4:2:0, 23–60 fps, maximum horizontal size 1920px, 3 seconds–15 minutes, **300 MB maximum**, video bitrate up to 25 Mbps, AAC audio (48 kHz maximum, mono/stereo), audio bitrate 128 kbps. 9:16 is recommended; the reference allows a wider aspect-ratio range. The MOV/MP4 metadata must support streaming (`moov` at front; no edit lists).
- Some Meta Postman material still says 1 GB. Prefer the **300 MB endpoint-reference limit** until an explicitly supported path is confirmed.
- The publish guide documents resumable video upload for Facebook Login for Business: create with `upload_type=resumable`, then upload to the returned/ documented `rupload.facebook.com/ig-api-upload/{version}/{container-id}` path, retaining the same container. Support local binary data or hosted media according to that flow. This does not remove the public-URL requirement for image publication.

Sources: [IG User Media reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/), [Publishing guide](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Meta's older Reel Postman specifications](https://www.postman.com/meta/instagram/folder/f95kq5e/reels-publishing).

### Instagram quotas: documentation conflict

The general publishing guide says 100 posts per rolling 24 hours; its carousel section and the `media_publish` reference say 50. A carousel counts as one publication. Do not promise a static 100-post quota.

Query `GET /{ig-user-id}/content_publishing_limit`. `quota_usage` is the default response field. The reference describes `config.quota_total` and `config.quota_duration`, but its example requests `rate_limit_settings` and returns `config`. Parse the actual provider response defensively and validate the optional field on the chosen token/API path. If a total cannot be obtained, use a clearly documented conservative policy rather than silently assuming unlimited publication.

Sources: [Publishing guide](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Publish reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media_publish/), [Publishing limit reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit/).

### Facebook Page photo/feed

The verified staged flow is:

1. `POST /{page-id}/photos` with `url` and `published=false`; persist the photo ID.
2. `POST /{page-id}/feed` with `message` and `attached_media=[{"media_fbid":"{photo-id}"}]`; persist the returned **Page Post ID**, which is distinct from the photo ID.
3. Read the post's `id,is_published,permalink_url` where supported; only then expose verified publication details.

Facebook supports JPEG, BMP, PNG, GIF and TIFF photos up to **10 MB**. The reference recommends PNG under 1 MB for quality. A JPEG-only product contract is a valid deliberate narrower first release. Unpublished photos are temporary and removed after about **24 hours** if not used, so stage them near the due time.

For native scheduled multi-photo posts the photo reference requires `temporary=true` during unpublished photo upload, then `published=false`, `scheduled_publish_time`, and `unpublished_content_type=SCHEDULED` on `/feed`. This is an optional distinct implementation; do not combine it accidentally with a worker that will publish again at the same time.

Source: [Page Photos](https://developers.facebook.com/docs/graph-api/reference/page/photos/).

### Facebook scheduling and video/Reels

Page Feed's v26.0 reference allows native scheduling between **10 minutes and 75 days** from the call. The broader Pages guide instead says **10 minutes to 30 days**. A due-time worker with immediate publication avoids this contradictory horizon. If native scheduling is implemented, validate the endpoint response and read back the actual scheduled timestamp; never silently change the requested time.

Traditional Page video uses `/videos` with source/file URL or its `start → transfer → finish` upload flow. The Pages guide lists `publish_video` for video publication. Facebook Reels use a different `/video_reels` flow: start an upload session, upload to its returned URL, inspect status, and finish with `video_state=PUBLISHED`. Meta's Postman includes a `SCHEDULED` state, but do not infer its complete timing contract from that enum alone.

Current Facebook Reels guide: Pages only; 30 API-published Reels per rolling 24 hours; 9:16, minimum 540×960 (1080×1920 recommended), 24–60 fps, 3–90 seconds. Its listed core permissions are `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`. Older Postman examples have narrower 4–60 second and older frame-rate values. Use the current dedicated guide.

Sources: [Page Feed](https://developers.facebook.com/docs/graph-api/reference/page/feed/), [Pages posts guide](https://developers.facebook.com/docs/pages-api/posts/), [Page Videos](https://developers.facebook.com/docs/graph-api/reference/page/videos/), [Facebook Reels publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing/), [Meta Facebook Postman collection](https://www.postman.com/meta/facebook/documentation/r56bjfd/facebook-api?entity=request-23987686-0b79260c-96bd-49de-875b-6076213785fc).

## 5. Asset hosting and token lifecycle

### Media hosting

Meta retrieves image/video URLs from its servers. A localhost URL, authenticated preview route, or browser-only blob URL will fail. For images, issue a narrowly scoped HTTPS asset URL that remains accessible throughout preparation and provider fetching. A sufficiently long-lived signed URL may meet this requirement if no cookies/custom request headers are necessary; this is an architectural inference from Meta's public-fetch requirement, not a guarantee for every storage provider.

Implementation safeguards: immutable asset hash and rendition, validated MIME/signature and actual dimensions, authorization binding asset to tenant/job, no secrets in asset URLs or logs, no redirect to internal hosts, and SSRF protection if accepting arbitrary external URLs. Do not expose a whole media bucket. Publishing consent should cover Meta retrieving the selected content.

Source: [Publishing guide: media on a public server](https://developers.facebook.com/docs/instagram-platform/content-publishing/).

### Tokens

- Facebook: exchange a valid short-lived User token server-side with `grant_type=fb_exchange_token`; long-lived User tokens generally last about **60 days**. Derive Page tokens from that long-lived User token. The resulting long-lived Page tokens have no fixed expiry date but remain revocable and can be invalidated. Never label them permanent.
- Instagram Login: authorization-code exchange yields a short-lived token; exchange server-side through `graph.instagram.com/access_token` with `ig_exchange_token` for a **60-day** token. Refresh with `ig_refresh_token` only when the long-lived token is at least **24 hours old and unexpired** and `instagram_business_basic` remains granted. An expired token requires reconnection.
- Persist returned expiry information, granted scopes, token type, target IDs, connection health and revocation status. Encrypt tokens at rest with a separately managed key and never return them to browser JavaScript, logs, exports, or error messages.
- OAuth implementation recommendation: bind a short-lived, single-use, cryptographically random `state` to the authenticated user, tenant and requested provider; reject missing/mismatched/replayed state, allowlist exact callback/return URLs, and exchange the code only server-side. Do not accept a client-supplied tenant or target account as proof of authority. Use secure cookies and provider-supported authorization protections; do not invent PKCE support.
- A connection health check should precede near-term jobs. Authentication/permission failure pauses publication and requests reconnection rather than retrying forever.

Sources: [Facebook long-lived tokens](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/), [Business Login for Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login/), [Graph errors](https://developers.facebook.com/docs/graph-api/guides/error-handling/).

## 6. Reliability, duplicate prevention and uncertain outcomes

The reviewed public publishing references do **not establish a general idempotency-key guarantee**. The generated Page SDK exposes a `client_mutation_id` parameter, but that alone does not prove deduplication. Do not promise exactly-once delivery based on it.

Recommended implementation:

1. Durable, unique publication key per tenant + target account + content revision; one publication job for each destination.
2. Atomic database claim and a renewable lease. Persist an intent/attempt record before every external write.
3. Persist provider container/photo/session IDs as soon as returned. Resume those objects; do not create new ones on every worker restart.
4. Treat a timeout/disconnection after a publishing request was sent as **unknown outcome**. Do not automatically re-create or republish the content.
5. For Instagram, read the saved container: `PUBLISHED` is authoritative published status; `FINISHED` means ready, `IN_PROGRESS` means pending, `ERROR` failed, `EXPIRED` expired. The official guide recommends polling once a minute for up to five minutes. After that provider-processing budget, move to deferred reconciliation/attention; do not declare success or blindly retry. If publication is confirmed but the media ID was lost, represent that honestly until the identifier is recovered.
6. Read recent Instagram media or Page posts to reconcile missing returned IDs using account, timing, text and known media identifiers. Similar captions or a matching text hash alone are insufficient proof, especially with repeated campaigns or manual posts. If no unique match can be established, require review instead of duplicating.
7. Reconcile crashes at every stage, including the gap between provider success and database commit. Cross-platform partial success must remain visible; retry only the unresolved destination.
8. Record redacted provider error code, subcode, useful message and `fbtrace_id`. Codes 190/102 indicate invalid session/token cases; 10 and 200–299 concern missing permissions. Rate-limit errors require backoff. A transport failure on a write still needs reconciliation even if generic error documentation suggests retrying.
9. Error 506 is a duplicate-post rejection, **not** an idempotency receipt and not proof of which previous job succeeded. Do not change approved content automatically to evade it.

Sources: [Instagram publication troubleshooting](https://developers.facebook.com/docs/instagram-platform/content-publishing/), [Graph errors](https://developers.facebook.com/docs/graph-api/guides/error-handling/), [Official generated Page SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py), [Official IG media fields](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/igmedia.py).

## 7. Minimum secure onboarding and release blockers

The code can be implemented and tested offline now. Real customer publication remains blocked until these are satisfied:

- An owner-controlled Meta developer app with the correct Facebook/Instagram use cases and supported pinned API version.
- An HTTPS public application base URL and exact OAuth callback configuration; functioning privacy/data-deletion information appropriate for the app and Meta review.
- App secret and encryption key provisioned through an authorized secret store. Do not ask for secrets in chat or commit them to source control.
- The owner completes Meta login/consent and grants persistent access themselves through the supported secure flow. Creating OAuth grants or entering credentials is not a prerequisite the assistant should silently perform.
- A verified Page and professional Instagram account, correct Page tasks, and requested scopes. Page Publishing Authorization and required two-factor authentication must be completed where Meta requires them; those checks can change after initial connection.
- Publicly retrievable media rendition and a deployed durable worker/database, independent of whether the user has the web app open.
- Advanced Access/App Review/Business Verification before offering the flow to unrelated customers.
- One explicitly approved live smoke test per implemented destination: correct account, approved caption/image, intended timing, persisted provider IDs, and read-back verification. Then test restart/retry/uncertain-outcome behavior with controlled fault injection. Offline mocks are necessary but do not establish that Meta accepted a real publication.

No evidence in this research establishes that the SaaS currently has these accounts, grants, review approvals, reachable hosting, or a successful live post. Keep that distinction visible in readiness checks.
