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

function validInput(overrides) {
  return Object.assign({
    t: 'input',
    v: Protocol.VERSION,
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
    weapon: 'smg',
    weaponSeq: 0,
    reloadSeq: 0
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
  assert.equal(Protocol.VERSION, 2);
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
    v: 2,
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
    [validInput({ round: 0 }), 'round'],
    [validInput({ round: 1.5 }), 'round'],
    [validInput({ seq: -1 }), 'seq'],
    [validInput({ seq: 1.5 }), 'seq'],
    [validInput({ seq: 4 }), 'increase', 4],
    [validInput({ fwd: Infinity }), 'finite'],
    [validInput({ strafe: '1' }), 'finite'],
    [validInput({ yaw: NaN }), 'finite'],
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
    round: 0,
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

  guest.send({ t: 'snapshot', v: Protocol.VERSION, round: 1, tick: 1, actors: [] });
  assert.equal((await guest.next('error')).code, 'host-only');

  host.send({ t: 'start', v: Protocol.VERSION, seed: 42 });
  const expectedStart = {
    t: 'start',
    v: Protocol.VERSION,
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

  host.send({ t: 'start', v: Protocol.VERSION });
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
  assert.equal(relayedInput.weaponSeq, 0);
  assert.equal(relayedInput.reloadSeq, 1);

  guest.send(validInput({ seq: 4 }));
  assert.equal((await guest.next('error')).code, 'invalid-input');

  guest.send(validInput({ round: 2, seq: 5 }));
  await expectNoMessage(host, 'input');
  guest.send(validInput({ round: 1, seq: 5 }));
  assert.equal((await host.next('input')).seq, 5);

  host.send({ t: 'snapshot', v: Protocol.VERSION, round: 0, tick: 6, actors: [] });
  await expectNoMessage(guest, 'snapshot');
  host.send({ t: 'snapshot', v: Protocol.VERSION, round: 1, tick: 7, actors: [] });
  assert.deepEqual(await guest.next('snapshot'), {
    t: 'snapshot',
    v: Protocol.VERSION,
    round: 1,
    tick: 7,
    actors: []
  });

  host.send({ t: 'event', v: Protocol.VERSION, round: 0, events: [{ id: 1, kind: 'shot' }] });
  await expectNoMessage(guest, 'event');
  host.send({ t: 'event', v: Protocol.VERSION, round: 1, events: [{ id: 1, kind: 'shot' }] });
  assert.deepEqual(await guest.next('event'), {
    t: 'event',
    v: Protocol.VERSION,
    round: 1,
    events: [{ id: 1, kind: 'shot' }]
  });

  host.send({ t: 'lobby', v: Protocol.VERSION, round: 0, winner: 'peer-1' });
  await expectNoMessage(guest, 'lobby');
  host.send({ t: 'snapshot', v: Protocol.VERSION, round: 1, tick: 8, actors: [] });
  assert.equal((await guest.next('snapshot')).tick, 8);

  host.send({ t: 'lobby', v: Protocol.VERSION, round: 1, winner: 'peer-1' });
  assert.deepEqual(await guest.next('lobby'), {
    t: 'lobby',
    v: Protocol.VERSION,
    round: 1,
    winner: 'peer-1'
  });

  host.send({ t: 'lobby', v: Protocol.VERSION, round: 1, winner: 'peer-1' });
  await expectNoMessage(guest, 'lobby');
  host.send({ t: 'snapshot', v: Protocol.VERSION, round: 1, tick: 9, actors: [] });
  await expectNoMessage(guest, 'snapshot');
  guest.send(validInput({ round: 1, seq: 6 }));
  await expectNoMessage(host, 'input');

  host.send({ t: 'start', v: Protocol.VERSION });
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

  host.send({ t: 'snapshot', v: Protocol.VERSION, round: 1, tick: 10, actors: [] });
  await expectNoMessage(guest, 'snapshot');
  host.send({ t: 'snapshot', v: Protocol.VERSION, round: 2, tick: 1, actors: [] });
  assert.equal((await guest.next('snapshot')).round, 2);

  host.send({ t: 'event', v: Protocol.VERSION, round: 1, events: [{ id: 2, kind: 'shot' }] });
  await expectNoMessage(guest, 'event');
  host.send({ t: 'event', v: Protocol.VERSION, round: 2, events: [{ id: 1, kind: 'respawn' }] });
  assert.equal((await guest.next('event')).round, 2);

  host.ws.close();
  assert.equal((await guest.next('room-closed')).v, Protocol.VERSION);
});

test('started rooms reject late joins, round-scoped lobby reopens them, and capacity is four', async (t) => {
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

  host.send({ t: 'start', v: Protocol.VERSION });
  const [hostStart, firstStart] = await Promise.all([
    host.next('start'),
    first.next('start')
  ]);
  assert.equal(hostStart.round, 1);
  assert.equal(firstStart.round, 1);

  const late = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await late.opened;
  late.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Late' });
  assert.equal((await late.next('error')).code, 'match-started');

  host.send({ t: 'lobby', v: Protocol.VERSION, round: 1 });
  assert.equal((await first.next('lobby')).round, 1);
  late.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Two' });
  await late.next('room');
  await late.next('members');
  await host.next('members');

  const third = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await third.opened;
  third.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Three' });
  await third.next('room');
  await third.next('members');
  await host.next('members');

  const fifth = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await fifth.opened;
  fifth.send({ t: 'join', v: Protocol.VERSION, room: room.room, name: 'Four' });
  assert.equal((await fifth.next('error')).code, 'room-full');

  first.ws.close();
  const roster = await host.next('members');
  assert.equal(roster.members.length, 3);
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

  host.send({ t: 'start', v: Protocol.VERSION });
  await Promise.all([host.next('start'), guest.next('start')]);

  host.send({
    t: 'event',
    v: Protocol.VERSION,
    round: 1,
    events: [{ id: 1, kind: 'shot', nested }]
  });
  assert.equal((await host.next('error')).code, 'invalid-shape');
  await expectNoMessage(guest, 'event');

  host.send({
    t: 'event',
    v: Protocol.VERSION,
    round: 1,
    events: [{ id: 1, kind: 'shot' }]
  });
  assert.deepEqual(await guest.next('event'), {
    t: 'event',
    v: Protocol.VERSION,
    round: 1,
    events: [{ id: 1, kind: 'shot' }]
  });

  host.send({ t: 'lobby', v: Protocol.VERSION, round: 1, winner: { id: 'safe-1' } });
  assert.deepEqual(await guest.next('lobby'), {
    t: 'lobby',
    v: Protocol.VERSION,
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

  host.send({ t: 'start', v: Protocol.VERSION });
  assert.equal((await host.next('start')).round, 1);
  host.send({ t: 'lobby', v: Protocol.VERSION, round: 1, winner: null });

  /* Joining is only possible between rounds, which is exactly the case that
     used to hand the newcomer a round baseline of 0 against a room on 1. */
  const late = websocketClient(`ws://127.0.0.1:${port}/ws`);
  await late.opened;
  late.send({ t: 'join', v: Protocol.VERSION, room: 'AAAAAA', name: 'Late' });
  const joined = await late.next('room');
  assert.equal(joined.round, 1, 'the newcomer inherits the round already played');

  host.send({ t: 'start', v: Protocol.VERSION });
  const started = await late.next('start');
  assert.equal(started.round, 2);
  assert.ok(started.round > joined.round,
    'the round the newcomer is told to start must be ahead of its handshake baseline');

  host.ws.terminate();
  late.ws.terminate();
});

test('the room browser lists only rooms you could actually join', async (t) => {
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
    { code: 'AAAAAA', host: 'Open Host', players: 1, max: Protocol.MAX_PLAYERS }
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

  open.send({ t: 'start', v: Protocol.VERSION });
  await open.next('start');
  assert.deepEqual(await fetchRooms(), [], 'a room in a live match is not joinable');

  open.send({ t: 'lobby', v: Protocol.VERSION, round: 1, winner: null });
  await guest.next('lobby');
  assert.deepEqual((await fetchRooms()).map((room) => room.code), ['AAAAAA'],
    'it comes back once the round ends');

  open.ws.terminate();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(await fetchRooms(), [], 'closing the host closes the room');

  secret.ws.terminate();
  guest.ws.terminate();
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
    null,
    'nope'
  ]);

  assert.deepEqual(cleaned, [
    { code: 'AAAAAA', host: 'Nova', players: 2, max: 4 },
    { code: 'BBBBBB', host: 'script', players: 1, max: 4 },
    { code: 'EEEEEE', host: 'Oversized', players: 1, max: Protocol.MAX_PLAYERS }
  ]);

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
