# Commercial pilot module

This module implements technical entitlements, quotas, operational administration and an offline billing verification contract. It does not sell subscriptions, connect a Stripe account, store payment credentials, issue receipts or send requests to Stripe.

## Runtime

The foundation calls `initializeCommercial(ctx, { billingAdapter })` after all migrations and before tenant routes, followed by `registerCommercial(app, ctx)`. Default provider: `DisabledBillingProvider`. The webhook route does not exist when disabled. Both checkout and portal return typed HTTP 503 after owner/recent-auth checks; they never return fabricated URLs.

A created tenant receives an explicitly labelled 14-day `manual_trial` using `pilot_base` v1. Presets have no price; the public label is “a definir”. Plan definitions are immutable by version. A grant is not a payment. Administrative grants require an existing separately bootstrapped platform-admin identity, recent authentication, a reason, an end date within 90 days and an idempotency key. The web API cannot assign platform-administrator privileges. Platform metadata endpoints expose no post text or media bytes and confer no tenant membership.

`ctx.services.entitlements.assertCan(tid, resource, delta)` must run in the same synchronous database write transaction as the mutation. Its resources are `workspaces`, `members`, `posts`, and `mediaBytes`; `delta=0` checks write access without requiring growth capacity. It fails closed outside a transaction. Pending valid invitations reserve seats; archived workspaces/posts do not consume their respective active quotas. Media counts normalized stored bytes. Expired/suspended access is read-only; downgrades preserve data and block increases only in the resource that exceeds its limit. Only tenant owners/admins receive organization-wide consumption figures over HTTP; brand-scoped roles receive plan/access/limits with `usage: null` and no over-limit list. Quota errors never expose aggregate used counts.

## Offline billing tests

`OfflineStripeTestAdapter` requires explicit `mode: 'test'`; app initialization rejects adapter injection in development. The adapter holds synthetic snapshots in Maps, and has no network client. `StripeWebhookVerifier` uses the official Stripe SDK on original body bytes with a 300-second clock window. Synthetic events target the fixed `2024-06-20` API shape and test mode only. Supported events: subscription created/updated/deleted and invoice paid/payment_failed. No claim is made about sandbox or live integration.

Server-provisioned customer/subscription bindings determine the tenant and plan. Metadata, event price and event status never determine access. Unknown/mismatched objects are quarantined. Only event identifiers, a body digest and operational status are retained, not raw webhook bodies.

Receipt atomically commits the event, deduplicated reconciliation job and audit before acknowledging. `ctx.services.billing.processNextJob()` performs one offline worker iteration: acquire a subscription lease, fetch current fixture invoice/subscription state outside the transaction, and apply only while still owning the lease. Expired-worker snapshots are fenced out. Current `active` or bounded `trialing` state permits access; other statuses are immediately read-only with no grace period. Five attempts, exponential backoff with deterministic jitter, safe error codes and an operational failure list make failure visible. A crashed final attempt becomes failed when its lease expires. Manual retry is authenticated, recent-authenticated, reasoned, idempotent and audited. No billing worker, webhook or social-publishing job runs in the default pilot.

## Verification

`node --test tests/commercial-core.test.mjs` covers transactional quotas, trial expiry, data retention, immutable presets, actual official-SDK signatures, altered bytes and clock rejection, mode/account/API validation, unknown mappings, hostile metadata, event deduplication, current-state reconciliation, worker retries, lease fencing and normalized database constraints. Independent HTTP/security tests exercise the integrated routes and authentication.

Public launch still requires approved commercial terms/prices, real authorized sandbox integration, PostgreSQL/RLS, operational security and the launch gates in the main contract. Nothing in this module enables those steps implicitly.
