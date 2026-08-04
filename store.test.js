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
