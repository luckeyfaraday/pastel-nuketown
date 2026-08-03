import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { COSMETICS, COSMETICS_BY_ID } from './cosmetics.mjs';
import { HttpError } from './http-utils.mjs';

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} is required.`);
  return value.trim();
}

function stripeReference(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.id === 'string') return value.id;
  return null;
}

function safeMetadata(object) {
  return object && object.metadata && typeof object.metadata === 'object'
    ? object.metadata
    : {};
}

export function verifyStripeWebhookSignature(
  rawBody,
  signatureHeader,
  secret,
  options = {}
) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const toleranceSeconds = options.toleranceSeconds || 300;
  if (!Buffer.isBuffer(rawBody)) rawBody = Buffer.from(rawBody || '');
  if (typeof signatureHeader !== 'string' || !signatureHeader)
    throw new HttpError(400, 'invalid_webhook_signature', 'Stripe signature is missing or invalid.');

  let timestamp = null;
  const signatures = [];
  for (const field of signatureHeader.split(',')) {
    const separator = field.indexOf('=');
    if (separator === -1) continue;
    const name = field.slice(0, separator).trim();
    const value = field.slice(separator + 1).trim();
    if (name === 't' && /^\d+$/.test(value) && timestamp === null)
      timestamp = Number.parseInt(value, 10);
    if (name === 'v1' && /^[a-f0-9]{64}$/i.test(value))
      signatures.push(Buffer.from(value, 'hex'));
  }
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0)
    throw new HttpError(400, 'invalid_webhook_signature', 'Stripe signature is missing or invalid.');

  const currentSeconds = Math.floor(now() / 1000);
  if (Math.abs(currentSeconds - timestamp) > toleranceSeconds)
    throw new HttpError(400, 'stale_webhook', 'Stripe webhook timestamp is outside the replay window.');

  const expected = createHmac('sha256', secret)
    .update(String(timestamp), 'ascii')
    .update('.', 'ascii')
    .update(rawBody)
    .digest();
  if (!signatures.some((candidate) =>
    candidate.length === expected.length && timingSafeEqual(candidate, expected)))
    throw new HttpError(400, 'invalid_webhook_signature', 'Stripe signature is missing or invalid.');
  return timestamp;
}

export function createShopService(options) {
  if (!options || !options.db) throw new Error('The shop needs an account database.');
  const db = options.db;
  const stripeSecretKey = requireString(options.stripeSecretKey, 'STRIPE_SECRET_KEY');
  const webhookSecret = requireString(options.stripeWebhookSecret, 'STRIPE_WEBHOOK_SECRET');
  const appOrigin = requireString(options.appOrigin, 'GAME_ORIGIN');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('The shop needs fetch().');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const priceIds = options.priceIds || {};
  const stripeApiBase = options.stripeApiBase || 'https://api.stripe.com/v1';
  const webhookToleranceSeconds = options.webhookToleranceSeconds || 300;
  const priceCacheMs = options.priceCacheMs || 5 * 60 * 1000;
  const configuredLogger = options.logger || console;
  /* A warning is diagnostic, never part of applying the Stripe event. Fall
     back field-by-field so a partial injected logger cannot throw inside the
     receipt-and-entitlement transaction and make Stripe retry forever. */
  const warn = typeof configuredLogger.warn === 'function'
    ? configuredLogger.warn.bind(configuredLogger)
    : console.warn.bind(console);
  const priceCache = new Map();

  async function stripeRequest(path, requestOptions = {}) {
    let response;
    try {
      response = await fetchImpl(`${stripeApiBase}${path}`, {
        ...requestOptions,
        headers: {
          authorization: `Bearer ${stripeSecretKey}`,
          ...(requestOptions.headers || {})
        }
      });
    } catch (error) {
      throw new HttpError(502, 'stripe_unavailable', 'The store is temporarily unavailable.');
    }
    if (!response.ok)
      throw new HttpError(502, 'stripe_unavailable', 'Stripe rejected the store request.');
    try {
      return await response.json();
    } catch (error) {
      throw new HttpError(502, 'stripe_unavailable', 'Stripe returned an invalid response.');
    }
  }

  async function loadPrice(priceId) {
    const cached = priceCache.get(priceId);
    if (cached && cached.expiresAt > now()) return cached.loading;
    if (!cached || cached.expiresAt <= now()) {
      const loading = stripeRequest(`/prices/${encodeURIComponent(priceId)}`)
        .then((price) => {
          if (!price || typeof price.id !== 'string' ||
              typeof price.currency !== 'string' ||
              !Number.isSafeInteger(price.unit_amount))
            throw new HttpError(502, 'stripe_unavailable', 'Stripe returned an invalid price.');
          return price;
        })
        .catch((error) => {
          const current = priceCache.get(priceId);
          if (current && current.loading === loading) priceCache.delete(priceId);
          throw error;
        });
      priceCache.set(priceId, { loading, expiresAt: now() + priceCacheMs });
      return loading;
    }
    return cached.loading;
  }

  async function catalog(userId = null) {
    const owned = new Set(userId ? db.listEntitlements(userId) : []);
    return Promise.all(COSMETICS.map(async (cosmetic) => {
      const priceId = priceIds[cosmetic.id];
      let price = null;
      let available = false;
      if (typeof priceId === 'string' && priceId) {
        const stripePrice = await loadPrice(priceId);
        available = stripePrice.active !== false;
        if (available) {
          price = {
            unitAmount: stripePrice.unit_amount,
            currency: stripePrice.currency
          };
        }
      }
      return {
        id: cosmetic.id,
        displayName: cosmetic.displayName,
        type: cosmetic.type,
        slot: cosmetic.slot,
        available,
        price,
        ...(userId ? { owned: owned.has(cosmetic.id) } : {})
      };
    }));
  }

  async function checkout(userId, cosmeticId) {
    const cosmetic = COSMETICS_BY_ID.get(cosmeticId);
    if (!cosmetic)
      throw new HttpError(400, 'unknown_cosmetic', 'That cosmetic does not exist.');
    if (db.hasEntitlement(userId, cosmetic.id))
      throw new HttpError(409, 'already_owned', 'You already own that cosmetic.');
    const grantVersion = db.entitlementGrantVersion(userId, cosmetic.id);
    const priceId = priceIds[cosmetic.id];
    if (typeof priceId !== 'string' || !priceId)
      throw new HttpError(409, 'cosmetic_unavailable', 'That cosmetic is not available for purchase.');
    const stripePrice = await loadPrice(priceId);
    if (stripePrice.active === false)
      throw new HttpError(409, 'cosmetic_unavailable', 'That cosmetic is not available for purchase.');

    /* The user and item are copied into both Checkout and its PaymentIntent.
       Checkout's completion event grants the item; the PaymentIntent metadata
       gives later charge/refund events enough identity to revoke it even when
       Stripe delivers only a Charge object. None of these values come from the
       browser: userId came from the bearer session and the item came from the
       fixed catalog above. */
    const form = new URLSearchParams({
      mode: 'payment',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${appOrigin.replace(/\/$/, '')}/?checkout=success`,
      cancel_url: `${appOrigin.replace(/\/$/, '')}/?checkout=cancelled`,
      client_reference_id: userId,
      'metadata[user_id]': userId,
      'metadata[cosmetic_id]': cosmetic.id,
      'payment_intent_data[metadata][user_id]': userId,
      'payment_intent_data[metadata][cosmetic_id]': cosmetic.id
    });
    /* The key names the purchase generation, not the tab that happened to ask.
       Concurrent tabs see the same prior grant and converge on one Checkout
       Session. After a refund, the retained row's granted_at distinguishes the
       repurchase; each later grant refreshes it for the next generation. Keep
       the first-purchase material unchanged so deploys do not split an in-flight
       Checkout across the old and new key schemes. */
    const purchaseIdentity =
      `pastel-nuketown-checkout\0${userId}\0${cosmetic.id}`;
    const idempotencyKey = createHash('sha256')
      .update(
        grantVersion === null
          ? purchaseIdentity
          : `${purchaseIdentity}\0${grantVersion}`,
        'utf8'
      )
      .digest('hex');
    const session = await stripeRequest('/checkout/sessions', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey
      },
      body: form
    });
    if (!session || typeof session.url !== 'string' || !session.url.startsWith('https://'))
      throw new HttpError(502, 'stripe_unavailable', 'Stripe did not return a checkout URL.');
    return { url: session.url };
  }

  function completedCheckout(object) {
    const metadata = safeMetadata(object);
    const userId = typeof metadata.user_id === 'string'
      ? metadata.user_id
      : (typeof object.client_reference_id === 'string' ? object.client_reference_id : null);
    const cosmeticId = typeof metadata.cosmetic_id === 'string'
      ? metadata.cosmetic_id
      : null;
    /* Old or hand-built Stripe objects should be acknowledged, but they must
       never mint an item outside this catalog or for a user that does not
       exist. Retrying such an event forever cannot make it safer. */
    if (!userId || !db.getUser(userId) || !COSMETICS_BY_ID.has(cosmeticId))
      return { action: 'ignored' };
    const paymentIntentId = stripeReference(object.payment_intent);
    if (db.hasEntitlement(userId, cosmeticId)) {
      /* Stripe has taken payment for a thing this account already owns. The
         correct remedy is a product decision (and may be a refund), so retain
         the event and make the duplicate unmistakable in the service journal
         rather than silently pretending one charge happened. */
      warn(
        `Duplicate paid cosmetic purchase for user ${userId}, item ${cosmeticId}, ` +
        `payment intent ${paymentIntentId || '<missing>'}.`
      );
    }
    db.grantEntitlement({
      userId,
      cosmeticId,
      checkoutSessionId: stripeReference(object.id),
      paymentIntentId,
      grantedAt: now()
    });
    return { action: 'granted', userId, cosmeticId };
  }

  function refundedInFull(object) {
    if (object && object.refunded === true) return true;
    return object && Number.isFinite(object.amount) && object.amount >= 0 &&
      Number.isFinite(object.amount_refunded) &&
      object.amount_refunded >= object.amount;
  }

  function revokedCharge(object) {
    const charge = object && object.charge && typeof object.charge === 'object'
      ? object.charge
      : null;
    const metadata = {
      ...safeMetadata(charge),
      ...safeMetadata(object)
    };
    const paymentIntentId = stripeReference(object && object.payment_intent) ||
      stripeReference(charge && charge.payment_intent);
    const revoked = db.revokePurchase({
      paymentIntentId,
      userId: typeof metadata.user_id === 'string' ? metadata.user_id : null,
      cosmeticId: typeof metadata.cosmetic_id === 'string' ? metadata.cosmetic_id : null,
      revokedAt: now()
    });
    return { action: 'revoked', count: revoked };
  }

  function applyWebhookEvent(event) {
    const object = event.data && event.data.object;
    if (!object || typeof object !== 'object') return { action: 'ignored' };
    if (event.type === 'checkout.session.completed') {
      /* Checkout completion can precede payment for delayed methods. Recording
         the receipt prevents replay, but only Stripe's paid state is authority
         to mint an entitlement; its later async-success event gets a separate
         receipt and performs the grant. */
      if (object.payment_status === 'paid') return completedCheckout(object);
      if (object.payment_status === 'unpaid') return { action: 'ignored' };
      /* A free grant is not currently an authorised store flow. Keep failing
         closed for `no_payment_required` and unknown future states, but make the
         completed session loud because its receipt prevents Stripe retrying it. */
      warn(
        `Stripe Checkout Session ${stripeReference(object.id) || '<missing>'} ` +
        `completed with unhandled payment status ` +
        `${typeof object.payment_status === 'string' ? object.payment_status : '<missing>'}.`
      );
      return { action: 'ignored' };
    }
    if (event.type === 'checkout.session.async_payment_succeeded')
      return completedCheckout(object);
    if (event.type === 'checkout.session.async_payment_failed')
      return { action: 'ignored' };
    if (event.type === 'charge.refunded' && !refundedInFull(object))
      return { action: 'ignored' };
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const result = revokedCharge(object);
      if (result.count === 0) {
        warn(
          `Stripe revocation event ${event.id} (${event.type}) matched zero entitlements.`
        );
      }
      return result;
    }
    return { action: 'ignored' };
  }

  async function webhook(rawBody, signatureHeader) {
    verifyStripeWebhookSignature(rawBody, signatureHeader, webhookSecret, {
      now,
      toleranceSeconds: webhookToleranceSeconds
    });
    let event;
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch (error) {
      throw new HttpError(400, 'invalid_webhook', 'Stripe webhook body is not valid JSON.');
    }
    if (!event || typeof event.id !== 'string' || !event.id ||
        typeof event.type !== 'string' || !event.type)
      throw new HttpError(400, 'invalid_webhook', 'Stripe webhook envelope is invalid.');

    const object = event.data && event.data.object;
    if (event.type === 'charge.dispute.created' && object &&
        typeof object.charge === 'string' && object.charge &&
        !stripeReference(object.payment_intent)) {
      /* Stripe normally leaves `charge` unexpanded on disputes. Resolve it
         before opening the SQLite transaction so a charge-only event can still
         find its PaymentIntent, without ever holding the write lock across a
         network request. The apply callback below deliberately remains fully
         synchronous. If Stripe is unavailable no receipt is written, allowing
         its normal webhook retry to try the revocation again. */
      object.charge = await stripeRequest(
        `/charges/${encodeURIComponent(object.charge)}`
      );
    }
    return db.processWebhookEvent(event.id, event.type, now(), () =>
      applyWebhookEvent(event));
  }

  return { catalog, checkout, webhook };
}
