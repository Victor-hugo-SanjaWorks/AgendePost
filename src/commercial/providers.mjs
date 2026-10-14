import Stripe from 'stripe';
import { randomBytes } from 'node:crypto';

export const STRIPE_API_VERSION = '2024-06-20';
export const WEBHOOK_TOLERANCE_SECONDS = 300;
const ALLOWED_EVENTS = new Set(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed']);
const id = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{1,200}$`).test(value);
export class BillingError extends Error {
  constructor(code, message = 'Cobrança indisponível.', statusCode = 503) { super(message); this.code = code; this.statusCode = statusCode; }
}
export class DisabledBillingProvider {
  enabled = false;
  name = 'disabled';
  createCheckout() { throw new BillingError('BILLING_NOT_CONFIGURED', 'Cobrança não configurada. Os preços estão a definir.'); }
  createPortal() { throw new BillingError('BILLING_NOT_CONFIGURED', 'Portal de cobrança não configurado.'); }
  verifyWebhook() { throw new BillingError('BILLING_NOT_CONFIGURED'); }
  fetchSubscription() { throw new BillingError('BILLING_NOT_CONFIGURED'); }
  fetchInvoice() { throw new BillingError('BILLING_NOT_CONFIGURED'); }
  normalizeEvent() { throw new BillingError('BILLING_NOT_CONFIGURED'); }
}

/** Local cryptographic verification only. This class has no API client or transport. */
export class StripeWebhookVerifier {
  constructor({ webhookSecret, accountScope = 'platform', clock = () => new Date().toISOString(), apiVersion = STRIPE_API_VERSION }) {
    if (typeof webhookSecret !== 'string' || webhookSecret.length < 24) throw new TypeError('An ephemeral test signing secret is required');
    this.webhookSecret = webhookSecret;
    this.accountScope = accountScope;
    this.clock = clock;
    this.apiVersion = apiVersion;
  }
  verifyWebhook(rawBody, headers) {
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 256 * 1024) throw new BillingError('WEBHOOK_BODY_INVALID', 'Corpo inválido.', 400);
    if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') throw new BillingError('WEBHOOK_ENCODING_INVALID', 'Compressão não aceita.', 415);
    const signature = headers['stripe-signature'];
    if (typeof signature !== 'string' || signature.length > 4096) throw new BillingError('WEBHOOK_SIGNATURE_INVALID', 'Assinatura inválida.', 400);
    let event;
    try {
      const receivedAt = new Date(this.clock()).getTime();
      if (!Number.isFinite(receivedAt)) throw new Error('clock');
      event = Stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret, WEBHOOK_TOLERANCE_SECONDS, undefined, receivedAt);
      // Stripe enforces old signatures. Also reject implausibly future-signed requests.
      const timestamp = Number(signature.match(/(?:^|,)t=(\d+)(?:,|$)/)?.[1]);
      if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(receivedAt / 1000) - timestamp) > WEBHOOK_TOLERANCE_SECONDS) throw new Error('timestamp');
    } catch { throw new BillingError('WEBHOOK_SIGNATURE_INVALID', 'Assinatura inválida ou expirada.', 400); }
    return this.normalizeEvent(event);
  }
  normalizeEvent(event) {
    if (!event || event.object !== 'event' || !id(event.id, 'evt') || event.livemode !== false || event.api_version !== this.apiVersion || !Number.isSafeInteger(event.created) || event.created < 0)
      throw new BillingError('WEBHOOK_CONTEXT_INVALID', 'Modo ou versão do evento inválidos.', 400);
    const account = event.account ?? 'platform';
    if (account !== this.accountScope) throw new BillingError('WEBHOOK_ACCOUNT_INVALID', 'Conta do evento inválida.', 400);
    if (!ALLOWED_EVENTS.has(event.type)) throw new BillingError('WEBHOOK_TYPE_UNSUPPORTED', 'Tipo de evento não habilitado.', 400);
    const object = event.data?.object;
    const subscriptionEvent = event.type.startsWith('customer.subscription.');
    const subscriptionId = subscriptionEvent ? object?.id : object?.subscription;
    if (!object || object.object !== (subscriptionEvent ? 'subscription' : 'invoice') || !id(object.id, subscriptionEvent ? 'sub' : 'in') || !id(object.customer, 'cus') || !id(subscriptionId, 'sub'))
      throw new BillingError('WEBHOOK_SCHEMA_INVALID', 'Estrutura de evento inválida.', 400);
    // Deliberately drop metadata, price, status and arbitrary fields. Mapping and access come from server bindings/current reconciliation.
    return { provider: 'stripe', accountScope: account, eventId: event.id, eventType: event.type, objectId: object.id, subscriptionId, customerId: object.customer };
  }
}

/** Injection-only test double, deliberately incapable of checkout or network requests. */
export class OfflineStripeTestAdapter extends DisabledBillingProvider {
  enabled = true;
  name = 'stripe';
  testOnly = true;
  constructor({ mode, webhookSecret = randomBytes(32).toString('hex'), accountScope = 'platform', clock, subscriptions = [], invoices = [] } = {}) {
    super();
    if (mode !== 'test') throw new Error('Offline billing adapters are restricted to test mode');
    this.verifier = new StripeWebhookVerifier({ webhookSecret, accountScope, clock });
    this.subscriptions = new Map(subscriptions.map(s => [s.id, structuredClone(s)]));
    this.invoices = new Map(invoices.map(i => [i.id, structuredClone(i)]));
    this.calls = { subscription: 0, invoice: 0 };
    this.failuresRemaining = 0;
  }
  verifyWebhook(rawBody, headers) { return this.verifier.verifyWebhook(rawBody, headers); }
  normalizeEvent(event) { return this.verifier.normalizeEvent(event); }
  async fetchSubscription(subscriptionId) {
    this.calls.subscription++;
    if (this.failuresRemaining > 0) { this.failuresRemaining--; throw new BillingError('PROVIDER_UNAVAILABLE'); }
    const result = this.subscriptions.get(subscriptionId);
    if (!result) throw new BillingError('PROVIDER_OBJECT_NOT_FOUND');
    return structuredClone(result);
  }
  async fetchInvoice(invoiceId) {
    this.calls.invoice++;
    const result = this.invoices.get(invoiceId);
    if (!result) throw new BillingError('PROVIDER_OBJECT_NOT_FOUND');
    return structuredClone(result);
  }
}
