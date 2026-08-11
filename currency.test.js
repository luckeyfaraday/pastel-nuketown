'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const test = require('node:test');

function response(body) {
  return {
    ok: true,
    async json() { return body; }
  };
}

function signedEvent(event, secret, now) {
  const raw = Buffer.from(JSON.stringify(event));
  const timestamp = Math.floor(now / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`, 'ascii')
    .update(raw)
    .digest('hex');
  return { raw, header: `t=${timestamp},v1=${signature}` };
}

test('wallet spending is atomic and payment reversals create debt without duplicating purchases', async (t) => {
  const { openStoreDatabase } = await import('./store-db.mjs');
  const db = openStoreDatabase(':memory:', {
    revocationIdFactory: () => 'currency-reversal-1'
  });
  t.after(() => db.close());
  const user = db.upsertGoogleUser({
    subject: 'wallet-user', email: 'wallet@example.com', displayName: 'Wallet'
  }, 1000);

  assert.deepEqual(db.creditCurrencyTopup({
    userId: user.id,
    packId: 'pastels-1100',
    amount: 1100,
    checkoutSessionId: 'cs_wallet_1',
    paymentIntentId: 'pi_wallet_1',
    creditedAt: 2000
  }), { credited: true, balance: 1100 });
  assert.deepEqual(db.creditCurrencyTopup({
    userId: user.id,
    packId: 'pastels-1100',
    amount: 1100,
    checkoutSessionId: 'cs_wallet_1',
    paymentIntentId: 'pi_wallet_1',
    creditedAt: 2001
  }), { credited: false, balance: 1100 });

  const first = db.purchaseWithCurrency({
    userId: user.id, cosmeticId: 'smg-cottoncloud', amount: 500, purchasedAt: 3000
  });
  assert.equal(first.purchased, true);
  assert.equal(first.balance, 600);
  assert.deepEqual(db.purchaseWithCurrency({
    userId: user.id, cosmeticId: 'smg-cottoncloud', amount: 500, purchasedAt: 3001
  }), { purchased: false, reason: 'already_owned', balance: 600 });
  assert.deepEqual(db.purchaseWithCurrency({
    userId: user.id, cosmeticId: 'char-midnight', amount: 800, purchasedAt: 3002
  }), { purchased: false, reason: 'insufficient_funds', balance: 600 });

  const reversed = db.reverseCurrencyTopup({
    paymentIntentId: 'pi_wallet_1', reversedAt: 4000
  });
  assert.equal(reversed.reversed, true);
  assert.equal(reversed.balance, -500);
  assert.equal(db.hasEntitlement(user.id, 'smg-cottoncloud'), true);
  assert.equal(db.purchaseWithCurrency({
    userId: user.id, cosmeticId: 'char-midnight', amount: 800, purchasedAt: 4001
  }).reason, 'insufficient_funds');

  const restored = db.restoreCurrencyTopup({
    paymentIntentId: 'pi_wallet_1', restoredAt: 5000
  });
  assert.equal(restored.restored, true);
  assert.equal(restored.balance, 600);
  assert.equal(db.restoreCurrencyTopup({
    paymentIntentId: 'pi_wallet_1', restoredAt: 5001
  }).restored, false);
});

test('Stripe checkout sells a fixed currency pack and its webhooks adjust the wallet', async (t) => {
  const [{ openStoreDatabase }, { createShopService }] = await Promise.all([
    import('./store-db.mjs'),
    import('./shop.mjs')
  ]);
  const db = openStoreDatabase(':memory:');
  t.after(() => db.close());
  const user = db.upsertGoogleUser({
    subject: 'stripe-wallet', email: 'stripe@example.com', displayName: 'Stripe Wallet'
  }, 1000);
  const now = 1_900_000_000_000;
  const checkoutRequests = [];
  const shop = createShopService({
    db,
    stripeSecretKey: 'sk_test_wallet',
    stripeWebhookSecret: 'whsec_wallet',
    appOrigin: 'https://game.example',
    currencyOnly: true,
    currencyPriceIds: { 'pastels-500': 'price_pastels_500' },
    now: () => now,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/prices/price_pastels_500')) {
        return response({
          id: 'price_pastels_500', currency: 'usd', unit_amount: 499, active: true
        });
      }
      if (url.endsWith('/checkout/sessions')) {
        checkoutRequests.push({
          form: new URLSearchParams(options.body),
          idempotencyKey: options.headers['idempotency-key']
        });
        return response({ url: 'https://checkout.stripe.com/c/pay/cs_wallet' });
      }
      throw new Error(`Unexpected Stripe URL: ${url}`);
    }
  });

  const catalog = await shop.catalog(user.id);
  assert.equal(catalog[0].currencyAvailable, true);
  assert.equal(catalog[0].currencyPrice, 500);
  assert.equal(catalog[0].available, false, 'direct item checkout is disabled');
  const wallet = await shop.wallet(user.id);
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.packs[0].available, true);
  assert.deepEqual(wallet.packs[0].price, { unitAmount: 499, currency: 'usd' });

  const checkout = await shop.currencyCheckout(user.id, 'pastels-500');
  assert.match(checkout.url, /^https:\/\/checkout\.stripe\.com\//);
  const form = checkoutRequests[0].form;
  assert.equal(form.get('line_items[0][price]'), 'price_pastels_500');
  assert.equal(form.get('metadata[purchase_type]'), 'currency_pack');
  assert.equal(form.get('metadata[currency_pack_id]'), 'pastels-500');
  assert.equal(form.has('metadata[cosmetic_id]'), false);

  async function send(event) {
    const signed = signedEvent(event, 'whsec_wallet', now);
    return shop.webhook(signed.raw, signed.header);
  }
  await send({
    id: 'evt_wallet_paid',
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_wallet_1',
      payment_intent: 'pi_wallet_1',
      payment_status: 'paid',
      metadata: {
        purchase_type: 'currency_pack',
        user_id: user.id,
        currency_pack_id: 'pastels-500'
      }
    } }
  });
  assert.equal(db.currencyBalance(user.id), 500);
  assert.equal(shop.purchaseWithCurrency(user.id, 'smg-cottoncloud').balance, 0);

  await send({
    id: 'evt_wallet_refund',
    type: 'charge.refunded',
    data: { object: {
      payment_intent: 'pi_wallet_1', amount: 499, amount_refunded: 499, refunded: true
    } }
  });
  assert.equal(db.currencyBalance(user.id), -500);
  assert.equal(db.hasEntitlement(user.id, 'smg-cottoncloud'), true);

  await send({
    id: 'evt_wallet_dispute_won',
    type: 'charge.dispute.closed',
    data: { object: {
      status: 'won',
      charge: { payment_intent: 'pi_wallet_1', refunded: false }
    } }
  });
  assert.equal(db.currencyBalance(user.id), 0);
});
