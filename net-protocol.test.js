'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');

const Protocol = require('./net-protocol.js');

function closeEnough(actual, expected, epsilon = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function validInput(overrides) {
  return Object.assign({
    t: 'input',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    seq: 1,
    fwd: 0.5,
    strafe: -0.25,
    jump: false,
    sprint: true,
    fire: false,
    fireSeq: 0,
    yaw: 0.75,
    pitch: -0.2,
    renderTime: 12.5,
    weapon: 'smg',
    weaponSeq: 0,
    reloadSeq: 0
  }, overrides);
}

function validCheckpoint(actorIds, overrides) {
  return Object.assign({
    t: 'checkpoint',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    tick: 60,
    time: 1,
    manifestVersion: 1,
    actors: actorIds.map((netId, index) => ({
      netId,
      controller: index === 0 ? 'local' : 'remote',
      human: true,
      skill: 'normal',
      ammoBy: { smg: [17, 120] }
    })),
    events: []
  }, overrides);
}

function websocketClient(url) {
  const ws = new WebSocket(url);
  const queued = [];
  const waiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8'));
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex === -1) {
      queued.push(message);
      return;
    }

    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  function next(predicate, timeoutMs = 1500) {
    const match = typeof predicate === 'string'
      ? (message) => message.t === predicate
      : predicate;
    const queuedIndex = queued.findIndex(match);
    if (queuedIndex !== -1) {
      return Promise.resolve(queued.splice(queuedIndex, 1)[0]);
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: match,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for WebSocket message'));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  }

  return {
    ws,
    opened: once(ws, 'open'),
    send(message) {
      ws.send(JSON.stringify(message));
    },
    next
  };
}

async function expectNoMessage(client, predicate, timeoutMs = 100) {
  await assert.rejects(
    client.next(predicate, timeoutMs),
    /Timed out waiting for WebSocket message/
  );
}

async function startRelay(t, options = {}) {
  const { createRelayServer } = await import('./server.mjs');
  const relay = createRelayServer({
    heartbeatMs: 0,
    ...options
  });

  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await relay.close();
  });

  return {
    relay,
    port: relay.address().port
  };
}

test('exports one frozen API to CommonJS and globalThis', () => {
  assert.equal(globalThis.NUKETOWN_PROTOCOL, Protocol);
  assert.ok(Object.isFrozen(Protocol));
  assert.equal(Protocol.VERSION, 6);
  assert.equal(Protocol.MAX_PLAYERS, 4);
  assert.deepEqual(Protocol.ALLOWED_WEAPONS, ['smg', 'shotgun', 'rifle']);
});

test('normalizes human-entered room codes and cleans display names', () => {
  assert.equal(Protocol.normalizeRoomCode(' ab-c 12!z9 more'), 'ABC12Z');
  assert.equal(Protocol.normalizeRoomCode(null), '');
  assert.equal(Protocol.normalizeRoomCode({ toString: () => ' room-7 ' }), '');

  assert.equal(
    Protocol.cleanPlayerName('\t<Ａlice>\n  Bob\u0000'),
    'Alice Bob'
  );
  assert.equal(Protocol.cleanPlayerName(null), '');
  assert.equal(Protocol.cleanPlayerName({ name: 'Alice' }), '');
  assert.equal(Protocol.cleanPlayerName(['Alice']), '');
  assert.equal(
    Array.from(Protocol.cleanPlayerName('😀'.repeat(30))).length,
    Protocol.MAX_PLAYER_NAME_LENGTH
  );
});

test('validates host promotion as a forward-only authority transition', () => {
  const changed = Protocol.sanitizeHostChanged({
    t: 'host-changed',
    v: Protocol.VERSION,
    authorityEpoch: 2,
    round: 3,
    host: 'peer-2',
    members: [
      { id: 'peer-2', name: ' New Host ', role: 'host' },
      { id: 'peer-3', name: 'Guest', role: 'guest' }
    ]
  }, 'peer-3', 1, 2);

  assert.equal(changed.ok, true);
  assert.deepEqual(changed.value, {
    t: 'host-changed',
    v: Protocol.VERSION,
    authorityEpoch: 2,
    round: 3,
    host: 'peer-2',
    members: [
      { id: 'peer-2', name: 'New Host', role: 'host' },
      { id: 'peer-3', name: 'Guest', role: 'guest' }
    ]
  });

  const invalid = [
    [{ t: 'snapshot' }, 'type'],
    [{ authorityEpoch: 1 }, 'authorityEpoch'],
    [{ round: 2 }, 'round'],
    [{ host: 'missing' }, 'host'],
    [{ members: [{ id: 'peer-2', name: 'Host', role: 'guest' }] }, 'roster'],
    [{ members: [{ id: 'peer-2', name: 'Host', role: 'host' }] }, 'roster']
  ];
  const base = {
    t: 'host-changed',
    v: Protocol.VERSION,
    authorityEpoch: 2,
    round: 3,
    host: 'peer-2',
    members: [
      { id: 'peer-2', name: 'Host', role: 'host' },
      { id: 'peer-3', name: 'Guest', role: 'guest' }
    ]
  };
  for (const [override, expected] of invalid) {
    const checked = Protocol.sanitizeHostChanged(
      { ...base, ...override }, 'peer-3', 1, 2);
    assert.equal(checked.ok, false);
    assert.match(checked.error, new RegExp(expected));
  }
});

test('creates fixed-length, unambiguous room codes with an injectable RNG', () => {
  assert.equal(
    Protocol.createRoomCode(() => 0),
    Protocol.ROOM_CODE_ALPHABET[0].repeat(Protocol.ROOM_CODE_LENGTH)
  );
  assert.equal(
    Protocol.createRoomCode(() => 1),
    Protocol.ROOM_CODE_ALPHABET.at(-1).repeat(Protocol.ROOM_CODE_LENGTH)
  );

  let index = 0;
  const code = Protocol.createRoomCode(
    () => (index++ + 0.5) / Protocol.ROOM_CODE_LENGTH
  );
  assert.equal(code.length, Protocol.ROOM_CODE_LENGTH);
  assert.match(code, /^[A-HJ-NP-Z2-9]+$/);
});

test('angle helpers stay finite and interpolate across the wrap boundary', () => {
  assert.equal(Protocol.isFiniteNumber(0), true);
  assert.equal(Protocol.isFiniteNumber(Infinity), false);
  assert.equal(Protocol.isFiniteNumber('1'), false);
  assert.equal(Protocol.clamp(3, -1, 1), 1);
  assert.equal(Protocol.clamp(-3, -1, 1), -1);
  assert.equal(Protocol.wrapAngle(Infinity), 0);
  closeEnough(Protocol.wrapAngle(Math.PI), -Math.PI);
  closeEnough(Protocol.wrapAngle(-Math.PI * 3), -Math.PI);

  const degrees = Math.PI / 180;
  closeEnough(
    Math.abs(Protocol.lerpAngle(170 * degrees, -170 * degrees, 0.5)),
    Math.PI
  );
  closeEnough(Protocol.lerpAngle(1, 2, -1), 1);
  closeEnough(Protocol.lerpAngle(1, 2, 2), 2);
});

test('recognizes loopback, private, link-local, and mDNS hosts', () => {
  const privateHosts = [
    'localhost',
    '127.0.0.1',
    '127.42.0.9',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.4.2',
    '::1',
    '[::1]',
    'fc00::1',
    '[fd12:3456::1]',
    'fe80::1',
    '[febf::9]',
    'nuketown.local',
    'NUKETOWN.LOCAL.'
  ];
  for (const hostname of privateHosts) {
    assert.equal(Protocol.isPrivateHost(hostname), true, hostname);
  }

  const publicHosts = [
    '172.15.255.255',
    '172.32.0.0',
    '192.167.1.1',
    '169.253.1.1',
    '8.8.8.8',
    'fbff::1',
    'fec0::1',
    'nuketown.example',
    '256.1.1.1',
    null
  ];
  for (const hostname of publicHosts) {
    assert.equal(Protocol.isPrivateHost(hostname), false, String(hostname));
  }
});

test('classifies weapon reconciliation and retained fire intent', () => {
  assert.equal(Protocol.isWeaponStateAcknowledged(3, 2), false);
  assert.equal(Protocol.isWeaponStateAcknowledged(3, 3), true);
  assert.equal(Protocol.isWeaponStateAcknowledged(3, 4), true);

  assert.equal(Protocol.FIRE_INTENT_TTL, 0.2);
  assert.equal(Protocol.classifyFireIntent(true, false, 0, 0, 1), 'fire');
  assert.equal(Protocol.classifyFireIntent(true, false, 0.01, 0, 1), 'retain');
  assert.equal(Protocol.classifyFireIntent(true, false, 0, 0.01, 0), 'retain');
  assert.equal(Protocol.classifyFireIntent(true, false, 0, 0, 0), 'drop');
  assert.equal(Protocol.classifyFireIntent(true, false, 0.01, 0, 0), 'drop');
  assert.equal(Protocol.classifyFireIntent(true, true, 0.01, 0, 1), 'drop');
  assert.equal(Protocol.classifyFireIntent(false, false, 0.01, 0, 1), 'drop');
});

test('clamps client render time to a bounded host-history window', () => {
  assert.equal(Protocol.MAX_REWIND_SECONDS, 0.3);
  closeEnough(Protocol.clampRewindTime(9.82, 10, 9.7), 9.82);
  closeEnough(
    Protocol.clampRewindTime(9.72, 10, 9.78),
    9.78,
    1e-12
  );
  assert.equal(Protocol.clampRewindTime(10.001, 10, 9.7), null);
  assert.equal(Protocol.clampRewindTime(9.699, 10, 9.6), null);
  assert.equal(Protocol.clampRewindTime(NaN, 10, 9.7), null);
});

test('selects interpolation brackets and bounds starved-buffer extrapolation', () => {
  const samples = [{ time: 1 }, { time: 1.05 }, { time: 1.1 }];
  const bracket = Protocol.selectTimedSamples(samples, 1.075, 0.1);
  assert.equal(bracket.from, 1);
  assert.equal(bracket.to, 2);
  closeEnough(bracket.alpha, 0.5);
  assert.equal(bracket.extrapolation, 0);
  assert.deepEqual(Protocol.selectTimedSamples(samples, 0.9, 0.1), {
    from: 0,
    to: 0,
    alpha: 0,
    extrapolation: 0
  });
  assert.deepEqual(Protocol.selectTimedSamples([{ time: 2 }], 2.15, 0.1), {
    from: 0,
    to: 0,
    alpha: 0,
    extrapolation: 0.1
  });
  assert.equal(Protocol.selectTimedSamples([], 1, 0.1), null);
});

test('derives repeatable, shooter-specific spread sequences from fireSeq', () => {
  const spread = (shooter, fireSeq, shotNo) => {
    const random = mulberry32(Protocol.shotSpreadSeed(shooter, fireSeq, shotNo));
    return Array.from({ length: 6 }, () => random());
  };

  assert.deepEqual(spread('guest-2', 9), spread('guest-2', 9));
  assert.notDeepEqual(spread('guest-2', 9), spread('guest-2', 10));
  assert.notDeepEqual(spread('guest-2', 9), spread('guest-3', 9));

  /* Both sides must derive the same seed for the same shot... */
  assert.deepEqual(spread('guest-2', 9, 24), spread('guest-2', 9, 24));

  /* ...but a held burst keeps one fireSeq throughout, so without a per-shot
     component every bullet in it would land on the same offset and the cone
     would collapse. Remaining ammo is what separates them. */
  const burst = [27, 26, 25, 24].map(ammo => spread('guest-2', 9, ammo));
  for (let i = 1; i < burst.length; i++) {
    assert.notDeepEqual(burst[i], burst[i - 1]);
  }
  assert.notDeepEqual(spread('guest-2', 9, 24), spread('guest-3', 9, 24));
});

test('sanitizes valid input into a bounded, canonical payload', () => {
  const sanitized = Protocol.sanitizeInput(validInput({
    seq: 9,
    fwd: 4,
    strafe: -3,
    jump: true,
    fire: true,
    fireSeq: 7,
    yaw: Math.PI * 3,
    pitch: 99,
    renderTime: 42.125,
    weapon: 'rifle',
    weaponSeq: 3,
    reloadSeq: 5,
    ignored: 'not relayed',
    from: 'spoofed'
  }), 8);

  assert.equal(sanitized.ok, true);
  assert.equal(sanitized.error, null);
  assert.deepEqual(sanitized.value, {
    t: 'input',
    v: 6,
    authorityEpoch: 1,
    round: 1,
    seq: 9,
    fwd: 1,
    strafe: -1,
    jump: true,
    sprint: true,
    fire: true,
    fireSeq: 7,
    yaw: -Math.PI,
    pitch: Protocol.MAX_PITCH,
    renderTime: 42.125,
    weapon: 'rifle',
    weaponSeq: 3,
    reloadSeq: 5
  });
});

test('rejects stale sequences, malformed controls, and unknown weapons', () => {
  const cases = [
    [null, 'object'],
    [validInput({ t: 'snapshot' }), 'type'],
    [validInput({ v: Protocol.VERSION + 1 }), 'version'],
    [validInput({ authorityEpoch: 0 }), 'authorityEpoch'],
    [validInput({ authorityEpoch: 1.5 }), 'authorityEpoch'],
    [validInput({ round: 0 }), 'round'],
    [validInput({ round: 1.5 }), 'round'],
    [validInput({ seq: -1 }), 'seq'],
    [validInput({ seq: 1.5 }), 'seq'],
    [validInput({ seq: 4 }), 'increase', 4],
    [validInput({ fwd: Infinity }), 'finite'],
    [validInput({ strafe: '1' }), 'finite'],
    [validInput({ yaw: NaN }), 'finite'],
    [validInput({ renderTime: undefined }), 'renderTime'],
    [validInput({ renderTime: NaN }), 'renderTime'],
    [validInput({ renderTime: -0.01 }), 'renderTime'],
    [validInput({ renderTime: 100000001 }), 'renderTime'],
    [validInput({ jump: 1 }), 'booleans'],
    [validInput({ sprint: null }), 'booleans'],
    [validInput({ fire: 'yes' }), 'booleans'],
    [validInput({ weapon: 'laser' }), 'weapon'],
    [validInput({ fireSeq: -1 }), 'counters'],
    [validInput({ fireSeq: 0.5 }), 'counters'],
    [validInput({ reloadSeq: -1 }), 'counters'],
    [validInput({ reloadSeq: Number.MAX_SAFE_INTEGER + 1 }), 'counters'],
    [validInput({ weaponSeq: undefined }), 'counters'],
    [validInput({ weaponSeq: -1 }), 'counters'],
    [validInput({ weaponSeq: 0.5 }), 'counters'],
    [validInput({ weaponSeq: Number.MAX_SAFE_INTEGER + 1 }), 'counters'],
    [validInput({ weaponSeq: 3 }), 'decrease', 0, 4]
  ];

  for (const [message, errorFragment, lastSeq, lastWeaponSeq] of cases) {
    const parsed = Protocol.sanitizeInput(message, lastSeq, lastWeaponSeq);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.value, null);
    assert.match(parsed.error, new RegExp(errorFragment));
  }

  assert.equal(
    Protocol.sanitizeInput(validInput({ seq: 2, weaponSeq: 4 }), 1, 4).ok,
    true,
    'weaponSeq may stay unchanged between inputs'
  );
});

test('parses JSON strings, Buffers, ArrayBuffers, and sliced byte views', () => {
  const message = { t: 'event', v: Protocol.VERSION, text: 'café' };
  const json = JSON.stringify(message);

  assert.deepEqual(Protocol.parseWireMessage(json).value, message);
  assert.deepEqual(Protocol.parseWireMessage(Buffer.from(json)).value, message);

  const bytes = new TextEncoder().encode(json);
  assert.deepEqual(
    Protocol.parseWireMessage(bytes.buffer).value,
    message
  );

  const padded = Buffer.concat([Buffer.from('xx'), Buffer.from(json), Buffer.from('yy')]);
  const slice = new Uint8Array(
    padded.buffer,
    padded.byteOffset + 2,
    Buffer.byteLength(json)
  );
  assert.deepEqual(Protocol.parseWireMessage(slice).value, message);
  assert.deepEqual(
    Protocol.parseWireMessage(Buffer.from(`\ufeff${json}`)).value,
    message
  );
});

test('applies byte-accurate wire limits and rejects malformed payloads', () => {
  const json = JSON.stringify({ name: 'é' });
  const byteLength = Buffer.byteLength(json);
  assert.equal(Protocol.parseWireMessage(json, byteLength).ok, true);
  assert.match(
    Protocol.parseWireMessage(json, byteLength - 1).error,
    /too large/
  );

  const invalidCases = [
    [Buffer.from([0xff]), /UTF-8/],
    ['{', /JSON/],
    ['null', /object/],
    ['[]', /object/],
    ['"text"', /object/],
    [{ t: 'input' }, /text or bytes/],
    ['', /JSON/]
  ];
  for (const [raw, expected] of invalidCases) {
    const parsed = Protocol.parseWireMessage(raw);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.value, null);
    assert.match(parsed.error, expected);
  }

  assert.match(Protocol.parseWireMessage('{}', 0).error, /maxBytes/);
});

test('HTTP server serves the game and protocol while rejecting other paths', async (t) => {
  const { port } = await startRelay(t);

  const game = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(game.status, 200);
  assert.match(game.headers.get('content-type'), /^text\/html/);
  assert.match(await game.text(), /^<!doctype html>/i);

  const protocol = await fetch(`http://127.0.0.1:${port}/net-protocol.js`);
  assert.equal(protocol.status, 200);
  assert.match(await protocol.text(), /NUKETOWN_PROTOCOL/);

  const missing = await fetch(`http://127.0.0.1:${port}/missing`);
  assert.equal(missing.status, 404);
});

test('room relay enforces authoritative rounds for start, input, snapshots, events, and lobby', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `peer-${++nextId}`,
    roomRandom: () => 0
  });

  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  const guest = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([host.opened, guest.opened]);

  host.send({ t: 'create', v: Protocol.VERSION, name: ' Host ' });
  const hostRoom = await host.next('room');
  assert.deepEqual(hostRoom, {
    t: 'room',
    v: Protocol.VERSION,
    room: 'AAAAAA',
    id: 'peer-1',
    role: 'host',
    authorityEpoch: 1,
    round: 0,
    started: false,
    members: [{ id: 'peer-1', name: 'Host', role: 'host' }]
  });
  await host.next('members');

  guest.send({ t: 'join', v: Protocol.VERSION, room: 'aaa-aaa', name: 'Guest' });
  const guestRoom = await guest.next('room');
  assert.equal(guestRoom.role, 'guest');
  assert.equal(guestRoom.id, 'peer-2');
  assert.equal(guestRoom.members.length, 2);
  assert.equal((await host.next('members')).members.length, 2);
  await guest.next('members');

  guest.send(validInput({ round: 1, seq: 1 }));
  await expectNoMessage(host, 'input');

  guest.send({
    t: 'snapshot',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    tick: 1,
    time: 1 / 60,
    eventSeq: 0,
    manifestVersion: 1,
    actors: []
  });
  assert.equal((await guest.next('error')).code, 'host-only');

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1, seed: 42 });
  const expectedStart = {
    t: 'start',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    members: [
      { id: 'peer-1', name: 'Host', role: 'host' },
      { id: 'peer-2', name: 'Guest', role: 'guest' }
    ]
  };
  const [hostStart, guestStart] = await Promise.all([
    host.next('start'),
    guest.next('start')
  ]);
  assert.deepEqual(hostStart, expectedStart);
  assert.deepEqual(guestStart, expectedStart);

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  assert.equal((await host.next('error')).code, 'already-started');
  await expectNoMessage(guest, 'start');

  guest.send(validInput({
    round: 1,
    seq: 4,
    fwd: 10,
    fireSeq: 2,
    weaponSeq: 0,
    reloadSeq: 1,
    from: 'forged'
  }));
  const relayedInput = await host.next('input');
  assert.equal(relayedInput.from, 'peer-2');
  assert.equal(relayedInput.fwd, 1);
  assert.equal(relayedInput.fireSeq, 2);
  assert.equal(relayedInput.renderTime, 12.5);
  assert.equal(relayedInput.weaponSeq, 0);
  assert.equal(relayedInput.reloadSeq, 1);

  guest.send(validInput({ seq: 4 }));
  assert.equal((await guest.next('error')).code, 'invalid-input');

  guest.send(validInput({ round: 2, seq: 5 }));
  await expectNoMessage(host, 'input');
  guest.send(validInput({ round: 1, seq: 5 }));
  assert.equal((await host.next('input')).seq, 5);

  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1,
    round: 0, tick: 6, time: 0.1, eventSeq: 0, manifestVersion: 1, actors: []
  });
  await expectNoMessage(guest, 'snapshot');
  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, tick: 7, time: 0.12, eventSeq: 0, manifestVersion: 1, actors: []
  });
  assert.deepEqual(await guest.next('snapshot'), {
    t: 'snapshot',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    tick: 7,
    time: 0.12,
    eventSeq: 0,
    manifestVersion: 1,
    actors: []
  });

  host.send({
    t: 'event', v: Protocol.VERSION, authorityEpoch: 1,
    round: 0, events: [{ id: 1, kind: 'shot' }]
  });
  await expectNoMessage(guest, 'event');
  host.send({
    t: 'event', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, events: [{ id: 1, kind: 'shot' }]
  });
  assert.deepEqual(await guest.next('event'), {
    t: 'event',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    events: [{ id: 1, kind: 'shot' }]
  });

  host.send({
    t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1,
    round: 0, winner: 'peer-1'
  });
  await expectNoMessage(guest, 'lobby');
  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, tick: 8, time: 0.14, eventSeq: 0, manifestVersion: 1, actors: []
  });
  assert.equal((await guest.next('snapshot')).tick, 8);

  host.send({
    t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, winner: 'peer-1'
  });
  assert.deepEqual(await guest.next('lobby'), {
    t: 'lobby',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    winner: 'peer-1'
  });

  host.send({
    t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, winner: 'peer-1'
  });
  await expectNoMessage(guest, 'lobby');
  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, tick: 9, time: 0.16, eventSeq: 0, manifestVersion: 1, actors: []
  });
  await expectNoMessage(guest, 'snapshot');
  guest.send(validInput({ round: 1, seq: 6 }));
  await expectNoMessage(host, 'input');

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  const [hostRematch, guestRematch] = await Promise.all([
    host.next('start'),
    guest.next('start')
  ]);
  assert.equal(hostRematch.round, 2);
  assert.deepEqual(guestRematch, hostRematch);

  guest.send(validInput({ round: 1, seq: 6 }));
  await expectNoMessage(host, 'input');
  guest.send(validInput({ round: 2, seq: 1 }));
  const firstRematchInput = await host.next('input');
  assert.equal(firstRematchInput.round, 2);
  assert.equal(firstRematchInput.seq, 1);

  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, tick: 10, time: 0.18, eventSeq: 0, manifestVersion: 1, actors: []
  });
  await expectNoMessage(guest, 'snapshot');
  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1,
    round: 2, tick: 1, time: 0.02, eventSeq: 0, manifestVersion: 1, actors: []
  });
  assert.equal((await guest.next('snapshot')).round, 2);

  host.send({
    t: 'event', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, events: [{ id: 2, kind: 'shot' }]
  });
  await expectNoMessage(guest, 'event');
  host.send({
    t: 'event', v: Protocol.VERSION, authorityEpoch: 1,
    round: 2, events: [{ id: 1, kind: 'respawn' }]
  });
  assert.equal((await guest.next('event')).round, 2);

  host.ws.close();
  assert.deepEqual(await guest.next('host-changed'), {
    t: 'host-changed',
    v: Protocol.VERSION,
    authorityEpoch: 2,
    round: 3,
    host: 'peer-2',
    members: [{ id: 'peer-2', name: 'Guest', role: 'host' }]
  });

  guest.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  assert.equal((await guest.next('error')).code, 'stale-authority');
  guest.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 2 });
  const restarted = await guest.next('start');
  assert.equal(restarted.authorityEpoch, 2);
  assert.equal(restarted.round, 4);
});

test('started rooms admit late joins, host migration survives them, and capacity is four', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `id-${++nextId}`,
    roomRandom: () => 0
  });

  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await host.opened;
  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host' });
  const room = await host.next('room');
  await host.next('members');

  const first = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await first.opened;
  first.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'One' });
  await first.next('room');
  await first.next('members');
  await host.next('members');

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  const [hostStart, firstStart] = await Promise.all([
    host.next('start'),
    first.next('start')
  ]);
  assert.equal(hostStart.round, 1);
  assert.equal(firstStart.round, 1);

  /* Drop-in. The relay hands over no world state: it tells the arrival the
     round is live and tells the host the roster changed, and the host's next
     snapshot is what actually seats them. */
  const late = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await late.opened;
  late.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Late' });
  const lateRoom = await late.next('room');
  assert.equal(lateRoom.started, true,
    'a peer walking into a live round is told so rather than sat in a lobby');
  assert.equal(lateRoom.round, 1, 'and inherits the round it walked into');
  assert.equal(lateRoom.authorityEpoch, 1);
  await late.next('members');
  const seated = await host.next('members');
  assert.deepEqual(seated.members.map((member) => member.name), ['Host', 'One', 'Late'],
    'the host hears about the arrival on the ordinary roster broadcast');
  await first.next('members');

  host.ws.close();
  const promoted = await first.next('host-changed');
  await late.next('host-changed');
  assert.equal(promoted.host, 'id-2');
  assert.equal(promoted.authorityEpoch, 2);
  assert.equal(promoted.round, 2);
  assert.deepEqual(promoted.members, [
    { id: 'id-2', name: 'One', role: 'host' },
    { id: 'id-3', name: 'Late', role: 'guest' }
  ], 'a player who dropped in is a member like any other when the host goes');

  const third = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await third.opened;
  third.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Three' });
  const thirdRoom = await third.next('room');
  assert.equal(thirdRoom.started, false,
    'the restart migration put the room back between rounds');
  await third.next('members');
  await first.next('members');
  await late.next('members');

  const fourth = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await fourth.opened;
  fourth.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Four' });
  await fourth.next('room');
  await fourth.next('members');
  await first.next('members');
  await late.next('members');
  await third.next('members');

  const overflow = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await overflow.opened;
  overflow.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Five' });
  assert.equal((await overflow.next('error')).code, 'room-full',
    'drop-in does not raise the ceiling');

  first.ws.close();
  const [secondPromotion, observedByThird, observedByFourth] = await Promise.all([
    late.next('host-changed'),
    third.next('host-changed'),
    fourth.next('host-changed')
  ]);
  assert.equal(secondPromotion.host, 'id-3',
    'the next-oldest surviving guest wins the next election');
  assert.equal(secondPromotion.authorityEpoch, 3);
  assert.equal(secondPromotion.round, 3);
  assert.deepEqual(observedByThird, secondPromotion);
  assert.deepEqual(observedByFourth, secondPromotion);
});

test('relay promotes from independently fresh snapshot and checkpoint caches without restarting', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `migrate-${++nextId}`,
    roomRandom: () => 0,
    promotionTimeoutMs: 500
  });
  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  const promoted = websocketClient(`ws://127.0.0.1:${port}/ws`);
  const observer = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([host.opened, promoted.opened, observer.opened]);

  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host' });
  const room = await host.next('room');
  await host.next('members');
  promoted.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Next' });
  await promoted.next('room'); await promoted.next('members'); await host.next('members');
  observer.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Observer' });
  await observer.next('room'); await observer.next('members');
  await promoted.next('members'); await host.next('members');

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  await Promise.all([host.next('start'), promoted.next('start'), observer.next('start')]);
  const ids = ['migrate-1', 'migrate-2', 'migrate-3'];
  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1, round: 1,
    tick: 100, time: 5 / 3, eventSeq: 12, manifestVersion: 1,
    actors: ids.map(netId => ({ netId })), over: false, winner: null
  });
  await Promise.all([promoted.next('snapshot'), observer.next('snapshot')]);

  /* A weapon switch can force slow state after the last pose snapshot. The
     newer checkpoint remains useful and must not disqualify migration. */
  host.send(validCheckpoint(ids, {
    tick: 101,
    time: 1.7,
    actors: [
      { netId: ids[0], controller: 'local', human: true, skill: 'normal',
        ammoBy: { smg: [7, 40], rifle: [9, 22] } },
      { netId: ids[1], controller: 'remote', human: true, skill: 'normal',
        ammoBy: { smg: [5, 31] } },
      { netId: ids[2], controller: 'remote', human: true, skill: 'normal',
        ammoBy: { smg: [11, 77] } }
    ]
  }));
  await Promise.all([promoted.next('checkpoint'), observer.next('checkpoint')]);

  host.ws.close();
  const [changeForHost, changeForObserver] = await Promise.all([
    promoted.next('host-changed'),
    observer.next('host-changed')
  ]);
  assert.equal(changeForHost.seamless, true);
  assert.equal(changeForHost.round, 1, 'the live round must not advance');
  assert.equal(changeForHost.authorityEpoch, 2);
  assert.equal(changeForHost.snapshot.tick, 100);
  assert.equal(changeForHost.checkpoint.tick, 101,
    'newer slow state should be combined with the latest pose');
  assert.deepEqual(changeForObserver, changeForHost);

  observer.send({
    t: 'authority-state', v: Protocol.VERSION,
    authorityEpoch: 2, round: 1,
    inputSeq: 50, fireSeq: 4, reloadSeq: 2, weaponSeq: 1, weapon: 'rifle'
  });
  const peerState = await promoted.next('authority-state');
  assert.equal(peerState.from, 'migrate-3');
  assert.equal(peerState.inputSeq, 50);

  promoted.send({
    t: 'authority-ready', v: Protocol.VERSION,
    authorityEpoch: 2, round: 1, tick: 100
  });
  const [readyHost, readyObserver] = await Promise.all([
    promoted.next('authority-ready'),
    observer.next('authority-ready')
  ]);
  assert.deepEqual(readyHost, readyObserver);
  assert.equal(readyHost.round, 1);

  observer.send(validInput({
    authorityEpoch: 2, round: 1, seq: 51,
    fireSeq: 4, reloadSeq: 2, weaponSeq: 1, weapon: 'rifle'
  }));
  assert.equal((await promoted.next('input')).seq, 51,
    'input must resume against the new authority only after ready');
});

test('relay rejects poisoned checkpoint fields and remains usable', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `poison-${++nextId}`,
    roomRandom: () => 0
  });
  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  const guest = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([host.opened, guest.opened]);
  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host' });
  const room = await host.next('room'); await host.next('members');
  guest.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Guest' });
  await guest.next('room'); await guest.next('members'); await host.next('members');
  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  await Promise.all([host.next('start'), guest.next('start')]);

  const ids = ['poison-1', 'poison-2'];
  const badKey = validCheckpoint(ids);
  badKey.actors[0].ammoBy.__proto_pollution = [1, 2];
  host.send(badKey);
  assert.equal((await host.next('error')).code, 'invalid-checkpoint');
  await expectNoMessage(guest, 'checkpoint');

  const badType = validCheckpoint(ids);
  badType.actors[1].ammoBy.smg = ['17', 120];
  host.send(badType);
  assert.equal((await host.next('error')).code, 'invalid-checkpoint');

  const tooManyKeys = validCheckpoint(ids);
  tooManyKeys.actors[0].ammoBy = {
    smg: [1, 2], rifle: [1, 2], shotgun: [1, 2], extra: [1, 2]
  };
  host.send(tooManyKeys);
  assert.equal((await host.next('error')).code, 'invalid-checkpoint');

  let nested = { leaf: true };
  for (let i = 0; i < 12; i++) nested = { child: nested };
  host.send(Object.assign(validCheckpoint(ids), { nested }));
  assert.equal((await host.next('error')).code, 'invalid-shape');

  const usable = validCheckpoint(ids);
  host.send(usable);
  assert.deepEqual(await guest.next('checkpoint'), usable,
    'rejected poison must not kill an otherwise usable connection');
});

test('failed promotion tries the next guest before falling back to a restarted round', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `retry-${++nextId}`,
    roomRandom: () => 0,
    promotionTimeoutMs: 40
  });
  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  const first = websocketClient(`ws://127.0.0.1:${port}/ws`);
  const second = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([host.opened, first.opened, second.opened]);
  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host' });
  const room = await host.next('room'); await host.next('members');
  first.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'First' });
  await first.next('room'); await first.next('members'); await host.next('members');
  second.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Second' });
  await second.next('room'); await second.next('members');
  await first.next('members'); await host.next('members');
  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  await Promise.all([host.next('start'), first.next('start'), second.next('start')]);
  const ids = ['retry-1', 'retry-2', 'retry-3'];
  host.send({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1, round: 1,
    tick: 30, time: 0.5, eventSeq: 0, manifestVersion: 1,
    actors: ids.map(netId => ({ netId })), over: false, winner: null
  });
  await Promise.all([first.next('snapshot'), second.next('snapshot')]);
  host.send(validCheckpoint(ids, { tick: 30, time: 0.5 }));
  await Promise.all([first.next('checkpoint'), second.next('checkpoint')]);
  host.ws.close();

  const firstAttempt = await first.next('host-changed');
  await second.next(message =>
    message.t === 'host-changed' && message.authorityEpoch === 2);
  assert.equal(firstAttempt.host, 'retry-2');
  assert.equal(firstAttempt.seamless, true);

  const [retryForFirst, retryForSecond] = await Promise.all([
    first.next(message => message.t === 'host-changed' && message.authorityEpoch === 3),
    second.next(message => message.t === 'host-changed' && message.authorityEpoch === 3)
  ]);
  assert.equal(retryForFirst.host, 'retry-3');
  assert.equal(retryForSecond.seamless, true);
  assert.equal(retryForSecond.round, 1);

  const [fallbackFirst, fallbackSecond] = await Promise.all([
    first.next(message => message.t === 'host-changed' && message.authorityEpoch === 4),
    second.next(message => message.t === 'host-changed' && message.authorityEpoch === 4)
  ]);
  assert.equal(fallbackFirst.seamless, undefined);
  assert.equal(fallbackFirst.round, 2,
    'exhausting healthy candidates must use the existing restart barrier');
  assert.deepEqual(fallbackSecond, fallbackFirst);
});

test('snapshot stall election is derived from observed cadence', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `stall-${++nextId}`,
    roomRandom: () => 0,
    snapshotStallCount: 3,
    promotionTimeoutMs: 500
  });
  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  const guest = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await Promise.all([host.opened, guest.opened]);
  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host' });
  const room = await host.next('room'); await host.next('members');
  guest.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Guest' });
  await guest.next('room'); await guest.next('members'); await host.next('members');
  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  await Promise.all([host.next('start'), guest.next('start')]);
  const ids = ['stall-1', 'stall-2'];
  host.send(validCheckpoint(ids, { tick: 1, time: 1 / 60 }));
  await guest.next('checkpoint');
  const pose = (tick, time) => ({
    t: 'snapshot', v: Protocol.VERSION, authorityEpoch: 1, round: 1,
    tick, time, eventSeq: 0, manifestVersion: 1,
    actors: ids.map(netId => ({ netId })), over: false, winner: null
  });
  host.send(pose(1, 1 / 60)); await guest.next('snapshot');
  await new Promise(resolve => setTimeout(resolve, 25));
  host.send(pose(2, 2 / 60)); await guest.next('snapshot');

  const change = await guest.next('host-changed');
  assert.equal(change.seamless, true);
  assert.equal(change.host, 'stall-2');
  assert.equal(change.round, 1);
});

test('hostile nesting and non-string fields are rejected without killing usable connections', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `safe-${++nextId}`,
    roomRandom: () => 0
  });

  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await host.opened;

  host.send({ t: 'create', v: Protocol.VERSION, name: { text: 'Host' } });
  assert.equal((await host.next('error')).code, 'invalid-name');

  let nested = { leaf: true };
  for (let i = 0; i < 12; i++) nested = { child: nested };
  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host', nested });
  assert.equal((await host.next('error')).code, 'invalid-shape');

  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host' });
  const room = await host.next('room');
  await host.next('members');

  const guest = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await guest.opened;
  guest.send({ t: 'join', v: Protocol.VERSION, room: { code: room.room }, name: 'Guest' });
  assert.equal((await guest.next('error')).code, 'room-not-found');
  guest.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: ['Guest'] });
  assert.equal((await guest.next('error')).code, 'invalid-name');

  guest.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Guest' });
  await guest.next('room');
  await guest.next('members');
  await host.next('members');

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  await Promise.all([host.next('start'), guest.next('start')]);

  host.send({
    t: 'event',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    events: [{ id: 1, kind: 'shot', nested }]
  });
  assert.equal((await host.next('error')).code, 'invalid-shape');
  await expectNoMessage(guest, 'event');

  host.send({
    t: 'event',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    events: [{ id: 1, kind: 'shot' }]
  });
  assert.deepEqual(await guest.next('event'), {
    t: 'event',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    events: [{ id: 1, kind: 'shot' }]
  });

  host.send({
    t: 'lobby',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    winner: { id: 'safe-1' }
  });
  assert.deepEqual(await guest.next('lobby'), {
    t: 'lobby',
    v: Protocol.VERSION,
    authorityEpoch: 1,
    round: 1,
    winner: null
  });
});

test('the room handshake carries the round so a player who joins between rounds can start', async (t) => {
  let nextId = 0;
  const { port } = await startRelay(t, {
    idFactory: () => `peer-${++nextId}`,
    roomRandom: () => 0
  });

  const host = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await host.opened;
  host.send({ t: 'create', v: Protocol.VERSION, name: 'Host' });
  const created = await host.next('room');
  assert.equal(created.round, 0, 'a brand new room starts before round 1');

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  assert.equal((await host.next('start')).round, 1);
  host.send({
    t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, winner: null
  });

  /* Joining is only possible between rounds, which is exactly the case that
     used to hand the newcomer a round baseline of 0 against a room on 1. */
  const late = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await late.opened;
  late.send({ t: 'join', v: Protocol.VERSION, room: 'AAAAAA', name: 'Late' });
  const joined = await late.next('room');
  assert.equal(joined.round, 1, 'the newcomer inherits the round already played');

  host.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  const started = await late.next('start');
  assert.equal(started.round, 2);
  assert.ok(started.round > joined.round,
    'the round the newcomer is told to start must be ahead of its handshake baseline');

  host.ws.terminate();
  late.ws.terminate();
});

test('the room browser lists rooms you can join and rooms you can only see', async (t) => {
  let nextId = 0;
  let nextCode = 0;
  const codes = ['AAAAAA', 'BBBBBB', 'CCCCCC', 'DDDDDD'];
  const { port } = await startRelay(t, {
    idFactory: () => `peer-${++nextId}`,
    roomRandom: () => {
      /* createRoomCode samples once per character, so hand back the index of
         the letter this room should repeat and advance after a full code. */
      const letter = codes[Math.floor(nextCode / Protocol.ROOM_CODE_LENGTH)] || 'ZZZZZZ';
      nextCode++;
      return Protocol.ROOM_CODE_ALPHABET.indexOf(letter[0]) / Protocol.ROOM_CODE_ALPHABET.length;
    }
  });

  const fetchRooms = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/rooms`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    return (await response.json()).rooms;
  };

  assert.deepEqual(await fetchRooms(), [], 'no rooms exist yet');

  const open = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await open.opened;
  open.send({ t: 'create', v: Protocol.VERSION, name: ' Open Host ' });
  await open.next('room');

  assert.deepEqual(await fetchRooms(), [
    { code: 'AAAAAA', host: 'Open Host', players: 1, max: Protocol.MAX_PLAYERS, inProgress: false }
  ]);

  const secret = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await secret.opened;
  secret.send({ t: 'create', v: Protocol.VERSION, name: 'Secret Host', listed: false });
  await secret.next('room');
  assert.deepEqual((await fetchRooms()).map((room) => room.code), ['AAAAAA'],
    'a room that opted out of listing stays hidden');

  const guest = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await guest.opened;
  guest.send({ t: 'join', v: Protocol.VERSION, room: 'AAAAAA', name: 'Guest' });
  await guest.next('room');
  assert.equal((await fetchRooms())[0].players, 2, 'the seat count tracks the roster');

  open.send({ t: 'start', v: Protocol.VERSION, authorityEpoch: 1 });
  await open.next('start');
  assert.deepEqual(await fetchRooms(), [
    { code: 'AAAAAA', host: 'Open Host', players: 2, max: Protocol.MAX_PLAYERS, inProgress: true }
  ], 'a room in a live match is still advertised, flagged as unjoinable');

  open.send({
    t: 'lobby', v: Protocol.VERSION, authorityEpoch: 1,
    round: 1, winner: null
  });
  await guest.next('lobby');
  assert.deepEqual((await fetchRooms()).map((room) => room.inProgress), [false],
    'it becomes joinable again once the round ends');

  open.ws.terminate();
  const promoted = await guest.next('host-changed');
  assert.equal(promoted.host, 'peer-3');
  assert.equal(promoted.authorityEpoch, 2);
  assert.deepEqual(await fetchRooms(), [
    { code: 'AAAAAA', host: 'Guest', players: 1, max: Protocol.MAX_PLAYERS, inProgress: false }
  ], 'closing the host promotes a survivor and preserves the listed room');

  secret.ws.terminate();
  guest.ws.terminate();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(await fetchRooms(), [], 'the room closes once no survivors remain');
});

test('room summaries from an untrusted server are cleaned entry by entry', () => {
  const cleaned = Protocol.cleanRoomSummaries([
    { code: 'aaa-aaa', host: ' Nova ', players: 2, max: 4 },
    { code: 'AAAAAA', host: 'Duplicate', players: 1, max: 4 },
    { code: 'BBBBBB', host: '<script>', players: 1, max: 4 },
    { code: 'SHORT', host: 'Nope', players: 1, max: 4 },
    { code: 'CCCCCC', host: 'Full', players: 4, max: 4 },
    { code: 'DDDDDD', host: 'Bad count', players: 1.5, max: 4 },
    { code: 'EEEEEE', host: 'Oversized', players: 1, max: 99 },
    { code: 'FFFFFF', host: 'Running full', players: 4, max: 4, inProgress: true },
    { code: 'GGGGGG', host: 'Overfull', players: 5, max: 4, inProgress: true },
    { code: 'HHHHHH', host: 'Truthy', players: 1, max: 4, inProgress: 'yes' },
    null,
    'nope'
  ]);

  assert.deepEqual(cleaned, [
    { code: 'AAAAAA', host: 'Nova', players: 2, max: 4, inProgress: false },
    { code: 'BBBBBB', host: 'script', players: 1, max: 4, inProgress: false },
    { code: 'EEEEEE', host: 'Oversized', players: 1, max: Protocol.MAX_PLAYERS, inProgress: false },
    { code: 'FFFFFF', host: 'Running full', players: 4, max: 4, inProgress: true },
    { code: 'HHHHHH', host: 'Truthy', players: 1, max: 4, inProgress: false }
  ], 'only a running room may be full, and only a real boolean says it is running');

  assert.deepEqual(Protocol.cleanRoomSummaries(null), []);
  assert.equal(
    Protocol.cleanRoomSummaries(
      Array.from({ length: 80 }, (_, i) => ({
        code: 'R' + String(i).padStart(5, '0'), host: 'H', players: 1, max: 4
      })),
      5
    ).length,
    5
  );
});

test('an origin allowlist gates the socket and the room browser when configured', async (t) => {
  const { port } = await startRelay(t, {
    allowedOrigins: ['https://nuketown.luckeysystems.com/', ' HTTPS://Relay.LuckeySystems.com ', '']
  });

  const dial = (origin) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    ws.on('open', () => { ws.terminate(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
  });

  assert.equal(await dial('https://nuketown.luckeysystems.com'), 'open');
  assert.equal(await dial('https://relay.luckeysystems.com'), 'open',
    'matching is case-insensitive and ignores a trailing slash');
  assert.equal(await dial('https://evil.example.com'), 'refused');
  assert.equal(await dial(null), 'refused', 'a socket with no Origin is refused too');

  const allowed = await fetch(`http://127.0.0.1:${port}/rooms`, {
    headers: { origin: 'https://nuketown.luckeysystems.com' }
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'),
    'https://nuketown.luckeysystems.com');
  assert.equal(allowed.headers.get('vary'), 'Origin');

  const blocked = await fetch(`http://127.0.0.1:${port}/rooms`, {
    headers: { origin: 'https://evil.example.com' }
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null,
    'the body is public but the browser will not hand it to a foreign page');
});

test('an unconfigured allowlist stays wide open so local play keeps working', async (t) => {
  const { port } = await startRelay(t);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://anywhere.example' });
  await once(ws, 'open');
  ws.terminate();

  const response = await fetch(`http://127.0.0.1:${port}/rooms`, {
    headers: { origin: 'https://anywhere.example' }
  });
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});
