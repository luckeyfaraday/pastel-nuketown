'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const WebSocket = require('ws');

const Protocol = require('./net-protocol.js');
const ADMIN_TOKEN = 'test-admin-token-that-is-longer-than-thirty-two-characters';

function client(url) {
  const ws = new WebSocket(url);
  const queued = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString('utf8'));
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index === -1) queued.push(message);
    else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  return {
    ws,
    opened: once(ws, 'open'),
    send(message) { ws.send(JSON.stringify(message)); },
    next(predicate, timeoutMs = 1500) {
      const match = typeof predicate === 'string'
        ? (message) => message.t === predicate
        : predicate;
      const index = queued.findIndex(match);
      if (index !== -1) return Promise.resolve(queued.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate: match,
          resolve,
          timer: setTimeout(() => {
            const position = waiters.indexOf(waiter);
            if (position !== -1) waiters.splice(position, 1);
            reject(new Error('Timed out waiting for WebSocket message'));
          }, timeoutMs)
        };
        waiters.push(waiter);
      });
    }
  };
}

async function startRelay(options = {}) {
  const { createRelayServer } = await import('./server.mjs');
  let nextId = 1;
  const relay = createRelayServer({
    adminToken: ADMIN_TOKEN,
    heartbeatMs: 0,
    idleKickMs: 0,
    autoStartMs: 0,
    idFactory: () => `peer-${String(nextId++).padStart(4, '0')}`,
    ...options
  });
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.listen(0, '127.0.0.1', resolve);
  });
  return relay;
}

async function admin(relay, route, body, token = ADMIN_TOKEN) {
  const response = await fetch(
    `http://127.0.0.1:${relay.address().port}/admin/${route}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }
  );
  return { response, body: await response.json() };
}

async function enter(clientSocket, message) {
  await clientSocket.opened;
  clientSocket.send({ v: Protocol.VERSION, ...message });
  return clientSocket.next('room');
}

test('the operator can list and kick one live player without blocking their return', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.address().port}/ws`;
  const host = client(url);
  const hostRoom = await enter(host, { t: 'create', name: 'Host', listed: false });
  const target = client(url);
  const targetRoom = await enter(target, { t: 'join', name: 'ostrch', room: hostRoom.room });

  const unauthorized = await admin(relay, 'players', undefined, 'x'.repeat(40));
  assert.equal(unauthorized.response.status, 401);
  const listed = await admin(relay, 'players');
  assert.equal(listed.response.status, 200);
  assert.deepEqual(listed.body.players.map((player) => player.name), ['Host', 'ostrch']);
  assert.equal(listed.body.players.find((player) => player.name === 'ostrch').id, targetRoom.id);
  assert.ok(listed.body.players.every((player) => /^[a-f0-9]{12}$/.test(player.network)));

  const kicked = await admin(relay, 'kick', {
    selector: 'OSTRCH',
    reason: 'operator test'
  });
  assert.equal(kicked.response.status, 200);
  assert.equal(kicked.body.player.id, targetRoom.id);
  assert.equal((await target.next('error')).code, 'kicked');
  await once(target.ws, 'close');
  assert.equal(host.ws.readyState, WebSocket.OPEN);

  const returned = client(url);
  const returnedRoom = await enter(returned, {
    t: 'join',
    name: 'ostrch',
    room: hostRoom.room
  });
  assert.equal(returnedRoom.room, hostRoom.room);
  returned.ws.close();
  host.ws.close();
});

test('a ban survives restart, rejects the network, and can be removed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuketown-bans-'));
  const banPath = path.join(directory, 'bans.json');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));

  let relay = await startRelay({ banPath, banIdFactory: () => 'ban-00000001' });
  const firstUrl = `ws://127.0.0.1:${relay.address().port}/ws`;
  const target = client(firstUrl);
  await enter(target, { t: 'create', name: 'ostrch', listed: false });
  const banned = await admin(relay, 'ban', { selector: 'ostrch', reason: 'cheating' });
  assert.equal(banned.response.status, 200);
  assert.equal(banned.body.ban.id, 'ban-00000001');
  assert.equal(banned.body.ban.reason, 'cheating');
  assert.equal((await target.next('error')).code, 'banned');
  await once(target.ws, 'close');

  const stored = fs.readFileSync(banPath, 'utf8');
  assert.doesNotMatch(stored, /127\.0\.0\.1|::1/);
  assert.match(stored, /"networkHashes": \[\s+"[a-f0-9]{64}"/);
  await relay.close();

  relay = await startRelay({ banPath });
  t.after(() => relay.close());
  const secondUrl = `ws://127.0.0.1:${relay.address().port}/ws`;
  const refused = client(secondUrl);
  await refused.opened;
  assert.equal((await refused.next('error')).code, 'banned');
  await once(refused.ws, 'close');

  const bans = await admin(relay, 'bans');
  assert.equal(bans.body.bans.length, 1);
  assert.equal(bans.body.bans[0].name, 'ostrch');
  const unbanned = await admin(relay, 'unban', { selector: 'ban-0000' });
  assert.equal(unbanned.response.status, 200);
  assert.equal(unbanned.body.ban.id, 'ban-00000001');

  const allowed = client(secondUrl);
  const room = await enter(allowed, { t: 'create', name: 'renamed', listed: false });
  assert.equal(room.role, 'host');
  allowed.ws.close();
});

test('duplicate display names require a peer id and disabled admin routes stay hidden', async (t) => {
  const relay = await startRelay();
  t.after(() => relay.close());
  const url = `ws://127.0.0.1:${relay.address().port}/ws`;
  const host = client(url);
  const room = await enter(host, { t: 'create', name: 'same', listed: false });
  const guest = client(url);
  await enter(guest, { t: 'join', name: 'same', room: room.room });

  const ambiguous = await admin(relay, 'kick', { selector: 'same' });
  assert.equal(ambiguous.response.status, 409);
  assert.equal(ambiguous.body.error, 'ambiguous_player');
  assert.equal(ambiguous.body.candidates.length, 2);
  host.ws.close();
  guest.ws.close();

  const hiddenRelay = await startRelay({ adminToken: '' });
  t.after(() => hiddenRelay.close());
  const hidden = await fetch(
    `http://127.0.0.1:${hiddenRelay.address().port}/admin/players`,
    { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }
  );
  assert.equal(hidden.status, 404);
});

test('account and forwarded-network identities are hashed and enforced independently', async (t) => {
  const { clientAddressFromRequest, createBanRegistry } = await import('./moderation.mjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuketown-ban-identities-'));
  const banPath = path.join(directory, 'bans.json');
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const registry = createBanRegistry({
    path: banPath,
    idFactory: () => 'ban-account1',
    now: () => Date.parse('2026-08-05T12:00:00.000Z')
  });
  registry.add({
    name: 'signed in',
    userId: 'private-account-id',
    address: '203.0.113.9'
  }, 'test');

  assert.ok(registry.match({ userId: 'private-account-id', address: '198.51.100.2' }));
  assert.ok(registry.match({ userId: 'different-account', address: '203.0.113.9' }));
  assert.equal(registry.match({ userId: 'different-account', address: '198.51.100.2' }), null);
  const stored = fs.readFileSync(banPath, 'utf8');
  assert.doesNotMatch(stored, /private-account-id|203\.0\.113\.9/);
  assert.match(stored, /"accountHashes": \[\s+"[a-f0-9]{64}"/);

  assert.equal(clientAddressFromRequest({
    socket: { remoteAddress: '::ffff:127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.9, 127.0.0.1' }
  }), '203.0.113.9');
  assert.equal(clientAddressFromRequest({
    socket: { remoteAddress: '198.51.100.2' },
    headers: { 'x-forwarded-for': '203.0.113.9' }
  }), '198.51.100.2');
});
