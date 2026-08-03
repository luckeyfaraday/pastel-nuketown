'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Protocol = require('./net-protocol.js');

function requestRelay(relay, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = {
      url: pathname,
      method: options.method || 'GET',
      headers: Object.fromEntries(
        Object.entries(options.headers || {})
          .map(([name, value]) => [name.toLowerCase(), value])
      )
    };
    let status = 0;
    let headers = {};
    const chunks = [];
    const response = {
      headersSent: false,
      writeHead(nextStatus, nextHeaders = {}) {
        status = nextStatus;
        headers = Object.fromEntries(
          Object.entries(nextHeaders)
            .map(([name, value]) => [name.toLowerCase(), String(value)])
        );
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          status,
          headers,
          body,
          json: () => JSON.parse(body)
        });
      }
    };
    try {
      relay.server.emit('request', request, response);
    } catch (error) {
      reject(error);
    }
  });
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.terminate();
  }

  terminate() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  ping() {}
}

test('account routing leaves relay HTTP, upgrades, and persisted match counts intact', async (t) => {
  const [{ createAccountStore }, { createRelayServer }] = await Promise.all([
    import('./account-store.mjs'),
    import('./server.mjs')
  ]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuketown-account-relay-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const indexPath = path.join(directory, 'index.html');
  const statsPath = path.join(directory, 'stats.json');
  fs.writeFileSync(indexPath, '<!doctype html><title>relay integration</title>');

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
  const routeResults = [];
  const routedAccounts = {
    async handleHttp(request, response, requestUrl) {
      const handled = await accounts.handleHttp(request, response, requestUrl);
      routeResults.push({ pathname: requestUrl.pathname, handled });
      return handled;
    },
    close: () => accounts.close()
  };
  const relay = createRelayServer({
    accountStore: routedAccounts,
    allowedOrigins: ['https://game.example'],
    heartbeatMs: 0,
    idleKickMs: 0,
    indexPath,
    statsPath,
    statsFlushMs: 60_000,
    roomRandom: () => 0,
    idFactory: () => 'peer-0001'
  });

  const roomsBefore = await requestRelay(relay, '/rooms');
  assert.equal(roomsBefore.status, 200);
  assert.equal(roomsBefore.json().matches, 0);
  const index = await requestRelay(relay, '/');
  assert.equal(index.status, 200);
  assert.match(index.body, /relay integration/);
  assert.deepEqual(routeResults, [
    { pathname: '/rooms', handled: false },
    { pathname: '/', handled: false }
  ]);

  const publicCatalog = await requestRelay(relay, '/shop/catalog');
  assert.equal(publicCatalog.status, 200);
  assert.equal(publicCatalog.json().items.length, 6);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routeResults.at(-1).handled, true);

  const callsBeforeUpgrade = routeResults.length;
  let upgradeReachedWebSocketServer = false;
  const originalHandleUpgrade = relay.wss.handleUpgrade;
  relay.wss.handleUpgrade = (request, socket, head) => {
    upgradeReachedWebSocketServer = true;
    assert.equal(request.url, '/ws');
    assert.equal(head.length, 0);
  };
  relay.server.emit('upgrade', {
    url: '/ws',
    headers: { origin: 'https://game.example' }
  }, {}, Buffer.alloc(0));
  relay.wss.handleUpgrade = originalHandleUpgrade;
  assert.equal(upgradeReachedWebSocketServer, true);
  assert.equal(
    routeResults.length,
    callsBeforeUpgrade,
    'the HTTP account router is never consulted for WebSocket upgrades'
  );

  const socket = new FakeWebSocket();
  relay.wss.emit('connection', socket, {});
  socket.emit('message', Buffer.from(JSON.stringify({
    t: 'create',
    v: Protocol.VERSION,
    name: 'Host'
  })));
  const roomsAfter = await requestRelay(relay, '/rooms');
  assert.equal(roomsAfter.json().matches, 1);

  await relay.close();
  assert.deepEqual(JSON.parse(fs.readFileSync(statsPath, 'utf8')), { matches: 1 });
});

test('boot configuration is strict by default and credential-free only by opt-out', async () => {
  const [{ createAccountStore }, { accountStoreForEnvironment, createRelayServer }] =
    await Promise.all([
      import('./account-store.mjs'),
      import('./server.mjs')
    ]);

  assert.throws(
    () => accountStoreForEnvironment({}),
    (error) => /Missing account\/store configuration/.test(error.message) &&
      /GOOGLE_CLIENT_ID/.test(error.message) &&
      /STRIPE_WEBHOOK_SECRET/.test(error.message)
  );
  assert.equal(accountStoreForEnvironment({ ACCOUNTS_ENABLED: '0' }), null);
  assert.throws(
    () => createAccountStore({
      dbPath: ':memory:',
      allowedOrigins: [],
      googleClientId: 'google-client.test',
      googleClientSecret: 'google-secret',
      googleRedirectUri: 'https://relay.example/auth/google/callback',
      appOrigin: 'https://game.example',
      stripeSecretKey: 'sk_test_fake',
      stripeWebhookSecret: 'whsec_test'
    }),
    /at least one ALLOWED_ORIGINS/
  );

  const relay = createRelayServer({ heartbeatMs: 0, idleKickMs: 0 });
  const rooms = await requestRelay(relay, '/rooms');
  assert.equal(rooms.status, 200);
  await relay.close();
});
