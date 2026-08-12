'use strict';

/* =====================================================================
   The sign-in contract.

   src/82-store.js shipped once with its callback parameter named wrong.
   Nothing caught it: the file parsed, the page built, the title screen
   looked exactly right, and the only symptom was that a real Google round
   trip left the player signed out with their bearer token sitting in the
   address bar. Syntax checks cannot see that. These can.

   The harness below is deliberately not a DOM. src/82-store.js is loaded
   into a vm context whose document hands back null for every element, so
   every render function no-ops through its own guard and what is left
   running is the part that decides things: where a token came from, where
   it is allowed to be sent, and what the player owns. Everything the tests
   need to watch — fetch, localStorage, the address bar — is a plain object
   they can read afterwards.
   ===================================================================== */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const NETP = require('./net-protocol.js');
const SOURCE = fs.readFileSync(path.join(__dirname, 'src', '82-store.js'), 'utf8');

const PAGE = 'https://game.example';
const RELAY = 'https://relay.luckeysystems.com';

function makeStorage() {
  const map = new Map();
  return {
    map: map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

/* A location that behaves like the real one under history.replaceState: the
   whole point of the first test is that the fragment is gone afterwards. */
function makeLocation(href) {
  const loc = {};
  loc.set = value => {
    const url = new URL(value);
    loc.href = url.href;
    loc.protocol = url.protocol;
    loc.hostname = url.hostname;
    loc.host = url.host;
    loc.origin = url.origin;
    loc.pathname = url.pathname;
    loc.search = url.search;
    loc.hash = url.hash;
  };
  loc.set(href);
  loc.assigned = [];
  loc.assign = target => { loc.assigned.push(target); };
  return loc;
}

/* The window that pressed SIGN IN, as seen from inside the popup: it only has
   to take a message and say whether it is still there. */
function makeOpener() {
  const posted = [];
  return { posted: posted, closed: false, postMessage(data, origin) { posted.push({ data: data, origin: origin }); } };
}

function makeStore(options) {
  const opts = options || {};
  const location = makeLocation(opts.href || PAGE + '/');
  const calls = [];
  const opened = [];

  const ctx = {
    console: console,
    URL: URL,
    URLSearchParams: URLSearchParams,
    AbortController: AbortController,
    Promise: Promise,
    Date: Date,
    Number: Number,
    Math: Math,
    JSON: JSON,
    Set: Set,
    Map: Map,
    Array: Array,
    Object: Object,
    Error: Error,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    NETP: NETP,
    crypto: require('node:crypto').webcrypto,
    NET_SERVER: 'relay.luckeysystems.com',
    location: location,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    /* Set when a load carrying a callback decides it is the sign-in popup and
       hands the token on; the real one closes the window. */
    opener: opts.opener || null,
    closedSelf: false,
    close() { ctx.closedSelf = true; },
    calls: calls,
    opened: opened,
    document: {
      /* No DOM at all, unless a test asks for a specific element. Every render
         path in the store checks its element and returns; what is left running
         is the logic these tests are about. */
      getElementById(id) { return (opts.elements && opts.elements[id]) || null; },
      addEventListener() {},
      activeElement: null,
      visibilityState: 'visible'
    },
    addEventListener(type, fn) { (ctx.listeners[type] = ctx.listeners[type] || []).push(fn); },
    listeners: {},
    history: {
      replaceState(state, title, url) { location.set(new URL(url, location.href).href); }
    }
  };
  ctx.window = ctx;
  ctx.QS = new URLSearchParams(location.search);
  ctx.fetch = (url, init) => {
    calls.push({ url: url, init: init, headers: Object.assign({}, init && init.headers) });
    const reply = (opts.reply || (() => ({ status: 404, body: null })))(url, init, calls.length);
    return Promise.resolve(reply).then(r => {
      if (r && r.reject) return Promise.reject(new Error('network'));
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: () => (typeof r.json === 'function' ? r.json(init) : Promise.resolve(r.body))
      };
    });
  };
  ctx.open = (url, name, features) => {
    opened.push({ url: url, name: name, features: features });
    if (opts.popupBlocked) return null;
    /* Reports itself shut the first time the store looks, which is both what
       a player pressing X does and what stops the watcher polling forever
       while the test runner waits for the event loop to empty. */
    let looks = 0;
    const win = { get closed() { return ++looks > 1; }, focus() {}, close() { win.closedByStore = true; } };
    win.closedByStore = false;
    opened[opened.length - 1].win = win;
    return win;
  };

  /* A sign-in marker already in place is what makes a callback *solicited*:
     the real one is written by storeBeginSignIn and copied into the popup as
     the browser creates it. */
  if (opts.signIn) ctx.sessionStorage.setItem('pastel-nuketown-signin', JSON.stringify(opts.signIn));

  /* Everything the page has that this harness does not: THREE, the two
     model builders, the frame clock. Only the display-case tests ask for
     any of it, and the point of the rest of the file is that the store
     works without it. */
  if (opts.globals) Object.assign(ctx, opts.globals);

  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx, { filename: 'src/82-store.js' });

  /* A top-level `const` in a classic script lands in the global lexical
     scope rather than on the global object — the same reason 82-store.js has
     to say `window.EQUIPPED = EQUIPPED` for later scripts to see it. ACCOUNT
     and STORE_URL_AUTH are read through the context instead. Values come back
     through JSON so they compare as this realm's plain objects. */
  ctx.__get = expr => vm.runInContext('(' + expr + ')', ctx);
  ctx.__json = expr => {
    const value = ctx.__get(expr);
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  };
  return ctx;
}

/* The fetches that carried an Authorization header, and where they went. */
function bearerCalls(ctx) {
  return ctx.calls.filter(c => c.headers && c.headers['Authorization']);
}

function settle() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/* ---------------------------------------------------------------------
   The callback
   --------------------------------------------------------------------- */

test('the exact callback fragment reaches the opener and leaves no token in the URL', async () => {
  const expires = Date.now() + 3600000;
  const opener = makeOpener();
  const ctx = makeStore({
    href: PAGE + '/#auth_token=SECRET-TOKEN&auth_expires_at=' + expires,
    opener: opener,
    signIn: { nonce: 'NONCE-1', at: Date.now() }
  });

  /* This load is the popup: it hands the token to the window that asked for
     it, tagged with that attempt's nonce, and closes itself. */
  assert.equal(opener.posted.length, 1);
  assert.equal(opener.posted[0].origin, PAGE);
  assert.deepEqual(JSON.parse(JSON.stringify(opener.posted[0].data)), {
    type: 'pastel-nuketown-auth', token: 'SECRET-TOKEN', expiresAt: expires, nonce: 'NONCE-1'
  });
  assert.equal(ctx.closedSelf, true);
  /* And it never signs *itself* in — the opener is the window the player is
     looking at. */
  ctx.initStore();
  await settle();
  assert.equal(ctx.__get('ACCOUNT.token'), null);
  assert.equal(bearerCalls(ctx).length, 0);

  /* The whole reason this is a test: COPY INVITE builds its link out of
     location.href, so a token still in the fragment is a token in somebody
     else's chat window. */
  assert.equal(ctx.location.hash, '');
  assert.ok(!ctx.location.href.includes('SECRET-TOKEN'), ctx.location.href);
});

test('an unsolicited callback token is refused outright and still scrubbed', async () => {
  const expires = Date.now() + 3600000;
  const href = PAGE + '/#auth_token=ATTACKER-TOKEN&auth_expires_at=' + expires;
  const reply = url => url === RELAY + '/auth/me'
    ? { status: 200, body: { userId: 'evil', email: 'a@e.com', displayName: 'Attacker', entitlements: ['char-midnight'] } }
    : { status: 200, body: [] };

  /* The attack this closes: a link somebody sends you. Opened in an ordinary
     tab it used to sign the reader into the sender's account, where every skin
     they bought afterwards was bought for the sender. There is no opener and
     no marker, so there was no sign-in to come back from. */
  const cold = makeStore({ href: href, reply: reply });
  cold.initStore();
  await settle();
  assert.equal(cold.__get('ACCOUNT.token'), null);
  assert.equal(cold.__get('ACCOUNT.user'), null);
  assert.equal(cold.storeSignedIn(), false);
  assert.equal(bearerCalls(cold).length, 0);
  assert.equal(cold.localStorage.getItem('pastel-nuketown-token'), null);
  /* Refused is not the same as ignored: it comes off the URL either way. */
  assert.equal(cold.location.hash, '');
  assert.ok(!cold.location.href.includes('ATTACKER-TOKEN'), cold.location.href);

  /* Nor does a window that merely has an opener count — a marker is written
     only by pressing SIGN IN. */
  const opener = makeOpener();
  const framed = makeStore({ href: href, reply: reply, opener: opener });
  framed.initStore();
  await settle();
  assert.deepEqual(opener.posted, []);
  assert.equal(framed.__get('ACCOUNT.token'), null);
  assert.equal(framed.location.hash, '');

  /* And neither does a marker on its own, in a window nothing opened. */
  const orphan = makeStore({ href: href, reply: reply, signIn: { nonce: 'N', at: Date.now() } });
  orphan.initStore();
  await settle();
  assert.equal(orphan.__get('ACCOUNT.token'), null);
  assert.equal(orphan.location.hash, '');
});

test('a marker left over from an abandoned sign-in has gone stale by the next day', () => {
  const opener = makeOpener();
  const ctx = makeStore({
    href: PAGE + '/#auth_token=SECRET&auth_expires_at=0',
    opener: opener,
    signIn: { nonce: 'OLD', at: Date.now() - 3600000 }
  });
  assert.deepEqual(opener.posted, []);
  assert.equal(ctx.location.hash, '');
});

test('a malformed auth fragment is still erased from the URL', () => {
  const ctx = makeStore({ href: PAGE + '/#auth_token=has%20a%20space&auth_expires_at=nonsense' });
  assert.equal(ctx.__get('STORE_URL_AUTH'), null);
  assert.equal(ctx.location.hash, '');
  assert.ok(!ctx.location.href.includes('has'), ctx.location.href);
});

test('an unrelated fragment survives, and one keeping company with a token does not carry it', () => {
  const plain = makeStore({ href: PAGE + '/#room=ABCDE' });
  assert.equal(plain.location.hash, '#room=ABCDE');

  const mixed = makeStore({ href: PAGE + '/#room=ABCDE&auth_token=SECRET&auth_expires_at=0' });
  assert.equal(mixed.location.hash, '#room=ABCDE');
  assert.ok(!mixed.location.href.includes('SECRET'));
  assert.equal(mixed.__get('STORE_URL_AUTH.token'), 'SECRET');
});

test('a token in the query string is never accepted', async () => {
  const ctx = makeStore({ href: PAGE + '/?token=QUERY-TOKEN&auth_token=QUERY-TOKEN' });
  ctx.initStore();
  await settle();

  assert.equal(ctx.__get('ACCOUNT.token'), null);
  assert.equal(bearerCalls(ctx).length, 0);
});

test('an already-expired callback token is not treated as a live session', () => {
  const ctx = makeStore({
    href: PAGE + '/#auth_token=STALE&auth_expires_at=' + (Date.now() - 1000)
  });
  /* The token is still taken — only the relay can really say it is dead —
     but the expiry it came with is not carried forward as if it were good. */
  assert.equal(ctx.__get('STORE_URL_AUTH.token'), 'STALE');
  assert.equal(ctx.__get('STORE_URL_AUTH.expiresAt'), 0);
});

/* ---------------------------------------------------------------------
   The scrubber that runs before everything else

   The token has to leave the URL before the CDN copy of Three.js — or
   anything else with page privileges — gets a chance to read location.href,
   which is why that part lives in an inline script at the top of <head>
   rather than in 82-store.js. It is pulled straight out of the head source
   here so it is tested where it actually ships.
   --------------------------------------------------------------------- */

const HEAD = fs.readFileSync(path.join(__dirname, 'src', '00-head.html'), 'utf8');

function headScrubber() {
  const match = /<script>([\s\S]*?)<\/script>/.exec(HEAD);
  assert.ok(match, 'the head still opens with an inline script');
  assert.ok(match[1].includes('auth_token'), 'the first inline script in the head is the callback scrubber');
  /* Nothing from the bundle is in scope: if this needs a helper the store
     defines, it cannot possibly run before the store loads. */
  assert.ok(!/\bstore[A-Z]/.test(match[1]), 'the scrubber leans on nothing the bundle defines');
  return match[1];
}

function runScrubber(href, opts) {
  opts = opts || {};
  const location = makeLocation(href);
  const store = makeStorage();
  if (opts.signIn) store.setItem('pastel-nuketown-signin', JSON.stringify(opts.signIn));
  const ctx = {
    location: location,
    URLSearchParams: URLSearchParams,
    URL: URL,
    JSON: JSON,
    Date: Date,
    isFinite: isFinite,
    sessionStorage: opts.noStorage ? null : store,
    opener: 'opener' in opts ? opts.opener : null,
    closedSelf: false,
    close() { ctx.closedSelf = true; },
    history: { replaceState(state, title, url) { location.set(new URL(url, location.href).href); } }
  };
  ctx.window = ctx;
  /* A window whose opener is itself is not a popup somebody opened; it is the
     shape a top-level load has in some browsers, and it must not be handed a
     token. Only expressible once the context exists. */
  if (opts.opener === 'self') ctx.opener = ctx;
  vm.createContext(ctx);
  vm.runInContext(headScrubber(), ctx, { filename: 'src/00-head.html' });
  ctx.storage = store;
  return ctx;
}

/* Everything on `window` after the snippet has run, minus what a bare context
   already carries. The security property is that this list never contains the
   token, under any outcome — a global holding a bearer is a global the CDN
   copy of Three.js can read, and that script runs long before the bundle. */
function leakedGlobals(ctx) {
  const known = new Set(['location', 'URLSearchParams', 'URL', 'JSON', 'Date', 'isFinite',
    'sessionStorage', 'opener', 'closedSelf', 'close', 'history', 'window', 'storage']);
  return Object.keys(ctx).filter(k => !known.has(k));
}

test('the head scrubs the callback out of the URL before any other script runs', () => {
  const opener = makeOpener();
  const ctx = runScrubber(PAGE + '/#auth_token=SECRET-TOKEN&auth_expires_at=99',
    { signIn: { nonce: 'NONCE-1', at: Date.now() }, opener: opener });

  assert.equal(ctx.location.hash, '');
  assert.ok(!ctx.location.href.includes('SECRET-TOKEN'), ctx.location.href);
});

/* The finding this exists for: the snippet used to leave the bearer on
   `window.__pnTakeAuthCallback` until the bundle collected it, so any script
   loading in between — the CDN copy of Three.js, or a compromised response
   standing in for it — could simply call it and take the token. */
test('the head hands the token to the opener and leaves nothing on window', () => {
  const opener = makeOpener();
  const ctx = runScrubber(PAGE + '/#auth_token=SECRET-TOKEN&auth_expires_at=99',
    { signIn: { nonce: 'NONCE-1', at: Date.now() }, opener: opener });

  assert.equal(opener.posted.length, 1);
  assert.equal(opener.posted[0].data.type, 'pastel-nuketown-auth');
  assert.equal(opener.posted[0].data.token, 'SECRET-TOKEN');
  assert.equal(opener.posted[0].data.nonce, 'NONCE-1');
  assert.equal(opener.posted[0].origin, PAGE);
  /* Expired long ago, so it arrives as 0 rather than as a lie. */
  assert.equal(opener.posted[0].data.expiresAt, 0);

  assert.deepEqual(leakedGlobals(ctx), [],
    'the snippet left something on window for the CDN script to read');
  /* Spent, and the window is on its way out. */
  assert.equal(ctx.storage.getItem('pastel-nuketown-signin'), null);
  assert.equal(ctx.closedSelf, true);
});

test('an unasked-for, stale or unopened callback is scrubbed and dropped', () => {
  const cases = {
    'no marker at all': {},
    'a marker from an attempt nobody is waiting on': {
      signIn: { nonce: 'NONCE-1', at: Date.now() - 601000 }, opener: makeOpener()
    },
    'a marker with no nonce': { signIn: { at: Date.now() }, opener: makeOpener() },
    'a live marker but no opener': { signIn: { nonce: 'NONCE-1', at: Date.now() } },
    'a window that opened itself': { signIn: { nonce: 'NONCE-1', at: Date.now() }, opener: 'self' },
    'no session storage to check': { noStorage: true, opener: makeOpener() }
  };
  for (const [why, opts] of Object.entries(cases)) {
    const ctx = runScrubber(PAGE + '/#auth_token=SECRET-TOKEN&auth_expires_at=99', opts);
    assert.equal(ctx.location.hash, '', why + ': the token stayed in the URL');
    assert.ok(!ctx.location.href.includes('SECRET-TOKEN'), why);
    assert.deepEqual(leakedGlobals(ctx), [], why + ': something was left on window');
    if (opts.opener && opts.opener !== 'self')
      assert.equal(opts.opener.posted.length, 0, why + ': the token was posted anyway');
    assert.equal(ctx.closedSelf, false, why);
  }
});

test('the head scrubber leaves an ordinary fragment, and an ordinary page, alone', () => {
  const opener = makeOpener();
  const mixed = runScrubber(PAGE + '/?x=1#room=ABCDE&auth_token=SECRET',
    { signIn: { nonce: 'NONCE-1', at: Date.now() }, opener: opener });
  assert.equal(mixed.location.href, PAGE + '/?x=1#room=ABCDE');
  assert.equal(opener.posted[0].data.token, 'SECRET');

  const plain = runScrubber(PAGE + '/#room=ABCDE');
  assert.equal(plain.location.hash, '#room=ABCDE');
  assert.deepEqual(leakedGlobals(plain), []);
});

/* The snippet cannot import the store's constants — needing the bundle is the
   whole thing it exists to avoid — so it carries its own copies of the storage
   key, the marker's life and the message shape. Nothing stops those drifting
   apart except this. */
test('the head snippet and the store agree on the key, the life and the shape', () => {
  const snippet = headScrubber();
  const ctx = makeStore({});
  for (const [what, value] of [
    ['the session key', ctx.__get('STORE_SIGNIN_KEY')],
    ['the marker life', String(ctx.__get('STORE_SIGNIN_TTL'))]
  ]) {
    assert.ok(snippet.includes(value), `the head snippet no longer carries ${what} (${value})`);
  }
  assert.ok(snippet.includes('pastel-nuketown-auth'),
    'the head snippet posts a message shape the store does not listen for');
});

/* ---------------------------------------------------------------------
   …and that it still runs first in the artifact that ships

   Testing the snippet out of src/00-head.html proves what it does, not
   when it does it. build.sh is what decides that, and a build that emitted
   the CDN tags above the snippet would restore the original exposure with
   every one of these tests still green.
   --------------------------------------------------------------------- */
test('the built page runs the scrubber before it loads anything off a CDN', () => {
  const built = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const scrubber = built.indexOf('auth_token');
  assert.ok(scrubber > 0, 'the built page has no callback scrubber in it at all');

  const external = [];
  const tag = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (let m = tag.exec(built); m; m = tag.exec(built)) external.push({ at: m.index, src: m[1] });
  assert.ok(external.length, 'the built page loads no external script — has the CDN gone?');

  const first = external.reduce((a, b) => (b.at < a.at ? b : a));
  assert.ok(scrubber < first.at,
    `the scrubber (byte ${scrubber}) runs after ${first.src} (byte ${first.at}), ` +
    'so a compromised CDN response reads the token off the URL first');
});

/* ---------------------------------------------------------------------
   …and that the CDN cannot come back as something else

   Running the scrubber first keeps a freshly issued token away from third
   party code on its way past. It is not the whole job: the session that
   token becomes lives in localStorage for thirty days, where a substituted
   CDN response would simply read it on the next load instead. The version
   is pinned, so the bytes are pinned too, and a response that is not this
   file does not execute at all. Both copies of Three.js are the same file,
   so both tags carry the same digest — and neither is checked at all
   without crossorigin, which is the part that is easy to drop.
   --------------------------------------------------------------------- */
test('every script the built page fetches off a CDN is pinned to its bytes', () => {
  const built = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  /* The fallback tag is assembled inside a JS string, so this looks for the
     src= that both forms share rather than for a <script> element. */
  const remote = /\bsrc\s*=\s*\\?["'](https?:\/\/[^"'\\]+)/gi;
  const loads = [];
  for (let m = remote.exec(built); m; m = remote.exec(built))
    loads.push({ url: m[1], tag: built.slice(m.index, m.index + 400) });

  assert.equal(loads.length, 2,
    `expected the pinned CDN copy and its fallback, found ${loads.length}: ` +
    loads.map((load) => load.url).join(', '));

  const digests = new Set();
  for (const { url, tag } of loads) {
    const digest = /\bintegrity\s*=\s*\\?["'](sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2})\\?["']/.exec(tag);
    assert.ok(digest, `${url} is loaded with no integrity hash to check it against`);
    assert.match(tag, /\bcrossorigin\s*=\s*\\?["']anonymous\\?["']/,
      `${url} has an integrity hash the browser will not check without crossorigin`);
    digests.add(digest[1]);
  }
  assert.equal(digests.size, 1,
    'the two CDN copies of the same file were pinned to different hashes');
});

/* ---------------------------------------------------------------------
   …and that both halves agree on what they are saying

   The store shipped unable to sell anything: the page posted `itemId` and
   the relay read `body.cosmeticId`, so every BUY came back "unknown
   cosmetic". Two full test suites had nothing to say about it, because
   neither crosses the boundary — the relay's tests write the request body
   themselves, and the tests above answer with a relay that agrees with
   whatever this file sends. Each half was internally consistent and blind.

   So read both sources and compare the one name they have to share. A
   regex over source is a poor substitute for an integration test and is
   used here on purpose: the client is a browser global soup that cannot
   import account-store.mjs, and a test that cannot fail on the real defect
   is worth less than an ugly one that can.
   --------------------------------------------------------------------- */
test('the checkout field the page sends is the field the relay reads', () => {
  const client = fs.readFileSync(path.join(__dirname, 'src', '82-store.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'account-store.mjs'), 'utf8');

  const sent = /storeAPI\(\s*'\/shop\/checkout'[\s\S]{0,300}?body:\s*\{\s*([A-Za-z_$][\w$]*)\s*:/.exec(client);
  assert.ok(sent, 'no /shop/checkout request body found in src/82-store.js — has the call moved?');

  const read = /shop\.checkout\(\s*[^,]+,\s*body\.([A-Za-z_$][\w$]*)\s*\)/.exec(server);
  assert.ok(read, 'no /shop/checkout route argument found in account-store.mjs — has the route moved?');

  assert.equal(sent[1], read[1],
    `the page sends { ${sent[1]}: … } and the relay reads body.${read[1]}, ` +
    'so every purchase fails as an unknown cosmetic');
});

/* ---------------------------------------------------------------------
   Where the token is allowed to go
   --------------------------------------------------------------------- */

test('?server= cannot move the origin a bearer token is sent to', async () => {
  const ctx = makeStore({
    href: PAGE + '/?server=https://attacker.example',
    reply: () => ({ status: 200, body: { userId: 'u1', email: 'p@example.com', displayName: 'P', entitlements: [] } })
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'SECRET', origin: RELAY, expiresAt: 0
  }));

  ctx.initStore();
  await settle();

  assert.equal(ctx.storeAuthOrigin(), RELAY);
  const authed = bearerCalls(ctx);
  assert.ok(authed.length > 0, 'expected at least one authenticated request');
  for (const call of authed) assert.ok(call.url.startsWith(RELAY + '/'), call.url);
  for (const call of ctx.calls) assert.ok(!call.url.includes('attacker.example'), call.url);
});

test('a cached token issued for another origin is dropped rather than sent', async () => {
  const ctx = makeStore({
    reply: () => ({ status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'P', entitlements: [] } })
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'SECRET', origin: 'https://attacker.example', expiresAt: 0
  }));

  ctx.initStore();
  await settle();

  assert.equal(ctx.__get('ACCOUNT.token'), null);
  assert.equal(ctx.localStorage.getItem('pastel-nuketown-token'), null);
  assert.equal(bearerCalls(ctx).length, 0);
});

test('a cached token whose expiry has passed is not sent anywhere', async () => {
  const ctx = makeStore({ reply: () => ({ status: 200, body: {} }) });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'SECRET', origin: RELAY, expiresAt: Date.now() - 1
  }));

  ctx.initStore();
  await settle();

  assert.equal(ctx.__get('ACCOUNT.token'), null);
  assert.equal(bearerCalls(ctx).length, 0);
});

/* ---------------------------------------------------------------------
   The relay is the record
   --------------------------------------------------------------------- */

test('a 401 clears the cached token and falls back to signed out', async () => {
  const ctx = makeStore({ reply: () => ({ status: 401, body: null }) });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'EXPIRED', origin: RELAY, expiresAt: 0
  }));

  ctx.initStore();
  await settle();

  assert.equal(ctx.__get('ACCOUNT.token'), null);
  assert.equal(ctx.__get('ACCOUNT.user'), null);
  assert.equal(ctx.localStorage.getItem('pastel-nuketown-token'), null);
  assert.equal(ctx.storeSignedIn(), false);
});

test('a relay that has not shipped auth yet leaves the token alone and the game signed out', async () => {
  const ctx = makeStore({ reply: () => ({ status: 404, body: null }) });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));

  ctx.initStore();
  await settle();

  assert.equal(ctx.storeSignedIn(), false);
  /* Only a 401 ends a session. A missing endpoint is the relay's problem to
     fix, not a reason to sign somebody out of it. */
  assert.ok(ctx.localStorage.getItem('pastel-nuketown-token').includes('GOOD'));
});

/* ---------------------------------------------------------------------
   Equipping
   --------------------------------------------------------------------- */

test('equipped preferences are filtered against what the relay says is owned', async () => {
  const ctx = makeStore({
    reply: url => url === RELAY + '/auth/me'
      ? { status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'P', entitlements: ['char-midnight'] } }
      : { status: 404, body: null }
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));
  /* Hand-edited storage claiming three skins, only one of which was bought. */
  ctx.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: 'char-midnight',
    weapons: { smg: 'smg-cottoncloud', shotgun: 'shotgun-toastedmallow', rifle: null }
  }));

  ctx.initStore();
  await settle();

  assert.equal(ctx.__get('EQUIPPED').character, 'char-midnight');
  assert.equal(ctx.__get('EQUIPPED').weapons.smg, null);
  assert.equal(ctx.__get('EQUIPPED').weapons.shotgun, null);
  assert.equal(ctx.__get('EQUIPPED').weapons.rifle, null);
});

test('active battle-pass claims resolve their slots and equip, while unearned claims do not', async () => {
  const earnedId = 's1-free-smg-first-light';
  const earned = makeStore({
    reply: url => url === RELAY + '/auth/me'
      ? { status: 200, body: {
        userId: 'bp-earned', email: 'earned@e.com', displayName: 'Earned',
        entitlements: [], earnedRewards: [earnedId], ownedCosmetics: [earnedId]
      } }
      : { status: 404, body: null }
  });
  earned.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));
  earned.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: null, effect: null, weapons: { smg: earnedId }
  }));
  earned.initStore();
  await settle();

  assert.deepEqual(earned.__json(`storeSlotOf('${earnedId}')`), {
    kind: 'weapon', slot: 'smg'
  });
  assert.deepEqual(earned.__json("storeSlotOf('s1-free-char-pink-horizon')"), {
    kind: 'character'
  });
  assert.deepEqual(earned.__json("storeSlotOf('s1-premium-fx-dawn-sparks')"), {
    kind: 'effect'
  });
  assert.equal(earned.__get('EQUIPPED').weapons.smg, earnedId);

  const unearned = makeStore({
    reply: url => url === RELAY + '/auth/me'
      ? { status: 200, body: {
        userId: 'bp-unearned', email: 'unearned@e.com', displayName: 'Unearned',
        entitlements: [], earnedRewards: [], ownedCosmetics: []
      } }
      : { status: 404, body: null }
  });
  unearned.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));
  unearned.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    weapons: { smg: earnedId }
  }));
  unearned.initStore();
  await settle();
  assert.equal(unearned.__get('EQUIPPED').weapons.smg, null);
  unearned.storeEquip(earnedId);
  assert.equal(unearned.__get('EQUIPPED').weapons.smg, null);
});

test('a claimed battle-pass card offers the equip action', () => {
  const ctx = makeStore();
  const made = [];
  ctx.document.createElement = tag => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      listeners: {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      addEventListener(type, listener) { this.listeners[type] = listener; }
    };
    made.push(node);
    return node;
  };
  ctx.__get("ACCOUNT.owned = new Set(['s1-free-smg-first-light'])");
  const me = ctx.__get("({ tier: 1, premium: false, claimed: new Set(['1:free']) })");
  const card = ctx.bpMakeNode(1, 'free', 's1-free-smg-first-light', me);

  assert.equal(card.tagName, 'BUTTON');
  assert.equal(card.attributes['aria-pressed'], 'false');
  assert.equal(typeof card.listeners.click, 'function');
  card.listeners.click();
  assert.equal(ctx.__get('EQUIPPED').weapons.smg, 's1-free-smg-first-light');
  assert.ok(made.some((node) => node.textContent === 'EQUIP'));
});

test('the premium pass offer only opens checkout for an available catalog item', () => {
  const ctx = makeStore();
  const catalog = available => ({ items: [{
    id: 'battlepass-season-1-premium',
    displayName: 'Season 1 Premium Pass',
    type: 'battlepass',
    available: available,
    price: available ? { unitAmount: 999, currency: 'usd' } : null
  }] });

  ctx.__get(`ACCOUNT.items = storeCleanCatalog(${JSON.stringify(catalog(false))})`);
  assert.equal(ctx.bpCatalogProduct(), null,
    'a listed but unavailable pass must not produce a checkout offer');

  ctx.__get(`ACCOUNT.items = storeCleanCatalog(${JSON.stringify(catalog(true))})`);
  assert.equal(ctx.__get('bpCatalogProduct().available'), true);
});

/* The catalog exactly as the relay answers it: a Stripe price and nothing
   else. The wallet build read a currency field this shape does not carry,
   found it undefined, and drew every BUY disabled — the pass offer worse,
   drawn live and silently returning on click. It shipped green, because the
   test of the day asked whether the offer *resolved* and never where pressing
   it *went*. That is the gap these close: the button is pressed, and the
   endpoint it reaches is the assertion. */
const CATALOG = { items: [{
  id: 'battlepass-season-1-premium',
  displayName: 'Season 1 Premium Pass',
  type: 'battlepass',
  productKind: 'battlepass',
  available: true,
  price: { unitAmount: 999, currency: 'usd' }
}] };

test('pressing the pass offer reaches the relay checkout and goes to Stripe', async () => {
  const ctx = makeStore({
    reply: url => url === RELAY + '/shop/checkout'
      ? { status: 200, body: { url: 'https://checkout.stripe.com/c/pay/abc' } }
      : { status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'P', entitlements: [] } }
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));
  ctx.initStore();
  await settle();
  assert.equal(ctx.storeSignedIn(), true);

  ctx.__get(`ACCOUNT.items = storeCleanCatalog(${JSON.stringify(CATALOG)})`);
  ctx.battlepassBuy();
  await settle();
  await settle();

  assert.equal(ctx.calls.filter(c => c.url === RELAY + '/shop/checkout').length, 1,
    'the pass offer must open a checkout, not resolve into nothing');
  assert.deepEqual(ctx.location.assigned, ['https://checkout.stripe.com/c/pay/abc']);
});

test('a listed pass is priced and named from the catalog, and withdrawn when off sale', () => {
  const ctx = makeStore();
  const clean = catalog => ctx.__get(`storeCleanCatalog(${JSON.stringify(catalog)})`)[0];

  const listed = clean(CATALOG);
  assert.equal(listed.available, true);
  assert.equal(ctx.storePriceText(listed.price), '$9.99');
  /* The pass is the one listed product this side has no local entry for, so
     it is the one that showed a raw id in the case. */
  assert.equal(listed.name, 'Season 1 Premium Pass');
  assert.equal(ctx.storeKindLabel(listed.id, listed.type, listed.productKind), 'BATTLE PASS');

  ctx.__get(`ACCOUNT.items = [${JSON.stringify(clean({ items: [Object.assign({},
    CATALOG.items[0], { available: false, price: null })] }))}]`);
  assert.equal(ctx.bpCatalogProduct(), null,
    'a pass the relay is not selling must not produce an offer');
});

test('editing localStorage alone cannot present an unowned item as equipped', () => {
  const ctx = makeStore();
  ctx.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: 'char-cloudknight',
    weapons: { smg: 'smg-cottoncloud', shotgun: 'shotgun-toastedmallow', rifle: 'rifle-berryswirl' }
  }));

  ctx.initStore();

  assert.deepEqual(ctx.__json('EQUIPPED'), {
    character: null, effect: null, weapons: { smg: null, shotgun: null, rifle: null }
  });
  /* And pressing EQUIP without an entitlement changes nothing either. */
  ctx.storeEquip('char-cloudknight', 'character');
  assert.equal(ctx.__get('EQUIPPED').character, null);
});

test('a character id cannot be equipped into a weapon slot', () => {
  const ctx = makeStore();
  ctx.__get("ACCOUNT.owned = new Set(['char-midnight', 'rifle-berryswirl'])");
  ctx.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: 'rifle-berryswirl',
    weapons: { smg: 'char-midnight', shotgun: 'rifle-berryswirl', rifle: 'rifle-berryswirl' }
  }));

  ctx.storeApplyEquipped();

  assert.equal(ctx.__get('EQUIPPED').character, null);          // a rifle skin is not a fighter
  assert.equal(ctx.__get('EQUIPPED').weapons.smg, null);        // nor is a fighter an SMG
  assert.equal(ctx.__get('EQUIPPED').weapons.shotgun, null);    // nor does a rifle skin fit a shotgun
  assert.equal(ctx.__get('EQUIPPED').weapons.rifle, 'rifle-berryswirl');
});

test('a shot effect equips into its own slot and takes nothing else off', () => {
  const ctx = makeStore();
  ctx.__get("ACCOUNT.owned = new Set(['char-midnight', 'rifle-berryswirl', 'fx-starfall', 'fx-bubbletrail'])");

  ctx.storeEquip('char-midnight', 'character');
  ctx.storeEquip('rifle-berryswirl', 'weapon');
  ctx.storeEquip('fx-starfall', 'effect');
  assert.deepEqual(ctx.__json('EQUIPPED'), {
    character: 'char-midnight',
    effect: 'fx-starfall',
    weapons: { smg: null, shotgun: null, rifle: 'rifle-berryswirl' }
  });

  /* One effect at a time: the second replaces the first rather than
     stacking two wakes on one player. */
  ctx.storeEquip('fx-bubbletrail', 'effect');
  assert.equal(ctx.__get('EQUIPPED').effect, 'fx-bubbletrail');
  assert.equal(ctx.__get('EQUIPPED').character, 'char-midnight');

  /* Pressing it again is how you get back to the default wake. */
  ctx.storeEquip('fx-bubbletrail', 'effect');
  assert.equal(ctx.__get('EQUIPPED').effect, null);
  assert.equal(ctx.__get('EQUIPPED').weapons.rifle, 'rifle-berryswirl');

  /* And it survives a reload, because it is a preference. */
  const again = makeStore({ localStorage: ctx.localStorage });
  again.localStorage = ctx.localStorage;
  again.__get("ACCOUNT.owned = new Set(['fx-starfall'])");
  again.storeEquip('fx-starfall', 'effect');
  const saved = JSON.parse(again.localStorage.getItem('pastel-nuketown-equipped'));
  assert.equal(saved.effect, 'fx-starfall');
});

test('an effect cannot be worn as a fighter or a gun, or a gun skin as an effect', () => {
  const ctx = makeStore();
  ctx.__get("ACCOUNT.owned = new Set(['fx-starfall', 'rifle-berryswirl'])");
  ctx.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: 'fx-starfall',
    effect: 'rifle-berryswirl',
    weapons: { smg: 'fx-starfall', shotgun: null, rifle: null }
  }));

  ctx.storeApplyEquipped();

  assert.deepEqual(ctx.__json('EQUIPPED'), {
    character: null, effect: null,
    weapons: { smg: null, shotgun: null, rifle: null }
  });
});

test('an effect nobody bought cannot be equipped by editing storage', () => {
  const ctx = makeStore();
  ctx.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: null, effect: 'fx-confettipop', weapons: {}
  }));

  ctx.initStore();

  assert.equal(ctx.__get('EQUIPPED').effect, null);
  ctx.storeEquip('fx-confettipop', 'effect');
  assert.equal(ctx.__get('EQUIPPED').effect, null);
});

test('EQUIPPED keeps the shape the network layer reads', () => {
  const ctx = makeStore();
  ctx.initStore();
  assert.deepEqual(Object.keys(ctx.__json('EQUIPPED')).sort(),
    ['character', 'effect', 'weapons']);
  assert.deepEqual(Object.keys(ctx.__json('EQUIPPED').weapons).sort(), ['rifle', 'shotgun', 'smg']);
});

/* ---------------------------------------------------------------------
   Answers that arrive too late
   --------------------------------------------------------------------- */

test('an /auth/me that lands after sign-out does not bring the account back', async () => {
  let release = null;
  const ctx = makeStore({
    reply: url => url === RELAY + '/auth/me'
      ? new Promise(resolve => { release = () => resolve({
          status: 200,
          body: { userId: 'u1', email: 'p@e.com', displayName: 'Ghost', entitlements: ['char-midnight'] }
        }); })
      : { status: 404, body: null }
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));
  ctx.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: 'char-midnight', weapons: {}
  }));

  ctx.initStore();          // /auth/me is now in flight
  ctx.storeSignOut();       // and the player leaves before it answers
  assert.equal(typeof release, 'function');
  release();
  await settle();
  await settle();

  assert.equal(ctx.__get('ACCOUNT.token'), null);
  assert.equal(ctx.__get('ACCOUNT.user'), null);
  assert.equal(ctx.__get('ACCOUNT.owned.size'), 0);
  /* The one that matters: Phase 2 reads this, and it must not carry the
     previous account's fighter into the next match. */
  assert.equal(ctx.__get('EQUIPPED').character, null);
});

test('signing out revokes the token instead of aborting its own revoke', async () => {
  const ctx = makeStore({ reply: () => ({ status: 200, body: null }) });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));

  ctx.initStore();
  ctx.storeSignOut();
  await settle();

  const logout = ctx.calls.filter(c => c.url === RELAY + '/auth/logout');
  assert.equal(logout.length, 1);
  assert.equal(logout[0].headers['Authorization'], 'Bearer GOOD');
  assert.equal(logout[0].init.signal.aborted, false);
});

test('a checkout answering after sign-out does not send the browser to Stripe', async () => {
  let release = null;
  const ctx = makeStore({
    reply: url => url === RELAY + '/shop/checkout'
      ? new Promise(resolve => { release = () => resolve({ status: 200, body: { url: 'https://checkout.stripe.com/c/pay/abc' } }); })
      : { status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'P', entitlements: [] } }
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));

  ctx.initStore();
  await settle();
  assert.equal(ctx.storeSignedIn(), true);

  ctx.storeBuy('char-midnight');
  ctx.storeSignOut();
  assert.equal(typeof release, 'function');
  release();
  await settle();
  await settle();

  assert.deepEqual(ctx.location.assigned, []);
  /* And the BUY buttons are usable again rather than stuck on WAIT. */
  assert.equal(ctx.__get('ACCOUNT.checkingOut'), false);
});

test('a checkout that fails after sign-out does not talk over the signed-out message', async () => {
  const note = { textContent: '', dataset: {} };
  let release = null;
  const ctx = makeStore({
    elements: { storeNote: note },
    reply: url => url === RELAY + '/shop/checkout'
      ? new Promise(resolve => { release = () => resolve({ reject: true }); })
      : { status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'P', entitlements: [] } }
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));

  ctx.initStore();
  await settle();
  ctx.storeBuy('char-midnight');
  ctx.storeSignOut();
  const parting = note.textContent;
  assert.match(parting, /Signed out/);

  /* Signing out aborts the checkout, so its rejection is our own doing and
     belongs to a session that has ended — it must not land on top of the last
     thing the player was actually told. */
  release();
  await settle();
  await settle();
  assert.equal(note.textContent, parting);
  assert.equal(ctx.__get('ACCOUNT.checkingOut'), false);
});

/* ---------------------------------------------------------------------
   Where a checkout is allowed to send the browser
   --------------------------------------------------------------------- */

/* Signed in, with the relay's answer to /shop/checkout under the test's
   control — the one thing between that answer and the address bar. */
async function boughtWith(checkoutBody) {
  const note = { textContent: '', dataset: {} };
  const ctx = makeStore({
    elements: { storeNote: note },
    reply: url => url === RELAY + '/shop/checkout'
      ? { status: 200, body: checkoutBody }
      : { status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'P', entitlements: [] } }
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'GOOD', origin: RELAY, expiresAt: 0
  }));
  ctx.initStore();
  await settle();
  assert.equal(ctx.storeSignedIn(), true);
  ctx.storeBuy('char-midnight');
  await settle();
  await settle();
  ctx.note = note;
  return ctx;
}

test('a checkout URL that will not parse is an error, not a permanently disabled BUY button', async () => {
  /* `https://%` passes any "looks like https" pattern and throws on the way
     into the address bar. When that throw escaped, cleanup never ran: every
     BUY button sat on WAIT and the panel went on claiming a checkout was
     opening, with no error, until the player reloaded. */
  const ctx = await boughtWith({ url: 'https://%' });

  assert.deepEqual(ctx.location.assigned, []);
  assert.equal(ctx.__get('ACCOUNT.checkingOut'), false);
  assert.match(ctx.note.textContent, /checkout would not open/);
  assert.equal(ctx.note.dataset.kind, 'error');
  /* Nothing was bought, so coming back must not reopen the panel as though
     something had been. */
  assert.equal(ctx.sessionStorage.getItem('pastel-nuketown-store-open'), null);
});

test('a userinfo-style host is not Stripe and is refused', async () => {
  /* Everything before the @ is a username: the site this actually visits is
     evil.example, which is where the player would be typing a card number. */
  const ctx = await boughtWith({ url: 'https://checkout.stripe.com@evil.example/c/pay/abc' });

  assert.deepEqual(ctx.location.assigned, []);
  assert.equal(ctx.__get('ACCOUNT.checkingOut'), false);
  assert.match(ctx.note.textContent, /checkout would not open/);
  assert.equal(ctx.storeCheckoutURL('https://checkout.stripe.com@evil.example/c/pay/abc'), null);
  assert.equal(ctx.storeCheckoutURL('https://checkout.stripe.com.evil.example/c/pay/abc'), null);
  assert.equal(ctx.storeCheckoutURL('http://checkout.stripe.com/c/pay/abc'), null);
  assert.equal(ctx.storeCheckoutURL('javascript:alert(1)'), null);
});

test('a real Stripe checkout URL still opens', async () => {
  const ctx = await boughtWith({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc123' });

  assert.deepEqual(ctx.location.assigned, ['https://checkout.stripe.com/c/pay/cs_test_abc123']);
  assert.equal(ctx.__get('ACCOUNT.checkingOut'), false);
  /* And the panel is waiting when the browser comes back from Stripe. */
  assert.equal(ctx.sessionStorage.getItem('pastel-nuketown-store-open'), '1');
});

/* ---------------------------------------------------------------------
   Timeouts
   --------------------------------------------------------------------- */

test('the timeout survives a relay that answers with headers and then stalls', async () => {
  const ctx = makeStore({
    reply: () => ({
      status: 200,
      /* Headers now, body never — the shape that used to slip past the
         eight seconds entirely and leave every BUY button on WAIT. */
      json: init => new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })
    })
  });

  await assert.rejects(ctx.storeAPI('/shop/catalog', { timeout: 30 }));
});

test('an empty body is a null body and not a failed request', async () => {
  const ctx = makeStore({
    reply: () => ({ status: 200, json: () => Promise.reject(new Error('not json')) })
  });
  const res = await ctx.storeAPI('/auth/logout', { method: 'POST' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

/* ---------------------------------------------------------------------
   Sign-in must not cost the player the game
   --------------------------------------------------------------------- */

test('SIGN IN opens a window instead of navigating the game away', () => {
  const ctx = makeStore();
  ctx.initStore();
  ctx.storeBeginSignIn();

  assert.equal(ctx.opened.length, 1);
  assert.equal(ctx.opened[0].url, RELAY + '/auth/google/start');
  /* The finding this replaces: a missing /auth/google/start used to replace
     the title screen, PLAY and the room browser with the relay's 404. */
  assert.deepEqual(ctx.location.assigned, []);
});

test('a blocked popup is reported and still does not navigate the game away', () => {
  const ctx = makeStore({ popupBlocked: true });
  ctx.initStore();
  ctx.storeBeginSignIn();

  assert.equal(ctx.opened.length, 1);
  assert.deepEqual(ctx.location.assigned, []);
});

test('the popup hands its token back only to this page, only from the window we opened, and only in the shape we send', async () => {
  const ctx = makeStore({
    reply: url => url === RELAY + '/auth/me'
      ? { status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'Pilot', entitlements: [] } }
      : { status: 200, body: [] }
  });
  ctx.initStore();
  ctx.storeBeginSignIn();
  const win = ctx.opened[0].win;
  const nonce = ctx.__get('STORE_SIGNIN.nonce');
  assert.ok(nonce, 'pressing SIGN IN records a nonce for the attempt');
  const good = { type: 'pastel-nuketown-auth', token: 'GOOD', expiresAt: 0, nonce: nonce };

  ctx.storeOnAuthMessage({ origin: 'https://attacker.example', source: win, data: good });
  assert.equal(ctx.__get('ACCOUNT.token'), null);

  /* Same origin is not enough on its own: any frame or window this page shares
     an origin with can post here, so the message has to come from the exact
     window SIGN IN opened. */
  ctx.storeOnAuthMessage({ origin: PAGE, source: { closed: false }, data: good });
  assert.equal(ctx.__get('ACCOUNT.token'), null);

  ctx.storeOnAuthMessage({ origin: PAGE, source: win, data: { type: 'something-else', token: 'EVIL', nonce: nonce } });
  assert.equal(ctx.__get('ACCOUNT.token'), null);

  /* A message from a different attempt — or one held back and replayed — does
     not carry this attempt's nonce. */
  ctx.storeOnAuthMessage({ origin: PAGE, source: win, data: { type: 'pastel-nuketown-auth', token: 'STALE', nonce: 'somebody-elses' } });
  assert.equal(ctx.__get('ACCOUNT.token'), null);

  ctx.storeOnAuthMessage({ origin: PAGE, source: win, data: good });
  await settle();

  assert.equal(ctx.__get('ACCOUNT.token'), 'GOOD');
  assert.equal(ctx.__get('ACCOUNT.tokenOrigin'), RELAY);
  assert.equal(ctx.storeSignedIn(), true);
  assert.ok(ctx.localStorage.getItem('pastel-nuketown-token').includes('GOOD'));
  /* The attempt is spent, so the same message cannot be replayed into it. */
  assert.equal(ctx.sessionStorage.getItem('pastel-nuketown-signin'), null);
  assert.equal(ctx.__get('STORE_SIGNIN.nonce'), '');
});

test('a relay without the auth routes says so instead of leaving a 404 window open', async () => {
  const note = { textContent: '', dataset: {} };
  const ctx = makeStore({
    elements: { storeNote: note },
    reply: () => ({ status: 404, body: null })     // this branch's server.mjs, exactly
  });
  ctx.initStore();
  ctx.storeBeginSignIn();
  const win = ctx.opened[0].win;
  await settle();

  /* Watching only for the window to close meant saying "finish there and come
     back" at a player staring at the relay's raw 404 until they shut it. */
  assert.match(note.textContent, /not available on this server yet/);
  assert.equal(note.dataset.kind, 'error');
  assert.equal(win.closedByStore, true);
  assert.equal(ctx.sessionStorage.getItem('pastel-nuketown-signin'), null);
});

/* ---------------------------------------------------------------------
   The keyboard, while the panel is up
   --------------------------------------------------------------------- */

test('Tab walks the dialog in a ring and never leaves it', () => {
  /* Enough of a panel for the trap to walk: three buttons and a card that is
     focusable but not a stop on the ring. Tab has to be moved by hand here —
     70-game.js claims the key for the scoreboard — so this is the store's own
     logic and not the browser's, which is precisely why it is worth a test. */
  const made = [];
  const button = id => {
    const el = { id: id, disabled: false, hidden: false, getAttribute: () => null, focus() { panel.focused = el; } };
    made.push(el);
    return el;
  };
  const card = { id: 'card', getAttribute: () => '-1', focus() { panel.focused = card; } };
  const panel = {
    focused: null,
    classList: { contains: () => false },
    querySelectorAll: () => made.concat([card]),
    contains: el => made.indexOf(el) >= 0 || el === card
  };
  const close = button('storeClose');
  const buyA = button('buyA');
  const buyB = button('buyB');
  const ctx = makeStore({ elements: { store: panel } });
  const tab = shift => {
    let prevented = false;
    ctx.document.activeElement = panel.focused;
    ctx.storeTrapFocus({ code: 'Tab', shiftKey: !!shift, preventDefault() { prevented = true; } });
    ctx.document.activeElement = panel.focused;
    return prevented;
  };

  panel.focused = card;
  assert.equal(tab(), true);
  assert.equal(panel.focused, close);      // the card is not a stop; the walk starts at the first
  tab();
  assert.equal(panel.focused, buyA);
  tab();
  assert.equal(panel.focused, buyB);
  tab();
  assert.equal(panel.focused, close);      // and wraps rather than escaping behind the panel
  tab(true);
  assert.equal(panel.focused, buyB);
});

/* ---------------------------------------------------------------------
   Nothing here may break the game
   --------------------------------------------------------------------- */

test('boot with storage switched off and no relay still leaves a usable signed-out title', () => {
  const ctx = makeStore({ href: 'https://game.example/' });
  const boom = () => { throw new Error('storage is off'); };
  ctx.localStorage = { getItem: boom, setItem: boom, removeItem: boom };
  ctx.sessionStorage = { getItem: boom, setItem: boom, removeItem: boom };
  ctx.fetch = undefined;

  ctx.initStore();

  assert.equal(ctx.__get('ACCOUNT.token'), null);
  assert.equal(ctx.storeSignedIn(), false);
  assert.deepEqual(ctx.__json('EQUIPPED'), {
    character: null, effect: null, weapons: { smg: null, shotgun: null, rifle: null }
  });
});

/* =====================================================================
   THE DISPLAY CASE

   The store used to sell pictures by describing them, and the reason it
   stopped is not testable here — nobody can assert that a skin looks
   worth four dollars. What is testable is the machinery around that,
   and all of it has a specific way of failing:

     - a preview per card would mean six WebGL contexts, and a browser
       that runs out takes the game's away first;
     - lighting the case by eye clips a MeshToonMaterial's top band, which
       turns every pastel in the shop the same white — this shop has
       already shipped that once;
     - an id from a relay newer than the client has no model to build, and
       must arrive as a sentence rather than a thrown exception on the
       title screen;
     - and a canvas left turning behind a closed panel is a frame budget
       spent beside a live match.

   None of the four needs a GPU to check. The fakes below are the smallest
   surface of THREE the store actually touches, which is also a useful
   thing to know: if the store starts needing more of three.js than this,
   that is a deliberate decision and this file is where it is noticed.
   ===================================================================== */

/* ---- the smallest THREE the case leans on ---- */
function fakeThree(log) {
  class Vector3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(v) { return this.set(v, v, v); }
  }
  class Obj {
    constructor() {
      this.children = []; this.parent = null; this.visible = true;
      this.position = new Vector3(); this.rotation = new Vector3();
      this.scale = new Vector3(1, 1, 1);
      this.userData = {};
    }
    add(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
    remove(k) {
      const at = this.children.indexOf(k);
      if (at >= 0) { this.children.splice(at, 1); k.parent = null; }
      return this;
    }
    traverse(fn) { fn(this); for (const k of this.children) k.traverse(fn); }
  }
  class Group extends Obj {}
  class Scene extends Obj {}
  /* A shot effect has no model to hand over, so 60-fx.js builds the case a
     small animated loop out of plain meshes. That is the whole of the
     extra THREE it needs, and it is here rather than in the store because
     the store still only mounts, measures and frames whatever it is given. */
  class SphereGeometry {
    constructor(r) {
      const s = r || 1;
      this.__box = { min: [-s, -s, -s], max: [s, s, s] };
    }
  }
  class MeshBasicMaterial {
    constructor(opts) { Object.assign(this, opts || {}); }
  }
  class Mesh extends Obj {
    constructor(geometry, material) {
      super();
      this.geometry = geometry; this.material = material;
      this.__box = geometry && geometry.__box;
    }
  }
  class Color { constructor(hex) { this.hex = hex; } }
  class Light extends Obj {
    constructor(kind, a, b, i) { super(); this.kind = kind; this.a = a; this.b = b; this.intensity = i; log.lights.push(this); }
  }
  return {
    Vector3: Vector3,
    Group: Group,
    Scene: Scene,
    Mesh: Mesh,
    SphereGeometry: SphereGeometry,
    MeshBasicMaterial: MeshBasicMaterial,
    Color: Color,
    sRGBEncoding: 3001,
    HemisphereLight: class extends Light {
      constructor(sky, ground, i) { super('hemi', sky, ground, i); }
    },
    DirectionalLight: class extends Light {
      constructor(colour, i) { super('dir', colour, undefined, i); }
    },
    PerspectiveCamera: class {
      constructor(fov, aspect, near, far) {
        this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
        this.position = new Vector3(); this.looked = null;
      }
      lookAt(x, y, z) { this.looked = [x, y, z]; }
      updateProjectionMatrix() { this.projections = (this.projections || 0) + 1; }
    },
    /* Reads the size a fake model declares for itself, and unions its
       children, which is enough for the framing arithmetic to be exercised
       for real. */
    Box3: class {
      setFromObject(node) {
        let lo = null, hi = null;
        node.traverse(o => {
          if (!o.__box) return;
          const b = o.__box, p = o.position;
          const min = [b.min[0] + p.x, b.min[1] + p.y, b.min[2] + p.z];
          const max = [b.max[0] + p.x, b.max[1] + p.y, b.max[2] + p.z];
          lo = lo ? lo.map((v, i) => Math.min(v, min[i])) : min;
          hi = hi ? hi.map((v, i) => Math.max(v, max[i])) : max;
        });
        this.lo = lo; this.hi = hi;
        return this;
      }
      isEmpty() { return !this.lo; }
      getCenter(v) { return this.lo ? v.set((this.lo[0] + this.hi[0]) / 2, (this.lo[1] + this.hi[1]) / 2, (this.lo[2] + this.hi[2]) / 2) : v; }
      getSize(v) { return this.lo ? v.set(this.hi[0] - this.lo[0], this.hi[1] - this.lo[1], this.hi[2] - this.lo[2]) : v; }
    },
    WebGLRenderer: class {
      constructor(opts) {
        this.opts = opts; this.shadowMap = { enabled: true }; this.frames = 0;
        this.sized = null; this.pixelRatio = 1;
        log.renderers.push(this);
      }
      setClearColor(colour, alpha) { this.clear = [colour, alpha]; }
      setPixelRatio(r) { this.pixelRatio = r; }
      setSize(w, h, css) { this.sized = [w, h, css]; }
      render() { this.frames++; log.frames++; }
    }
  };
}

/* ---- the smallest DOM the panel leans on ---- */
function fakeDoc() {
  const all = [];
  const make = (tag, id) => {
    const el = {
      tagName: tag, id: id || '', className: '', textContent: '', hidden: false,
      disabled: false, style: {}, dataset: {}, attrs: {}, children: [], listeners: {},
      clientWidth: 340, clientHeight: 200, focused: 0, classes: new Set(),
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
      addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
      appendChild(kid) { el.children.push(kid); kid.parent = el; return kid; },
      focus() { el.focused++; },
      press(type) { for (const fn of el.listeners[type] || []) fn({ target: el }); },
      querySelector() { return null; },
      querySelectorAll(sel) {
        const want = sel.replace('.', ''), found = [];
        const walk = node => {
          for (const kid of node.children) {
            if (String(kid.className).split(/\s+/).indexOf(want) >= 0) found.push(kid);
            walk(kid);
          }
        };
        walk(el);
        return found;
      }
    };
    el.classList = {
      contains: c => el.classes.has(c),
      add: c => el.classes.add(c),
      remove: c => el.classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !el.classes.has(c) : on) el.classes.add(c); else el.classes.delete(c); }
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return ''; },
      set(v) { if (!v) el.children.length = 0; }
    });
    all.push(el);
    return el;
  };

  const byId = {};
  for (const id of ['store', 'storeGrid', 'storeStage', 'storeCanvas', 'stageName',
                    'stageKind', 'stageEmpty', 'stageTagA', 'stageTagB', 'stageCompare',
                    'storeNote', 'storeWho', 'storeClose'])
    byId[id] = make('div', id);
  byId.store.classes.add('off');          // the panel ships closed

  /* The one thing a canvas does that a div does not, and the whole of what
     the card pictures are taken with. The count is the point: six items are
     six calls, once, however many frames go by. */
  /* The case is a tall window, because the tallest thing in it is a
     standing character. .stage-case in src/00-head.html. */
  byId.storeCanvas.clientHeight = 272;
  byId.storeCanvas.shots = 0;
  byId.storeCanvas.toDataURL = function (type) {
    byId.storeCanvas.shots++;
    if (byId.storeCanvas.shotFails) throw new Error('tainted canvas');
    return 'data:' + (type || 'image/png') + ';base64,' + 'A'.repeat(64);
  };

  return {
    byId: byId,
    doc: {
      getElementById(id) { return byId[id] || null; },
      createElement(tag) { return make(tag, ''); },
      addEventListener() {},
      activeElement: null,
      visibilityState: 'visible'
    }
  };
}

/* The six ids the client knows, plus the four models behind them. Each
   fake carries the bounding box of the real thing so the framing does
   arithmetic on plausible numbers: a character is about 1.8m tall and a
   viewmodel gun about 0.45m long. */
function makeCase(options) {
  const opts = options || {};
  const log = { renderers: [], lights: [], frames: 0, built: [] };
  const three = fakeThree(log);
  const dom = fakeDoc();
  const frames = [];

  const model = (box, kids) => {
    const g = new three.Group();
    g.__box = box;
    for (const k of kids || []) g.add(k);
    return g;
  };
  const CHAR_BOX = { min: [-0.42, 0, -0.36], max: [0.42, 1.83, 0.36] };
  const GUN_BOX = { min: [-0.05, -0.09, -0.30], max: [0.05, 0.07, 0.19] };
  /* A skin is allowed to be a different shape from the thing it replaces —
     a crest, a taller cap — and the framing has to survive it. */
  const SKIN_BOX = opts.skinBox || CHAR_BOX;
  /* A shot crossing the case: wide, shallow, and nothing like either of
     the other two, which is exactly why the framing is measured. */
  const FX_BOX = { min: [-0.48, 0, -0.10], max: [0.48, 0.42, 0.10] };

  const globals = {
    document: dom.doc,
    THREE: three,
    devicePixelRatio: 2,
    SOFTWARE_GPU: false,
    PLAYER_COLOR: { body: 0xfff8f0, trim: 0xffc9d6, name: 'You' },
    WBY: {
      smg: { id: 'smg', name: 'BUBBLEGUN' },
      shotgun: { id: 'shotgun', name: 'MARSHMALLOW' },
      rifle: { id: 'rifle', name: 'LOLLIPOP' }
    },
    buildCharacter(colors, skinId) {
      if (opts.builderThrows) throw new Error('no geometry today');
      log.built.push({ kind: 'character', colors: colors, skinId: skinId });
      return { root: model(skinId ? SKIN_BOX : CHAR_BOX) };
    },
    buildGunMesh(weapon, skinId) {
      if (opts.builderThrows) throw new Error('no geometry today');
      log.built.push({ kind: 'weapon', weapon: weapon && weapon.id, skinId: skinId });
      return model(GUN_BOX);
    },
    /* A shot effect has no model, so 60-fx.js hands the case a node that
       animates itself instead. The case's side of that bargain is all this
       fake needs to have: a box to be framed by, and a pnTick to be driven
       by rather than spun. */
    buildEffectPreview(effectId) {
      if (opts.builderThrows) throw new Error('no geometry today');
      log.built.push({ kind: 'effect', skinId: effectId });
      const node = model(FX_BOX);
      node.userData.pnTick = () => { node.ticks = (node.ticks || 0) + 1; };
      return node;
    },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    cancelAnimationFrame(id) { log.cancelled = (log.cancelled || 0) + 1; frames[id - 1] = null; }
  };
  if (opts.noThree) delete globals.THREE;
  if (opts.contextFails) globals.THREE = Object.assign({}, three, {
    WebGLRenderer: function () { throw new Error('no webgl here'); }
  });

  const ctx = makeStore({ globals: globals, reply: opts.reply });
  ctx.initStore();
  ctx.__log = log;
  ctx.__dom = dom.byId;
  /* One generation of frames at a time: a tick that asks for the next one
     must not be run inside the same pump, or this loops forever. */
  ctx.__pump = (times) => {
    for (let i = 0; i < (times || 1); i++) {
      const due = frames.splice(0, frames.length);
      for (const fn of due) if (fn) fn();
    }
  };
  ctx.__pending = () => frames.filter(Boolean).length;
  return ctx;
}

const CASE_IDS = ['smg-cottoncloud', 'shotgun-toastedmallow', 'rifle-berryswirl',
                  'char-midnight', 'char-sherbetfox', 'char-cloudknight',
                  'fx-starfall', 'fx-confettipop', 'fx-bubbletrail'];

test('the case previews every catalog id, on one shared renderer', async () => {
  const ctx = makeCase();
  ctx.storeShow(true);
  await settle();

  assert.equal(ctx.__dom.storeStage.hidden, false);

  for (const id of CASE_IDS) {
    ctx.STAGE_TEST_ID = id;
    /* Exactly what pressing the card does. */
    assert.doesNotThrow(() => ctx.stageSelect(id), id);
    const stage = ctx.__get('STAGE');
    assert.equal(stage.itemId, id);
    assert.ok(stage.slots.some(s => s.node), id + ' put nothing in the case');
    assert.equal(ctx.__dom.stageEmpty.hidden, true, id + ' fell back to the empty message');
    assert.ok(ctx.__dom.stageName.textContent, id + ' has no name under it');
  }

  /* The whole reason the case is one canvas: a context per card is six
     contexts on a phone that is already running the game in a seventh. */
  assert.equal(ctx.__log.renderers.length, 1);
  assert.equal(ctx.__log.renderers[0].opts.alpha, true);

  /* Both builders were driven with the real ids, and each was also asked
     for the plain version — that pair is the comparison. */
  const built = ctx.__log.built;
  for (const id of CASE_IDS)
    assert.ok(built.some(b => b.skinId === id), 'never built ' + id);
  assert.ok(built.some(b => b.kind === 'character' && b.skinId === undefined));
  assert.ok(built.some(b => b.kind === 'weapon' && b.weapon === 'smg' && b.skinId === undefined));
  /* The default half of an effect's comparison is the plain shot, which is
     a null id rather than an absent one — there is no "no effect" model to
     leave out. */
  assert.ok(built.some(b => b.kind === 'effect' && b.skinId === null));

  /* And nothing was built twice: a player walking the row is not paying
     for geometry they already have. */
  const keys = built.map(b => b.kind + '/' + (b.weapon || '') + '/' + b.skinId);
  assert.equal(new Set(keys).size, keys.length, keys.join(' '));
});

test('an effect runs its own loop in the case instead of turning on the stand', async () => {
  const ctx = makeCase();
  ctx.storeShow(true);
  await settle();

  ctx.stageSelect('char-midnight');
  ctx.__pump(3);
  const model = ctx.__get('STAGE').slots.find(s => s.node);
  assert.ok(model.spinner.rotation.y !== model.yaw0, 'a character stopped turning');

  ctx.stageSelect('fx-starfall');
  ctx.__pump(3);
  const stage = ctx.__get('STAGE');
  const shown = stage.slots.filter(s => s.node);
  assert.equal(shown.length, 2, 'the effect lost its default to compare against');
  for (const slot of shown) {
    assert.ok(slot.node.ticks > 0, 'the effect was never given a frame');
    /* A wake seen edge-on is nothing, so this one is left facing the
       lens rather than put on the turntable. */
    assert.equal(slot.spinner.rotation.y, 0);
  }
  assert.equal(ctx.__dom.stageEmpty.hidden, true,
    'an effect fell back to the apology instead of previewing');
  assert.equal(ctx.__dom.stageKind.textContent, 'SHOT EFFECT');

  /* And it stops with the panel, like everything else in the case. */
  const before = shown[0].node.ticks;
  ctx.storeShow(false);
  ctx.__pump(3);
  assert.equal(shown[0].node.ticks, before);
});

test('the case is lit with the game\'s own numbers, not brighter ones', () => {
  const ctx = makeCase();
  ctx.storeShow(true);

  const lights = ctx.__log.lights;
  const rig = (kind, i) => lights.filter(l => l.kind === kind).map(l => l.intensity);

  /* initLights (src/10-core.js) and initViewmodel (src/40-weapons.js), to
     the digit. These are not decoration: MeshToonMaterial bands over a
     four-step gradient map and r128 does no tone mapping, so a total much
     past 1.35 clips the top band and every pastel in the shop comes out
     the same white. */
  const hemis = lights.filter(l => l.kind === 'hemi');
  const dirs = lights.filter(l => l.kind === 'dir');
  assert.deepEqual(hemis.map(l => l.intensity), [0.68, 0.50]);
  assert.deepEqual(dirs.map(l => l.intensity), [0.52, 0.15, 0.72, 0.22]);
  assert.deepEqual(hemis.map(l => [l.a.hex, l.b.hex]),
    [[0xdcefff, 0xffe0bd], [0xffffff, 0xd9c9e8]]);
  assert.deepEqual(dirs.map(l => l.a.hex), [0xfff4d9, 0xcfd9ff, 0xfff4d9, 0xc8d8ff]);
  assert.ok(rig('hemi')[0] + rig('dir')[0] + rig('dir')[1] <= 1.36);

  /* A character is lit the way the street lights one; a gun the way your
     own hands do. */
  const stage = () => ctx.__get('STAGE');
  ctx.stageSelect('char-midnight');
  assert.equal(stage().rigs.world.visible, true);
  assert.equal(stage().rigs.view.visible, false);
  ctx.stageSelect('rifle-berryswirl');
  assert.equal(stage().rigs.world.visible, false);
  assert.equal(stage().rigs.view.visible, true);
});

test('the default stands beside the skin until the toggle takes it away', () => {
  const ctx = makeCase();
  ctx.storeShow(true);
  ctx.stageSelect('char-sherbetfox');

  const stage = () => ctx.__get('STAGE');
  /* The value of a skin is the difference from what you already have, and
     that is not visible with only the skin on the shelf. */
  assert.ok(stage().slots[0].node, 'the default is not beside the skin');
  assert.ok(stage().slots[1].node);
  assert.notEqual(stage().slots[0].node, stage().slots[1].node);
  /* Standing apart, not inside each other. */
  assert.ok(stage().slots[0].pivot.position.x < 0);
  assert.ok(stage().slots[1].pivot.position.x > 0);
  assert.equal(ctx.__dom.stageTagA.hidden, false);
  assert.equal(ctx.__dom.stageTagB.textContent, 'SHERBET FOX');
  assert.equal(ctx.__dom.stageCompare.getAttribute('aria-pressed'), 'true');

  ctx.stageToggleCompare();
  assert.equal(stage().slots[0].node, null);
  assert.ok(stage().slots[1].node);
  assert.equal(stage().slots[1].pivot.position.x, 0);
  assert.equal(ctx.__dom.stageTagA.hidden, true);
  assert.equal(ctx.__dom.stageCompare.getAttribute('aria-pressed'), 'false');

  /* The camera was moved to fit what is actually there rather than left at
     a distance that happened to suit a character. */
  const far = stage().camera.position.z;
  ctx.stageToggleCompare();
  ctx.stageSelect('smg-cottoncloud');
  assert.ok(stage().camera.position.z < far,
    'a 0.5m gun is framed from no further back than a 1.8m character');
  assert.ok(stage().camera.position.z > 0);
});

test('an id this client has never heard of degrades to a sentence, not a throw', () => {
  /* A relay that ships a seventh cosmetic before the page that can draw
     it. The panel must keep working; it is not allowed to take the title
     screen down over a picture. */
  const ctx = makeCase({
    reply: url => /\/shop\/catalog/.test(url)
      ? { status: 200, body: [{ id: 'hat-mystery', name: 'Mystery Hat', type: 'hat', price: 499 }] }
      : { status: 404, body: null }
  });
  ctx.storeShow(true);

  assert.doesNotThrow(() => ctx.stageSelect('hat-mystery'));
  const stage = ctx.__get('STAGE');
  assert.equal(stage.slots[0].node, null);
  assert.equal(stage.slots[1].node, null);
  assert.equal(ctx.__dom.stageEmpty.hidden, false);
  assert.ok(ctx.__dom.stageEmpty.textContent.length > 0);
  /* Nothing to turn means nothing to draw. The cards take their pictures
     off the first frames after the panel opens — those are the renders
     being allowed for here — and after that an empty case costs nothing at
     all, however long it is left open. */
  ctx.__pump(4);
  const settled = ctx.__log.frames;
  ctx.__pump(6);
  assert.equal(ctx.__log.frames, settled, 'an empty case kept drawing');
  assert.equal(ctx.__pending(), 0, 'an empty case is still asking for frames');
  assert.equal(ctx.__get('STAGE').raf, 0);

  /* A weapon-shaped id whose paint this client does not have is a softer
     miss: the gun is still the gun, so it shows the gun. */
  assert.doesNotThrow(() => ctx.stageSelect('rifle-notyet'));
  assert.ok(ctx.__get('STAGE').slots[1].node, 'an unknown rifle skin lost the rifle too');
  assert.equal(ctx.__dom.stageEmpty.hidden, true);

  /* And the store still does its actual job. */
  assert.deepEqual(ctx.__json('EQUIPPED'), {
    character: null, effect: null, weapons: { smg: null, shotgun: null, rifle: null }
  });
});

test('closing the panel stops the case rendering', () => {
  const ctx = makeCase();
  ctx.storeShow(true);
  ctx.stageSelect('char-midnight');

  ctx.__pump(3);
  const drawn = ctx.__log.frames;
  assert.ok(drawn >= 3, 'the case never started: ' + drawn);
  assert.ok(ctx.__pending() > 0, 'no frame was queued for the case');

  /* CLOSE, Escape and the wash all arrive here. This runs beside a live
     match on a phone; a canvas turning behind a closed panel is frames
     taken off the game. */
  ctx.storeShow(false);
  assert.equal(ctx.__get('STAGE').raf, 0);
  assert.ok(ctx.__log.cancelled >= 1, 'the frame request was never cancelled');
  assert.equal(ctx.__pending(), 0);

  ctx.__pump(5);
  assert.equal(ctx.__log.frames, drawn, 'the case kept drawing after the panel closed');

  /* Belt as well as braces: a frame that was already in flight when the
     panel closed finds the door shut and does not queue another. */
  assert.doesNotThrow(() => ctx.stageTick());
  assert.equal(ctx.__log.frames, drawn);
  assert.equal(ctx.__pending(), 0);

  /* Opening it again picks the case back up rather than needing a reload. */
  ctx.storeShow(true);
  ctx.__pump(2);
  assert.ok(ctx.__log.frames > drawn);
});

test('a browser that cannot give the store a context still gets the store', async () => {
  for (const how of [{ noThree: true }, { contextFails: true }, { builderThrows: true }]) {
    const label = JSON.stringify(how);
    const ctx = makeCase(how);
    assert.doesNotThrow(() => ctx.storeShow(true), label);
    await settle();

    /* The case folds away and the cards go back to being the text-and-price
       layout they were before any of this existed — no dead preview
       buttons on them, and nothing thrown at the title screen. */
    if (!how.builderThrows) {
      assert.equal(ctx.__dom.storeStage.hidden, true, label);
      assert.equal(ctx.__get('STAGE.can'), false, label);
      assert.equal(ctx.__log.frames, 0, label);
      const cards = ctx.__dom.storeGrid.querySelectorAll('.spick');
      assert.ok(cards.length > 0, label);
      for (const pick of cards) assert.notEqual(pick.tagName, 'button', label);
    }
    assert.equal(ctx.__dom.storeGrid.querySelectorAll('.sitem').length, 9, label);
    assert.equal(ctx.storeSignedIn(), false, label);
    assert.deepEqual(ctx.__json('EQUIPPED'), {
      character: null, effect: null, weapons: { smg: null, shotgun: null, rifle: null }
    }, label);
  }
});

/* =====================================================================
   FRAMING

   The stage used to put the camera where a number said, and the number
   had been chosen against a gun: 0.9m of mostly horizontal detail. A
   character is 1.8m of mostly vertical detail, and the difference is a
   shopper looking at a headless torso while deciding whether to spend
   four dollars on the head.

   So the camera is derived from the bounding box, every time, and these
   tests do the projection by hand: every corner of every model that is
   mounted has to land inside the frustum, whatever shape it is. No
   pixels are needed to know that a corner behind the glass is a corner
   the shopper cannot see.
   ===================================================================== */

const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  unit: a => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
};

/* Where a world point lands in the camera's own frame, as a fraction of
   the half-frame: |x| and |y| under 1 is on screen. */
function project(cam, point) {
  const pos = [cam.position.x, cam.position.y, cam.position.z];
  const forward = V.unit(V.sub(cam.looked, pos));
  const right = V.unit(V.cross(forward, [0, 1, 0]));
  const up = V.cross(right, forward);
  const v = V.sub(point, pos);
  const depth = V.dot(v, forward);
  const vHalf = Math.tan(cam.fov * Math.PI / 360);
  return {
    depth: depth,
    x: V.dot(v, right) / (depth * vHalf * cam.aspect),
    y: V.dot(v, up) / (depth * vHalf)
  };
}

/* Every corner of the box a mounted model sweeps as it turns, in stage
   space: the stand's offset, the model's own swept radius, and its
   height standing on the floor. */
function cornersOf(slot) {
  const r = slot.node.userData.pnFlat, h = slot.node.userData.pnHeight;
  const x = slot.pivot.position.x, out = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, h])
    out.push([x + sx * r, y, sz * r]);
  return out;
}

function framing(ctx) {
  const stage = ctx.__get('STAGE');
  const cam = stage.camera;
  const seen = [];
  for (const slot of stage.slots) {
    if (!slot.node) continue;
    const points = cornersOf(slot).map(p => project(cam, p));
    seen.push({
      slot: slot,
      worst: {
        x: Math.max(...points.map(p => Math.abs(p.x))),
        top: Math.max(...points.map(p => p.y)),
        bottom: Math.min(...points.map(p => p.y))
      },
      /* Where the model's floor and its top land on the screen, which is
         what says whether two models were framed together. */
      floor: Math.max(...points.filter((p, i) => i % 2 === 0).map(p => p.y)),
      height: Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)),
      near: Math.min(...points.map(p => p.depth))
    });
  }
  return seen;
}

test('a 1.8m character is framed as completely as a 0.9m gun', () => {
  const ctx = makeCase();
  ctx.storeShow(true);

  /* Both kinds, and both with and without the default beside them: four
     different shapes of content through one piece of arithmetic. */
  for (const id of ['char-midnight', 'smg-cottoncloud', 'rifle-berryswirl', 'char-cloudknight']) {
    for (const compare of [true, false]) {
      ctx.stageSelect(id);
      if (ctx.__get('STAGE').compare !== compare) ctx.stageToggleCompare();
      const shown = framing(ctx);
      assert.ok(shown.length, id + ' put nothing in the case');
      for (const model of shown) {
        const where = id + (compare ? ' (compared)' : ' (alone)');
        assert.ok(model.near > 0, where + ' is behind the camera');
        assert.ok(model.worst.top <= 1, where + ' loses its head off the top: ' + model.worst.top);
        assert.ok(model.worst.bottom >= -1, where + ' is cut off at the bottom: ' + model.worst.bottom);
        assert.ok(model.worst.x <= 1, where + ' runs off the side: ' + model.worst.x);
        /* The captions are drawn over the bottom of the case. A pair of
           boots behind the word DEFAULT is not a preview of the boots. */
        assert.ok(model.worst.bottom >= -1 + 2 * 0.16 * 0.9,
          where + ' stands in the caption band: ' + model.worst.bottom);
      }
    }
  }
});

test('the camera is derived from the box, not from what kind of thing it is', () => {
  /* The same id, built twice at two sizes. Nothing about the item changed
     — only its geometry — and the framing has to follow it, because that
     is the whole difference between derived and guessed. */
  const near = makeCase({ skinBox: { min: [-0.3, 0, -0.3], max: [0.3, 0.9, 0.3] } });
  near.storeShow(true);
  near.stageSelect('char-midnight');
  near.stageToggleCompare();                      // the skin on its own

  const far = makeCase({ skinBox: { min: [-0.3, 0, -0.3], max: [0.3, 3.6, 0.3] } });
  far.storeShow(true);
  far.stageSelect('char-midnight');
  far.stageToggleCompare();

  const z = ctx => ctx.__get('STAGE').camera.position.z;
  assert.ok(z(far) > z(near) * 2,
    'a model four times as tall was framed from the same distance: ' + z(near) + ' vs ' + z(far));
  for (const ctx of [near, far])
    for (const model of framing(ctx)) {
      assert.ok(model.worst.top <= 1, 'cropped at the top: ' + model.worst.top);
      assert.ok(model.worst.bottom >= -1, 'cropped at the bottom: ' + model.worst.bottom);
    }
});

test('the default and the skin are framed as one group, so a taller skin looks taller', () => {
  /* A skin framed on its own would be blown up to fill the same window as
     the default beside it, and a shop that draws a hat twice the size of
     the head it sits on is a shop lying about what it is selling. */
  const ctx = makeCase({ skinBox: { min: [-0.42, 0, -0.36], max: [0.42, 2.20, 0.36] } });
  ctx.storeShow(true);
  ctx.stageSelect('char-sherbetfox');

  const shown = framing(ctx);
  assert.equal(shown.length, 2, 'the default is not beside the skin');
  const [base, skin] = shown;

  /* Both feet on the same line: one floor, one group, one camera. */
  assert.ok(Math.abs(base.floor - skin.floor) < 0.02,
    'the two are standing at different heights: ' + base.floor + ' vs ' + skin.floor);
  /* And the taller one is honestly taller — 2.20m against 1.83m. */
  const ratio = skin.height / base.height;
  assert.ok(ratio > 1.15 && ratio < 1.30, 'the pair does not share a scale: ' + ratio);
  for (const model of shown) {
    assert.ok(model.worst.top <= 1, 'the group crops: ' + model.worst.top);
    assert.ok(model.worst.bottom >= -1, 'the group crops: ' + model.worst.bottom);
  }
});

/* =====================================================================
   THE PICTURES ON THE CARDS
   ===================================================================== */

test('every card gets a render of its own item, drawn once and not once a frame', () => {
  const ctx = makeCase();
  const canvas = ctx.__dom.storeCanvas;
  ctx.storeShow(true);
  assert.equal(canvas.shots, 0, 'the panel waited on six renders before it appeared');

  ctx.__pump(4);
  assert.equal(canvas.shots, CASE_IDS.length,
    'one picture per item, and no more: ' + canvas.shots);

  /* Six pictures, six cards, and the gradient still under each of them for
     the browsers that never get this far. */
  const shots = ctx.__dom.storeGrid.querySelectorAll('.sshot');
  assert.equal(shots.length, CASE_IDS.length);
  for (const img of shots) assert.ok(/^data:image/.test(img.src), img.src);
  for (const swatch of ctx.__dom.storeGrid.querySelectorAll('.swatch'))
    assert.ok(/linear-gradient/.test(swatch.style.background), 'the fallback wash is gone');

  /* The whole reason to cache them: this runs beside a live match. Frames
     go by, the grid is redrawn, the panel is closed and opened — and the
     renderer is not asked for another picture. */
  ctx.__pump(30);
  ctx.storeRenderGrid();
  ctx.storeShow(false);
  ctx.storeShow(true);
  ctx.__pump(10);
  assert.equal(canvas.shots, CASE_IDS.length, 'pictures were retaken: ' + canvas.shots);
  assert.equal(ctx.__log.renderers.length, 1, 'a second context was made for the cards');

  /* And the case itself came back from being borrowed for the cards. */
  ctx.stageSelect('char-midnight');
  ctx.__pump(2);
  assert.ok(ctx.__get('STAGE').slots.some(s => s.node), 'the case never got its models back');
  assert.deepEqual(ctx.__get('STAGE.renderer').sized.slice(0, 2), [340, 272],
    'the renderer was left at the thumbnail size');
});

test('a card whose picture cannot be taken keeps the gradient it always had', () => {
  const ctx = makeCase();
  ctx.__dom.storeCanvas.shotFails = true;
  assert.doesNotThrow(() => ctx.storeShow(true));
  assert.doesNotThrow(() => ctx.__pump(4));

  assert.equal(ctx.__dom.storeGrid.querySelectorAll('.sshot').length, 0);
  const swatches = ctx.__dom.storeGrid.querySelectorAll('.swatch');
  assert.equal(swatches.length, 9);
  for (const swatch of swatches)
    assert.ok(/linear-gradient/.test(swatch.style.background));

  /* Failing to take a picture is not a reason to stop trying to show the
     case, or to stop being a shop. */
  assert.equal(ctx.__dom.storeStage.hidden, false);
  assert.deepEqual(ctx.__json('EQUIPPED'), {
    character: null, effect: null, weapons: { smg: null, shotgun: null, rifle: null }
  });
});

/* =====================================================================
   THE PRICE ON THE CARD

   /shop/catalog answers { unitAmount, currency } — Stripe's smallest unit
   with a name on it — and the card used to hand that object to a formatter
   that only read strings and numbers, so every shelf in the store showed a
   blank where the price belongs. These pin the shape the relay actually
   sends, and the two older shapes the formatter has always understood.
   ===================================================================== */

test('a price is read in the shape the relay sends it', () => {
  const ctx = makeStore();
  assert.equal(ctx.storePriceText({ unitAmount: 499, currency: 'usd' }), '$4.99');
  assert.equal(ctx.storePriceText({ unitAmount: 425, currency: 'eur' }), '€4.25');
  assert.equal(ctx.storePriceText({ unitAmount: 350, currency: 'gbp' }), '£3.50');
  /* Stripe counts a yen whole, so the unit is not divided away. */
  assert.equal(ctx.storePriceText({ unitAmount: 1200, currency: 'jpy' }), '¥1200');
  /* A currency with no symbol in the table keeps its code. */
  assert.equal(ctx.storePriceText({ unitAmount: 500, currency: 'sek' }), 'SEK 5.00');
  /* The two older shapes keep working. */
  assert.equal(ctx.storePriceText(499), '$4.99');
  assert.equal(ctx.storePriceText('4.99 kr'), '4.99 kr');
  /* Anything unreadable leaves the space empty rather than lying. */
  assert.equal(ctx.storePriceText(null), '');
  assert.equal(ctx.storePriceText({}), '');
  assert.equal(ctx.storePriceText({ unitAmount: -5, currency: 'usd' }), '');
  assert.equal(ctx.storePriceText({ unitAmount: '499', currency: 'usd' }), '');
});

test('the cards show the prices the catalog sends', async () => {
  /* The body is the envelope account-store.mjs answers with, and each item
     is the shape shop.mjs builds — displayName, available, and a price
     object, exactly as a signed-out page load receives them. */
  const ctx = makeCase({
    reply: url => /\/shop\/catalog/.test(url)
      ? { status: 200, body: { items: [
            { id: 'smg-cottoncloud', displayName: 'Folded Paper Crane', type: 'weapon',
              slot: 'smg', productKind: 'cosmetic', available: true,
              price: { unitAmount: 499, currency: 'usd' } },
            { id: 'char-midnight', displayName: 'Midnight', type: 'character',
              slot: null, productKind: 'cosmetic', available: true,
              price: { unitAmount: 425, currency: 'eur' } },
            { id: 'fx-starfall', displayName: 'Starfall', type: 'effect',
              slot: null, productKind: 'cosmetic', available: true,
              price: { unitAmount: 1200, currency: 'jpy' } }
          ] } }
      : { status: 404, body: null }
  });
  ctx.storeShow(true);
  await settle();

  const prices = ctx.__dom.storeGrid.querySelectorAll('.sprice')
    .map(el => el.textContent);
  assert.deepEqual(prices, ['$4.99', '€4.25', '¥1200']);
});

/* ---------------------------------------------------------------------
   THE PANEL ON A PHONE HELD SIDEWAYS

   This game is played in landscape, which is about 640x296 of layout
   viewport once Android has taken its bars. Everything on the card is a
   fixed height there — a 44px CLOSE, a 44px compare button, a case with a
   floor under it — and stacked they came to more than the card, so the
   grid was squeezed to six pixels and the bottom of the panel walked off
   the screen. Nine items for sale and not one of them reachable.

   Neither half of the fix is visible to a unit test: it is CSS, and the
   fake DOM these tests run against does not do layout. What is testable is
   that the two pieces the fix is made of are both still there — the
   wrapper the case and the shelf share, and the rule that turns that
   wrapper sideways — because either one going missing on its own puts the
   panel straight back to unusable with every other test in this file
   still green.
   --------------------------------------------------------------------- */
const BODY_HTML = fs.readFileSync(path.join(__dirname, 'src', '01-body.html'), 'utf8');

test('the case and the shelf are in one box, so they can sit side by side', () => {
  const open = BODY_HTML.indexOf('<div class="store-body">');
  assert.ok(open > 0, 'no .store-body wrapper — the landscape rules have nothing to flip');

  /* Both of them inside it, and the grid last, so the row reads case then
     shelf in source order as well as on screen. */
  const stage = BODY_HTML.indexOf('id="storeStage"', open);
  const grid = BODY_HTML.indexOf('id="storeGrid"', open);
  assert.ok(stage > open, 'the display case is outside .store-body');
  assert.ok(grid > stage, 'the grid is outside .store-body, or above the case in it');

  /* And the wrapper closes after the grid rather than between the two. */
  const card = BODY_HTML.indexOf('class="store-card', 0);
  assert.ok(card > 0 && card < open, '.store-body is not inside the card');
});

/* The body of one @media block, brace-counted rather than matched to the
   next `}` — the rules inside have braces of their own, and more than one
   block in this stylesheet opens with the same query. `mentioning` is which
   of those is wanted; the short-screen query is shared with the title
   card's rules, which are not these. */
function mediaBlock(query, mentioning) {
  for (let at = HEAD.indexOf(query); at >= 0; at = HEAD.indexOf(query, at + 1)) {
    let depth = 0, i = HEAD.indexOf('{', at);
    const from = i + 1;
    for (; i < HEAD.length; i++) {
      if (HEAD[i] === '{') depth++;
      else if (HEAD[i] === '}' && --depth === 0) break;
    }
    const body = HEAD.slice(from, i);
    if (!mentioning || body.includes(mentioning)) return body;
  }
  return null;
}

test('a short screen puts the case beside the shelf and keeps a row of stock on it', () => {
  const short = mediaBlock('@media(max-height:430px){', '#storeGrid');
  assert.ok(short, 'the short-screen store rules are gone from src/00-head.html');

  /* The floor under the grid. Without it the case takes what it wants and
     the shelf gets the remainder, which is what six pixels was. */
  const floor = short.match(/#storeGrid\{[^}]*min-height:(\d+)px/);
  assert.ok(floor, 'the grid has no min-height on a short screen');
  assert.ok(Number(floor[1]) >= 80,
    `a ${floor[1]}px floor is not a row of stock`);

  /* And what pays for it: the case has to be able to give the difference
     up. `flex:none` is what it is everywhere else and what made the panel
     overflow here. */
  assert.ok(/\.store-stage\{[^}]*flex:0 1 auto/.test(short),
    'the case is still unshrinkable on a short screen');
  assert.ok(/\.stage-case\{[^}]*min-height:0/.test(short),
    'the case cannot shrink past its own content without min-height:0');

  /* The landscape rule itself: wide enough for two columns, so stop
     stacking. The width it turns on has to be under the narrowest phone
     anybody holds sideways, which is 568. */
  const header = HEAD.match(/@media\(max-height:430px\) and \(min-width:(\d+)px\)\{/);
  assert.ok(header, 'nothing turns the panel sideways on a landscape phone');
  assert.ok(Number(header[1]) <= 568,
    `a ${header[1]}px threshold leaves the smallest landscape phone stacked`);
  const wide = mediaBlock(header[0]);
  assert.ok(/\.store-body\{[^}]*flex-direction:row/.test(wide),
    'the landscape block does not put the case beside the shelf');
});

test('the battle pass mirrors the mobile store split without clipping a reward lane', () => {
  const open = BODY_HTML.indexOf('<div class="bp-body">');
  assert.ok(open > 0, 'no .bp-body wrapper — the pass cannot split like the store');
  const summary = BODY_HTML.indexOf('class="bp-summary"', open);
  const ladder = BODY_HTML.indexOf('class="bp-ladder-wrap"', open);
  assert.ok(summary > open && ladder > summary,
    'the battle-pass summary and reward shelf are not ordered inside .bp-body');

  const landscape = mediaBlock('@media(max-height:430px){', '.bp-body');
  assert.ok(landscape, 'the landscape battle-pass rules are gone');
  assert.ok(/\.bp-body\{[^}]*flex-direction:row/.test(landscape),
    'the battle pass does not split into summary and rewards in landscape');
  assert.ok(/\.bp-ladder-wrap\{[^}]*min-width:0/.test(landscape),
    'the reward shelf cannot shrink inside the landscape row');

  const short = mediaBlock('@media(max-height:330px) and (min-width:560px){');
  assert.ok(short, 'the screenshot-height battle-pass rules are gone');
  assert.ok(/\.bp-progress\{[^}]*flex-direction:row/.test(short),
    'the progress card remains too tall on the shortest landscape phones');
  const node = short.match(/\.bp-node,\.bp-lane-label\{[^}]*height:(\d+)px/);
  assert.ok(node && Number(node[1]) <= 60,
    'both reward lanes no longer fit at the screenshot-height breakpoint');
});

/* =====================================================================
   THE WIDE TITLE SCREEN

   A HUD around a character rather than a column of cards, which means the
   layout is a grid of named corners. Each test below is a mistake this
   arrangement actually made on the way in.
   ===================================================================== */

const HUD_QUERY = '@media (min-width:640px) and (min-aspect-ratio:13/10)';

function hudBlock() {
  const body = mediaBlock(HUD_QUERY, '#title.hud{');
  assert.ok(body, 'the wide title screen rules are gone from src/00-head.html');
  return body;
}

/* The rule body of a single selector inside a block, brace-matched so a
   nested grid declaration cannot be mistaken for the outer one. */
function ruleBody(css, selector) {
  const at = css.indexOf(selector + '{');
  if (at < 0) return null;
  return css.slice(at + selector.length + 1, css.indexOf('}', at));
}

test('every corner of the wide title screen is claimed by name', () => {
  const hud = hudBlock();
  const grid = ruleBody(hud, '#title.hud');
  assert.ok(grid, '#title.hud has no rule of its own');

  const template = grid.match(/grid-template-areas:([^;]+);/);
  assert.ok(template, 'the layout names no areas');
  const cells = new Set((template[1].match(/"[^"]*"/g) || [])
    .join(' ').replace(/"/g, ' ').trim().split(/\s+/).filter(Boolean));

  /* What each area holds. An element that is on the screen and not in here
     is auto-placed, which is how the previous attempt at this layout ended
     up with the key legend sitting on top of the status line: the grid
     invents a row for anything it was not told about. */
  const placed = {
    '.hud-player': 'tl', 'h1': 'h1', '.hud-meta': 'tr',
    '.locker': 'lft', '.menu-hero': 'mid', '.hud-rail': 'rgt',
    '#menuNote': 'note', '.hud-season': 'bl', '#modePicker': 'mode',
    '.menu-actions': 'br',
  };
  const claimed = new Set();
  for (const [sel, area] of Object.entries(placed)) {
    const re = new RegExp('#title\\.hud [^{}]*' +
      sel.replace('.', '\\.') + '\\{[^}]*grid-area:' + area + '\\b');
    assert.ok(re.test(hud), `${sel} is not placed in the ${area} corner`);
    claimed.add(area);
  }
  assert.deepStrictEqual([...cells].sort(), [...claimed].sort(),
    'the template and the placements disagree about which corners exist');
});

test('the three layers that are not corners stay out of the grid', () => {
  const hud = hudBlock();
  /* Scenery, a popover and a footnote. Each one would otherwise take a cell
     of its own -- the social link did exactly that, and drew itself as a
     panel filling the bottom-left corner. */
  for (const sel of ['.hud-stage', '.menu-settings', '.social']) {
    const rule = ruleBody(hud, '#title.hud ' + sel);
    assert.ok(rule && /position:absolute/.test(rule),
      `${sel} is in flow, so it is taking a grid cell`);
  }
  /* And the scenery goes behind rather than the content being lifted in
     front of it: a blanket `position:relative` on #menu's children carries
     two ids and silently outranks every rule above. */
  assert.ok(/#title\.hud \.hud-stage\{[^}]*z-index:-1/.test(hud),
    'the stage is not the layer behind the content');
  assert.ok(!/#title\.hud #menu>\*\{[^}]*position:relative/.test(hud),
    'the blanket position rule is back, and it outranks the rules below it');
});

test('the wide layout does not inherit .screen centring for its rows', () => {
  const grid = ruleBody(hudBlock(), '#title.hud');
  /* .screen is a centred flex column. `align-items:center` survives the
     switch to grid, where it stops meaning "centre the column" and starts
     meaning "every item is as tall as its own content" -- which collapses
     the character's row to nothing, because the character is out of flow. */
  assert.ok(/align-items:stretch/.test(grid),
    'the grid still takes align-items:center from .screen');
});

test('the character and its badge are laid out, not pinned', () => {
  const hud = hudBlock();
  const img = ruleBody(hud, '#title.hud .menu-hero img');
  assert.ok(img, 'the character has no rule');
  /* Pinning the badge to the picture's box cannot put it on the head:
     `contain` letterboxes the raster inside the img, so the img's top edge
     is not the character's — and when the row is shorter than the cap, an
     absolute badge is pushed clean out of the row and onto the wordmark.
     As flex items in one column they stack, and neither can escape. */
  const box = ruleBody(hud, '#title.hud .menu-hero');
  assert.ok(/display:flex/.test(box) && /flex-direction:column/.test(box),
    'the character box is not a column, so the badge is pinned again');
  assert.ok(/flex:none/.test(ruleBody(hud, '#title.hud .hero-rank')),
    'the badge is not a flex item of that column');
  assert.ok(/flex:1 1 auto/.test(img) && /min-height:0/.test(img),
    'the character cannot give its row back the space the badge needs');
  /* `contain` is what both bounds the still and lets it scale up. `width:auto`
     bounds it too, but only downwards -- which made the raster a ceiling on
     how big the character could ever be, so the taller the display, the
     smaller a share of it the character took. */
  assert.ok(/object-fit:contain/.test(img), 'nothing bounds the character');
  const height = img.match(/max-height:(\d+)vh/);
  assert.ok(height, 'the character is not capped against the window');
  assert.ok(Number(height[1]) >= 45 && Number(height[1]) <= 62,
    `${height[1]}vh leaves no room for the wordmark above the character`);
  assert.ok(/min-height:0/.test(box),
    'without min-height:0 the row cannot shrink below the picture');
});

test('the wordmark is across the top, not through the character', () => {
  const hud = hudBlock();
  /* It sits in a row of its own above the character. In the middle column it
     was 10vw of display type standing exactly where the head goes, which is
     what made that attempt read as a poster rather than a menu. */
  const h1 = ruleBody(hud, '#title.hud h1');
  assert.ok(h1 && /grid-area:h1/.test(h1), 'the wordmark is not in its own row');
  const size = h1.match(/font-size:clamp\([^,]+,([\d.]+)vw/);
  assert.ok(size && Number(size[1]) <= 5,
    `${size && size[1]}vw is the size that crowded the character out of the middle`);
  /* And it has to leave room for the sub-line it shares the row with, or the
     tier badge in the row below lands on top of it. */
  assert.ok(/padding-bottom:clamp/.test(h1), 'the wordmark row cannot hold its own sub-line');
  /* The key legend is the one thing with no home here — still on the column
     and the pause card, which is where somebody looking up a key is. */
  assert.ok(/#title\.hud \.keys\{display:none\}/.test(hud), 'the key legend is back on the HUD');
  /* The boot screen kept the copy it was given when the title screen had
     none, and it is still the first thing the game says. */
  assert.ok(/<div id="loading">[^]*?class="lmark">PASTEL<em>NUKETOWN<\/em>/.test(BODY_HTML),
    'the boot screen lost the wordmark');
});

test('the room browser is a dialog and keeps every id the network drives', () => {
  /* Moved out of the middle of the title card, where it competed with PLAY
     for the same glance. 75-network.js was not rewritten to match, so every
     id it reaches for has to still be here. */
  const card = BODY_HTML.match(/<div class="screen off" id="rooms"[^]*?\n<\/div>/);
  assert.ok(card, 'there is no room browser dialog');
  for (const id of ['roomList', 'roomCode', 'joinGame', 'hostGame', 'roomPublic',
                    'refreshRooms', 'roomsClose']) {
    assert.ok(card[0].includes('id="' + id + '"'), `#${id} is not in the dialog`);
  }
  /* And the way in, on the right rail. */
  assert.ok(/id="roomsOpen"/.test(BODY_HTML), 'nothing opens the room browser');
  /* The collapsed panel it replaces is gone rather than left behind hidden. */
  assert.ok(!/id="roomToggle"/.test(BODY_HTML),
    'the old collapse toggle is still in the markup');
  assert.ok(!/id="roomToggle"/.test(fs.readFileSync(path.join(__dirname, 'src', '75-network.js'), 'utf8')),
    '75-network.js still wires a toggle that no longer exists');
});

test('the wide layout is measured from the corners of the screen', () => {
  const grid = ruleBody(hudBlock(), '#title.hud');
  /* A fixed content cap put 428 points of nothing outside every corner on a
     2495-wide display, and the arrangement stopped reading as a HUD. The
     padding is a share of the window now, and bounded so it cannot run away
     on an ultrawide. */
  assert.ok(!/calc\(\(100vw - \d+px\) \/ 2\)/.test(grid),
    'the fixed content cap is back, and it strands the corners');
  const pad = grid.match(/--hud-pad:clamp\((\d+)px,([\d.]+)vw,(\d+)px\)/);
  assert.ok(pad, 'the padding does not scale with the window');
  assert.ok(Number(pad[3]) <= 80, `a ${pad[3]}px outer margin is a cap by another name`);
  /* And the rails scale with it, or the HUD stays laptop-sized in a bigger
     frame -- which is the same complaint from the other direction. */
  assert.ok(/grid-template-columns:clamp\(/.test(grid),
    'the rails are a fixed width at every screen size');
});

test('the character raster is drawn to the window, not to one fixed size', () => {
  /* The CSS can only scale a still it was given. A 440x680 raster is a
     ceiling: upscaled it goes soft, so it simply stopped growing, and on a
     tall display the character was 46% of the frame. */
  assert.ok(/function menuHudHeroSize\(\)/.test(SOURCE),
    'the hero raster is a constant again');
  const fn = SOURCE.slice(SOURCE.indexOf('function menuHudHeroSize()'));
  assert.ok(/innerHeight/.test(fn.slice(0, 500)), 'the raster ignores the window height');
  assert.ok(/devicePixelRatio/.test(fn.slice(0, 500)), 'the raster ignores pixel density');
  /* Bounded at both ends: a floor for a laptop, and a ceiling because past
     it this is a data URL nobody can see the difference in. */
  assert.ok(/MENU_HUD_HERO_MIN\s*=\s*\d+/.test(SOURCE) && /MENU_HUD_HERO_MAX\s*=\s*\d+/.test(SOURCE),
    'the raster size is unbounded');
  /* And a resize redraws it, or the character stays whatever size the window
     happened to be at boot. */
  assert.ok(/addEventListener\('resize'/.test(SOURCE), 'a resized window never redraws the character');
  assert.ok(/MENU_HUD_HERO_SLACK/.test(SOURCE),
    'every resize event redraws, which is a render and a PNG encode per frame');
});

test('the season corner is on the screen whether or not there is a climb', () => {
  /* It used to hide itself when /battlepass/me had nothing to report, which
     is most of the time: server.mjs awards match XP against an account
     identity, so a signed-out player earns nothing and would never see this
     corner at all. Hiding the one thing that says the season exists is the
     opposite of what the corner is for. */
  assert.ok(!/id="hudPass"[^>]*\shidden/.test(BODY_HTML),
    'the season corner still ships hidden');
  /* Plate and strip are one stack, so the corner is laid out rather than two
     things aligned to the same edge and held apart by arithmetic. */
  assert.ok(/<div class="hud-season setup-only">[^]*?id="hudPass"[^]*?id="hudTrack"/.test(BODY_HTML),
    'the plate and the reward strip are not one corner');
  /* And it is the way in, the way the mockup's pass widget is. */
  assert.ok(/<button class="hud-pass[^"]*" id="hudPass"/.test(BODY_HTML),
    'the season corner is not pressable');
  assert.ok(/pass\.addEventListener\('click', \(\) => battlepassShow\(true\)\)/.test(SOURCE),
    'pressing the season corner does not open the pass');

  /* What it says with nothing to report. A tier is a standing and there
     isn't one, so it must not draw a zero — it says what would change
     that. */
  const render = SOURCE.slice(SOURCE.indexOf('function menuHudRenderSeason()'));
  const idle = render.slice(0, render.indexOf('const pct'));
  assert.ok(/rank\.hidden = true/.test(idle),
    'a signed-out player is shown a tier badge over their character');
  assert.ok(/SIGN IN TO EARN XP/.test(idle), 'the idle corner does not say what to do');
  assert.ok(!/TIER ' \+/.test(idle), 'the idle corner draws a tier nobody is on');
});

test('the stage is a place, not a wash', () => {
  const hud = hudBlock();
  /* A flat gradient behind a character is what made the first pass read as
     floating. The floor needs a horizon that fades rather than cuts, and
     tiles that actually recede. */
  for (const layer of ['.hud-sky', '.hud-floor', '.hud-grid']) {
    assert.ok(HEAD.includes(layer + '{'), `${layer} is gone from the stage`);
  }
  assert.ok(/<i class="hud-floor"><i class="hud-grid"><\/i><\/i>/.test(BODY_HTML),
    'the grid is not inside the floor, so it cannot be clipped by it');
  const grid = ruleBody(HEAD, '.hud-grid');
  assert.ok(/perspective\(/.test(grid) && /rotateX\(/.test(grid),
    'the floor tiles do not recede, so the floor is a band of colour');
  assert.ok(/mask-image/.test(grid),
    'the grid runs into the horizon, where it turns into moire');
  const floor = ruleBody(HEAD, '.hud-floor');
  assert.ok(/rgba\(255,255,255,0\) 0/.test(floor),
    'the floor has a hard top edge, which cuts the sky rather than meeting it');
  /* The picture is the stage's subject, so it has to sit in front of the
     street rather than be tinted by it. (What keeps the badge off the
     wordmark is the column in the test above, not overflow.) */
  assert.ok(/\.hud-scene\{[^}]*position:absolute/.test(HEAD),
    'the street is in flow, so it is taking a grid cell');
});

test('the street is inlined at build time, so the page stays one file', () => {
  const build = fs.readFileSync(path.join(__dirname, 'build.sh'), 'utf8');
  /* server.mjs serves exactly two paths — / and /net-protocol.js — so a
     relative URL would 404 for anyone the relay is serving, and teaching it
     a static route would turn a picture into a relay deploy. */
  assert.ok(/base64 -w0 art\/nuketown-street\.webp/.test(build),
    'the backdrop is not inlined, so it is a request the relay cannot answer');
  assert.ok(fs.existsSync(path.join(__dirname, 'art', 'nuketown-street.webp')),
    'the backdrop art is missing');
  /* Small enough that inlining it is cheaper than a second request: this is
     under a tenth of what three.js costs on the same page. */
  const bytes = fs.statSync(path.join(__dirname, 'art', 'nuketown-street.webp')).size;
  assert.ok(bytes < 220 * 1024, `${Math.round(bytes / 1024)} KB is too much to inline`);
  /* And it really is in the built page rather than only in the recipe. */
  const built = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(built.includes('data:image/webp;base64,'), 'the built page has no backdrop in it');
});

test('the mode card is decoration over the two real toggles', () => {
  /* Two buttons carrying aria-pressed are what a group of two modes needs,
     and they are what the column and the pause card show. The card is the
     wide layout's picture of the same state, so it must not become a third
     source of truth: it is filled from syncModePicker, which is the one
     place that already knows which mode is live, and CHANGE MODE presses
     the toggle rather than setting the mode itself. */
  const main = fs.readFileSync(path.join(__dirname, 'src', '90-main.js'), 'utf8');
  const sync = main.slice(main.indexOf('function syncModePicker'));
  const body = sync.slice(0, sync.indexOf('\nfunction '));
  assert.ok(/modeCardName/.test(body) && /modeCardGoal/.test(body),
    'the mode card is filled somewhere other than syncModePicker');
  assert.ok(/chooseMode\(G\.mode === 'kc' \? 'dm' : 'kc'\)/.test(main),
    'CHANGE MODE does not go through the same path as the buttons');
  /* The toggles stay in the accessibility tree when the card covers them —
     clipped, not display:none, or a screen reader loses the control. */
  const hud = hudBlock();
  const opts = ruleBody(hud, '#title.hud .mode-options');
  assert.ok(opts && /clip-path/.test(opts) && !/display:none/.test(opts),
    'the wide layout hides the mode toggles from assistive tech');
  /* The card and its button are the wide layout's alone; in the column the
     toggles are the control and a second one would be clutter. */
  assert.ok(/\.menu-gear,\.hud-season,\.menu-hero,\.mode-card,\.mode-swap\{display:none\}/.test(HEAD),
    'the mode card leaks into the narrow column');
});

test('a short screen takes the room out of the mode card, not the character', () => {
  /* The character is the only element here that can shrink — it is the flex
     item with min-height:0, and everything around it is clamp()ed to a
     floor — so on a short screen it paid for all of them. At 875x406 the
     mode row was 208 points of a 406-point window and the character's row
     was 50: 13% of the frame for the one thing the screen is about.

     The fix is not to shrink the character further but to stop the card
     having a floor it does not need. The strip of street is decoration and
     the blurb restates the name and the goal, so on a short screen they go
     and the card lands under the PLAY/SOLO stack beside it — which the
     bottom band cannot be shorter than anyway, so it costs nothing. */
  const short = mediaBlock('@media (min-width:640px) and (max-height:480px){', '#title.hud');
  assert.ok(short, 'the short-screen rules are gone from src/00-head.html');
  assert.ok(/\.mode-card-art,#title\.hud \.mode-card-blurb\{display:none\}/.test(short),
    'the mode card keeps its decoration on a screen with no room for it');
  assert.ok(/#title\.hud \.mode-swap\{[^}]*min-height:3\dpx/.test(short),
    'CHANGE MODE keeps the tall-screen tap target that pushed the card over');

  /* And the pieces that were sized against the viewport still are, so the
     card is not simply pinned small everywhere. */
  const hud = hudBlock();
  assert.ok(/height:clamp\(/.test(ruleBody(hud, '.mode-card-art') || ''),
    'the mode card art no longer scales on a screen that has the room');
});

test('a signed-in load asks for the season, so the title plate is not a guess', async () => {
  /* The season plate in the bottom corner draws BATTLEPASS.me, and the only
     thing that used to fill it was opening the pass screen. So a signed-in
     player was met by their own season reading SEASON NOT RUNNING until they
     pressed SEASON 1 once, after which it was suddenly right — the corner
     reporting the absence of an answer nobody had asked for. Entitlements were
     already fetched on every load for the same class of reason; the season is
     the other half of what the title screen draws about the player. */
  const ctx = makeStore({
    reply: url => url.endsWith('/battlepass/me')
      ? { status: 200, body: { xp: 900, tier: 3, premium: false, earned: [] } }
      : { status: 200, body: { userId: 'u1', email: 'p@e.com', displayName: 'P', entitlements: [] } }
  });
  ctx.localStorage.setItem('pastel-nuketown-token', JSON.stringify({
    token: 'SECRET-TOKEN-THAT-IS-LONG-ENOUGH', origin: RELAY, expiresAt: Date.now() + 3600000
  }));

  ctx.initStore();
  await settle();
  await settle();

  const asked = ctx.calls.filter(c => c.url === RELAY + '/battlepass/me');
  assert.equal(asked.length, 1, 'a signed-in load never asks the relay for the season');
  assert.ok(asked[0].headers && asked[0].headers['Authorization'],
    'the season is asked for without the token that identifies whose it is');
});

test('a signed-out load does not ask the relay for a season nobody owns', async () => {
  const ctx = makeStore({ reply: () => ({ status: 200, body: {} }) });
  ctx.initStore();
  await settle();
  assert.equal(ctx.calls.filter(c => c.url.endsWith('/battlepass/me')).length, 0);
});

test('a landscape phone keeps the wordmark legibly the wordmark', () => {
  /* 2.9vw was 25px on an 873-point phone. Baloo 2 is a display face and at
     25px it flattens out — the reported symptom was "why is the mobile font
     different", and the font is not different: it measures as Baloo 2 at every
     width. It was simply small enough to stop looking like itself. */
  const short = mediaBlock('@media (min-width:640px) and (max-height:480px){', '#title.hud');
  assert.ok(short, 'the short-screen rules are gone from src/00-head.html');
  const h1 = short.match(/#title\.hud h1\{font-size:clamp\((\d+)px,([\d.]+)vw,(\d+)px\)/);
  assert.ok(h1, 'the short-screen wordmark no longer sets a clamped size');
  assert.ok(Number(h1[1]) >= 26,
    'the wordmark floor is back under the size where the lettering stops reading');
  /* The slope matters as much as the floor: the floor only bites under about
     650 points of width, and the phones in question are wider than that. */
  const atTypicalPhone = Math.max(Number(h1[1]), 873 * Number(h1[2]) / 100);
  assert.ok(atTypicalPhone >= 32,
    'an 873-point phone draws the wordmark at only ' + Math.round(atTypicalPhone) + 'px');
});

test('the short-screen economy is the column\'s, not the corner layout\'s', () => {
  /* The tagline, the counts and the social link are dropped at 430 points of
     height. That was written for the column — one stack down the middle, where
     everything charges the stack its own height. The HUD is corners: the counts
     sit in the top-right cell beside the gear, in a row already sized by the
     player card opposite them, and the social link is absolutely positioned in
     the bottom-left and has never taken part in the layout. Hiding those two
     bought no height and cost the player the matches-played count — the one
     number on the title screen that says somebody else is here.

     So the rules are scoped to the column. If the `:not(.hud)` comes off, a
     landscape phone silently loses its furniture again. */
  const shortest = mediaBlock('@media(max-height:430px){');
  assert.ok(shortest, 'the 430-point rules are gone from src/00-head.html');
  /* Read as selectors rather than as substrings: `.sub{display:none}` is a
     substring of the scoped rule too, so a text search cannot tell the fix
     from the bug. */
  const selectors = shortest.split('}')
    .map(rule => rule.slice(0, rule.indexOf('{')).trim())
    .filter(Boolean)
    .flatMap(list => list.split(',').map(one => one.trim()));

  for (const sel of ['.sub', '.online-count', '.social']) {
    assert.ok(shortest.includes('#title:not(.hud) ' + sel + '{display:none}'),
      sel + ' is hidden on a short screen without asking which layout is on');
    assert.ok(!selectors.includes(sel),
      sel + ' is still hidden unscoped, which reaches the wide layout too');
  }
});

test('the wide title screen still goes away when the match starts', () => {
  /* The bug this closes: `.screen.off{display:none}` is two classes and
     `#title.hud` is an id and a class, so the wide layout quietly outranked
     the class that takes every screen down. startMatch added `off` to #title
     and nothing happened — the title HUD stayed at full size over the running
     match, and because it is a grid of corner tiles the clicks went to it and
     not to the game. PLAY sat live on top of a match in progress.

     Asserted as specificity rather than as text, because the fix is only a
     fix if it outranks the rule that caused it. */
  const hud = hudBlock();
  assert.ok(/display:grid/.test(ruleBody(hud, '#title.hud') || ''),
    'the wide title screen no longer sets its own display');
  const off = ruleBody(hud, '#title.hud.off');
  assert.ok(off, '#title.hud.off has no rule, so `off` cannot hide the wide layout');
  assert.ok(/display:none/.test(off),
    '#title.hud.off does not hide the title');

  /* And it has to sit inside the same media block as the grid it undoes: a
     copy outside it would be right by accident and would stop being right the
     moment the layout moved. */
  const at = hud.indexOf('#title.hud.off{');
  assert.ok(at > hud.indexOf('#title.hud{'),
    'the override is not stated alongside the layout it corrects');
});
