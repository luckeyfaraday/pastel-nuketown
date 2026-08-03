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

  /* What the head's inline scrubber left behind, when a test wants the store
     to find the callback the way it really arrives in the built page. */
  if (opts.stashed) {
    let found = opts.stashed;
    ctx.__pnTakeAuthCallback = () => {
      const taken = found;
      found = null;
      delete ctx.__pnTakeAuthCallback;
      return taken;
    };
  }

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

function runScrubber(href) {
  const location = makeLocation(href);
  const ctx = {
    location: location,
    URLSearchParams: URLSearchParams,
    URL: URL,
    history: { replaceState(state, title, url) { location.set(new URL(url, location.href).href); } }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(headScrubber(), ctx, { filename: 'src/00-head.html' });
  return ctx;
}

test('the head scrubs the callback out of the URL before any other script runs', () => {
  const ctx = runScrubber(PAGE + '/#auth_token=SECRET-TOKEN&auth_expires_at=99');

  assert.equal(ctx.location.hash, '');
  assert.ok(!ctx.location.href.includes('SECRET-TOKEN'), ctx.location.href);

  /* Handed on once and then gone, so that nothing loading after the store —
     or instead of it — can pick the token up a second time. */
  const taken = ctx.window.__pnTakeAuthCallback();
  assert.equal(taken.token, 'SECRET-TOKEN');
  assert.equal(taken.expiresAt, '99');
  assert.equal(ctx.window.__pnTakeAuthCallback, undefined);
});

test('the head scrubber leaves an ordinary fragment, and an ordinary page, alone', () => {
  const mixed = runScrubber(PAGE + '/?x=1#room=ABCDE&auth_token=SECRET');
  assert.equal(mixed.location.href, PAGE + '/?x=1#room=ABCDE');
  assert.equal(mixed.window.__pnTakeAuthCallback().token, 'SECRET');

  const plain = runScrubber(PAGE + '/#room=ABCDE');
  assert.equal(plain.location.hash, '#room=ABCDE');
  assert.equal(plain.window.__pnTakeAuthCallback, undefined);
});

test('the store takes the head scrubber\'s values rather than re-reading the URL', async () => {
  const opener = makeOpener();
  const ctx = makeStore({
    /* The URL as the store finds it in the real page: already clean. */
    href: PAGE + '/',
    opener: opener,
    signIn: { nonce: 'NONCE-2', at: Date.now() },
    stashed: { token: 'SECRET-TOKEN', expiresAt: '0' }
  });

  assert.equal(ctx.__get('STORE_URL_AUTH.token'), 'SECRET-TOKEN');
  assert.equal(opener.posted.length, 1);
  assert.equal(opener.posted[0].data.token, 'SECRET-TOKEN');
  /* One shot: the store consumed it, so there is nothing left on window. */
  assert.equal(ctx.__pnTakeAuthCallback, undefined);
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

test('editing localStorage alone cannot present an unowned item as equipped', () => {
  const ctx = makeStore();
  ctx.localStorage.setItem('pastel-nuketown-equipped', JSON.stringify({
    character: 'char-cloudknight',
    weapons: { smg: 'smg-cottoncloud', shotgun: 'shotgun-toastedmallow', rifle: 'rifle-berryswirl' }
  }));

  ctx.initStore();

  assert.deepEqual(ctx.__json('EQUIPPED'), {
    character: null, weapons: { smg: null, shotgun: null, rifle: null }
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

test('EQUIPPED keeps the shape the network layer reads', () => {
  const ctx = makeStore();
  ctx.initStore();
  assert.deepEqual(Object.keys(ctx.__json('EQUIPPED')).sort(), ['character', 'weapons']);
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
    character: null, weapons: { smg: null, shotgun: null, rifle: null }
  });
});
