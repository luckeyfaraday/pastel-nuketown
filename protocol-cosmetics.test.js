'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const Protocol = require('./net-protocol.js');
const SIM = require('./net-sim.js');

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  message(value) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }

  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  close() { this.terminate(); }
  ping() {}

  latest(type) {
    return this.sent.findLast((message) => message.t === type);
  }
}

test('protocol v9 treats cosmetic fields as soft, slot-aware metadata', () => {
  assert.equal(Protocol.VERSION, 9);

  const accepts = (id, kind, slot) =>
    (id === 'char-midnight' && kind === 'character' && slot === null) ||
    (id === 'fx-starfall' && kind === 'effect' && slot === null) ||
    (id === 'smg-cottoncloud' && kind === 'weapon' && slot === 'smg');
  assert.deepEqual(Protocol.sanitizeCosmetics({
    character: 'char-midnight',
    weapons: {
      smg: 'smg-cottoncloud',
      shotgun: 'smg-cottoncloud',
      rifle: 'future-rifle-skin'
    }
  }, accepts), {
    character: 'char-midnight',
    weapons: { smg: 'smg-cottoncloud', shotgun: null, rifle: null }
  });

  /* A shot effect rides the same payload. It is written only when there is
     one, so the shape a default-dressed player produces is exactly what it
     was before effects existed — which is the whole reason this is still
     version 9 and not version 10. */
  assert.deepEqual(Protocol.sanitizeCosmetics({
    character: 'char-midnight', effect: 'fx-starfall'
  }, accepts), {
    character: 'char-midnight',
    effect: 'fx-starfall',
    weapons: { smg: null, shotgun: null, rifle: null }
  });
  assert.ok(!('effect' in Protocol.sanitizeCosmetics({ effect: 'fx-unknown' }, accepts)),
    'an effect the catalog does not know is not a selection');
  assert.ok(!('effect' in Protocol.sanitizeCosmetics({ effect: 'FX Starfall' }, accepts)),
    'and neither is something that is not even shaped like an id');
  assert.equal(Protocol.hasCosmetics(
    Protocol.sanitizeCosmetics({ effect: 'fx-starfall' }, accepts)), true,
    'an effect on its own is a selection worth carrying');
  /* An effect is slotless, so it cannot be claimed into a weapon slot and a
     weapon skin cannot be claimed as one. */
  assert.ok(!('effect' in Protocol.sanitizeCosmetics(
    { effect: 'smg-cottoncloud' }, accepts)));
  assert.equal(Protocol.sanitizeCosmetics(
    { weapons: { smg: 'fx-starfall' } }, accepts).weapons.smg, null);

  for (const malformed of [null, [], 'char-midnight', { character: {} }, {
    character: '<script>', weapons: { smg: 12, shotgun: [], rifle: 'x'.repeat(121) }
  }]) {
    assert.doesNotThrow(() => Protocol.sanitizeCosmetics(malformed, accepts));
    assert.equal(Protocol.hasCosmetics(Protocol.sanitizeCosmetics(malformed, accepts)), false);
  }
  assert.equal(Protocol.hasCosmetics(Protocol.sanitizeCosmetics({
    character: 'unknown-but-well-shaped'
  }, accepts)), false, 'an unknown catalog id becomes default appearance');
});

test('the relay derives roster and snapshot cosmetics from database entitlements', async () => {
  const [{ createAccountStore }, { createRelayServer }] = await Promise.all([
    import('./account-store.mjs'),
    import('./server.mjs')
  ]);
  const accounts = createAccountStore({
    dbPath: ':memory:',
    allowedOrigins: ['https://game.example'],
    googleClientId: 'google-client.test',
    googleClientSecret: 'google-secret',
    googleRedirectUri: 'https://relay.example/auth/google/callback',
    appOrigin: 'https://game.example',
    stripeSecretKey: 'sk_test_fake',
    stripeWebhookSecret: 'whsec_test',
    fetchImpl: async () => { throw new Error('Unexpected network request'); }
  });
  const user = accounts.db.upsertGoogleUser({
    subject: 'cosmetic-owner',
    email: 'owner@example.com',
    displayName: 'Owner'
  });
  accounts.db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'char-midnight',
    paymentIntentId: 'pi_cosmetic_test'
  });
  accounts.db.grantEntitlement({
    userId: user.id,
    cosmeticId: 'fx-confettipop',
    paymentIntentId: 'pi_cosmetic_effect'
  });
  const session = accounts.auth.issueSession(user.id);

  const ids = ['peer-host', 'peer-guest'];
  const relay = createRelayServer({
    accountStore: accounts,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => ids.shift(),
    roomRandom: () => 0
  });

  try {
    const host = new FakeWebSocket();
    const guest = new FakeWebSocket();
    relay.wss.emit('connection', host, {});
    relay.wss.emit('connection', guest, {});

    host.message({
      t: 'create',
      v: Protocol.VERSION,
      name: 'Host',
      authToken: session.token,
      cosmetics: {
        character: 'char-midnight',
        /* Bought. The starfall claimed on the snapshot below is not. */
        effect: 'fx-confettipop',
        weapons: {
          smg: 'smg-cottoncloud',
          shotgun: 'shotgun-toastedmallow',
          rifle: 'future-rifle-skin'
        }
      }
    });
    const room = host.latest('room').room;
    guest.message({
      t: 'join',
      v: Protocol.VERSION,
      room,
      name: 'Guest',
      authToken: 'not-a-live-session-token',
      cosmetics: {
        character: 'char-cloudknight',
        effect: 'fx-bubbletrail',
        weapons: { rifle: 'rifle-berryswirl' }
      }
    });

    const roster = guest.latest('members').members;
    /* The character was bought and the effect was not, so one survives and
       the other is stripped — from the same claim, in the same message. */
    assert.deepEqual(roster.find((member) => member.id === 'peer-host').cosmetics, {
      character: 'char-midnight',
      effect: 'fx-confettipop',
      weapons: { smg: null, shotgun: null, rifle: null }
    });
    assert.equal(roster.find((member) => member.id === 'peer-guest').cosmetics, undefined,
      'a signed-out claim is stripped without rejecting the join');

    host.message({
      t: 'start', v: Protocol.VERSION, authorityEpoch: 1
    });
    host.message({
      t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1, round: 1,
      tick: 60, time: 1, eventSeq: 0, manifestVersion: 1,
      mode: 'dm', over: false, winner: null, donuts: [],
      actors: [
        {
          netId: 'peer-host', human: true,
          cosmetics: {
            character: 'char-cloudknight',
            effect: 'fx-starfall',
            weapons: { smg: 'smg-cottoncloud' }
          }
        },
        {
          netId: 'peer-guest', human: true,
          cosmetics: {
            character: 'char-midnight',
            effect: 'fx-confettipop',
            weapons: { rifle: 'rifle-berryswirl' }
          }
        }
      ]
    });

    const snapshot = guest.latest('snapshot');
    assert.deepEqual(snapshot.actors.find((actor) => actor.netId === 'peer-host').cosmetics, {
      character: 'char-midnight',
      effect: 'fx-confettipop',
      weapons: { smg: null, shotgun: null, rifle: null }
    }, 'the owned selection survives join -> relay -> snapshot, and the'
     + ' unowned effect the host wrote onto itself does not');
    assert.equal(
      snapshot.actors.find((actor) => actor.netId === 'peer-guest').cosmetics,
      undefined,
      'the host cannot forge an unowned skin onto another actor'
    );

    host.message({
      t: 'checkpoint', v: Protocol.VERSION, authorityEpoch: 1, round: 1,
      tick: 60, time: 1, mode: 'dm', manifestVersion: 1,
      actors: [
        { netId: 'peer-host', controller: 'local', human: true, skill: 'normal', ammoBy: {} },
        { netId: 'peer-guest', controller: 'remote', human: true, skill: 'normal', ammoBy: {} }
      ],
      events: [], confirmEvents: []
    });
    host.terminate();
    const migration = guest.latest('host-changed');
    assert.equal(migration.seamless, true);
    assert.equal(
      migration.snapshot.actors.find((actor) => actor.netId === 'peer-host')
        .cosmetics.character,
      'char-midnight',
      'the cached migration snapshot keeps the relay-approved appearance'
    );
    assert.equal(
      migration.snapshot.actors.find((actor) => actor.netId === 'peer-host')
        .cosmetics.effect,
      'fx-confettipop',
      'including the effect, which crosses a host change like everything else'
    );
  } finally {
    await relay.close();
  }
});

test('current builders render malformed or unavailable cosmetics as default', () => {
  const client = SIM.createInstance({ ms: 0 });
  client.run(`
    globalThis.EQUIPPED = {
      character: { bad: true },
      weapons: { smg: '<bad>', shotgun: 17, rifle: 'future-rifle-skin' }
    };
    initViewmodel(); initFX(); initInput(); initAI();
    CFG.combatants = 2;
    NET.mode = 'solo';
    netBeginMatch();
  `);
  assert.equal(client.get('G.started'), true);
  assert.equal(client.get('VM.cur'), 'smg');
  assert.equal(client.get('G.actors.length'), 9);
});
