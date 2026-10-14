# AgendePost 0.4: read-only social metrics

## What is implemented

A persistent, server-side collector reads authorized Facebook and Instagram account/post counts. The dashboard reads SQLite snapshots only. A public dashboard visit, browser reload, or settings read cannot resolve credentials, enqueue work, or call a social provider.

This release deliberately does **not** claim a complete insights/analytics integration:

- Facebook Page: current follower count; published Page-post likes, comments, shares, and reactions when returned by Graph. Reactions and likes have different keys and must not be added together.
- Instagram professional account through Facebook Login: current follower count; published media likes and comments when returned by Graph.
- Reach, impressions, account interactions/profile visits, clicks, and Instagram saves/shares are explicitly unsupported in this adapter and remain `null`.
- LinkedIn: explicit `METRICS_LINKEDIN_UNSUPPORTED`. There is no LinkedIn OAuth adapter, credential intake, scraping, invented connection, or API request.
- Owned published posts/media are discovered through one bounded first page per connected Meta account (at most 25 results), including content published outside AgendePost. Successful local publishing history is retained and deduplicated against remote results. No historic backfill, drafts, captions, internal titles, images, comment bodies, user lists, demographics, or paid-ad reporting are retrieved. Aggregate comment/reaction edges use `limit(0)`; any unexpected user/body fields returned by a provider are discarded.

`0` means the provider actually returned integer zero. Missing, withheld, malformed, permission-limited, or unsupported values are `null`, with a reason. No metrics are estimated, seeded, or mocked outside tests.

## Runtime integration

Initialize after `initializeSocialConnections`:

```js
import { initializeSocialMetrics } from './social-metrics/index.mjs';
initializeSocialMetrics(ctx, options);
// After app.ready():
ctx.services.socialMetrics.start();
// On close, before db.close():
await ctx.services.socialMetrics.stop();
```

Migration `070-social-metrics.sql` adds four tables and a connection fencing trigger. Additive migration `075-social-metrics-remote-posts.sql` adds remote-post snapshots and discovery coverage; migration 070 is unchanged by this extension. Existing migrations, publishing records, encrypted credentials, and editorial/strategy data are not rewritten. The package is a separate 0.4 copy; the original 0.3 directory/archive remains untouched.

### Two independent gates

1. Server operator sets `SOCIAL_SAAS_METRICS_ENABLED=true`. All other values, including omission or `false`, disable network collection.
2. An active, verified organization **owner** explicitly enables collection for that brand. The authenticated settings route calls `service.configure(req)` with `{enabled, cadenceMinutes, expectedVersion}`. Cadence accepts integers from 15 through 1440 minutes. Initial settings are disabled, cadence 15, version 1. Successful mutation increments the version, verifies recent authentication, and appends a redacted audit event.

Changing settings does not make a provider call. It fences in-flight work and changes the next scheduler eligibility. Pausing preserves authorized historical snapshots but labels their values stale/paused. Disconnect/rebind purges snapshots immediately through a database trigger; it never falls back to static publisher credentials.

A global gate is an operator configuration, not a public query parameter. No HTTP route should expose `tick`, `start`, `stop`, or a transport/credential override. Live configuration does not accept the test seam.

### Service contract

- `summary(tenantId, workspaceId)`: synchronous, database-only, explicitly constructed DTO. Caller must enforce private workspace authorization or validate an unrevoked public read-only share first.
- `settings(tenantId, workspaceId)`: `{enabled,cadenceMinutes,version}`; no side effects.
- `configure(req)`: validates owner/recent auth/current workspace plus expected version; returns settings. Parent route must retain normal authentication, tenant context, origin, CSRF and strict body validation.
- `start()`: idempotently starts the scheduler when globally enabled.
- `stop()`: aborts active reads, waits for work to settle, and clears the scheduler. Call before database shutdown.
- `tick()`: internal scheduler primitive; one in-flight promise per process, persisted leases across processes. Never wire to public/read routes.

Summary shape:

```js
{
  brand: { name, color }, generatedAt, lastSyncedAt, stale,
  collection: { enabled, status, lastAttemptAt, nextRunAt },
  settings: { enabled, cadenceMinutes, version },
  notices: [{ code, message }],
  accounts: [{
    id, channelId, platform, platformLabel, label, displayName,
    connectionStatus, status, code, observedAt, lastSyncedAt,
    lastAttemptAt, nextRefreshAt,
    coverage: { scope: 'recent_account_posts_and_agendepost', limit: 25, pages: 1,
                fullHistory: false, returnedCount, hasMore, observedAt, lastAttemptAt, status },
    metrics: [{ key, label, value, unit, period, source, observedAt, state, code }],
    posts: [{ id, platform, publishedAt, permalink, status, code,
              observedAt, lastSyncedAt, lastAttemptAt, metrics: [/* same descriptor */] }]
  }]
}
```

Account metric keys: `followers`, `reach`, `impressions`, `engagements`, `profileViews`.
Post keys: `reach`, `impressions`, `likes`, `comments`, `shares`, `saves`, `clicks`, `reactions`.

The implemented counts all use `period: "snapshot"`: current provider totals at `observedAt`, **not** a selected date-range result, daily gain, or historical time series. No cross-network reach, unified audience, combined engagement rate, or follower growth is computed. `generatedAt` is response generation time and must never be labeled data refresh time. `lastSyncedAt` is the newest actual account observation, not a guarantee that every account/post is fresh.

Account statuses include `pending`, `syncing`, `partial`, `stale`, `error`, `disabled`, `paused`, `disconnected`, `scope_missing`, and `unsupported`. Valid basic data is `partial` because the advanced metrics are not implemented. Metric states are `available`, `unavailable`, `unsupported`, `scope_missing`, `stale`, `error`, `disconnected`, and `pending`.

Public sharing should project a separate fixed allowlist from this DTO. Do not return `settings`, tenant/member IDs, credential or authorization metadata, sync leases, publishing state, or raw database rows. Render all labels as text. Permalinks are provider-verified, HTTPS, host/path restricted, and stripped of irrelevant queries; local publishing URLs are never trusted as evidence of a public post.

## Scheduler, persistence, and boundaries

- Scheduler checks due work once per minute. A brand's collection interval is at least 15 minutes.
- Each tick handles at most four accounts, and each account appears at most once per tick. No tight retries after a race.
- Each account first requests one fixed endpoint page: `/{page-id}/published_posts` for Facebook (hidden/expired posts excluded) or `/{ig-user-id}/media` for Instagram. `limit=25` is fixed. More than 25 rows, duplicate remote IDs, invalid/future timestamps or any wrong/missing owner identity reject the entire batch. The remote snapshot table is replaced atomically with each successful bounded page; it never grows past 25 rows per account. A missing row does not prove the provider deleted a post.
- No pagination is followed. Presence of a next link is converted only to a boolean; the URL/cursor is neither saved nor returned. A full page is conservatively marked `hasMore`. Coverage is the first up-to-25 records returned by the provider, not a guarantee of globally newest posts or all history. Instagram ordering controls are not supported.
- Up to 20 additional local successful publications per account per cycle are selected by least recent attempt among the last 90 days. A local post already returned by discovery reuses that verified result without another GET. This rotates across busy accounts; it is not a promise that all posts refresh every 15 minutes.
- A summary merges remote discovery and up to the latest 100 local successful publications, deduplicates against local remote IDs, sorts by actual publication timestamp, and caps the merged result at 100 per channel. Older-than-90-day local posts outside the discovered page are outside automatic refresh, with an explicit state when no snapshot exists. No accountwide engagement total is inferred from this limited selection.
- Graph GETs have a 10-second timeout and 128 KiB response cap. An entire account cycle has a 60-second abort budget. Redirects are rejected. Fixed Graph host and version `v26.0`; no provider pagination URLs or user-supplied URLs are followed.
- Persisted leases last the account budget plus 30 seconds. A crashed worker's lease can be reclaimed after expiry. No lease can authorize a response after settings, channel version, connection authorization, user/membership, tenant, or brand authority changes.
- Failures preserve the last valid numerical snapshots and actual timestamps. Status marks them stale/error. Authentication/scope failures hide prior values. Disconnect/rebind purges them.
- Backoff begins at the configured cadence and doubles to a maximum of 24 hours. A valid `Retry-After` can extend the wait, bounded at 24 hours. Requests are never retried inside the transport.
- Read methods do not open the encrypted token. Only the worker calls the existing private `ctx.services.socialConnections.resolveBinding`, immediately before each provider GET and again after asynchronous waits, requiring the exact current authorization version and destination.
- The existing credential resolver checks membership, verified/active user, tenant, archived records, expiration and encrypted binding authenticity. The collector independently checks the enabling owner is still authorized and required stored grant scopes remain present. Remote Graph reads validate token identity and reject provider-side revocation. There is no separate user-token introspection flow; the existing encrypted connection stores a Page token only.
- Base scopes: `pages_read_engagement`; Instagram additionally `instagram_basic`, and the existing Business Manager access-basis condition requires `ads_read` or `ads_management`. This collector does not request new scopes or create credentials.
- Database tables store numeric descriptors, safe status codes, safe permalinks, timestamps, local IDs and authorization-version references. No access tokens, proofs, provider raw errors, headers, provider bodies, or secret configuration are persisted or returned.

## Optional insights OAuth proposal, not activated

If a future release implements insights after verifying the exact current reference/version and app capabilities, the login UI should request explicit opt-in before adding `instagram_manage_insights` (Instagram Facebook Login) or `read_insights` (Facebook Page). Preserve publishing-only authorization as the default. Persist opt-in in OAuth state/pending data; verify returned grants, Page `ANALYZE` authority where required, destination identity, app-review/advanced-access requirements, expiry, and connection binding both on selection and subsequent refresh. Do not silently upgrade existing grants.

Adding unused scopes now provides no metrics and increases consent scope. This release therefore proposes the opt-in but makes no OAuth or live permission changes. Advanced insight keys remain `null` even if an existing connection happens to carry these permissions. New adapters must encode metric-specific windows, definitions, supported media products, privacy thresholds, latency, retention and current deprecations, rather than substituting old impressions/play metrics for views.

## Current primary-source review (2026-10-14)

- [Meta's official Instagram API Postman collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api): Facebook Login/Page-linked professional-account flow, Page tokens and basic permissions. The collection's login variants have distinct scopes; they are not interchangeable.
- [Meta official current IGUser SDK schema](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/iguser.py): `followers_count` is a supported object field, and `get_media` defines a GET `/media` edge returning IGMedia. The current SDK source was directly checked on 2026-10-14.
- [Meta official current IGMedia SDK schema](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/igmedia.py): object `owner`, `timestamp`, `permalink`, `like_count`, `comments_count`. Only aggregate values and validated permalink are retained.
- [Meta official Page SDK schema](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/page.py): Page `followers_count` field; `get_published_posts` explicitly defines GET `/published_posts`, PagePost results, `limit`, `include_hidden`, and `show_expired`. The current SDK source was directly checked on 2026-10-14. This is owned Page-published content, not the `/feed` edge that may contain visitor content.
- [Meta official PagePost SDK schema](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/pagepost.py): post identity, `from`, `created_time`, permalink, shares and aggregate edge definitions. [Meta Post schema](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/post.py) provides the corresponding likes/comments/reactions edges.
- [Meta Instagram insights reference](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/insights/), [Page reference](https://developers.facebook.com/docs/graph-api/reference/page/), and [permissions reference](https://developers.facebook.com/docs/permissions/): attempted directly; research tool returned unavailable/429. Full current insights definitions were not verified, which is why this implementation avoids insight-name or date-window guesses. SDK schema availability does not guarantee an individual account's grant/access: production rollout still requires authorized account acceptance testing.
- [LinkedIn Organization Follower Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/follower-statistics?view=li-lms-2026-09): distinguishes lifetime/demographic and time-bound results; its permission table specifies organization administration access, and total follower count is obtained through a separate network-size API.
- [LinkedIn Organization Share Statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics?view=li-lms-2026-09) and [Organization Access Control by Role](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-09): versioned organization access/reporting is a separate integration. No LinkedIn API version, OAuth grant, or product approval is pretended here.

## Verification and rollout limits

Run `node --test --test-concurrency=1 tests/social-metrics*.test.mjs` plus the full repository checks. Synthetic transports live only in tests. Test enabling requires both `mode: "test"` and an explicitly injected transport (`socialMetrics: {enabled:true,fetchImpl,autoStart:false}`); merely setting the environment variable cannot cause live network in tests. Production/development rejects this options object.

No real account/API request, credential setup, deployment, OAuth scope expansion, or live grant has occurred as part of implementation. Before enabling collection, the operator must deploy the migration, configure approved existing Meta OAuth, verify correct app/Graph version and field access on authorized accounts, test revoke/reconnect and rate limits, then the brand owner opts in. Public shares only expose whatever supported, authorized snapshots actually exist.
