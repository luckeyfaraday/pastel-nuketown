'use strict';

const assert = require('node:assert/strict');
const {
  createHash,
  createHmac,
  generateKeyPairSync,
  sign
} = require('node:crypto');
const { Readable } = require('node:stream');
const test = require('node:test');

function response(body, options = {}) {
  return {
    ok: options.ok !== false,
    status: options.status || 200,
    headers: {
      get(name) {
        return name.toLowerCase() === 'cache-control'
          ? (options.cacheControl || null)
          : null;
      }
    },
    async json() { return body; }
  };
}

function webhookBody(event) {
  return Buffer.from(JSON.stringify(event), 'utf8');
}

function webhookHeader(raw, secret, timestamp) {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.`, 'ascii')
    .update(raw)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function signedGoogleToken(privateKey, kid, claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid }))
    .toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

async function httpRequest(accountStore, path, options = {}) {
  const rawBody = options.body === undefined
    ? Buffer.alloc(0)
    : Buffer.from(options.body, 'utf8');
  const request = Readable.from(rawBody.length ? [rawBody] : []);
  request.method = options.method || 'GET';
  request.headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  if (rawBody.length) request.headers['content-length'] = String(rawBody.length);
  let status = 0;
  let headers = {};
  const chunks = [];
  const response = {
    headersSent: false,
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = Object.fromEntries(
        Object.entries(nextHeaders).map(([name, value]) => [name.toLowerCase(), String(value)])
      );
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };
  const handled = await accountStore.handleHttp(
    request,
    response,
    new URL(path, 'http://relay.test')
  );
  const body = Buffer.concat(chunks).toString('utf8');
  return {
    handled,
    status,
    headers,
    body,
    json: () => JSON.parse(body)
  };
}

async function accountModules() {
  const [database, auth, shop, accountStore] = await Promise.all([
    import('./store-db.mjs'),
    import('./auth.mjs'),
    import('./shop.mjs'),
    import('./account-store.mjs')
  ]);
  return { database, auth, shop, accountStore };
}

function serviceOptions(db, overrides = {}) {
  return {
    db,
    googleClientId: 'google-client.test',
    googleClientSecret: 'google-secret',
    googleRedirectUri: 'https://relay.example/auth/google/callback',
    appOrigin: 'https://game.example',
    stripeSecretKey: 'sk_test_fake',
    stripeWebhookSecret: 'whsec_test',
    fetchImpl: async () => { throw new Error('Unexpected network request'); },
    ...overrides
  };
}

test('session tokens issue, expire, and revoke without storing client claims', async (t) => {
  const { database, auth } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  let clock = 1_800_000_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-1',
    email: 'player@example.com',
    displayName: 'Player One'
  }, clock);
  const sessions = auth.createAuthService({
    ...serviceOptions(db),
    now: () => clock,
    sessionTtlMs: 1_000
  });

  const first = sessions.issueSession(user.id);
  const authenticated = sessions.authenticate({
    authorization: `Bearer ${first.token}`
  });
  assert.equal(authenticated.userId, user.id);
  assert.deepEqual(authenticated.entitlements, []);

  clock += 1_000;
  assert.throws(
    () => sessions.authenticate({ authorization: `Bearer ${first.token}` }),
    (error) => error.code === 'invalid_session' && error.status === 401
  );

  const second = sessions.issueSession(user.id);
  assert.equal(
    db.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count,
    1,
    'issuing a session prunes credentials that have already expired'
  );
  sessions.revokePresentedSession({ authorization: `Bearer ${second.token}` });
  assert.throws(
    () => sessions.authenticate({ authorization: `Bearer ${second.token}` }),
    (error) => error.code === 'invalid_session' && error.status === 401
  );
});

test('Google callback consumes state and verifies a signed ID token against JWKS', async (t) => {
  const { database, auth } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const clock = 1_800_000_000_000;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'google-key-1', alg: 'RS256', use: 'sig' });
  let idToken = '';
  let tokenExchanges = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenExchanges++;
      return response({ id_token: idToken });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/certs')
      return response({ keys: [jwk] }, { cacheControl: 'public, max-age=3600' });
    throw new Error(`Unexpected URL ${url}`);
  };
  const google = auth.createAuthService({
    ...serviceOptions(db),
    fetchImpl,
    now: () => clock
  });
  const consent = new URL(google.startGoogleLogin());
  const state = consent.searchParams.get('state');
  const nonce = consent.searchParams.get('nonce');
  const validClaims = {
    iss: 'https://accounts.google.com',
    aud: 'google-client.test',
    exp: Math.floor(clock / 1000) + 3_600,
    iat: Math.floor(clock / 1000),
    nonce,
    sub: 'google-subject',
    email: 'Player@Example.com',
    email_verified: true,
    name: 'Pastel Player'
  };
  idToken = signedGoogleToken(privateKey, jwk.kid, validClaims);

  const session = await google.finishGoogleLogin({ code: 'one-use-code', state });
  assert.equal(session.user.email, 'player@example.com');
  assert.equal(session.user.displayName, 'Pastel Player');
  assert.equal(
    google.authenticate({ authorization: `Bearer ${session.token}` }).userId,
    session.user.id
  );
  const parts = idToken.split('.');
  const alteredClaims = Buffer.from(JSON.stringify({
    ...validClaims,
    aud: 'somebody-elses-client'
  })).toString('base64url');
  await assert.rejects(
    google.verifyGoogleIdToken(`${parts[0]}.${alteredClaims}.${parts[2]}`, nonce),
    (error) => error.code === 'invalid_google_token' && /signature/i.test(error.message)
  );
  await assert.rejects(
    google.finishGoogleLogin({ code: 'another-code', state }),
    (error) => error.code === 'invalid_oauth_state'
  );
  assert.equal(tokenExchanges, 1, 'a consumed state is rejected before another code exchange');
});

test('Google ID token claim checks reject independently re-signed tokens', async (t) => {
  const { database, auth } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const clock = 1_800_000_000_000;
  const currentSeconds = Math.floor(clock / 1000);
  const nonce = 'expected-nonce';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: 'jwk' });
  Object.assign(jwk, { kid: 'google-claims-key', alg: 'RS256', use: 'sig' });
  const google = auth.createAuthService({
    ...serviceOptions(db),
    now: () => clock,
    fetchImpl: async (url) => {
      assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
      return response({ keys: [jwk] }, { cacheControl: 'public, max-age=3600' });
    }
  });
  const validClaims = {
    iss: 'https://accounts.google.com',
    aud: 'google-client.test',
    exp: currentSeconds + 3_600,
    iat: currentSeconds,
    nonce,
    sub: 'google-claims-subject',
    email: 'claims@example.com',
    email_verified: true
  };
  const invalidClaims = [
    ['wrong audience', { aud: 'somebody-elses-client' }, /audience/i],
    ['wrong issuer', { iss: 'https://identity.example' }, /issuer/i],
    ['expired beyond clock leeway', { exp: currentSeconds - 61 }, /expired/i],
    ['unverified email', { email_verified: false }, /verified account identity/i],
    ['wrong nonce', { nonce: 'someone-elses' }, /nonce/i],
    [
      'multi-audience token with the wrong authorized party',
      { aud: ['google-client.test', 'another-client'], azp: 'another-client' },
      /audience/i
    ],
    ['future issued-at time', { iat: currentSeconds + 301 }, /future/i]
  ];

  for (const [name, overrides, message] of invalidClaims) {
    await t.test(name, async () => {
      const token = signedGoogleToken(privateKey, jwk.kid, {
        ...validClaims,
        ...overrides
      });
      await assert.rejects(
        google.verifyGoogleIdToken(token, nonce),
        (error) => error.code === 'invalid_google_token' && message.test(error.message)
      );
    });
  }

  await assert.doesNotReject(() => google.verifyGoogleIdToken(
    signedGoogleToken(privateKey, jwk.kid, {
      ...validClaims,
      exp: currentSeconds - 30
    }),
    nonce
  ));
});

/* Anybody at all can start a login, and the pending states have to be bounded
   because of it. What must not happen is a stranger's traffic quietly taking
   the seat of somebody who is already at Google's consent screen: that failure
   surfaces minutes later, at the callback, as "state missing, expired, or
   already used", with nothing to say a flood caused it. */
test('a burst of new sign-ins is refused rather than evicting a login in flight', async (t) => {
  const { database, auth } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  let clock = 1_800_000_000_000;
  const google = auth.createAuthService({
    ...serviceOptions(db),
    now: () => clock,
    maxPendingStates: 2,
    fetchImpl: async () => response({}, { ok: false })
  });

  const inFlight = new URL(google.startGoogleLogin()).searchParams.get('state');
  google.startGoogleLogin();
  assert.throws(
    () => google.startGoogleLogin(),
    (error) => error.status === 503 && error.code === 'sign_in_busy'
  );

  /* Reaching Google and being turned away there proves the state survived: an
     evicted login fails earlier and differently, on the state itself. */
  await assert.rejects(
    google.finishGoogleLogin({ code: 'code-from-google', state: inFlight }),
    (error) => error.code === 'invalid_oauth_code',
    'the login already in flight was discarded to make room for a stranger'
  );

  /* And the cap is a queue, not a wall: the entries expire and sign-in reopens
     without anybody restarting the relay. */
  clock += 11 * 60 * 1000;
  assert.match(google.startGoogleLogin(), /^https:\/\/accounts\.google\.com\//);
});

test('webhooks reject bad signatures and timestamps before reading events', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000
  });
  const raw = webhookBody({ id: 'evt_bad', type: 'unimportant', data: { object: {} } });

  await assert.rejects(
    store.webhook(raw, webhookHeader(raw, 'the-wrong-secret', timestamp)),
    (error) => error.code === 'invalid_webhook_signature'
  );
  await assert.rejects(
    store.webhook(raw, webhookHeader(raw, 'whsec_test', timestamp - 301)),
    (error) => error.code === 'stale_webhook'
  );
  assert.equal(db.countProcessedWebhookEvents(), 0);
});

test('double-delivered checkout grants once and refunds and disputes revoke it', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-webhook',
    email: 'buyer@example.com',
    displayName: 'Buyer'
  }, timestamp * 1000);
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000
  });
  const completed = webhookBody({
    id: 'evt_checkout_1',
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_1',
      payment_status: 'paid',
      payment_intent: 'pi_1',
      metadata: { user_id: user.id, cosmetic_id: 'smg-cottoncloud' }
    } }
  });
  const completedSignature = webhookHeader(completed, 'whsec_test', timestamp);

  assert.equal((await store.webhook(completed, completedSignature)).duplicate, false);
  assert.equal((await store.webhook(completed, completedSignature)).duplicate, true);
  assert.deepEqual(db.listEntitlements(user.id), ['smg-cottoncloud']);
  assert.equal(db.countProcessedWebhookEvents(), 1);

  const refunded = webhookBody({
    id: 'evt_refund_1',
    type: 'charge.refunded',
    data: { object: { id: 'ch_1', payment_intent: 'pi_1', refunded: true } }
  });
  await store.webhook(refunded, webhookHeader(refunded, 'whsec_test', timestamp));
  assert.deepEqual(db.listEntitlements(user.id), []);

  const secondCheckout = webhookBody({
    id: 'evt_checkout_2',
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_2',
      payment_status: 'paid',
      payment_intent: 'pi_2',
      metadata: { user_id: user.id, cosmetic_id: 'smg-cottoncloud' }
    } }
  });
  await store.webhook(secondCheckout, webhookHeader(secondCheckout, 'whsec_test', timestamp));
  const lateOldRefund = webhookBody({
    id: 'evt_refund_old_again',
    type: 'charge.refunded',
    data: { object: {
      id: 'ch_1',
      payment_intent: 'pi_1',
      refunded: true,
      metadata: { user_id: user.id, cosmetic_id: 'smg-cottoncloud' }
    } }
  });
  await store.webhook(lateOldRefund, webhookHeader(lateOldRefund, 'whsec_test', timestamp));
  assert.deepEqual(
    db.listEntitlements(user.id),
    ['smg-cottoncloud'],
    'a late refund for an older purchase does not revoke the repurchase'
  );
  const dispute = webhookBody({
    id: 'evt_dispute_1',
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_1', payment_intent: 'pi_2' } }
  });
  await store.webhook(dispute, webhookHeader(dispute, 'whsec_test', timestamp));
  assert.deepEqual(db.listEntitlements(user.id), []);
});

test('unpaid and failed Checkout sessions record receipts without granting', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-delayed-payment',
    email: 'delayed@example.com',
    displayName: 'Delayed Buyer'
  });
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000
  });
  const session = {
    id: 'cs_delayed',
    status: 'complete',
    payment_status: 'unpaid',
    payment_intent: 'pi_delayed',
    metadata: { user_id: user.id, cosmetic_id: 'smg-cottoncloud' }
  };
  const unpaid = webhookBody({
    id: 'evt_unpaid',
    type: 'checkout.session.completed',
    data: { object: session }
  });
  const unpaidResult = await store.webhook(
    unpaid,
    webhookHeader(unpaid, 'whsec_test', timestamp)
  );
  assert.equal(unpaidResult.result.action, 'ignored');
  assert.equal(db.countProcessedWebhookEvents(), 1);
  assert.deepEqual(db.listEntitlements(user.id), []);

  const failed = webhookBody({
    id: 'evt_async_failed',
    type: 'checkout.session.async_payment_failed',
    data: { object: session }
  });
  assert.equal((await store.webhook(
    failed,
    webhookHeader(failed, 'whsec_test', timestamp)
  )).result.action, 'ignored');
  assert.deepEqual(db.listEntitlements(user.id), []);

  const succeeded = webhookBody({
    id: 'evt_async_succeeded',
    type: 'checkout.session.async_payment_succeeded',
    data: { object: { ...session, payment_status: 'paid' } }
  });
  assert.equal((await store.webhook(
    succeeded,
    webhookHeader(succeeded, 'whsec_test', timestamp)
  )).result.action, 'granted');
  assert.deepEqual(db.listEntitlements(user.id), ['smg-cottoncloud']);
  assert.equal(db.countProcessedWebhookEvents(), 3);
});

test('no-payment Checkout warns without granting even with a partial logger', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-no-payment',
    email: 'no-payment@example.com',
    displayName: 'No Payment Buyer'
  });
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000,
    logger: {}
  });
  const completed = webhookBody({
    id: 'evt_no_payment',
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_no_payment',
      payment_status: 'no_payment_required',
      metadata: { user_id: user.id, cosmetic_id: 'smg-cottoncloud' }
    } }
  });

  assert.equal((await store.webhook(
    completed,
    webhookHeader(completed, 'whsec_test', timestamp)
  )).result.action, 'ignored');
  assert.deepEqual(db.listEntitlements(user.id), []);
  assert.equal(db.countProcessedWebhookEvents(), 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no_payment_required/);
});

test('request body idle timeout returns 408 and clears the socket timer', async () => {
  const { readRequestBody } = await import('./http-utils.mjs');
  const request = new Readable({ read() {} });
  let timeoutMs = null;
  let timerCleared = false;
  request.setTimeout = (milliseconds, callback) => {
    if (milliseconds === 0) {
      timerCleared = true;
    } else {
      timeoutMs = milliseconds;
      queueMicrotask(callback);
    }
    return request;
  };

  await assert.rejects(
    readRequestBody(request),
    (error) => error.status === 408 && error.code === 'request_timeout'
  );
  assert.equal(timeoutMs, 15_000);
  assert.equal(timerCleared, true);
});

test('partial refunds retain ownership and full refunds permit repurchase', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-partial-refund',
    email: 'partial@example.com',
    displayName: 'Partial Refund Buyer'
  });
  let checkoutCreated = false;
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000,
    priceIds: { 'smg-cottoncloud': 'price_cotton' },
    fetchImpl: async (url) => {
      if (url.endsWith('/prices/price_cotton')) {
        return response({
          id: 'price_cotton', active: true, unit_amount: 2000, currency: 'eur'
        });
      }
      if (url.endsWith('/checkout/sessions')) {
        checkoutCreated = true;
        return response({ url: 'https://checkout.stripe.test/repurchase' });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'smg-cottoncloud',
    checkoutSessionId: 'cs_paid',
    paymentIntentId: 'pi_paid'
  });
  const partial = webhookBody({
    id: 'evt_partial',
    type: 'charge.refunded',
    data: { object: {
      id: 'ch_paid',
      payment_intent: 'pi_paid',
      amount: 2000,
      amount_refunded: 100,
      refunded: false
    } }
  });
  assert.equal((await store.webhook(
    partial,
    webhookHeader(partial, 'whsec_test', timestamp)
  )).result.action, 'ignored');
  assert.deepEqual(db.listEntitlements(user.id), ['smg-cottoncloud']);

  const full = webhookBody({
    id: 'evt_full',
    type: 'charge.refunded',
    data: { object: {
      id: 'ch_paid',
      payment_intent: 'pi_paid',
      amount: 2000,
      amount_refunded: 2000,
      refunded: false
    } }
  });
  assert.equal((await store.webhook(
    full,
    webhookHeader(full, 'whsec_test', timestamp)
  )).result.count, 1);
  assert.deepEqual(db.listEntitlements(user.id), []);
  await assert.doesNotReject(() => store.checkout(user.id, 'smg-cottoncloud'));
  assert.equal(checkoutCreated, true, 'a revoked item is eligible for Checkout again');
});

test('unexpanded disputes resolve their charge and zero-match revocations warn', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-dispute-charge',
    email: 'dispute@example.com',
    displayName: 'Dispute Buyer'
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'char-midnight',
    checkoutSessionId: 'cs_disputed',
    paymentIntentId: 'pi_disputed'
  });
  const warnings = [];
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000,
    logger: { warn: (message) => warnings.push(message) },
    fetchImpl: async (url) => {
      if (url.endsWith('/charges/ch_z'))
        return response({ id: 'ch_z', payment_intent: 'pi_disputed' });
      if (url.endsWith('/charges/ch_missing'))
        return response({ id: 'ch_missing', payment_intent: 'pi_missing' });
      throw new Error(`Unexpected URL ${url}`);
    }
  });
  const disputed = webhookBody({
    id: 'evt_dispute_unexpanded',
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_1', charge: 'ch_z' } }
  });
  assert.equal((await store.webhook(
    disputed,
    webhookHeader(disputed, 'whsec_test', timestamp)
  )).result.count, 1);
  assert.deepEqual(db.listEntitlements(user.id), []);

  const missing = webhookBody({
    id: 'evt_dispute_missing',
    type: 'charge.dispute.created',
    data: { object: { id: 'dp_2', charge: 'ch_missing' } }
  });
  assert.equal((await store.webhook(
    missing,
    webhookHeader(missing, 'whsec_test', timestamp)
  )).result.count, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /evt_dispute_missing/);
  assert.match(warnings[0], /charge\.dispute\.created/);
});

test('metadata-only revocation cannot remove a newer identified purchase', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-safe-fallback',
    email: 'fallback@example.com',
    displayName: 'Fallback Buyer'
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'char-midnight',
    checkoutSessionId: 'cs_old',
    paymentIntentId: 'pi_old'
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'char-midnight',
    checkoutSessionId: 'cs_new',
    paymentIntentId: 'pi_new'
  });
  const warnings = [];
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000,
    logger: { warn: (message) => warnings.push(message) }
  });
  const lateMetadataRefund = webhookBody({
    id: 'evt_metadata_old',
    type: 'charge.refunded',
    data: { object: {
      id: 'ch_old',
      refunded: true,
      metadata: { user_id: user.id, cosmetic_id: 'char-midnight' }
    } }
  });
  assert.equal((await store.webhook(
    lateMetadataRefund,
    webhookHeader(lateMetadataRefund, 'whsec_test', timestamp)
  )).result.count, 0);
  assert.match(warnings[0], /evt_metadata_old/);
  assert.deepEqual(db.listEntitlements(user.id), ['char-midnight']);

  assert.equal(db.revokePurchase({
    userId: user.id,
    cosmeticId: 'char-midnight'
  }), 0);
  assert.deepEqual(db.listEntitlements(user.id), ['char-midnight']);

  db.grantEntitlement({ userId: user.id, cosmeticId: 'char-sherbetfox' });
  assert.equal(db.revokePurchase({
    userId: user.id,
    cosmeticId: 'char-sherbetfox'
  }), 1, 'metadata remains a usable fallback for identifier-less legacy rows');
});

test('a paid duplicate purchase is retained and logged with its payment intent', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const timestamp = 1_800_000_000;
  const user = db.upsertGoogleUser({
    subject: 'google-duplicate-payment',
    email: 'duplicate@example.com',
    displayName: 'Duplicate Buyer'
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'rifle-berryswirl',
    checkoutSessionId: 'cs_first',
    paymentIntentId: 'pi_first'
  });
  const warnings = [];
  const store = shop.createShopService({
    ...serviceOptions(db),
    now: () => timestamp * 1000,
    logger: { warn: (message) => warnings.push(message) }
  });
  const duplicate = webhookBody({
    id: 'evt_duplicate_purchase',
    type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_second',
      payment_status: 'paid',
      payment_intent: 'pi_second',
      metadata: { user_id: user.id, cosmetic_id: 'rifle-berryswirl' }
    } }
  });
  assert.equal((await store.webhook(
    duplicate,
    webhookHeader(duplicate, 'whsec_test', timestamp)
  )).result.action, 'granted');
  assert.deepEqual(db.listEntitlements(user.id), ['rifle-berryswirl']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /pi_second/);
});

test('catalog reads Stripe prices and reports missing price configuration unavailable', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  let requests = 0;
  const store = shop.createShopService({
    ...serviceOptions(db),
    priceIds: { 'smg-cottoncloud': 'price_cotton' },
    fetchImpl: async (url) => {
      requests++;
      assert.match(url, /\/prices\/price_cotton$/);
      return response({
        id: 'price_cotton',
        active: true,
        unit_amount: 425,
        currency: 'eur'
      });
    }
  });

  const items = await store.catalog();
  assert.equal(items.length, 9);
  assert.deepEqual(items[0].price, { unitAmount: 425, currency: 'eur' });
  assert.equal(items[0].available, true);
  assert.equal(items[1].price, null);
  assert.equal(items[1].available, false);
  assert.equal('owned' in items[0], false);
  assert.equal(requests, 1);
});

test('checkout sends the authenticated user and catalog item to Stripe', async (t) => {
  const { database, shop } = await accountModules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const user = db.upsertGoogleUser({
    subject: 'google-checkout',
    email: 'checkout@example.com',
    displayName: 'Checkout Player'
  });
  const checkoutRequests = [];
  const store = shop.createShopService({
    ...serviceOptions(db),
    priceIds: { 'char-midnight': 'price_midnight' },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/prices/price_midnight')) {
        return response({
          id: 'price_midnight',
          active: true,
          unit_amount: 700,
          currency: 'usd'
        });
      }
      if (url.endsWith('/checkout/sessions')) {
        checkoutRequests.push(options);
        return response({ url: 'https://checkout.stripe.test/session' });
      }
      throw new Error(`Unexpected URL ${url}`);
    }
  });

  assert.deepEqual(await Promise.all([
    store.checkout(user.id, 'char-midnight'),
    store.checkout(user.id, 'char-midnight')
  ]), [
    { url: 'https://checkout.stripe.test/session' },
    { url: 'https://checkout.stripe.test/session' }
  ]);
  const checkoutRequest = checkoutRequests[0];
  const form = checkoutRequest.body;
  assert.equal(form.get('line_items[0][price]'), 'price_midnight');
  assert.equal(form.get('client_reference_id'), user.id);
  assert.equal(form.get('metadata[user_id]'), user.id);
  assert.equal(form.get('metadata[cosmetic_id]'), 'char-midnight');
  assert.equal(form.get('payment_intent_data[metadata][cosmetic_id]'), 'char-midnight');
  const expectedKey = createHash('sha256')
    .update(`pastel-nuketown-checkout\0${user.id}\0char-midnight`, 'utf8')
    .digest('hex');
  assert.equal(checkoutRequest.headers['idempotency-key'], expectedKey);
  assert.equal(
    checkoutRequests[1].headers['idempotency-key'],
    expectedKey,
    'concurrent tabs use the same Stripe idempotency key'
  );

  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'char-midnight',
    checkoutSessionId: 'cs_original',
    paymentIntentId: 'pi_original',
    grantedAt: 1_800_000_000_123
  });
  assert.equal(db.revokePurchase({
    paymentIntentId: 'pi_original',
    revokedAt: 1_800_000_001_000
  }), 1);
  await Promise.all([
    store.checkout(user.id, 'char-midnight'),
    store.checkout(user.id, 'char-midnight')
  ]);
  const repurchaseKey = checkoutRequests[2].headers['idempotency-key'];
  assert.notEqual(
    repurchaseKey,
    expectedKey,
    'a revoked purchase advances the Stripe idempotency key'
  );
  assert.equal(
    checkoutRequests[3].headers['idempotency-key'],
    repurchaseKey,
    'concurrent repurchase tabs still share one Stripe idempotency key'
  );
});

test('account HTTP routes reject foreign CORS and unknown or owned checkout items', async (t) => {
  const { accountStore } = await accountModules();
  let stripeRequests = 0;
  const accounts = accountStore.createAccountStore({
    dbPath: ':memory:',
    allowedOrigins: ['https://game.example'],
    ...serviceOptions(null),
    db: undefined,
    fetchImpl: async () => {
      stripeRequests++;
      throw new Error('Checkout should have been rejected before Stripe');
    }
  });
  t.after(() => accounts.close());

  const publicCatalog = await httpRequest(accounts, '/shop/catalog');
  assert.equal(publicCatalog.status, 200);
  assert.equal(publicCatalog.json().items.length, 9);
  assert.equal(stripeRequests, 0);

  const malformedAuthorization = await httpRequest(accounts, '/auth/me', {
    headers: { authorization: 'Basic abc' }
  });
  assert.equal(malformedAuthorization.status, 401);
  assert.equal(malformedAuthorization.json().error, 'invalid_session');

  const foreign = await httpRequest(accounts, '/auth/me', {
    headers: { origin: 'https://foreign.example' }
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);

  const preflight = await httpRequest(accounts, '/shop/checkout', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://game.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://game.example');

  const user = accounts.db.upsertGoogleUser({
    subject: 'google-http',
    email: 'http@example.com',
    displayName: 'HTTP Player'
  });
  const session = accounts.auth.issueSession(user.id);
  const requestHeaders = {
    authorization: `Bearer ${session.token}`,
    'content-type': 'application/json',
    origin: 'https://game.example'
  };
  const me = await httpRequest(accounts, '/auth/me', { headers: requestHeaders });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json(), {
    userId: user.id,
    email: 'http@example.com',
    displayName: 'HTTP Player',
    entitlements: []
  });

  const unknown = await httpRequest(accounts, '/shop/checkout', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ cosmeticId: 'not-in-the-catalog' })
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json().error, 'unknown_cosmetic');

  accounts.db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'smg-cottoncloud'
  });
  const owned = await httpRequest(accounts, '/shop/checkout', {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ cosmeticId: 'smg-cottoncloud' })
  });
  assert.equal(owned.status, 409);
  assert.equal(owned.json().error, 'already_owned');
  assert.equal(stripeRequests, 0);

  const logout = await httpRequest(accounts, '/auth/logout', {
    method: 'POST',
    headers: requestHeaders
  });
  assert.equal(logout.status, 200);
  const afterLogout = await httpRequest(accounts, '/auth/me', { headers: requestHeaders });
  assert.equal(afterLogout.status, 401);
});
