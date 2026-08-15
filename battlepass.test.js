'use strict';

const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const Protocol = require('./net-protocol.js');

async function modules() {
  const [catalog, cosmetics, database, battlepass, accounts, server] =
    await Promise.all([
      import('./season1.mjs'),
      import('./cosmetics.mjs'),
      import('./store-db.mjs'),
      import('./battlepass.mjs'),
      import('./account-store.mjs'),
      import('./server.mjs')
    ]);
  return { catalog, cosmetics, database, battlepass, accounts, server };
}

function makeAccountOptions(overrides = {}) {
  return {
    dbPath: ':memory:',
    allowedOrigins: ['https://game.example'],
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

function createUser(db, suffix = 'one') {
  return db.upsertGoogleUser({
    subject: `battlepass-${suffix}`,
    email: `${suffix}@example.com`,
    displayName: `Player ${suffix}`
  });
}

function awardQualifyingMatch(pass, matchId, userIds) {
  return pass.awardMatch(matchId, userIds, {
    durationMs: 90_000,
    participantCount: new Set(userIds).size,
    snapshotCount: 10
  });
}

async function httpRequest(accountStore, pathname, options = {}) {
  const request = Readable.from([]);
  request.method = options.method || 'GET';
  request.headers = Object.fromEntries(
    Object.entries(options.headers || {})
      .map(([name, value]) => [name.toLowerCase(), value])
  );
  let status = 0;
  let headers = {};
  const chunks = [];
  const response = {
    writeHead(nextStatus, nextHeaders = {}) {
      status = nextStatus;
      headers = nextHeaders;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.from(chunk));
    }
  };
  const handled = await accountStore.handleHttp(
    request,
    response,
    new URL(pathname, 'http://relay.test')
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

function webhookEnvelope(id, userId, productId) {
  return Buffer.from(JSON.stringify({
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        payment_status: 'paid',
        payment_intent: `pi_${id}`,
        client_reference_id: userId,
        metadata: { user_id: userId, cosmetic_id: productId }
      }
    }
  }), 'utf8');
}

function stripeEvent(id, type, object) {
  return Buffer.from(JSON.stringify({
    id,
    type,
    data: { object }
  }), 'utf8');
}

function webhookSignature(raw, at, secret = 'whsec_test') {
  const seconds = Math.floor(at / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${seconds}.`, 'ascii')
    .update(raw)
    .digest('hex');
  return `t=${seconds},v1=${signature}`;
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(value) { this.sent.push(JSON.parse(value)); }
  message(value) {
    let message = value;
    if ((value.t === 'create' || value.t === 'join') &&
        !Object.hasOwn(value, 'maps')) {
      message = { ...message, maps: ['nuketown'] };
    }
    if (value.t === 'create' && !Object.hasOwn(value, 'map'))
      message = { ...message, map: 'nuketown' };
    if ((value.t === 'snapshot' || value.t === 'checkpoint') &&
        !Object.hasOwn(value, 'map')) {
      message = { ...message, map: 'nuketown' };
    }
    this.emit('message', Buffer.from(JSON.stringify(message)));
  }
  latest(type) { return this.sent.findLast((message) => message.t === type); }
  ping() {}
  close() { this.terminate(); }
  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function connectAuthenticatedPeer(relay, accountStore, user, message) {
  const socket = new FakeWebSocket();
  const session = accountStore.auth.issueSession(user.id);
  relay.wss.emit('connection', socket, {});
  socket.message({
    ...message,
    v: Protocol.VERSION,
    authToken: session.token
  });
  return socket;
}

function relaySnapshot(host, tick, round = 1) {
  host.message({
    t: 'snapshot',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round,
    tick,
    time: tick / 60,
    eventSeq: 0,
    manifestVersion: 0,
    actors: []
  });
}

function relaySnapshots(host, count, round = 1) {
  for (let tick = 1; tick <= count; tick++) relaySnapshot(host, tick, round);
}

function relaySpacedSnapshots(host, count, advanceClock, round = 1) {
  for (let tick = 1; tick <= count; tick++) {
    relaySnapshot(host, tick, round);
    if (tick < count) advanceClock();
  }
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('Season 1 is a frozen 25-tier, 30-day contract with an explicit reachable curve', async () => {
  const { catalog, cosmetics } = await modules();
  const season = catalog.SEASON_1;
  assert.equal(season.id, 'season-1');
  assert.equal(
    Date.parse(season.endsAt) - Date.parse(season.startsAt),
    30 * 24 * 60 * 60 * 1000
  );
  assert.equal(season.tiers.length, 25);
  assert.equal(catalog.SEASON_1_XP_CURVE.length, 25);
  assert.ok(Object.isFrozen(season));
  assert.ok(Object.isFrozen(season.tiers));
  assert.ok(season.tiers.every(Object.isFrozen));

  for (let index = 0; index < season.tiers.length; index++) {
    const tier = season.tiers[index];
    assert.equal(tier.tier, index + 1);
    assert.equal(tier.xpRequired, catalog.SEASON_1_XP_CURVE[index]);
    assert.equal(typeof tier.freeReward, 'string');
    assert.equal(typeof tier.premiumReward, 'string');
    if (index > 0) {
      assert.ok(
        catalog.SEASON_1_XP_CURVE[index] > catalog.SEASON_1_XP_CURVE[index - 1],
        `tier ${index + 1} must require more XP than tier ${index}`
      );
    }
  }
  assert.ok(
    catalog.SEASON_1_XP_CURVE.at(-1) <=
      catalog.SEASON_1_MATCH_XP * 3 * 30,
    'three relay-confirmed matches per day must be enough to finish the pass'
  );

  assert.deepEqual(
    catalog.validateSeason1Rewards(cosmetics.COSMETICS_BY_ID),
    { valid: true, unknownIds: [] }
  );
  const emptyCatalog = new Set();
  const emptyValidation = catalog.validateSeason1Rewards(emptyCatalog);
  assert.equal(emptyValidation.valid, false);
  assert.equal(emptyValidation.unknownIds.length, 50);
  assert.ok(emptyValidation.unknownIds.includes(season.tiers[0].freeReward));
});

test('tier is a pure function of XP and is not persisted as writable progress', async (t) => {
  const { catalog, database } = await modules();
  const examples = [
    [0, 0],
    [599, 0],
    [600, 1],
    [13_799, 11],
    [13_800, 12],
    [44_999, 24],
    [45_000, 25],
    [100_000, 25]
  ];
  for (const [xp, expected] of examples) {
    assert.equal(catalog.tierForXp(xp), expected);
    assert.equal(catalog.tierForXp(xp), expected, 'the same XP has the same tier');
  }

  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const columns = db.database.prepare('PRAGMA table_info(battlepass_progress)').all();
  assert.deepEqual(
    columns.map((column) => column.name),
    ['user_id', 'season_id', 'xp', 'updated_at']
  );
  assert.ok(!columns.some((column) => column.name === 'tier'));
  assert.ok(!db.database.prepare('PRAGMA table_info(battlepass_claimed_rewards)')
    .all().some((column) => column.name === 'tier'));
});

test('match XP is idempotent and season boundaries use the injected clock', async (t) => {
  const { catalog, database, battlepass } = await modules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const user = createUser(db, 'clock');
  const opponent = createUser(db, 'clock-opponent');
  const participants = [user.id, opponent.id];
  let clock = Date.parse(catalog.SEASON_1_START) - 1;
  const pass = battlepass.createBattlePassService({ db, now: () => clock });

  assert.equal(pass.me(user.id).status, 'not-yet-active');
  assert.equal(awardQualifyingMatch(pass, 'before-start', participants).xpPerAccount, 0);
  assert.equal(pass.me(user.id).xp, 0);

  clock = Date.parse(catalog.SEASON_1_START) + 1;
  const first = awardQualifyingMatch(pass, 'match-one', participants);
  const replay = awardQualifyingMatch(pass, 'match-one', participants);
  assert.equal(first.accounts[0].awarded, true);
  assert.equal(replay.accounts[0].awarded, false);
  assert.equal(pass.me(user.id).xp, catalog.SEASON_1_MATCH_XP);

  awardQualifyingMatch(pass, 'match-two', participants);
  const active = pass.me(user.id);
  assert.equal(active.tier, 1);
  assert.equal(active.claimedRewards.length, 1);
  assert.equal(active.claimedRewards[0].lane, 'free');

  clock = Date.parse(catalog.SEASON_1_END);
  assert.equal(pass.me(user.id).status, 'ended');
  assert.equal(awardQualifyingMatch(pass, 'after-end', participants).xpPerAccount, 0);
  assert.equal(pass.me(user.id).xp, catalog.SEASON_1_MATCH_XP * 2);
  assert.equal(pass.me(user.id).tier, 1, 'the final standing remains readable');
});

test('XP, claims, and match receipts survive reopening the SQLite store', async (t) => {
  const { catalog, cosmetics, database, battlepass } = await modules();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuketown-battlepass-'));
  const dbPath = path.join(directory, 'accounts.sqlite');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const clock = Date.parse(catalog.SEASON_1_START) + 1;

  const ids = ['persistent-user', 'persistent-opponent'];
  let db = database.openStoreDatabase(dbPath, { idFactory: () => ids.shift() });
  const user = createUser(db, 'persistent');
  const opponent = createUser(db, 'persistent-opponent');
  const participants = [user.id, opponent.id];
  let pass = battlepass.createBattlePassService({ db, now: () => clock });
  awardQualifyingMatch(pass, 'persistent-one', participants);
  awardQualifyingMatch(pass, 'persistent-two', participants);
  const legacyRewardId = pass.me(user.id).claimedRewards[0].rewardId;
  const orphanRewardId = catalog.SEASON_1.tiers[1].freeReward;
  const purchasedRewardId = catalog.SEASON_1.tiers[1].premiumReward;
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: legacyRewardId,
    grantedAt: clock
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: orphanRewardId,
    grantedAt: clock
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: purchasedRewardId,
    checkoutSessionId: 'cs_real_reward_purchase',
    paymentIntentId: 'pi_real_reward_purchase',
    grantedAt: clock
  });
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: cosmetics.PREMIUM_PASS_ID,
    checkoutSessionId: 'cs_real_premium_pass',
    paymentIntentId: 'pi_real_premium_pass',
    grantedAt: clock
  });
  db.database.prepare(`
    DELETE FROM schema_migrations
    WHERE migration_id = 'season-1-earned-entitlements-cleanup'
  `).run();
  assert.equal(pass.me(user.id).claimedRewards.some(
    (reward) => reward.rewardId === orphanRewardId
  ), false, 'the orphaned entitlement has no corresponding claim row');
  db.close();

  const migrationLogs = [];
  db = database.openStoreDatabase(dbPath, {
    logger: { info: (message) => migrationLogs.push(message) }
  });
  t.after(() => db.close());
  pass = battlepass.createBattlePassService({ db, now: () => clock });
  assert.equal(pass.me(user.id).xp, catalog.SEASON_1_MATCH_XP * 2);
  assert.equal(pass.me(user.id).claimedRewards.length, 1);
  assert.deepEqual(
    db.listEntitlements(user.id),
    [cosmetics.PREMIUM_PASS_ID, purchasedRewardId].sort(),
    'reopening removes claimed and orphaned earned rows but preserves Stripe purchases'
  );
  assert.match(migrationLogs[0], /removed 2 legacy earned rows/);
  assert.equal(
    awardQualifyingMatch(pass, 'persistent-one', participants).accounts[0].awarded,
    false
  );
  assert.equal(pass.me(user.id).xp, catalog.SEASON_1_MATCH_XP * 2);

  db.grantEntitlement({
    userId: user.id,
    cosmeticId: orphanRewardId,
    grantedAt: clock
  });
  db.close();
  db = database.openStoreDatabase(dbPath);
  assert.ok(db.listEntitlements(user.id).includes(orphanRewardId),
    'a comped Season 1 reward inserted after migration survives a reopen');
});

test('GET /battlepass/me is authenticated and reports derived account progress', async (t) => {
  const { catalog, accounts } = await modules();
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({
    now: () => clock
  }));
  t.after(() => accountStore.close());
  const user = createUser(accountStore.db, 'route');
  const opponent = createUser(accountStore.db, 'route-opponent');
  const session = accountStore.auth.issueSession(user.id);

  const anonymous = await httpRequest(accountStore, '/battlepass/me');
  assert.equal(anonymous.handled, true);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json().error, 'authentication_required');

  awardQualifyingMatch(accountStore.battlePass, 'route-match', [user.id, opponent.id]);
  const mine = await httpRequest(accountStore, '/battlepass/me', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json(), {
    seasonId: catalog.SEASON_1_ID,
    startsAt: catalog.SEASON_1_START,
    endsAt: catalog.SEASON_1_END,
    status: 'active',
    xp: catalog.SEASON_1_MATCH_XP,
    tier: 0,
    xpToNextTier: 100,
    premium: false,
    claimedRewards: []
  });
});

test('the existing Stripe entitlement path sells the pass and retroactively opens tier 12', async (t) => {
  const { catalog, cosmetics, accounts, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/prices/price_season_1')) {
      return {
        ok: true,
        async json() {
          return { id: 'price_season_1', currency: 'usd', unit_amount: 900, active: true };
        }
      };
    }
    if (url.endsWith('/checkout/sessions')) {
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('metadata[cosmetic_id]'), cosmetics.PREMIUM_PASS_ID);
      assert.equal(form.get('payment_intent_data[metadata][cosmetic_id]'),
        cosmetics.PREMIUM_PASS_ID);
      return { ok: true, async json() { return { url: 'https://checkout.stripe.test/s1' }; } };
    }
    throw new Error(`Unexpected Stripe request ${url}`);
  };
  const accountStore = accounts.createAccountStore(makeAccountOptions({
    now: () => clock,
    fetchImpl,
    priceIds: { [cosmetics.PREMIUM_PASS_ID]: 'price_season_1' },
    includePremiumPassInCatalog: true
  }));
  t.after(() => accountStore.close());
  const user = createUser(accountStore.db, 'premium');
  const opponent = createUser(accountStore.db, 'premium-opponent');

  for (let match = 1; match <= 28; match++) {
    if (match === battlepass.BATTLE_PASS_MAX_AWARDS_PER_WINDOW + 1)
      clock += battlepass.BATTLE_PASS_AWARD_WINDOW_MS + 1;
    awardQualifyingMatch(
      accountStore.battlePass,
      `earned-${match}`,
      [user.id, opponent.id]
    );
  }
  const earned = accountStore.battlePass.me(user.id);
  assert.equal(earned.tier, 12);
  assert.equal(earned.claimedRewards.filter((reward) => reward.lane === 'free').length, 12);
  assert.equal(earned.claimedRewards.some((reward) => reward.lane === 'premium'), false);

  assert.equal(cosmetics.PREMIUM_PASS_PRODUCT.priceEnvVar,
    'STRIPE_PRICE_BATTLEPASS_SEASON_1_PREMIUM');
  assert.equal(cosmetics.PREMIUM_PASS_PRODUCT.slot, null,
    'the pass is a product entitlement, not an equip slot');
  assert.ok(Object.isFrozen(cosmetics.PREMIUM_PASS_PRODUCT));
  assert.equal(cosmetics.STORE_PRODUCTS_BY_ID.get(cosmetics.PREMIUM_PASS_ID),
    cosmetics.PREMIUM_PASS_PRODUCT);
  const passListing = (await accountStore.shop.catalog(user.id))
    .find((item) => item.id === cosmetics.PREMIUM_PASS_ID);
  assert.deepEqual(passListing, {
    id: cosmetics.PREMIUM_PASS_ID,
    displayName: 'Season 1 Premium Pass',
    type: 'battlepass',
    slot: null,
    productKind: 'battlepass',
    available: true,
    price: { unitAmount: 900, currency: 'usd' },
    owned: false
  });
  assert.deepEqual(
    await accountStore.shop.checkout(user.id, cosmetics.PREMIUM_PASS_ID),
    { url: 'https://checkout.stripe.test/s1' }
  );
  assert.equal(requests.length, 2);

  const raw = webhookEnvelope('evt_pass_paid', user.id, cosmetics.PREMIUM_PASS_ID);
  const signature = webhookSignature(raw, clock);
  const first = await accountStore.shop.webhook(raw, signature);
  const replay = await accountStore.shop.webhook(raw, signature);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(first.result.rewardsUnlocked.map((reward) => reward.tier),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  const unlocked = accountStore.battlePass.me(user.id);
  const premium = unlocked.claimedRewards.filter((reward) => reward.lane === 'premium');
  assert.equal(unlocked.premium, true);
  assert.deepEqual(premium.map((reward) => reward.tier),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(accountStore.db.database.prepare(`
    SELECT COUNT(*) AS count FROM entitlements
    WHERE user_id = ? AND cosmetic_id = ?
  `).get(user.id, cosmetics.PREMIUM_PASS_ID).count, 1);
  assert.equal(accountStore.db.database.prepare(`
    SELECT COUNT(*) AS count FROM entitlements
    WHERE user_id = ? AND cosmetic_id LIKE 's1-%'
  `).get(user.id).count, 0,
  'earned rewards never pollute the payments-owned entitlements table');
  assert.equal(accountStore.db.database.prepare(`
    SELECT COUNT(*) AS count FROM battlepass_claimed_rewards
    WHERE user_id = ? AND season_id = ? AND lane = 'premium'
  `).get(user.id, catalog.SEASON_1_ID).count, 12);
  assert.equal(accountStore.db.countProcessedWebhookEvents(), 1);
});

test('earned cosmetics pass the client and relay ownership gates until their claim is revoked', async (t) => {
  const { catalog, cosmetics, accounts, server } = await modules();
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const earnedUser = createUser(accountStore.db, 'wear-earned');
  const unearnedUser = createUser(accountStore.db, 'wear-unearned');
  const paid = webhookEnvelope('bp_equip_paid', earnedUser.id, cosmetics.PREMIUM_PASS_ID);
  await accountStore.shop.webhook(paid, webhookSignature(paid, clock));
  awardQualifyingMatch(accountStore.battlePass, 'wear-xp-1', [earnedUser.id, unearnedUser.id]);
  awardQualifyingMatch(accountStore.battlePass, 'wear-xp-2', [earnedUser.id, unearnedUser.id]);
  const premiumReward = catalog.SEASON_1.tiers[0].premiumReward;

  const session = accountStore.auth.issueSession(earnedUser.id);
  const me = await httpRequest(accountStore, '/auth/me', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.deepEqual(me.json().entitlements, [cosmetics.PREMIUM_PASS_ID]);
  assert.ok(me.json().earnedRewards.includes(premiumReward));
  assert.ok(me.json().ownedCosmetics.includes(premiumReward));
  assert.equal(accountStore.db.listEntitlements(earnedUser.id).includes(premiumReward), false,
    'earned ownership remains outside the paid entitlements table');

  let peer = 0;
  const relayAccountStore = { ...accountStore, close() {} };
  const relay = server.createRelayServer({
    accountStore: relayAccountStore,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-wear-${++peer}`,
    roomRandom: () => 0
  });
  try {
    const wearer = connectAuthenticatedPeer(relay, accountStore, earnedUser, {
      t: 'create', name: 'Earned Wearer',
      cosmetics: { weapons: { smg: premiumReward } }
    });
    const room = wearer.latest('room').room;
    const claimant = connectAuthenticatedPeer(relay, accountStore, unearnedUser, {
      t: 'join', name: 'Unearned Claimant', room,
      cosmetics: { weapons: { smg: premiumReward } }
    });
    const roster = claimant.latest('members').members;
    assert.equal(roster.find((member) => member.name === 'Earned Wearer')
      .cosmetics.weapons.smg, premiumReward);
    assert.equal(roster.find((member) => member.name === 'Unearned Claimant').cosmetics,
      undefined);
  } finally {
    await relay.close();
  }

  const refunded = stripeEvent('evt_bp_equip_refund', 'charge.refunded', {
    id: 'ch_bp_equip',
    payment_intent: 'pi_bp_equip_paid',
    refunded: true
  });
  await accountStore.shop.webhook(refunded, webhookSignature(refunded, clock));
  assert.equal(accountStore.battlePass.claimedRewardIds(earnedUser.id)
    .includes(premiumReward), false);
  const refundedMe = await httpRequest(accountStore, '/auth/me', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(refundedMe.json().earnedRewards.includes(premiumReward), false);
  assert.equal(refundedMe.json().ownedCosmetics.includes(premiumReward), false,
    'the client ownership answer drops a revoked claim');

  const afterRefund = server.createRelayServer({
    accountStore,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => 'peer-refunded-wearer',
    roomRandom: () => 0
  });
  try {
    const rejected = connectAuthenticatedPeer(afterRefund, accountStore, earnedUser, {
      t: 'create', name: 'Refunded Wearer',
      cosmetics: { weapons: { smg: premiumReward } }
    });
    assert.equal(rejected.latest('members').members[0].cosmetics, undefined,
      'a revoked premium claim no longer passes the relay ownership gate');
  } finally {
    await afterRefund.close();
  }
});

test('client-authored progress is rejected and a zero-play create/start/lobby loop awards nothing', async (t) => {
  const { catalog, accounts, server } = await modules();
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({
    now: () => clock
  }));
  t.after(() => accountStore.close());
  const user = createUser(accountStore.db, 'relay');
  const session = accountStore.auth.issueSession(user.id);
  const relay = server.createRelayServer({
    accountStore,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => 'peer-battlepass-host',
    matchIdFactory: () => 'relay-owned-match-id',
    roomRandom: () => 0
  });
  try {
    const socket = new FakeWebSocket();
    relay.wss.emit('connection', socket, {});
    socket.message({
      t: 'create',
      v: Protocol.VERSION,
      name: 'Cheater',
      authToken: session.token,
      xp: 45_000,
      tier: 25,
      rewardId: catalog.SEASON_1.tiers[24].premiumReward
    });
    assert.equal(socket.latest('error').code, 'client-progress-forbidden');
    assert.equal(relay.rooms.size, 0);
    assert.equal(accountStore.battlePass.me(user.id).xp, 0);

    socket.message({
      t: 'create',
      v: Protocol.VERSION,
      name: 'Player',
      authToken: session.token
    });
    socket.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    socket.message({
      t: 'event',
      v: Protocol.VERSION,
      authorityEpoch: 1,
      round: 1,
      events: [{
        id: 1,
        kind: 'match-over',
        rewardUnlock: { tier: 25 }
      }]
    });
    assert.equal(socket.latest('error').code, 'client-progress-forbidden');
    assert.equal(accountStore.battlePass.me(user.id).xp, 0,
      'nesting a progress claim in relay data does not make it authoritative');

    socket.message({
      t: 'lobby',
      v: Protocol.VERSION,
      authorityEpoch: 1,
      round: 1,
      winner: 'peer-battlepass-host',
      xp: 45_000,
      tier: 25
    });
    assert.equal(socket.latest('error').code, 'client-progress-forbidden');
    assert.equal(accountStore.battlePass.me(user.id).xp, 0,
      'a rejected result cannot end the match or award its asserted XP');

    socket.message({
      t: 'lobby',
      v: Protocol.VERSION,
      authorityEpoch: 1,
      round: 1,
      winner: 'peer-battlepass-host'
    });
    assert.equal(accountStore.battlePass.me(user.id).xp, 0,
      'zero elapsed play, a solo roster, and zero snapshots cannot mint XP');
    assert.equal(accountStore.db.database.prepare(`
      SELECT COUNT(*) AS count FROM battlepass_match_awards
      WHERE match_id = 'relay-owned-match-id'
    `).get().count, 0);
  } finally {
    await relay.close();
  }
});

test('a match shorter than the 90-second balance floor awards no XP', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [createUser(accountStore.db, 'short-host'), createUser(accountStore.db, 'short-guest')];
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-short-${++peer}`,
    matchIdFactory: () => 'match-too-short',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Short Host'
    });
    const guest = connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Short Guest', room: host.latest('room').room
    });
    assert.ok(guest.latest('room'));
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1) - 1;
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });
    assert.deepEqual(users.map((user) => accountStore.battlePass.me(user.id).xp), [0, 0]);
  } finally {
    await relay.close();
  }
});

test('anonymous rounds are silent while an incomplete signed-in round still warns', async (t) => {
  const { catalog, accounts, server } = await modules();
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const signedUser = createUser(accountStore.db, 'warning-signed');
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-warning-${++peer}`,
    matchIdFactory: (() => {
      let match = 0;
      return () => `match-warning-${++match}`;
    })(),
    roomRandom: () => 0
  });
  try {
    const host = new FakeWebSocket();
    const guest = new FakeWebSocket();
    relay.wss.emit('connection', host, {});
    relay.wss.emit('connection', guest, {});
    host.message({ t: 'create', v: Protocol.VERSION, name: 'Anonymous Host' });
    const room = host.latest('room').room;
    guest.message({ t: 'join', v: Protocol.VERSION, name: 'Anonymous Guest', room });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });
    assert.deepEqual(warnings, [], 'an all-anonymous round is not a missed award');

    connectAuthenticatedPeer(relay, accountStore, signedUser, {
      t: 'join', name: 'Signed Player', room
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 2
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /match-warning-2/);
    assert.match(warnings[0], /duration/);
    assert.match(warnings[0], /snapshots/);
    assert.doesNotMatch(warnings[0], /participants/,
      'one end-to-end account is enough even when the other players are anonymous');
  } finally {
    await relay.close();
  }
});

test('only authenticated accounts present at both match endpoints are paid', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const hostUser = createUser(accountStore.db, 'roster-host');
  const lateUser = createUser(accountStore.db, 'roster-late');
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-roster-${++peer}`,
    matchIdFactory: () => 'match-late-roster',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, hostUser, {
      t: 'create', name: 'Roster Host'
    });
    const room = host.latest('room').room;
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);
    const late = connectAuthenticatedPeer(relay, accountStore, lateUser, {
      t: 'join', name: 'Late Guest', room
    });
    assert.equal(late.latest('room').started, true);
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });
    assert.equal(
      accountStore.battlePass.me(hostUser.id).xp,
      catalog.SEASON_1_MATCH_XP,
      'the end-to-end account earns even though it played the round with bots'
    );
    assert.equal(accountStore.battlePass.me(lateUser.id).xp, 0,
      'joining only for the result is not participation at both endpoints');
  } finally {
    await relay.close();
  }
});

test('a signed-in player earns through a qualifying round with anonymous players', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const user = createUser(accountStore.db, 'anonymous-opponents');
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-anonymous-opponents-${++peer}`,
    matchIdFactory: () => 'match-anonymous-opponents',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, user, {
      t: 'create', name: 'Signed Host'
    });
    const anonymous = new FakeWebSocket();
    relay.wss.emit('connection', anonymous, {});
    anonymous.message({
      t: 'join',
      v: Protocol.VERSION,
      name: 'Anonymous Guest',
      room: host.latest('room').room
    });
    assert.ok(anonymous.latest('room'));

    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });

    assert.equal(accountStore.battlePass.me(user.id).xp, catalog.SEASON_1_MATCH_XP);
  } finally {
    await relay.close();
  }
});

test('a burst of host-authored ticks counts as one relay observation and awards no XP', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [createUser(accountStore.db, 'burst-host'), createUser(accountStore.db, 'burst-guest')];
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-burst-${++peer}`,
    matchIdFactory: () => 'match-burst-snapshots',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Burst Host'
    });
    const roomCode = host.latest('room').room;
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Burst Guest', room: roomCode
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    relaySnapshots(host, battlepass.BATTLE_PASS_MIN_SNAPSHOTS);
    assert.equal(relay.rooms.get(roomCode).battlePassSnapshotCount, 1);

    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS;
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });
    assert.deepEqual(users.map((user) => accountStore.battlePass.me(user.id).xp), [0, 0]);
  } finally {
    await relay.close();
  }
});

test('fewer than ten relay-observed snapshots awards no XP', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [createUser(accountStore.db, 'snap-host'), createUser(accountStore.db, 'snap-guest')];
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-snap-${++peer}`,
    matchIdFactory: () => 'match-too-few-snapshots',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Snapshot Host'
    });
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Snapshot Guest', room: host.latest('room').room
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1,
      () => { clock += observationGap; }
    );
    host.message({
      t: 'snapshot',
      v: Protocol.VERSION,
      authorityEpoch: 1,
      round: 1,
      tick: battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1,
      time: 1,
      eventSeq: 0,
      manifestVersion: 0,
      actors: []
    });
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 2);
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });
    assert.deepEqual(users.map((user) => accountStore.battlePass.me(user.id).xp), [0, 0]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /match-too-few-snapshots/);
    assert.match(warnings[0], /snapshots \(9\/10\)/);
  } finally {
    await relay.close();
  }
});

test('a 90-second two-account match with ten observed snapshots pays both accounts', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [createUser(accountStore.db, 'legit-host'), createUser(accountStore.db, 'legit-guest')];
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-legit-${++peer}`,
    matchIdFactory: () => 'match-legitimate',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Legit Host'
    });
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Legit Guest', room: host.latest('room').room
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });
    assert.deepEqual(
      users.map((user) => accountStore.battlePass.me(user.id).xp),
      [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
    );
  } finally {
    await relay.close();
  }
});

test('a non-seamless host fallback records the qualifying in-flight match', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [
    createUser(accountStore.db, 'fallback-host'),
    createUser(accountStore.db, 'fallback-guest')
  ];
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-fallback-${++peer}`,
    matchIdFactory: () => 'match-fallback-result',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Fallback Host'
    });
    const roomCode = host.latest('room').room;
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Fallback Guest', room: roomCode
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);

    /* Empty actor snapshots cannot migrate seamlessly, so losing this host
       ends the match through fallbackRestart instead of the lobby handler. */
    host.terminate();
    assert.equal(relay.rooms.get(roomCode).started, false);
    assert.deepEqual(
      users.map((user) => accountStore.battlePass.me(user.id).xp),
      [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
    );
  } finally {
    await relay.close();
  }
});

test('relay close records every qualifying in-flight room before shutting down', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  const users = [
    createUser(accountStore.db, 'close-host'),
    createUser(accountStore.db, 'close-guest')
  ];
  let peer = 0;
  const relayAccountStore = { ...accountStore, close() {} };
  const relay = server.createRelayServer({
    accountStore: relayAccountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-close-${++peer}`,
    matchIdFactory: () => 'match-relay-close',
    roomRandom: () => 0
  });
  const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
    t: 'create', name: 'Close Host'
  });
  connectAuthenticatedPeer(relay, accountStore, users[1], {
    t: 'join', name: 'Close Guest', room: host.latest('room').room
  });
  host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
    battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
  relaySpacedSnapshots(
    host,
    battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
    () => { clock += observationGap; }
  );
  clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
    observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);

  await relay.close();
  assert.deepEqual(
    users.map((user) => accountStore.battlePass.me(user.id).xp),
    [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
  );
  accountStore.close();
});

test('a late first snapshot does not extend the independent 90-second floor', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [
    createUser(accountStore.db, 'late-snapshot-host'),
    createUser(accountStore.db, 'late-snapshot-guest')
  ];
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-late-snapshot-${++peer}`,
    matchIdFactory: () => 'match-late-first-snapshot',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Late Snapshot Host'
    });
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Late Snapshot Guest', room: host.latest('room').room
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });

    clock += 10_000;
    const snapshotTimes = [10_000, 18_000, 27_000, 36_000, 45_000,
      54_000, 63_000, 72_000, 81_000, 90_000];
    for (let index = 0; index < snapshotTimes.length; index++) {
      if (index > 0) clock += snapshotTimes[index] - snapshotTimes[index - 1];
      relaySnapshot(host, index + 1);
    }
    clock += 5_000;
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });

    assert.deepEqual(
      users.map((user) => accountStore.battlePass.me(user.id).xp),
      [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
    );
    assert.equal(host.sent.some((message) =>
      message.t === 'error' && message.code === 'battlepass-award-pending'), false);
  } finally {
    await relay.close();
  }
});

test('a seamlessly migrated match pays whistle participants still present at the result', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [
    createUser(accountStore.db, 'migration-host'),
    createUser(accountStore.db, 'migration-promoted'),
    createUser(accountStore.db, 'migration-survivor')
  ];
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    authorityGraceMs: 60_000,
    idFactory: () => `peer-migration-${++peer}`,
    matchIdFactory: () => 'match-after-migration',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Migration Host'
    });
    const roomCode = host.latest('room').room;
    const promoted = connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Promoted Player', room: roomCode
    });
    const survivor = connectAuthenticatedPeer(relay, accountStore, users[2], {
      t: 'join', name: 'Surviving Player', room: roomCode
    });
    const peerIds = [
      'peer-migration-1',
      'peer-migration-2',
      'peer-migration-3'
    ];
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    for (let tick = 1; tick <= battlepass.BATTLE_PASS_MIN_SNAPSHOTS; tick++) {
      host.message({
        t: 'snapshot',
        v: Protocol.VERSION,
        authorityEpoch: 1,
        round: 1,
        tick,
        time: tick,
        eventSeq: 0,
        manifestVersion: 1,
        actors: peerIds.map((netId) => ({ netId })),
        over: false,
        winner: null
      });
      if (tick < battlepass.BATTLE_PASS_MIN_SNAPSHOTS) clock += observationGap;
    }
    host.message({
      t: 'checkpoint',
      v: Protocol.VERSION,
      authorityEpoch: 1,
      round: 1,
      tick: battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      time: battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      manifestVersion: 1,
      actors: peerIds.map((netId, index) => ({
        netId,
        controller: index === 0 ? 'local' : 'remote',
        human: true,
        skill: 'normal',
        ammoBy: { smg: [17, 120] }
      })),
      events: []
    });
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);

    host.terminate();
    assert.equal(promoted.latest('host-changed').seamless, true);
    survivor.message({
      t: 'authority-state',
      v: Protocol.VERSION,
      authorityEpoch: 2,
      round: 1,
      inputSeq: 0,
      fireSeq: 0,
      reloadSeq: 0,
      weaponSeq: 0,
      weapon: 'smg'
    });
    promoted.message({
      t: 'authority-ready',
      v: Protocol.VERSION,
      authorityEpoch: 2,
      round: 1,
      tick: battlepass.BATTLE_PASS_MIN_SNAPSHOTS
    });
    promoted.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 2, round: 1
    });

    assert.equal(survivor.latest('lobby').round, 1);
    assert.deepEqual(
      users.map((user) => accountStore.battlePass.me(user.id).xp),
      [0, catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
    );
  } finally {
    await relay.close();
  }
});

test('a transient relay award failure ends play and the durable retry pays XP', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [
    createUser(accountStore.db, 'retry-host'),
    createUser(accountStore.db, 'retry-guest')
  ];
  let awardAttempts = 0;
  const realAwardMatch = accountStore.db.awardBattlePassMatch;
  accountStore.db.awardBattlePassMatch = (...args) => {
    awardAttempts++;
    if (awardAttempts === 1) throw new Error('transient sqlite busy');
    return realAwardMatch(...args);
  };
  const logged = [];
  t.mock.method(console, 'error', (message) => logged.push(message));
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    battlePassRetryMs: 5,
    idFactory: () => `peer-retry-${++peer}`,
    matchIdFactory: () => 'match-retried-after-busy',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Retry Host'
    });
    const roomCode = host.latest('room').room;
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Retry Guest', room: roomCode
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);
    const result = {
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    };

    host.message(result);
    const endedRoom = relay.rooms.get(roomCode);
    assert.deepEqual(users.map((user) => accountStore.battlePass.me(user.id).xp), [0, 0]);
    assert.equal(endedRoom.started, false);
    assert.equal(endedRoom.matchId, null);
    assert.equal(endedRoom.battlePassSnapshotCount, 0);
    assert.equal(host.latest('error').code, 'battlepass-award-pending');
    assert.equal(accountStore.db.database.prepare(`
      SELECT COUNT(*) AS count FROM battlepass_pending_matches
      WHERE match_id = 'match-retried-after-busy'
    `).get().count, 1);
    assert.match(logged[0], /match-retried-after-busy/);

    await waitFor(() => accountStore.battlePass.me(users[0].id).xp > 0);
    assert.equal(awardAttempts, 2);
    assert.deepEqual(
      users.map((user) => accountStore.battlePass.me(user.id).xp),
      [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
    );
    assert.equal(accountStore.db.database.prepare(`
      SELECT COUNT(*) AS count FROM battlepass_pending_matches
      WHERE match_id = 'match-retried-after-busy'
    `).get().count, 0);
  } finally {
    await relay.close();
  }
});

test('a persistent award failure ends the round for every player and stays recoverable', async (t) => {
  const { catalog, database, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuketown-pending-award-'));
  const dbPath = path.join(directory, 'accounts.sqlite');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const accountStore = accounts.createAccountStore(makeAccountOptions({
    dbPath,
    now: () => clock
  }));
  t.after(() => accountStore.close());
  const users = [
    createUser(accountStore.db, 'persistent-failure-host'),
    createUser(accountStore.db, 'persistent-failure-guest')
  ];
  accountStore.db.awardBattlePassMatch = () => {
    throw new Error('persistent account database failure');
  };
  t.mock.method(console, 'error', () => {});
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-persistent-failure-${++peer}`,
    matchIdFactory: () => 'match-persistent-failure',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Persistent Failure Host'
    });
    const roomCode = host.latest('room').room;
    const guest = connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Persistent Failure Guest', room: roomCode
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
      observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });

    const room = relay.rooms.get(roomCode);
    assert.equal(room.started, false);
    assert.equal(guest.latest('lobby').round, 1);
    assert.equal(host.latest('error').code, 'battlepass-award-pending');
    assert.deepEqual(users.map((user) => accountStore.battlePass.me(user.id).xp), [0, 0]);
    assert.equal(accountStore.db.database.prepare(`
      SELECT COUNT(*) AS count FROM battlepass_pending_matches
      WHERE match_id = 'match-persistent-failure'
    `).get().count, 1);

    relay.retryBattlePassAwards();
    assert.equal(accountStore.db.database.prepare(`
      SELECT COUNT(*) AS count FROM battlepass_pending_matches
      WHERE match_id = 'match-persistent-failure'
    `).get().count, 1, 'persistent failure leaves the durable result recoverable');
  } finally {
    await relay.close();
  }

  const reopened = database.openStoreDatabase(dbPath);
  t.after(() => reopened.close());
  assert.equal(reopened.database.prepare(`
    SELECT COUNT(*) AS count FROM battlepass_pending_matches
    WHERE match_id = 'match-persistent-failure'
  `).get().count, 1, 'the recoverable result survives a database reopen');
  const recovery = battlepass.createBattlePassService({
    db: reopened,
    now: () => clock,
    retryNow: () => Number.MAX_SAFE_INTEGER
  }).retryPendingMatches();
  assert.equal(recovery.failures.length, 0);
  assert.equal(recovery.awarded.length, 1);
  assert.deepEqual(
    users.map((user) => recovery.awarded[0].accounts
      .find((account) => account.userId === user.id).xp),
    [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
  );
});

test('the non-durable fallback queue is bounded and exposes operator counts', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const users = [
    createUser(accountStore.db, 'fallback-queue-host'),
    createUser(accountStore.db, 'fallback-queue-guest')
  ];
  accountStore.battlePass.recordMatchResult = () => {
    throw new Error('pending table unavailable');
  };
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  let peer = 0;
  let match = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    battlePassMaxRetryAttempts: 1,
    maxUnrecordedBattlePassMatches: 2,
    idFactory: () => `peer-fallback-queue-${++peer}`,
    matchIdFactory: () => `match-fallback-queue-${++match}`,
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Fallback Queue Host'
    });
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Fallback Queue Guest', room: host.latest('room').room
    });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    for (let round = 1; round <= 3; round++) {
      host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
      relaySpacedSnapshots(
        host,
        battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
        () => { clock += observationGap; },
        round
      );
      clock += battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS -
        observationGap * (battlepass.BATTLE_PASS_MIN_SNAPSHOTS - 1);
      host.message({
        t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round
      });
    }

    assert.deepEqual(relay.battlePassFallbackState(), {
      queued: 2,
      operator: 2,
      dropped: 1
    });
    assert.ok(errors.some((message) => /fallback is capped at 2/.test(message)));
  } finally {
    await relay.close();
  }
});

test('a permanently corrupt pending row backs off and stops in operator state', async (t) => {
  const { catalog, accounts, server } = await modules();
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  accountStore.db.database.prepare(`
    INSERT INTO battlepass_pending_matches (
      match_id, user_ids_json, duration_ms, participant_count,
      snapshot_count, awarded_at
    ) VALUES ('match-corrupt-poison', '{', 90000, 2, 10, ?)
  `).run(clock);
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  const relay = server.createRelayServer({
    accountStore,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    battlePassRetryMs: 5,
    battlePassMaxRetryAttempts: 3
  });
  try {
    await waitFor(() => accountStore.db.database.prepare(`
      SELECT retry_state
      FROM battlepass_pending_matches
      WHERE match_id = 'match-corrupt-poison'
    `).get().retry_state === 'operator');
    const terminal = accountStore.db.database.prepare(`
      SELECT attempt_count, retry_state, last_error, operator_at
      FROM battlepass_pending_matches
      WHERE match_id = 'match-corrupt-poison'
    `).get();
    assert.equal(terminal.attempt_count, 3);
    assert.equal(terminal.retry_state, 'operator');
    assert.match(terminal.last_error, /JSON/);
    assert.ok(Number.isSafeInteger(terminal.operator_at));
    assert.equal(errors.filter((message) => /needs operator attention/.test(message)).length, 1);

    const loggedAtGiveUp = errors.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    relay.retryBattlePassAwards();
    assert.equal(errors.length, loggedAtGiveUp,
      'terminal rows neither re-arm nor log again');
  } finally {
    await relay.close();
  }
});

test('pending scans materialize only due rows up to the indexed batch limit', async (t) => {
  const { catalog, database } = await modules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const insert = db.database.prepare(`
    INSERT INTO battlepass_pending_matches (
      match_id, user_ids_json, duration_ms, participant_count,
      snapshot_count, awarded_at, next_attempt_at
    ) VALUES (?, '[]', 90000, 0, 10, ?, ?)
  `);
  for (let index = 0; index < 140; index++)
    insert.run(`due-${String(index).padStart(3, '0')}`, clock + index, clock);
  for (let index = 0; index < 20; index++)
    insert.run(`future-${String(index).padStart(3, '0')}`, clock + index, clock + 60_000);

  const due = db.pendingBattlePassMatches(clock, 25);
  assert.equal(due.length, 25);
  assert.ok(due.every((pending) => pending.nextAttemptAt <= clock));
  assert.ok(due.every((pending) => pending.matchId.startsWith('due-')));

  const plan = db.database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT match_id
    FROM battlepass_pending_matches
    WHERE retry_state = 'pending' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, awarded_at, match_id
    LIMIT ?
  `).all(clock, 25);
  assert.ok(plan.some((step) => /battlepass_pending_due/.test(step.detail)),
    JSON.stringify(plan));
});

test('an unrelated poisoned row does not report a clean match as pending', async (t) => {
  const { catalog, accounts, server, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  accountStore.db.database.prepare(`
    INSERT INTO battlepass_pending_matches (
      match_id, user_ids_json, duration_ms, participant_count,
      snapshot_count, awarded_at
    ) VALUES (
      'match-unrelated-poison', '["missing-user-a","missing-user-b"]',
      90000, 2, 10, ?
    )
  `).run(clock);
  const users = [
    createUser(accountStore.db, 'healthy-after-poison-host'),
    createUser(accountStore.db, 'healthy-after-poison-guest')
  ];
  t.mock.method(console, 'error', () => {});
  let peer = 0;
  const relay = server.createRelayServer({
    accountStore,
    now: () => clock,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    battlePassRetryMs: 60_000,
    idFactory: () => `peer-healthy-after-poison-${++peer}`,
    matchIdFactory: () => 'match-clean-after-poison',
    roomRandom: () => 0
  });
  try {
    const host = connectAuthenticatedPeer(relay, accountStore, users[0], {
      t: 'create', name: 'Healthy Host'
    });
    connectAuthenticatedPeer(relay, accountStore, users[1], {
      t: 'join', name: 'Healthy Guest', room: host.latest('room').room
    });
    host.message({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
    const observationGap = battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS /
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS;
    relaySpacedSnapshots(
      host,
      battlepass.BATTLE_PASS_MIN_SNAPSHOTS,
      () => { clock += observationGap; }
    );
    clock += observationGap;
    host.message({
      t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1, round: 1
    });

    assert.deepEqual(
      users.map((user) => accountStore.battlePass.me(user.id).xp),
      [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
    );
    assert.equal(host.sent.some((message) =>
      message.t === 'error' && message.code === 'battlepass-award-pending'), false);
    assert.equal(accountStore.db.database.prepare(`
      SELECT retry_state
      FROM battlepass_pending_matches
      WHERE match_id = 'match-unrelated-poison'
    `).get().retry_state, 'pending');
  } finally {
    await relay.close();
  }
});

test('an account is capped at 20 awarded matches in a rolling 24 hours', async (t) => {
  const { catalog, database, battlepass } = await modules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const user = createUser(db, 'rolling-cap');
  const opponent = createUser(db, 'rolling-cap-opponent');
  const participants = [user.id, opponent.id];
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const pass = battlepass.createBattlePassService({ db, now: () => clock });

  assert.equal(battlepass.BATTLE_PASS_MIN_MATCH_DURATION_MS, 90_000);
  assert.equal(battlepass.BATTLE_PASS_MIN_PARTICIPANTS, 1);
  assert.equal(battlepass.BATTLE_PASS_MIN_SNAPSHOTS, 10);
  assert.equal(battlepass.BATTLE_PASS_MAX_AWARDS_PER_WINDOW, 20);
  assert.equal(battlepass.BATTLE_PASS_AWARD_WINDOW_MS, 24 * 60 * 60 * 1000);
  for (let match = 1; match <= 20; match++)
    assert.equal(
      awardQualifyingMatch(pass, `cap-${match}`, participants).accounts[0].awarded,
      true
    );

  const refused = awardQualifyingMatch(pass, 'cap-21', participants).accounts[0];
  assert.equal(refused.awarded, false);
  assert.equal(refused.capped, true);
  assert.equal(pass.me(user.id).xp, 20 * catalog.SEASON_1_MATCH_XP);

  clock += battlepass.BATTLE_PASS_AWARD_WINDOW_MS + 1;
  assert.equal(
    awardQualifyingMatch(pass, 'cap-after-window', participants).accounts[0].awarded,
    true
  );
});

test('awardMatch directly refuses missing or insufficient relay evidence', async (t) => {
  const { catalog, database, battlepass } = await modules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const users = [createUser(db, 'floor-first'), createUser(db, 'floor-second')];
  const participants = users.map((user) => user.id);
  const pass = battlepass.createBattlePassService({
    db,
    now: () => Date.parse(catalog.SEASON_1_START) + 1
  });
  const insufficient = [
    undefined,
    { durationMs: 89_999, participantCount: 2, snapshotCount: 10 },
    { durationMs: 90_000, participantCount: 1, snapshotCount: 10 },
    { durationMs: 90_000, participantCount: 2, snapshotCount: 9 }
  ];

  for (const [index, evidence] of insufficient.entries()) {
    const result = pass.awardMatch(`insufficient-${index}`, participants, evidence);
    assert.equal(result.xpPerAccount, 0);
    assert.ok(result.accounts.every((account) => account.awarded === false));
  }
  assert.deepEqual(users.map((user) => pass.me(user.id).xp), [0, 0]);
  assert.equal(db.database.prepare(`
    SELECT COUNT(*) AS count FROM battlepass_match_awards
  `).get().count, 0);
});

test('a participant failure rolls the whole match award back', async (t) => {
  const { catalog, database, battlepass } = await modules();
  const ids = ['atomic-first', 'atomic-second'];
  const db = database.openStoreDatabase(':memory:', { idFactory: () => ids.shift() });
  t.after(() => db.close());
  const first = createUser(db, 'atomic-first');
  const second = createUser(db, 'atomic-second');
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const pass = battlepass.createBattlePassService({ db, now: () => clock });
  awardQualifyingMatch(pass, 'atomic-seed', [first.id, second.id]);
  db.database.exec(`
    CREATE TEMP TRIGGER fail_second_participant
    BEFORE UPDATE OF xp ON battlepass_progress
    WHEN NEW.user_id = 'atomic-second'
    BEGIN
      SELECT RAISE(ABORT, 'forced participant failure');
    END
  `);

  assert.throws(
    () => awardQualifyingMatch(pass, 'atomic-result', [first.id, second.id]),
    /forced participant failure/
  );
  assert.deepEqual(
    [pass.me(first.id).xp, pass.me(second.id).xp],
    [catalog.SEASON_1_MATCH_XP, catalog.SEASON_1_MATCH_XP]
  );
  assert.equal(db.database.prepare(`
    SELECT COUNT(*) AS count FROM battlepass_match_awards
    WHERE match_id = 'atomic-result'
  `).get().count, 0);
});

test('revoke and restore roll back their entitlement change when apply throws', async (t) => {
  const { database } = await modules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const user = createUser(db, 'purchase-transaction');
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'char-midnight',
    checkoutSessionId: 'cs_purchase_transaction',
    paymentIntentId: 'pi_purchase_transaction'
  });

  assert.throws(() => db.revokePurchase({
    paymentIntentId: 'pi_purchase_transaction',
    apply: () => { throw new Error('forced revoke apply failure'); }
  }), /forced revoke apply failure/);
  assert.equal(db.hasEntitlement(user.id, 'char-midnight'), true,
    'the revoke is rolled back with its callback');

  assert.equal(db.revokePurchase({
    paymentIntentId: 'pi_purchase_transaction'
  }), 1);
  assert.equal(db.hasEntitlement(user.id, 'char-midnight'), false);
  assert.throws(() => db.restorePurchase({
    paymentIntentId: 'pi_purchase_transaction',
    apply: () => { throw new Error('forced restore apply failure'); }
  }), /forced restore apply failure/);
  assert.equal(db.hasEntitlement(user.id, 'char-midnight'), false,
    'the restore is rolled back with its callback');
});

test('purchase revocation joins an open webhook transaction without isTransaction', async (t) => {
  const { database } = await modules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const user = createUser(db, 'nested-revocation');
  db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'char-midnight',
    checkoutSessionId: 'cs_nested_revocation',
    paymentIntentId: 'pi_nested_revocation'
  });
  const storeSource = fs.readFileSync(path.join(__dirname, 'store-db.mjs'), 'utf8');
  assert.doesNotMatch(storeSource, /database\.isTransaction/);

  const receipt = db.processWebhookEvent(
    'evt_nested_revocation',
    'charge.refunded',
    Date.now(),
    () => db.revokePurchase({ paymentIntentId: 'pi_nested_revocation' })
  );
  assert.equal(receipt.duplicate, false);
  assert.equal(receipt.result, 1);
  assert.equal(db.hasEntitlement(user.id, 'char-midnight'), false);
  assert.equal(db.countProcessedWebhookEvents(), 1);
});

test('legacy null revocations restore claims and hand revocations use unique ids', async (t) => {
  const { catalog, cosmetics, accounts } = await modules();
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const user = createUser(accountStore.db, 'legacy-null-revocation');
  const opponent = createUser(accountStore.db, 'legacy-null-revocation-opponent');
  accountStore.db.grantEntitlement({
    userId: user.id,
    cosmeticId: cosmetics.PREMIUM_PASS_ID,
    checkoutSessionId: 'cs_legacy_null',
    paymentIntentId: 'pi_legacy_null',
    grantedAt: clock
  });
  awardQualifyingMatch(
    accountStore.battlePass,
    'legacy-null-earned',
    [user.id, opponent.id]
  );
  awardQualifyingMatch(
    accountStore.battlePass,
    'legacy-null-earned-2',
    [user.id, opponent.id]
  );
  assert.equal(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium').length, 1);

  accountStore.db.database.prepare(`
    UPDATE entitlements
    SET revoked_at = ?, revocation_id = NULL
    WHERE user_id = ? AND cosmetic_id = ?
  `).run(clock, user.id, cosmetics.PREMIUM_PASS_ID);
  accountStore.db.database.prepare(`
    UPDATE battlepass_claimed_rewards
    SET revoked_at = ?, revocation_id = NULL
    WHERE user_id = ? AND season_id = ? AND lane = 'premium'
  `).run(clock, user.id, catalog.SEASON_1_ID);

  let restoredRewards = [];
  assert.equal(accountStore.db.restorePurchase({
    paymentIntentId: 'pi_legacy_null',
    apply: ({ userId, cosmeticId, revocationId }) => {
      restoredRewards = accountStore.battlePass.entitlementRestored(
        userId,
        cosmeticId,
        clock,
        revocationId
      );
    }
  }), 1);
  assert.equal(restoredRewards.length, 1);
  assert.equal(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium').length, 1);

  const first = accountStore.battlePass.entitlementRevoked(
    user.id,
    cosmetics.PREMIUM_PASS_ID,
    clock
  );
  assert.equal(first.length, 1);
  accountStore.battlePass.entitlementRestored(
    user.id,
    cosmetics.PREMIUM_PASS_ID,
    clock,
    first[0].revocationId
  );
  const second = accountStore.battlePass.entitlementRevoked(
    user.id,
    cosmetics.PREMIUM_PASS_ID,
    clock
  );
  assert.equal(second.length, 1);
  assert.notEqual(first[0].revocationId, second[0].revocationId);
});

test('premium reward claims revoke on refund and restore with the purchase', async (t) => {
  const { catalog, cosmetics, accounts } = await modules();
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const user = createUser(accountStore.db, 'refund-cycle');
  const opponent = createUser(accountStore.db, 'refund-cycle-opponent');
  awardQualifyingMatch(
    accountStore.battlePass,
    'refund-xp-1',
    [user.id, opponent.id]
  );
  awardQualifyingMatch(
    accountStore.battlePass,
    'refund-xp-2',
    [user.id, opponent.id]
  );

  const paid = webhookEnvelope('refund_cycle_paid', user.id, cosmetics.PREMIUM_PASS_ID);
  const grant = await accountStore.shop.webhook(paid, webhookSignature(paid, clock));
  assert.equal(grant.result.rewardsUnlocked.length, 1);
  assert.equal(accountStore.battlePass.me(user.id).premium, true);
  assert.equal(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium').length, 1);

  const refunded = stripeEvent('evt_pass_refunded', 'charge.refunded', {
    id: 'ch_pass',
    payment_intent: 'pi_refund_cycle_paid',
    refunded: true
  });
  const revoke = await accountStore.shop.webhook(
    refunded,
    webhookSignature(refunded, clock)
  );
  assert.equal(revoke.result.count, 1);
  assert.equal(revoke.result.rewardsRevoked.length, 1);
  assert.equal(accountStore.battlePass.me(user.id).premium, false);
  assert.equal(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium').length, 0);
  assert.equal(accountStore.db.database.prepare(`
    SELECT COUNT(*) AS count FROM battlepass_claimed_rewards
    WHERE user_id = ? AND lane = 'premium' AND revoked_at IS NOT NULL
  `).get(user.id).count, 1);

  const restored = stripeEvent('evt_pass_restored', 'charge.dispute.closed', {
    id: 'dp_pass',
    status: 'won',
    payment_intent: 'pi_refund_cycle_paid',
    charge: { id: 'ch_pass', payment_intent: 'pi_refund_cycle_paid', refunded: false }
  });
  const restore = await accountStore.shop.webhook(
    restored,
    webhookSignature(restored, clock)
  );
  assert.equal(restore.result.count, 1);
  assert.equal(restore.result.rewardsRestored.length, 1);
  assert.equal(accountStore.battlePass.me(user.id).premium, true);
  assert.equal(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium').length, 1);
});

test('restoring a pass after season end unlocks tiers earned while it was revoked', async (t) => {
  const { catalog, cosmetics, accounts, battlepass } = await modules();
  let clock = Date.parse(catalog.SEASON_1_START) + 1;
  const accountStore = accounts.createAccountStore(makeAccountOptions({ now: () => clock }));
  t.after(() => accountStore.close());
  const user = createUser(accountStore.db, 'exact-restore');
  const opponent = createUser(accountStore.db, 'exact-restore-opponent');
  const participants = [user.id, opponent.id];

  for (let match = 1; match <= 28; match++) {
    if (match === battlepass.BATTLE_PASS_MAX_AWARDS_PER_WINDOW + 1)
      clock += battlepass.BATTLE_PASS_AWARD_WINDOW_MS + 1;
    awardQualifyingMatch(accountStore.battlePass, `exact-before-${match}`, participants);
  }
  assert.equal(accountStore.battlePass.me(user.id).tier, 12);

  const paid = webhookEnvelope('exact_restore_paid', user.id, cosmetics.PREMIUM_PASS_ID);
  await accountStore.shop.webhook(paid, webhookSignature(paid, clock));
  assert.deepEqual(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium')
    .map((reward) => reward.tier), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  const refunded = stripeEvent('evt_exact_restore_refund', 'charge.refunded', {
    id: 'ch_exact_restore',
    payment_intent: 'pi_exact_restore_paid',
    refunded: true
  });
  await accountStore.shop.webhook(refunded, webhookSignature(refunded, clock));
  for (let match = 29; match <= 39; match++)
    awardQualifyingMatch(accountStore.battlePass, `exact-after-${match}`, participants);
  assert.equal(accountStore.battlePass.me(user.id).tier, 15);
  assert.equal(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium').length, 0);

  clock = Date.parse(catalog.SEASON_1_END) + 24 * 60 * 60 * 1000;

  const restored = stripeEvent('evt_exact_restore_won', 'charge.dispute.closed', {
    id: 'dp_exact_restore',
    status: 'won',
    payment_intent: 'pi_exact_restore_paid',
    charge: {
      id: 'ch_exact_restore',
      payment_intent: 'pi_exact_restore_paid',
      refunded: false
    }
  });
  const result = await accountStore.shop.webhook(
    restored,
    webhookSignature(restored, clock)
  );
  assert.equal(result.result.rewardsRestored.length, 15);
  assert.deepEqual(accountStore.battlePass.me(user.id).claimedRewards
    .filter((reward) => reward.lane === 'premium')
    .map((reward) => reward.tier),
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('unknown persisted reward ids remain explicit in serialized progress', async (t) => {
  const { catalog, database, battlepass } = await modules();
  const db = database.openStoreDatabase(':memory:');
  t.after(() => db.close());
  const user = createUser(db, 'unknown-reward');
  const clock = Date.parse(catalog.SEASON_1_START) + 1;
  db.database.prepare(`
    INSERT INTO battlepass_progress (user_id, season_id, xp, updated_at)
    VALUES (?, ?, 0, ?)
  `).run(user.id, catalog.SEASON_1_ID, clock);
  db.database.prepare(`
    INSERT INTO battlepass_claimed_rewards (
      user_id, season_id, lane, reward_id, claimed_at, revoked_at
    ) VALUES (?, ?, 'free', 'unknown-persisted-reward', ?, NULL)
  `).run(user.id, catalog.SEASON_1_ID, clock);
  const serialized = JSON.parse(JSON.stringify(
    battlepass.createBattlePassService({ db, now: () => clock }).me(user.id)
  ));
  assert.equal(serialized.claimedRewards[0].rewardId, 'unknown-persisted-reward');
  assert.equal(serialized.claimedRewards[0].tier, null);
});

test('deployment and relay structure retain the production battle-pass safeguards', () => {
  const provision = fs.readFileSync(path.join(__dirname, 'deploy/provision.sh'), 'utf8');
  assert.equal(
    (provision.match(/STRIPE_PRICE_BATTLEPASS_SEASON_1_PREMIUM/g) || []).length,
    3,
    'the variable is allowed, defaulted, and thereby written through the shared allowlist'
  );
  assert.equal(
    (provision.match(/BATTLEPASS_CATALOG_ENABLED/g) || []).length,
    3,
    'the catalog flag is allowed, defaulted, and written through the shared allowlist'
  );
  const relaySource = fs.readFileSync(path.join(__dirname, 'server.mjs'), 'utf8');
  assert.doesNotMatch(relaySource, /function hasClientProgressField/);
  assert.doesNotMatch(relaySource,
    /battlePassParticipants:\s*new Set\(room\.battlePassParticipants\)/,
    'migration must not carry a participant snapshot that nothing mutates');
  assert.doesNotMatch(relaySource,
    /room\.battlePassParticipants\s*=\s*migration\.battlePassParticipants/);
  assert.doesNotMatch(relaySource, /Object\.entries\(value\)/,
    'the hot path must not walk each message a second time for progress keys');
});
