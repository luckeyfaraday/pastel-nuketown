/* =====================================================================
   PASTEL NUKETOWN — sign-in, the locker, and what you have equipped

   Two rules run through everything below.

   The first: nobody has to sign in. Signing in buys you skins and nothing
   else, so every failure here — a relay that has not shipped these
   endpoints, a dead network, a browser with localStorage switched off —
   ends in the same place, which is the title screen exactly as it looks
   for a signed-out player. Nothing in this file may throw its way into
   the game.

   The second: the token is a cache and the server is the record. What a
   player owns is asked for on every load and never read out of
   localStorage, because localStorage is a text field the player can edit.
   Which skin they have *chosen* to wear is the opposite — it is a
   setting, it lives in localStorage, and losing it costs a preference
   rather than an item.
   ===================================================================== */

/* The nine cosmetics are a fixed contract with the relay, so the ids are safe
   to hold here. Names and prices still come from /shop/catalog — this table
   is what lets the panel say something sensible when the relay cannot be
   reached, and it is where a weapon skin learns which gun it belongs on,
   since the slot is the first half of the id. The tints are decoration:
   deliberately a flat pastel swatch and not a render of the real skin, so a
   skin whose renderer has not landed yet still draws a card instead of
   throwing. */
const STORE_ITEMS = [
  { id: 'smg-cottoncloud',       type: 'weapon',    name: 'Folded Paper Crane',   tint: ['#f7b3c8', '#8c7ad6'] },
  { id: 'shotgun-toastedmallow', type: 'weapon',    name: 'Cobalt Willow Teapot', tint: ['#9fb3ee', '#6f7bd4'] },
  { id: 'rifle-berryswirl',      type: 'weapon',    name: 'Twisted Glass Cane',   tint: ['#63c9d6', '#c25fae'] },
  { id: 'char-midnight',         type: 'character', name: 'Midnight',       tint: ['#8f9bd6', '#4a3f5c'] },
  { id: 'char-sherbetfox',       type: 'character', name: 'Sherbet Fox',    tint: ['#ffe6c9', '#ff9aa2'] },
  { id: 'char-cloudknight',      type: 'character', name: 'Cloud Knight',   tint: ['#eaf7ff', '#a8dcf0'] },
  /* Shot effects. One per player rather than one per gun, so — like a
     character and unlike a weapon skin — they have no slot in the id. */
  { id: 'fx-starfall',           type: 'effect',    name: 'Starfall',       tint: ['#fff8e0', '#ffe08a'] },
  { id: 'fx-confettipop',        type: 'effect',    name: 'Confetti Pop',   tint: ['#ffeef6', '#b8f2d8'] },
  { id: 'fx-bubbletrail',        type: 'effect',    name: 'Bubble Trail',   tint: ['#e6fbff', '#8eeeff'] }
];
const STORE_BY_ID = new Map(STORE_ITEMS.map(item => [item.id, item]));
const STORE_SLOTS = ['smg', 'shotgun', 'rifle'];

const STORE_TOKEN_KEY = 'pastel-nuketown-token';
const STORE_EQUIP_KEY = 'pastel-nuketown-equipped';
/* Survives the round trip to Google or to Stripe and nothing more, which is
   exactly what sessionStorage is for: come back and the panel you left from
   is the panel you land on. */
const STORE_RETURN_KEY = 'pastel-nuketown-store-open';
/* The marker that says *this browser* asked for a sign-in. Written before the
   popup is opened so the popup inherits a copy of it — sessionStorage is
   cloned into a window opened from this one — and read on the way back. */
const STORE_SIGNIN_KEY = 'pastel-nuketown-signin';
/* Ten minutes, the same span the popup watcher gives up after. A marker older
   than that belongs to an attempt nobody is still waiting on. */
const STORE_SIGNIN_TTL = 600000;

/* =====================================================================
   THE SELECTION — the one thing outside this file reads

   EQUIPPED = { character: id|null, effect: id|null,
                weapons: { smg: id|null, shotgun: id|null, rifle: id|null } }

   null means the default look. An id only ever appears here after the
   server has said this account owns it, so whatever puts cosmetics on the
   wire can send these straight out without re-checking. Read it; the store
   owns writing it.
   ===================================================================== */
const EQUIPPED = {
  character: null,
  /* The shot effect: one selection for every gun, which is why it sits
     beside `character` rather than inside `weapons`. */
  effect: null,
  weapons: { smg: null, shotgun: null, rifle: null }
};
/* Top-level `const` in a classic script lands in the global lexical scope,
   where later scripts can read it by name but `window.EQUIPPED` cannot see
   it. Both spellings work from here on. */
window.EQUIPPED = EQUIPPED;

const ACCOUNT = {
  token: null,          // a cached string and nothing more; untrusted
  tokenOrigin: null,    // the relay that issued it; it is never shown to another
  expiresAt: 0,         // 0 when the relay did not say
  user: null,           // { userId, email, displayName } once /auth/me confirms it
  owned: new Set(),     // entitlement ids, only ever straight from the relay
  items: null,          // last /shop/catalog answer, or null if we have never had one
  checkingOut: false,
  lastRefresh: 0,
  /* Bumped every time the session changes — a sign-in, a sign-out, a token
     dropped. Requests carry the number they were sent under, so an answer that
     arrives for a session that has ended can be recognised and thrown away
     instead of quietly restoring the last account's entitlements. */
  session: 1,
  pending: new Set()    // AbortControllers for authenticated requests in flight
};

/* ---------------------------------------------------------------------
   Storage. Every one of these can throw — Safari's private mode does it
   for a living — and none of them is worth a broken title screen.
   --------------------------------------------------------------------- */
function storeRead(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storeWrite(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
function storeErase(key) { try { localStorage.removeItem(key); } catch (e) {} }
function storeSessionRead(key) { try { return sessionStorage.getItem(key); } catch (e) { return null; } }
function storeSessionWrite(key, value) { try { sessionStorage.setItem(key, value); } catch (e) {} }
function storeSessionErase(key) { try { sessionStorage.removeItem(key); } catch (e) {} }

/* A token goes out in an HTTP header, so anything with whitespace or a
   control character in it is not a token — it is a mangled URL or a
   hand-edited storage entry, and sending it would only earn a fetch that
   throws where a clean 401 would have been. */
function storeCleanToken(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token || token.length > 4096 || !/^[\x21-\x7e]+$/.test(token)) return null;
  return token;
}

/* =====================================================================
   THE CALLBACK

   The relay finishes sign-in by sending the browser back to this page with
   `#auth_token=<token>&auth_expires_at=<ms>` on the end of the URL. Those
   two keys are the contract; nothing else is accepted, and in particular
   nothing is read out of the query string, because a fragment never
   leaves the browser and a query string is sent to every server the URL
   is aimed at.

   The fragment is erased from the address bar before anything else in the
   page can read location.href. In the assembled page all of it — the
   erasure and the handoff to the opener both — has already happened by the
   time this file is parsed: the inline snippet at the top of <head> does
   the whole job in the first tick and keeps the token inside its own
   closure, because everything between there and here, the CDN copy of
   Three.js included, runs with page privileges and could read anything
   left on window. The parsing below is the fallback for a page assembled
   without that snippet, and it is what the tests drive; in the built page
   it finds an empty fragment and does nothing. Either way the token leaves
   the URL, because a token left
   in the bar survives into browser history, into a bookmark, into anything
   the player copies; COPY INVITE builds its link out of location.href, so
   a token still sitting there would be pasted into a chat window along
   with the invite. It is erased even when it is malformed, and even when
   it is refused outright below, because a token we will not use is still a
   token somebody else should not be able to read.
   ===================================================================== */

function storeTakeAuthFromURL() {
  const hash = typeof location.hash === 'string' ? location.hash : '';
  if (hash.length < 2) return null;

  let fragment = null;
  try { fragment = new URLSearchParams(hash.slice(1)); } catch (e) { return null; }
  if (!fragment.has('auth_token') && !fragment.has('auth_expires_at')) return null;

  const rawToken = fragment.get('auth_token');
  const rawExpiry = fragment.get('auth_expires_at');
  fragment.delete('auth_token');
  fragment.delete('auth_expires_at');

  /* Whatever else was in the fragment belongs to the page and stays. */
  try {
    const url = new URL(location.href);
    const rest = fragment.toString();
    url.hash = rest ? '#' + rest : '';
    if (typeof history === 'object' && history && history.replaceState)
      history.replaceState(null, '', url.toString());
  } catch (e) {}

  return storeCleanCallback(rawToken, rawExpiry);
}

function storeCleanCallback(rawToken, rawExpiry) {
  const token = storeCleanToken(rawToken);
  if (!token) return null;
  /* Milliseconds since the epoch, per the relay. A number we cannot make
     sense of is not a reason to refuse a session — it just means the only
     thing that can end this token is the relay saying 401. */
  const expiresAt = /^\d{1,15}$/.test(String(rawExpiry || '')) ? Number(rawExpiry) : 0;
  return { token: token, expiresAt: expiresAt > Date.now() ? expiresAt : 0 };
}

const STORE_URL_AUTH = storeTakeAuthFromURL();

/* =====================================================================
   A CALLBACK IS ONLY WORTH ANYTHING IF WE ASKED FOR IT

   A bearer token on the end of a URL is a URL that signs you in, and a URL
   is something anybody can send anybody. Left unguarded, a link to
   `…/#auth_token=<a token of mine>` signs the person who clicks it into
   *my* account — /auth/me agrees, the panel shows my name, and every skin
   they buy from then on is bought for me. Nothing about the token itself
   can tell the two cases apart: it is perfectly valid, it is just not
   theirs.

   So the evidence has to come from this browser instead. Pressing SIGN IN
   writes a random nonce into sessionStorage and only then opens the popup,
   which inherits a copy of that storage; the callback lands in the popup,
   which is the only window that ever visits the relay. A load carrying a
   callback is therefore believed only when it has both an opener and a
   live marker — that is, only when it is a window this page opened for a
   sign-in somebody actually asked for. Anything else is somebody else's
   link, and the token goes in the bin (the URL has already been scrubbed
   above, which is the part that matters even for a token we refuse).

   The nonce then travels back with the token in the postMessage, where the
   opener checks it against the attempt it is still waiting on.
   ===================================================================== */
function storeReadSignInMark() {
  const raw = storeSessionRead(STORE_SIGNIN_KEY);
  if (!raw) return null;
  let mark = null;
  try { mark = JSON.parse(raw); } catch (e) { return null; }
  if (!mark || typeof mark !== 'object' || typeof mark.nonce !== 'string' || !mark.nonce) return null;
  const at = typeof mark.at === 'number' && Number.isFinite(mark.at) ? mark.at : 0;
  if (!at || Date.now() - at > STORE_SIGNIN_TTL) return null;
  return mark;
}

function storeNewSignInMark() {
  let nonce = '';
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) nonce += byte.toString(16).padStart(2, '0');
  } catch (e) {
    /* Without WebCrypto this is guesswork rather than secrecy, and it is
       still worth having: the marker's job is to prove a sign-in was asked
       for at all, which an attacker's link cannot do however predictable
       the nonce is. */
    nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  }
  storeSessionWrite(STORE_SIGNIN_KEY, JSON.stringify({ nonce: nonce, at: Date.now() }));
  return nonce;
}

/* Sign-in happens in a popup (see storeBeginSignIn), so the window the relay
   redirects back to is not the window the player is looking at. When this load
   is that popup, its entire job is to hand the token to the game and get out of
   the way — before boot() spends a second building a renderer nobody will ever
   see. Same-origin only: the token goes to the page that opened us and nowhere
   else. This window never signs *itself* in; if the handoff cannot happen, the
   token is simply dropped. */
(function storeHandOffToOpener() {
  if (!STORE_URL_AUTH) return;
  const mark = storeReadSignInMark();
  if (!mark) return;
  try {
    if (!window.opener || window.opener.closed || window.opener === window) return;
    window.opener.postMessage({
      type: 'pastel-nuketown-auth',
      token: STORE_URL_AUTH.token,
      expiresAt: STORE_URL_AUTH.expiresAt,
      nonce: mark.nonce
    }, location.origin);
    /* This copy of the marker is spent. The opener clears its own. */
    storeSessionErase(STORE_SIGNIN_KEY);
    window.close();
  } catch (e) {}
})();

/* =====================================================================
   WHERE THE RELAY IS

   The page is on Netlify and the relay is on another origin, so there is
   no cookie to lean on and no same-origin fallback worth taking: the
   token is spelled out on every request instead.

   ?server= is deliberately not consulted here, and this is the one place
   this file knowingly parts company with 75-network.js. That override
   exists so a player can point the *gameplay socket* at a LAN box or a
   relay of their own, and it is typed into a URL somebody else can send
   them. Letting it choose where credentials go would turn a shareable
   link into a way to collect bearer tokens: one visit to
   ?server=https://somewhere-else and this page would introduce itself,
   token first, to whoever was listening. Where the game connects and
   where the session lives are two different questions, so they get two
   different answers. A private origin is still allowed to serve its own
   relay, because that is a machine the player is already standing at.
   ===================================================================== */
function storeAuthOrigin() {
  let raw;
  if (location.protocol === 'file:') raw = 'http://localhost:8080';
  else if (NETP && NETP.isPrivateHost(location.hostname)) raw = location.origin;
  else raw = typeof NET_SERVER === 'string' ? NET_SERVER : '';
  raw = String(raw).trim();
  if (!raw) return null;
  if (/^wss?:\/\//i.test(raw)) raw = raw.replace(/^ws/i, 'http');
  if (!/^https?:\/\//i.test(raw)) raw = (location.protocol === 'https:' ? 'https://' : 'http://') + raw;
  try {
    const u = new URL(raw);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return null;
    return u.protocol + '//' + u.host;
  } catch (e) {}
  return null;
}

function storeRelayURL(path) {
  const origin = storeAuthOrigin();
  return origin ? origin + path : null;
}

/* A token is only ever spelled out to the relay that issued it. In practice
   the two always agree — the origin is pinned above and the token was saved
   with it — so this is a belt on top of braces, and it is here because the
   cost of the one case where they disagree is somebody else's session. */
function storeBearerFor(origin) {
  if (!ACCOUNT.token || !origin || ACCOUNT.tokenOrigin !== origin) return null;
  return ACCOUNT.token;
}

/* Every call the store makes goes through here. A missing endpoint, a relay
   that is down and a request that timed out all arrive as the same kind of
   nothing, because the title screen treats all three the same way: it
   behaves as though there is no store. Only the status code carries meaning
   worth acting on, and only one of them does — see storeRefreshMe. */
function storeAPI(path, opts) {
  opts = opts || {};
  const origin = storeAuthOrigin();
  const url = origin ? origin + path : null;
  if (!url || typeof fetch !== 'function') return Promise.reject(new Error('no relay'));

  const headers = { 'Accept': 'application/json' };
  /* opts.bearer is the one caller that names its own token: signing out drops
     the session first and revokes second, so by the time the revoke is sent
     there is no ACCOUNT.token left to read. It is pinned to an origin all the
     same. */
  const bearer = opts.bearer
    ? (opts.bearerOrigin === origin ? storeCleanToken(opts.bearer) : null)
    : (opts.auth ? storeBearerFor(origin) : null);
  if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const control = typeof AbortController === 'function' ? new AbortController() : null;
  /* Authenticated requests are held onto so signing out can cut them off
     rather than wait for their answers to turn up unwanted. */
  if (control && opts.auth) ACCOUNT.pending.add(control);
  const bail = control ? setTimeout(() => control.abort(), opts.timeout || 8000) : 0;
  const done = () => {
    if (bail) clearTimeout(bail);
    if (control) ACCOUNT.pending.delete(control);
  };

  return fetch(url, {
    method: opts.method || 'GET',
    headers: headers,
    cache: 'no-store',
    mode: 'cors',
    credentials: 'omit',
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: control ? control.signal : undefined
  }).then(response => {
    /* The timeout deliberately outlives the headers. A relay that answers
       200 and then trickles — or never finishes — its body is exactly the
       failure the eight seconds are for, and clearing the timer here, where
       it used to be cleared, is what let that request hang forever with the
       BUY buttons stuck on WAIT. */
    return response.json().then(body => body, error => {
      /* An empty body is normal — /auth/logout has nothing to say — so a
         body that will not parse is a null body and not a failed request.
         An abort is the one exception: that is the timeout doing its job,
         and it must not be mistaken for a relay with nothing to say. */
      if (control && control.signal.aborted) throw error;
      return null;
    }).then(body => ({ ok: response.ok, status: response.status, body: body }));
  }).then(res => { done(); return res; }, error => { done(); return Promise.reject(error); });
}

/* An answer to a question the player has stopped asking. Sign-out and a new
   token both move the session on, and everything in flight under the old one
   is dropped where it lands rather than allowed to repopulate the panel. */
function storeStale(session) { return session !== ACCOUNT.session; }

function storeEndSession() {
  ACCOUNT.session++;
  for (const control of ACCOUNT.pending) { try { control.abort(); } catch (e) {} }
  ACCOUNT.pending.clear();
}

/* =====================================================================
   SESSION
   ===================================================================== */
function storeSignedIn() { return !!(ACCOUNT.token && ACCOUNT.user); }

/* The token is stored next to the origin that issued it and the moment it
   stops being good for anything. Both are checked on the way back out: a
   token minted by one relay is not a token for another, and one that has
   already expired is a guaranteed 401 that would sign the player out with a
   flash of the wrong state on the way. */
function storeSaveToken(token, expiresAt, origin) {
  ACCOUNT.token = token;
  ACCOUNT.tokenOrigin = origin;
  ACCOUNT.expiresAt = expiresAt || 0;
  storeWrite(STORE_TOKEN_KEY, JSON.stringify({
    token: token, origin: origin, expiresAt: expiresAt || 0
  }));
}

function storeLoadToken(origin) {
  const raw = storeRead(STORE_TOKEN_KEY);
  if (!raw) return null;
  let saved = null;
  try { saved = JSON.parse(raw); } catch (e) { return null; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const token = storeCleanToken(saved.token);
  if (!token || saved.origin !== origin) return null;
  const expiresAt = typeof saved.expiresAt === 'number' && Number.isFinite(saved.expiresAt)
    ? saved.expiresAt : 0;
  if (expiresAt > 0 && Date.now() >= expiresAt) return null;
  return { token: token, expiresAt: expiresAt };
}

function storeForgetToken() {
  ACCOUNT.token = null;
  ACCOUNT.tokenOrigin = null;
  ACCOUNT.expiresAt = 0;
  storeErase(STORE_TOKEN_KEY);
  /* Anything still in flight was asked on behalf of an account that has just
     left. Cut it off, and move the session on so whatever slips through the
     gap is recognisable as an answer to the wrong question. */
  storeEndSession();
  storeSetSignedOut();
}

/* Signed out is not an error state — it is the state the game ships in — so
   this clears the session without touching the stored preference. Sign back
   in and the look comes back; it was never the thing being owned. */
function storeSetSignedOut() {
  ACCOUNT.user = null;
  ACCOUNT.owned = new Set();
  storeApplyEquipped();
  storeRenderAccount();
  storeRenderGrid();
}

function storeCleanEntitlements(value) {
  const owned = new Set();
  if (!Array.isArray(value)) return owned;
  for (const id of value.slice(0, 64))
    if (typeof id === 'string' && id && id.length <= 120) owned.add(id);
  return owned;
}

/* The cached token is a guess; this is the answer, and it is asked again on
   every load because entitlements change while a tab is closed — a checkout
   that finished on a phone, a refund, a session revoked from another
   device. A 401 is the only reply that clears the cached token. A relay that
   is down, or one that has not shipped /auth/me yet, must not be able to
   sign anybody out — it just leaves the title screen looking signed out
   until it comes back. */
function storeRefreshMe() {
  if (!ACCOUNT.token) { storeSetSignedOut(); return Promise.resolve(false); }
  const session = ACCOUNT.session;
  return storeAPI('/auth/me', { auth: true }).then(res => {
    if (storeStale(session)) return false;
    if (res.status === 401) { storeForgetToken(); return false; }
    const body = res.body;
    if (!res.ok || !body || typeof body !== 'object' || Array.isArray(body)) {
      storeSetSignedOut();
      return false;
    }
    ACCOUNT.user = {
      userId: typeof body.userId === 'string' ? body.userId : '',
      email: typeof body.email === 'string' ? body.email : '',
      displayName: typeof body.displayName === 'string' && body.displayName.trim()
        ? body.displayName.trim().slice(0, 40)
        : (typeof body.email === 'string' ? body.email.split('@')[0].slice(0, 40) : 'PLAYER')
    };
    ACCOUNT.owned = storeCleanEntitlements(body.entitlements);
    storeApplyEquipped();
    storeRenderAccount();
    storeRenderGrid();
    return true;
  }, () => {
    if (storeStale(session)) return false;
    storeSetSignedOut();
    return false;
  });
}

/* =====================================================================
   SIGNING IN

   In its own window, not this one. Sending the whole browser to
   /auth/google/start is how this used to work, and on any day the relay has
   not shipped that route the player presses one button and the game is
   replaced by the relay's raw 404 — title screen, PLAY, room browser and
   all, until they think to press Back. Nothing here is allowed to cost
   somebody a game they were about to play, so the trip to Google happens in
   a window the game can survive losing, and every way it can go wrong ends
   as a sentence on the title screen instead.
   ===================================================================== */
const STORE_SIGNIN = { win: null, poll: 0, nonce: '' };

/* An attempt is over — however it ended. The marker goes with it, so a
   callback URL arriving after this point has nothing to match against. */
function storeSignInForget() {
  STORE_SIGNIN.win = null;
  STORE_SIGNIN.nonce = '';
  storeSessionErase(STORE_SIGNIN_KEY);
}

/* Ends the attempt from this side: the watcher stops, the marker is spent, and
   the popup — which this page opened, so this page may close — goes away
   rather than being left sitting on whatever it failed at. */
function storeSignInGiveUp(message) {
  if (STORE_SIGNIN.poll) { clearInterval(STORE_SIGNIN.poll); STORE_SIGNIN.poll = 0; }
  const win = STORE_SIGNIN.win;
  storeSignInForget();
  if (win) { try { win.close(); } catch (e) {} }
  storeLockerNote(message);
  storeNote(message, 'error');
}

/* The popup is at the relay and cannot be read across origins, so a relay that
   has not shipped the auth routes yet shows the player a raw 404 in a window
   the game has no way to see into — and the title screen goes on saying
   "finish there and come back" until they close it by hand. Asking the relay a
   question we *can* read settles it in a second: /auth/me exists exactly when
   sign-in exists, so a 404 or a 501 from it means the popup is sitting on a
   dead end. Any other answer, 401 included, means the routes are there and the
   player is simply still typing their password; a request that fails outright
   says nothing either way and is left alone. */
function storeCheckAuthShipped(win) {
  storeAPI('/auth/me', { timeout: 6000 }).then(res => {
    if (STORE_SIGNIN.win !== win) return;   // already finished, or a newer attempt owns it
    if (res.status !== 404 && res.status !== 501) return;
    storeSignInGiveUp('Sign-in is not available on this server yet. You can still play — everything but the skins is free.');
  }, () => {});
}

function storeSignInWatch() {
  if (STORE_SIGNIN.poll) { clearInterval(STORE_SIGNIN.poll); STORE_SIGNIN.poll = 0; }
  if (!STORE_SIGNIN.win) return;
  /* The popup cannot be read across origins while it is at Google, so the one
     thing worth watching is whether it is still there. Closed without a token
     covers all of it: the player changed their mind, Google refused, or the
     relay answered 404 in a window they then shut. */
  let ticks = 0;
  STORE_SIGNIN.poll = setInterval(() => {
    let closed = false;
    try { closed = !STORE_SIGNIN.win || STORE_SIGNIN.win.closed; } catch (e) { closed = true; }
    /* Ten minutes is long past the point where anybody is still filling in a
       Google form, and a window left open all afternoon is not worth a timer
       twice a second for the rest of the session. */
    if (!closed && ++ticks < 1200) return;
    if (!closed) { storeSignInForget(); clearInterval(STORE_SIGNIN.poll); STORE_SIGNIN.poll = 0; return; }
    clearInterval(STORE_SIGNIN.poll);
    STORE_SIGNIN.poll = 0;
    storeSignInForget();
    if (storeSignedIn() || ACCOUNT.token) return;
    storeLockerNote('Sign-in did not finish. You can still play — everything but the skins is free.');
    storeNote('Sign-in did not finish. Try again, or carry on without it.', 'error');
  }, 500);
}

function storeBeginSignIn() {
  const url = storeRelayURL('/auth/google/start');
  if (!url) { storeLockerNote('Sign-in is unavailable right now — you can still play.'); return; }

  /* Deliberately a bare GET with nothing bolted on. Where to send the player
     back to is the relay's business, and the contract does not offer a way
     to tell it. */
  /* No `noopener` here, deliberately: the opener is how the token gets home.
     It is safe to keep because the window only ever visits the relay and then
     this page, and only a same-origin message is listened to. */
  /* The marker is written *before* the window is opened, and the order is the
     whole trick: sessionStorage is copied into a window as it is created, so a
     popup opened on the next line carries this attempt's nonce with it and one
     opened by anybody else's link does not. */
  const nonce = storeNewSignInMark();

  let win = null;
  try { win = window.open(url, 'pastel-nuketown-signin', 'popup=yes,width=480,height=680'); }
  catch (e) {}
  if (!win) {
    storeSignInForget();
    /* No fallback navigation on purpose: taking the page away is the thing
       this flow exists to avoid, and a blocked popup is one click in the
       address bar away from working. */
    storeLockerNote('Your browser blocked the sign-in window. Allow pop-ups for this page and try again.');
    storeNote('Your browser blocked the sign-in window. Allow pop-ups for this page and try again.', 'error');
    return;
  }
  STORE_SIGNIN.win = win;
  STORE_SIGNIN.nonce = nonce;
  try { win.focus(); } catch (e) {}
  storeLockerNote('Sign-in opened in a new window — finish there and come back.');
  storeNote('Sign-in opened in a new window — finish there and come back.');
  storeSignInWatch();
  storeCheckAuthShipped(win);
}

/* The popup comes back to this page, hands the token over and closes itself
   (see storeHandOffToOpener). Four things have to line up before a token this
   page did not fetch itself becomes a session: the message came from this
   page's own origin, it came from the exact window this page opened for a
   sign-in, it is shaped like the one we send, and it carries the nonce of the
   attempt still running. The window check is the load-bearing one — any
   same-origin frame or window can postMessage here — and the nonce is what
   stops a message held back from an earlier attempt being replayed into a
   later one. */
function storeOnAuthMessage(event) {
  if (!event || event.origin !== location.origin) return;
  if (!STORE_SIGNIN.win || event.source !== STORE_SIGNIN.win) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || data.type !== 'pastel-nuketown-auth') return;
  if (!STORE_SIGNIN.nonce || data.nonce !== STORE_SIGNIN.nonce) return;
  const token = storeCleanToken(data.token);
  if (!token) return;
  const origin = storeAuthOrigin();
  if (!origin) return;

  /* The attempt is spent whether or not what follows works out. */
  storeSignInForget();

  const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) &&
    data.expiresAt > Date.now() ? data.expiresAt : 0;
  storeEndSession();               // a new token is a new session
  storeSaveToken(token, expiresAt, origin);
  storeLockerNote('');
  storeNote('Signing you in…');
  storeRefreshAll();
}

/* The local session ends whether or not the relay agrees. The revoke is
   sent, but the token is dropped without waiting for the reply: pressing
   SIGN OUT on a flaky connection has to sign you out. */
function storeSignOut() {
  const bearer = ACCOUNT.token;
  const bearerOrigin = ACCOUNT.tokenOrigin;
  /* Drop the session first. The revoke goes out afterwards holding its own
     copy of the token, because ending the session aborts everything in
     flight and would otherwise abort the revoke along with it. */
  storeForgetToken();
  if (bearer) {
    storeAPI('/auth/logout', {
      method: 'POST', bearer: bearer, bearerOrigin: bearerOrigin
    }).catch(() => {});
  }
  storeLockerNote('');
  storeNote('Signed out. Your skins are waiting whenever you sign back in.');
  /* Signing out cut the catalog request off along with everything else, so
     an open panel is left waiting on an answer that is never coming. Ask
     again, signed out this time. */
  if (storeIsOpen()) storeRefreshCatalog();
}

/* =====================================================================
   WHAT IS EQUIPPED
   ===================================================================== */

/* Which slot an id can go in. The nine are known here, and anything the relay
   adds later still works as long as a weapon id starts with the gun it is
   for — which is the shape the whole catalog is already in. */
function storeSlotOf(id, type) {
  const known = STORE_BY_ID.get(id);
  const kind = known ? known.type : type;
  if (kind === 'character') return { kind: 'character' };
  if (kind === 'effect') return { kind: 'effect' };
  if (kind !== 'weapon' || typeof id !== 'string') return null;
  const slot = id.split('-')[0];
  return STORE_SLOTS.indexOf(slot) >= 0 ? { kind: 'weapon', slot: slot } : null;
}

function storeReadEquipPrefs() {
  const empty = { character: null, effect: null, weapons: {} };
  const raw = storeRead(STORE_EQUIP_KEY);
  if (!raw) return empty;
  let saved = null;
  try { saved = JSON.parse(raw); } catch (e) { return empty; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return empty;
  const weapons = {};
  if (saved.weapons && typeof saved.weapons === 'object')
    for (const slot of STORE_SLOTS)
      if (typeof saved.weapons[slot] === 'string') weapons[slot] = saved.weapons[slot];
  return {
    character: typeof saved.character === 'string' ? saved.character : null,
    effect: typeof saved.effect === 'string' ? saved.effect : null,
    weapons: weapons
  };
}

/* Equipped is a preference and lives in localStorage; owning the thing is
   not, and lives on the server. So the stored choice is filtered through
   whatever entitlements the relay just handed us, and anything that is not
   on that list drops out of the live selection without a word. It stays in
   storage though — a player who signs out, or who loads the page while the
   relay is down, gets their look back the moment the server confirms it
   again, rather than silently losing a setting to a bad minute. */
function storeApplyEquipped() {
  const prefs = storeReadEquipPrefs();
  const allowed = id => typeof id === 'string' && ACCOUNT.owned.has(id) && !!storeSlotOf(id);
  EQUIPPED.character = allowed(prefs.character) && storeSlotOf(prefs.character).kind === 'character'
    ? prefs.character : null;
  EQUIPPED.effect = allowed(prefs.effect) && storeSlotOf(prefs.effect).kind === 'effect'
    ? prefs.effect : null;
  for (const slot of STORE_SLOTS) {
    const id = prefs.weapons[slot];
    const where = allowed(id) ? storeSlotOf(id) : null;
    EQUIPPED.weapons[slot] = where && where.kind === 'weapon' && where.slot === slot ? id : null;
  }
}

function storeSaveEquipped() {
  storeWrite(STORE_EQUIP_KEY, JSON.stringify({
    character: EQUIPPED.character,
    effect: EQUIPPED.effect,
    weapons: {
      smg: EQUIPPED.weapons.smg,
      shotgun: EQUIPPED.weapons.shotgun,
      rifle: EQUIPPED.weapons.rifle
    }
  }));
}

function storeIsEquipped(id) {
  return EQUIPPED.character === id || EQUIPPED.effect === id ||
    STORE_SLOTS.some(slot => EQUIPPED.weapons[slot] === id);
}

/* Pressing an equipped item again takes it off, which is the only way back
   to the default look. Nothing here reaches into the renderer: equipping
   records a choice and that is all, so a skin id whose model has not been
   built yet cannot break the panel it was chosen from. */
function storeEquip(id, type) {
  const where = storeSlotOf(id, type);
  if (!where || !ACCOUNT.owned.has(id)) return;      // never wear what the server has not confirmed
  if (where.kind === 'character') EQUIPPED.character = EQUIPPED.character === id ? null : id;
  else if (where.kind === 'effect') EQUIPPED.effect = EQUIPPED.effect === id ? null : id;
  else EQUIPPED.weapons[where.slot] = EQUIPPED.weapons[where.slot] === id ? null : id;
  storeSaveEquipped();
  storeRenderGrid();
  if (typeof SFX === 'object' && SFX) SFX.ui();
}

/* =====================================================================
   THE CATALOG
   ===================================================================== */

/* The relay is the authority on what is for sale, so an answer it gives
   replaces the local table. A bare array is the shape the contract
   describes; an { items: [...] } envelope is common enough that accepting
   it costs one line and saves a launch-day mismatch. */
function storeCleanCatalog(body) {
  const raw = Array.isArray(body) ? body
    : (body && typeof body === 'object' && Array.isArray(body.items) ? body.items : null);
  if (!raw) return null;
  const items = [];
  for (const entry of raw.slice(0, 24)) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' ||
        !entry.id || entry.id.length > 120) continue;
    const known = STORE_BY_ID.get(entry.id);
    items.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim().slice(0, 40) : (known ? known.name : entry.id),
      type: entry.type === 'weapon' || entry.type === 'character' ||
        entry.type === 'effect'
        ? entry.type : (known ? known.type : ''),
      price: entry.price,
      owned: entry.owned === true
    });
  }
  return items;
}

/* Stripe counts in the currency's smallest unit, so a whole number is cents
   and 499 is $4.99. A string is passed through exactly as the relay wrote
   it, which is the escape hatch the moment a price is not dollars. */
function storePriceText(price) {
  if (typeof price === 'string' && price.trim()) return price.trim().slice(0, 16);
  if (typeof price === 'number' && Number.isFinite(price) && price >= 0)
    return '$' + (Math.round(price) / 100).toFixed(2);
  return '';
}

function storeRefreshCatalog() {
  if (storeIsOpen()) storeNote('Checking the shelves…');
  const session = ACCOUNT.session;
  return storeAPI('/shop/catalog', { auth: true }).then(res => {
    if (storeStale(session)) return false;
    if (res.status === 401) {
      storeForgetToken();
      storeNote('Your sign-in expired. Sign in again to see what you own.', 'error');
      return false;
    }
    const items = res.ok ? storeCleanCatalog(res.body) : null;
    if (!items || !items.length) {
      ACCOUNT.items = null;
      storeRenderGrid();
      storeNote('The store is not reachable right now. Nothing else is affected — go and play.', 'error');
      return false;
    }
    ACCOUNT.items = items;
    /* `owned` is only meaningful on an authenticated call, and when it is
       there it is as fresh as /auth/me — fresher, if a checkout landed
       between the two. Signed out it is absent, and absent must not be read
       as "you own nothing" for ids the catalog did not mention. */
    if (storeSignedIn()) {
      for (const item of items) {
        if (item.owned) ACCOUNT.owned.add(item.id);
        else ACCOUNT.owned.delete(item.id);
      }
      storeApplyEquipped();
    }
    storeRenderGrid();
    storeNote(storeSignedIn() ? '' : 'Sign in to buy and equip skins. Everything else is free and always will be.');
    return true;
  }, () => {
    if (storeStale(session)) return false;
    ACCOUNT.items = null;
    storeRenderGrid();
    storeNote('The store is not reachable right now. Nothing else is affected — go and play.', 'error');
    return false;
  });
}

/* Re-asks both questions in the order that matters: entitlements first,
   because that is what decides whether a card says BUY or EQUIP. */
function storeRefreshAll() {
  ACCOUNT.lastRefresh = Date.now();
  return storeRefreshMe().then(() => storeRefreshCatalog());
}

/* =====================================================================
   BUYING

   The relay owns the Stripe session; the client's whole part is to ask for
   a URL and go there. No key of any kind belongs on this side.
   ===================================================================== */

/* Where a checkout is allowed to send the browser. Stripe hosts it, so this is
   the one line to change on the day the relay moves to a custom checkout
   domain — and it is a list of hosts rather than a pattern on the whole string
   on purpose. Matching text is how `https://checkout.stripe.com@evil.example/`
   gets through: everything before the @ is a username, the site is
   evil.example, and a player who followed it would be typing their card number
   into somebody else's page. Only the parsed host answers that question. */
const STORE_CHECKOUT_HOSTS = ['checkout.stripe.com'];

function storeCheckoutURL(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url = null;
  /* A regex can say a string looks like a URL; only the parser can say it is
     one. `https://%` passes any reasonable pattern and throws on the way into
     the address bar. */
  try { url = new URL(raw.trim()); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;      // never javascript:, never plain http
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const known = STORE_CHECKOUT_HOSTS.some(allowed => host === allowed || host.endsWith('.' + allowed));
  return known ? url.href : null;
}

function storeBuy(id) {
  if (!storeSignedIn()) { storeBeginSignIn(); return; }
  if (ACCOUNT.checkingOut) return;
  ACCOUNT.checkingOut = true;
  storeNote('Opening the checkout…');
  storeRenderGrid();

  /* The contract fixes the path and the reply but not the request field.
     The item is the only thing this endpoint can need, and `itemId` is the
     name it goes out under — if the relay chose another one, this line is
     the whole change. */
  const session = ACCOUNT.session;
  storeAPI('/shop/checkout', { method: 'POST', auth: true, body: { itemId: id } })
    .then(res => {
      /* A checkout that answers after the player has signed out is a
         redirect to a Stripe page belonging to an account that is no longer
         here. It goes nowhere. */
      if (storeStale(session)) return;
      if (res.status === 401) {
        storeForgetToken();
        storeNote('Your sign-in expired before the checkout opened. Nothing was charged.', 'error');
        return;
      }
      /* Whatever comes back is about to become the address bar, so it has to
         be a checkout URL and not, say, a javascript: one or a lookalike host.
         Stripe's checkout is always https and always Stripe's, so this rejects
         nothing legitimate. */
      const url = storeCheckoutURL(res.ok && res.body ? res.body.url : '');
      if (!url) {
        storeNote('The checkout would not open. Nothing was charged — try again in a moment.', 'error');
        return;
      }
      storeSessionWrite(STORE_RETURN_KEY, '1');
      /* Navigation can still refuse — an address the parser accepted and the
         browser will not go to. Say so, and let the finally below put the BUY
         buttons back; a throw escaping here is what used to leave every card
         on WAIT with the panel claiming a checkout was opening, until reload. */
      try {
        location.assign(url);
      } catch (e) {
        storeSessionErase(STORE_RETURN_KEY);
        storeNote('The checkout would not open. Nothing was charged — try again in a moment.', 'error');
      }
    }, () => {
      /* A rejection that belongs to a session the player has left is usually
         our own abort from signing out, and its message would land on top of
         "Signed out." — the last thing they were actually told. */
      if (storeStale(session)) return;
      storeNote('Could not reach the store. Nothing was charged — try again in a moment.', 'error');
    })
    /* Whatever happened, the buttons come back. */
    .finally(() => { ACCOUNT.checkingOut = false; storeRenderGrid(); })
    /* And nothing from this chain is allowed to surface as an unhandled
       rejection in the middle of a match. Both outcomes have already had
       their say above. */
    .catch(() => {});
}

/* =====================================================================
   THE DISPLAY CASE

   A skin is a picture, and a shop that describes pictures in words is not
   a shop. So the panel builds the real thing: buildCharacter and
   buildGunMesh, the same two functions the match calls, so what turns in
   the case is the model that will be on the street — not an illustration
   of it that can drift.

   Three rules run through everything below, and each of them is here
   because of a specific way this can go wrong.

   ONE CONTEXT. There is exactly one WebGLRenderer for the whole store,
   and it is not made until the panel is opened for the first time. A
   browser gives a page a small number of live WebGL contexts and then
   starts taking the oldest ones away; the game is already holding one,
   and six more — a canvas per card — is how a store costs a player the
   match they were about to play.

   THE GAME'S OWN LIGHT. The numbers below are copied from initLights and
   initViewmodel and are not to be tuned by eye. The materials are
   MeshToonMaterial over a four-step gradient map, and there is no tone
   mapping in r128: past roughly 1.35 of total intensity the top band
   clips, and a wall of pastels all clip to the same white. A preview lit
   "so you can see it better" is how this store once ended up advertising
   six colourless skins. Characters get the world rig because that is
   where a character is seen; guns get the viewmodel rig, because a gun is
   seen in your own hands.

   NOTHING HERE MAY BREAK THE PANEL. Every entry point checks its
   elements, its builders and its THREE, every build is wrapped, and a
   context that cannot be made or is later lost hides the case and leaves
   the cards below exactly as they were before any of this existed.
   ===================================================================== */

const STAGE = {
  /* null until the first open decides; then true, or false forever. */
  can: null,
  renderer: null, scene: null, camera: null, canvas: null,
  /* Everything the case is showing, under one parent, because the framing
     measures the pair as a single object — see stageBounds. */
  group: null,
  rigs: { world: null, view: null },
  /* Two, and only ever two: the default on the left, the selection on the
     right. Each is a pivot (where it stands) holding a spinner (its own
     turn), so comparing two things turns them both on the spot rather than
     swinging one around the other. */
  slots: [],
  /* Built models, keyed by what they are. A player clicking along the row
     should not pay to rebuild a character they looked at ten seconds ago,
     and a build that failed is remembered as a failure so it is not retried
     sixty times a second. */
  cache: new Map(),
  /* One picture per catalog id, drawn once and kept as a data URL. The cards
     read from here; a null is an item that could not be drawn, remembered so
     it is not attempted again. */
  thumbs: new Map(),
  thumbPivot: null, thumbCam: null, thumbJob: 0,
  raf: 0, last: 0, spin: 0,
  itemId: null,
  compare: true,
  w: 0, h: 0
};

/* Slow enough to read as a display case rather than a spinning trophy:
   about eleven seconds a turn. */
const STAGE_SPIN = 0.55;
const STAGE_TAU = Math.PI * 2;
/* Four characters and four guns is the whole reachable set today; the cap
   is here so a relay that starts selling forty cannot make the panel hold
   forty models' worth of buffers. */
const STAGE_CACHE_MAX = 16;
/* A narrow lens. A display case wants the near-orthographic read of a shop
   window; at the game's 74 degrees two models a metre apart are seen from
   two noticeably different sides, which is the one thing a comparison
   cannot afford. */
const STAGE_FOV = 27;
/* A shade above the horizon: enough to see the top of a cap and the top of a
   barrel, not enough to look down on anything. */
const STAGE_TILT = 0.20;
/* Air between the content and the glass. A display case that touches its own
   edges reads as a mistake, and six per cent also absorbs the small error in
   treating a tilted box as an upright one. */
const STAGE_MARGIN = 1.06;
/* The share of the case's height the caption pills sit over. It is reserved
   rather than drawn into: without it a character stands with their boots
   behind the word DEFAULT, which is not a preview of the boots. */
const STAGE_CAPTION = 0.16;
/* The picture on a card. Rendered once per item at this size and kept as a
   data URL, so the row of cards costs six draws for the life of the page
   rather than six draws a frame. */
const STAGE_THUMB_W = 256;
const STAGE_THUMB_H = 160;

/* 10-core.js owns the one conversion from authored hex to linear, and the
   store must use it or its lights will not match the game's. The fallback
   is for a page where 10-core.js is absent — which is every one of the
   tests, and no browser. */
function stageColor(hex) {
  if (typeof C === 'function') { try { return C(hex); } catch (e) {} }
  return new THREE.Color(hex);
}

function stageEl(id) {
  return typeof document === 'object' && document && document.getElementById
    ? document.getElementById(id) : null;
}

/* Lit exactly as initLights (10-core.js) lights the street: hemisphere
   heavy, one warm sun, one cool bounce, ~1.35 in total. */
function stageWorldRig() {
  const g = new THREE.Group();
  const hemi = new THREE.HemisphereLight(stageColor(0xdcefff), stageColor(0xffe0bd), 0.68);
  hemi.position.set(0, 40, 0);
  const sun = new THREE.DirectionalLight(stageColor(0xfff4d9), 0.52);
  sun.position.set(-34, 46, 26);
  const fill = new THREE.DirectionalLight(stageColor(0xcfd9ff), 0.15);
  fill.position.set(30, 18, -26);
  g.add(hemi, sun, fill);
  return g;
}

/* And exactly as initViewmodel (40-weapons.js) lights your own hands. */
function stageViewRig() {
  const g = new THREE.Group();
  const hemi = new THREE.HemisphereLight(stageColor(0xffffff), stageColor(0xd9c9e8), 0.50);
  const key = new THREE.DirectionalLight(stageColor(0xfff4d9), 0.72);
  key.position.set(-0.6, 1.1, 0.9);
  const fill = new THREE.DirectionalLight(stageColor(0xc8d8ff), 0.22);
  fill.position.set(0.9, 0.2, -0.6);
  g.add(hemi, key, fill);
  return g;
}

/* Everything the case needs from outside this file. Asked once, because
   the answer cannot change inside a page load and because the expensive
   half of it is making a context. */
function stageInit() {
  if (STAGE.can !== null) return STAGE.can;
  STAGE.can = false;

  const canvas = stageEl('storeCanvas');
  if (!canvas) return false;
  if (typeof THREE !== 'object' || !THREE || typeof THREE.WebGLRenderer !== 'function') return false;
  if (typeof buildCharacter !== 'function' && typeof buildGunMesh !== 'function') return false;

  try {
    /* alpha, and a clear colour of nothing: the wash behind the models and
       the shadow under them are CSS, which costs the renderer no fill and
       keeps the case looking like a case even on the frame the context
       goes away. */
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: typeof SOFTWARE_GPU === 'boolean' ? !SOFTWARE_GPU : true,
      alpha: true,
      /* The card pictures are taken off this same canvas with toDataURL, and
         a drawing buffer the browser is free to throw away the moment the
         frame is composited reads back blank about as often as it does not.
         One small canvas that only draws while the panel is open can afford
         to keep its buffer; six cards of empty grey cannot. */
      preserveDrawingBuffer: true
    });
    renderer.setClearColor(stageColor(0x000000), 0);
    if (THREE.sRGBEncoding !== undefined) renderer.outputEncoding = THREE.sRGBEncoding;
    /* No shadow map. It would be a second geometry pass for one object on a
       floor that is a CSS ellipse, and the store is a guest on a page that
       is already rendering a game. */
    if (renderer.shadowMap) renderer.shadowMap.enabled = false;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    if (typeof renderer.setPixelRatio === 'function')
      renderer.setPixelRatio(Math.min(dpr, typeof SOFTWARE_GPU === 'boolean' && SOFTWARE_GPU ? 1 : 1.75));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(STAGE_FOV, 1, 0.05, 80);

    STAGE.rigs.world = stageWorldRig();
    STAGE.rigs.view = stageViewRig();
    scene.add(STAGE.rigs.world, STAGE.rigs.view);

    const group = new THREE.Group();
    scene.add(group);
    STAGE.slots = [];
    for (let i = 0; i < 2; i++) {
      const pivot = new THREE.Group();
      const spinner = new THREE.Group();
      pivot.add(spinner);
      pivot.visible = false;
      group.add(pivot);
      STAGE.slots.push({ pivot: pivot, spinner: spinner, node: null, yaw0: 0 });
    }
    STAGE.group = group;

    /* Where a card's picture is taken. Its own stand and its own lens, in
       this same scene and under these same lights, because the alternative
       is a second rig — and a second rig is a second set of numbers to keep
       matching the game's. */
    STAGE.thumbPivot = new THREE.Group();
    STAGE.thumbPivot.visible = false;
    scene.add(STAGE.thumbPivot);
    STAGE.thumbCam = new THREE.PerspectiveCamera(
      STAGE_FOV, STAGE_THUMB_W / STAGE_THUMB_H, 0.05, 80);

    STAGE.renderer = renderer;
    STAGE.scene = scene;
    STAGE.camera = camera;
    STAGE.canvas = canvas;

    /* A lost context is not an error the player should be shown — it is a
       phone reclaiming memory, usually because the game wanted some. Fold
       the case away and leave the shop working. */
    if (typeof canvas.addEventListener === 'function')
      canvas.addEventListener('webglcontextlost', e => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        stageGiveUp();
      }, false);
  } catch (e) {
    STAGE.renderer = null;
    return false;
  }

  STAGE.can = true;
  return true;
}

/* The one way out. Whatever went wrong, the panel keeps working without
   a picture in it, and nothing tries again this page load. */
function stageGiveUp() {
  stageStop();
  STAGE.can = false;
  STAGE.renderer = null;
  STAGE.cache.clear();
  STAGE.thumbs.clear();
  const wrap = stageEl('storeStage');
  if (wrap) wrap.hidden = true;
  /* The cards were drawn with a preview button on them; they are not any
     more. */
  storeRenderGrid();
}

/* The jersey the preview wears. A character skin is costume pieces over a
   team colour, so showing it on the player's own cream jersey is showing
   it on the body they will be looking at. */
function stagePreviewJersey() {
  const c = typeof PLAYER_COLOR === 'object' && PLAYER_COLOR ? PLAYER_COLOR : null;
  return {
    body: c && c.body !== undefined ? c.body : 0xfff8f0,
    trim: c && c.trim !== undefined ? c.trim : 0xffc9d6,
    name: 'You'
  };
}

/* Measure the model — the real thing, `new THREE.Box3().setFromObject`, not
   a number per category. A gun is about 0.9m end to end and a character
   about 1.8m tall, and any framing that treats those two the same crops one
   of them; which one depends only on which the numbers were guessed against.

   Two things come out of it. The model is stood on y = 0, so a default and
   a skin of slightly different heights share a floor and the taller one
   honestly looks taller. And two extents are recorded: how tall it is, and
   the radius of the circle its footprint sweeps, which is the horizontal
   half-extent under the only transform the case applies — a turn about Y.
   Measuring once, at build time, is also what stops a model drifting:
   measuring a node that has already been offset would offset it again. */
function stageMeasure(node) {
  node.userData = node.userData || {};
  node.userData.pnFlat = 0.5;
  node.userData.pnHeight = 1;
  if (typeof THREE.Box3 !== 'function' || typeof THREE.Vector3 !== 'function') return;
  try {
    const box = new THREE.Box3().setFromObject(node);
    if (typeof box.isEmpty === 'function' && box.isEmpty()) return;
    const centre = new THREE.Vector3(), size = new THREE.Vector3();
    box.getCenter(centre);
    box.getSize(size);
    if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return;
    node.position.set(-centre.x, -(centre.y - size.y / 2), -centre.z);
    node.userData.pnFlat = Math.max(1e-3, 0.5 * Math.hypot(size.x, size.z));
    node.userData.pnHeight = Math.max(1e-3, size.y);
  } catch (e) {}
}

function stageCacheKey(kind, slot, skinId) {
  return kind + '|' + (slot || '') + '|' + (skinId || '');
}

/* Build one model, or answer null. `skinId` of null is the default look,
   which is the whole point of the comparison. Every way this can fail —
   a builder that is not there, a weapon slot the game does not have, an id
   from a relay newer than this client, a throw from inside a builder — is
   the same null, and the null is cached so a broken id costs one attempt
   rather than one per frame. */
function stagePreviewNode(kind, slot, skinId) {
  const key = stageCacheKey(kind, slot, skinId);
  if (STAGE.cache.has(key)) return STAGE.cache.get(key);
  if (STAGE.cache.size >= STAGE_CACHE_MAX) STAGE.cache.clear();

  let node = null;
  try {
    if (kind === 'character' && typeof buildCharacter === 'function') {
      const built = buildCharacter(stagePreviewJersey(), skinId || undefined);
      node = built && built.root ? built.root : null;
    } else if (kind === 'weapon' && typeof buildGunMesh === 'function') {
      const weapon = typeof WBY === 'object' && WBY ? WBY[slot] : null;
      if (weapon) node = buildGunMesh(weapon, skinId || undefined) || null;
    } else if (kind === 'effect' && typeof buildEffectPreview === 'function') {
      /* An effect has no model, so 60-fx.js hands the case a small loop of
         its own instead — see buildEffectPreview. `null` is the plain shot,
         which is what the default half of the comparison is. */
      node = buildEffectPreview(skinId || null) || null;
    }
  } catch (e) { node = null; }

  if (node) {
    /* buildCharacter marks every mesh as casting and receiving; there is no
       shadow map here to pay for it. */
    if (typeof node.traverse === 'function')
      try { node.traverse(o => { o.castShadow = false; o.receiveShadow = false; }); } catch (e) {}
    stageMeasure(node);
  }
  STAGE.cache.set(key, node);
  return node;
}

/* Which way a model faces on the frame it appears. It turns from here
   either way, but the first look should be the flattering one: a character
   looking at you, a gun in profile with the muzzle to the left. Both models
   are built facing -Z, which is away from a camera on +Z. */
function stageRestYaw(kind) {
  if (kind === 'weapon') return -Math.PI / 2;
  /* An effect crosses the case left to right and is built facing the lens
     already; turning it would only show the wake edge-on. */
  if (kind === 'effect') return 0;
  return Math.PI;
}

/* What to draw for an id. storeSlotOf is deliberately strict, because the
   question it answers is what may be *worn* and a generous answer there
   puts an id the server never confirmed into EQUIPPED. The case is only
   deciding what to point a camera at, so it is allowed to guess: a newer
   relay's `rifle-whatever` is a rifle whatever else it turns out to be,
   and a plain rifle in the case beats an apology. An id that is not even
   shaped like one of ours still comes back null and still gets the
   apology. */
function stageKindOf(id, type) {
  const where = storeSlotOf(id, type);
  if (where) return where;
  if (typeof id !== 'string' || !id) return null;
  if (id.indexOf('char-') === 0) return { kind: 'character' };
  if (id.indexOf('fx-') === 0) return { kind: 'effect' };
  const slot = id.split('-')[0];
  return STORE_SLOTS.indexOf(slot) >= 0 ? { kind: 'weapon', slot: slot } : null;
}

function stageMount(index, node, yaw0) {
  const slot = STAGE.slots[index];
  if (!slot) return;
  if (slot.node && slot.node !== node) {
    try { slot.spinner.remove(slot.node); } catch (e) {}
    slot.node = null;
  }
  if (node && slot.node !== node) {
    try { slot.spinner.add(node); } catch (e) { return; }
    slot.node = node;
  }
  slot.yaw0 = yaw0 || 0;
  /* Stand it where it is meant to rest. A stand that was turning a
     character a moment ago is still at that angle, and a thing that runs
     its own loop instead of spinning would inherit it and never work it
     off — a wake at 180 degrees is a wake pointing away. */
  slot.spinner.rotation.y = slot.yaw0;
  slot.pivot.visible = !!slot.node;
}

/* The box the camera has to fit, measured off what is actually mounted
   right now rather than off what category the item is in.

   The vertical half comes from a live `Box3` over the whole group — the
   default and the skin together, so the pair is framed as one object and
   shares a scale. A skin that is framed tighter than the default looks
   bigger than it is, which is a shop lying about the thing it is selling.

   The horizontal and depth halves come from the swept radii instead, so
   the frame does not breathe in and out as the models turn: a box measured
   at one yaw is not the box at the next. */
function stageBounds(shown) {
  if (!shown.length) return null;

  let flat = 0, top = 0;
  for (const s of shown) {
    flat = Math.max(flat, s.node.userData.pnFlat || 0.5);
    top = Math.max(top, s.node.userData.pnHeight || 1);
  }
  let minX = Infinity, maxX = -Infinity;
  for (const s of shown) {
    minX = Math.min(minX, s.pivot.position.x - flat);
    maxX = Math.max(maxX, s.pivot.position.x + flat);
  }

  /* The models stand on y = 0 and the tallest decides the top, which the
     measured heights already say. The Box3 is asked all the same, because
     it is the one answer that cannot go stale: a builder that grows a hat
     moves this without anybody remembering to change a constant. */
  let minY = 0, maxY = top;
  if (STAGE.group && typeof THREE.Box3 === 'function' && typeof THREE.Vector3 === 'function') {
    try {
      const box = new THREE.Box3().setFromObject(STAGE.group);
      if (!(typeof box.isEmpty === 'function' && box.isEmpty())) {
        const centre = new THREE.Vector3(), size = new THREE.Vector3();
        box.getCenter(centre);
        box.getSize(size);
        if (Number.isFinite(centre.y) && Number.isFinite(size.y) && size.y > 0) {
          minY = Math.min(minY, centre.y - size.y / 2);
          maxY = Math.max(maxY, centre.y + size.y / 2);
        }
      }
    } catch (e) {}
  }
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY, halfZ: flat };
}

/* Put a camera where the whole of `bounds` fits in front of it, with
   `band` of the bottom of the frame left empty for whatever is drawn over
   it. Nothing here knows what it is looking at — a 0.9m gun and a 1.8m
   character go through the same arithmetic and come out framed the same
   way, which is the only version of this that a redesign cannot break. */
function stageFrame(cam, bounds, band) {
  if (!cam || !bounds) return;
  const fov = (cam.fov || STAGE_FOV) * Math.PI / 180;
  const aspect = cam.aspect && Number.isFinite(cam.aspect) && cam.aspect > 0 ? cam.aspect : 1;
  const vHalf = Math.tan(fov / 2);                 // half the frame, per unit of distance
  const hHalf = vHalf * aspect;

  const halfX = Math.max(1e-3, (bounds.maxX - bounds.minX) / 2);
  const halfY = Math.max(1e-3, (bounds.maxY - bounds.minY) / 2);
  const halfZ = Math.max(0, bounds.halfZ);
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;
  const midZ = Number.isFinite(bounds.midZ) ? bounds.midZ : 0;

  /* Seen from a camera pitched down by STAGE_TILT, an upright box stands
     taller on the screen than it does in the world: the far top corner
     lifts by the depth times the sine of the tilt. */
  const needY = halfY * Math.cos(STAGE_TILT) + halfZ * Math.sin(STAGE_TILT);
  /* The content has to fit the part of the frame that is not the caption
     band, so the frame itself is that much taller than the content. */
  const frameHalf = needY / Math.max(0.2, 1 - (band || 0)) * STAGE_MARGIN;
  /* Whichever axis runs out first, and then stand back by the depth, since
     the near face of a turning model is `halfZ` closer than its middle. */
  const dist = Math.max(frameHalf / vHalf, halfX * STAGE_MARGIN / hHalf) + halfZ;

  /* Aiming below the middle by half the band is what lifts the content out
     of the captions; the frame was made taller by exactly that much above,
     so nothing goes off the top to pay for it. */
  const aimY = midY - frameHalf * (band || 0);
  cam.position.set(midX, aimY + Math.sin(STAGE_TILT) * dist, midZ + Math.cos(STAGE_TILT) * dist);
  if (typeof cam.lookAt === 'function') cam.lookAt(midX, aimY, midZ);
  return dist;
}

/* Stand the models where they go and put the camera where all of them fit. */
function stageLayout() {
  const cam = STAGE.camera;
  if (!cam) return;
  const shown = STAGE.slots.filter(s => s.node);
  if (!shown.length) return;

  let flat = 0;
  for (const s of shown) flat = Math.max(flat, s.node.userData.pnFlat || 0.5);

  if (shown.length > 1) {
    const offset = flat * 1.20;                   // a fifth of a model's width between them
    shown[0].pivot.position.x = -offset;
    shown[1].pivot.position.x = offset;
  } else {
    shown[0].pivot.position.x = 0;
  }

  const dist = stageFrame(cam, stageBounds(shown), STAGE_CAPTION) || 1;

  /* Toe the pair in towards the lens. Two models a metre apart under a
     perspective camera are seen from two different sides — the left one
     from its right, the right one from its left — and a comparison where
     the two halves are at different angles is not a comparison. Turning
     each stand by the angle it sits off the axis puts the same face of
     both in front of the player, which is what a shop window with two
     turntables in it actually does. */
  for (const slot of shown)
    slot.pivot.rotation.y = Math.atan2(-slot.pivot.position.x, dist);
}

/* =====================================================================
   THE PICTURE ON THE CARD

   A two-tone gradient labelled "Folded Paper Crane" tells a shopper nothing:
   every card looks like every other card and none of them looks like the
   thing being sold. So each card gets a render of its own item.

   It is drawn on the same renderer as the case, in the same scene and
   under the same lights, once per item, and kept as a data URL. Once is
   the whole point — six models redrawn every frame, behind a live game, is
   the sort of thing that is only ever noticed on somebody's phone. A card
   whose picture cannot be taken keeps the gradient it always had, which is
   also what every card looks like on a browser that gave the store no
   context at all.
   ===================================================================== */

/* The box something occupies exactly as it stands, straight off THREE, or
   null if that cannot be had. Only good for a still: the moment the thing
   turns, this is last frame's answer. */
function stageStillBounds(obj) {
  if (!obj || typeof THREE.Box3 !== 'function' || typeof THREE.Vector3 !== 'function') return null;
  try {
    const box = new THREE.Box3().setFromObject(obj);
    if (typeof box.isEmpty === 'function' && box.isEmpty()) return null;
    const centre = new THREE.Vector3(), size = new THREE.Vector3();
    box.getCenter(centre);
    box.getSize(size);
    if (!Number.isFinite(size.x) || !Number.isFinite(size.y) || !Number.isFinite(size.z)) return null;
    if (!(size.x > 0) && !(size.y > 0)) return null;
    return {
      minX: centre.x - size.x / 2, maxX: centre.x + size.x / 2,
      minY: centre.y - size.y / 2, maxY: centre.y + size.y / 2,
      halfZ: size.z / 2, midZ: centre.z
    };
  } catch (e) {}
  return null;
}

/* Empty both stands, so the models they were holding can be borrowed. */
function stageClearSlots() {
  for (const slot of STAGE.slots) {
    if (slot.node) { try { slot.spinner.remove(slot.node); } catch (e) {} }
    slot.node = null;
    slot.pivot.visible = false;
  }
}

/* One item, one picture, or null. Everything is put back afterwards by the
   caller — this leaves the renderer at the thumbnail's size and the stage
   stands empty. */
function stageDrawThumb(id, type) {
  const where = stageKindOf(id, type);
  if (!where || !STAGE.renderer || !STAGE.thumbPivot || !STAGE.thumbCam) return null;
  const node = stagePreviewNode(where.kind, where.slot, id);
  if (!node) return null;

  const canvas = (STAGE.renderer && STAGE.renderer.domElement) || STAGE.canvas;
  if (!canvas || typeof canvas.toDataURL !== 'function') return null;

  const pivot = STAGE.thumbPivot;
  let url = null;
  try {
    pivot.add(node);
    pivot.visible = true;
    pivot.rotation.y = stageRestYaw(where.kind);
    if (STAGE.rigs.world) STAGE.rigs.world.visible = where.kind !== 'weapon';
    if (STAGE.rigs.view) STAGE.rigs.view.visible = where.kind === 'weapon';

    /* A card's picture does not turn, so it is framed on the box the model
       actually occupies at the yaw it is drawn at rather than on the circle
       it would sweep — which is the difference between a gun that fills its
       card and a gun sitting in the middle of one. */
    const swept = {
      minX: -node.userData.pnFlat, maxX: node.userData.pnFlat,
      minY: 0, maxY: node.userData.pnHeight,
      halfZ: node.userData.pnFlat
    };
    stageFrame(STAGE.thumbCam, stageStillBounds(pivot) || swept, 0);
    if (typeof STAGE.thumbCam.updateProjectionMatrix === 'function')
      STAGE.thumbCam.updateProjectionMatrix();

    STAGE.renderer.setSize(STAGE_THUMB_W, STAGE_THUMB_H, false);
    STAGE.renderer.render(STAGE.scene, STAGE.thumbCam);
    url = canvas.toDataURL('image/png');
    if (typeof url !== 'string' || url.length < 32) url = null;
  } catch (e) {
    url = null;
  }
  try { pivot.remove(node); } catch (e) {}
  pivot.visible = false;
  return url;
}

/* Take whatever pictures are still missing, then put the case back exactly
   as it was. Called from the grid; a second call once every card has its
   picture does nothing at all, which is what makes this once per item
   rather than once per render. */
function stageMakeThumbs(items) {
  if (STAGE.can !== true || !STAGE.renderer) return false;
  let made = 0;
  for (const item of items) {
    if (STAGE.thumbs.has(item.id)) continue;
    if (STAGE.thumbs.size >= STAGE_CACHE_MAX) break;
    if (!made) stageClearSlots();          // the stands may be holding a model we need
    made++;
    STAGE.thumbs.set(item.id, stageDrawThumb(item.id, item.type));
  }
  if (!made) return false;
  /* The renderer is the thumbnail's size and the stands are empty; putting
     the case back is a re-apply, which re-mounts, re-sizes and re-frames. */
  STAGE.w = 0; STAGE.h = 0;
  stageApply();
  return true;
}

/* Drop the pictures into the cards that are already on screen, rather than
   rebuilding the grid — a card replaced under a finger is a card that was
   not pressed, and a keyboard would lose its place. */
function stageFillThumbs() {
  const grid = document.getElementById('storeGrid');
  if (!grid || typeof grid.querySelectorAll !== 'function') return;
  for (const swatch of grid.querySelectorAll('.swatch')) {
    if (!swatch.dataset || swatch.dataset.shot === '1') continue;
    const url = STAGE.thumbs.get(swatch.dataset.id);
    if (!url) continue;
    const img = document.createElement('img');
    img.className = 'sshot';
    img.src = url;
    /* Decoration on a control that the name and the kind underneath
       already say out loud. */
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    swatch.appendChild(img);
    swatch.dataset.shot = '1';
  }
}

/* Off the frame the panel opened on. Six models built and drawn is not
   free, and it is not worth making the panel wait to appear. */
function stageThumbsSoon(items) {
  if (STAGE.can !== true || STAGE.thumbJob) return;
  if (!storeIsOpen()) return;
  if (!items.some(item => !STAGE.thumbs.has(item.id))) return;
  const run = () => {
    STAGE.thumbJob = 0;
    if (STAGE.can !== true || !storeIsOpen()) return;
    if (stageMakeThumbs(items)) stageFillThumbs();
  };
  if (typeof requestAnimationFrame === 'function') {
    STAGE.thumbJob = requestAnimationFrame(run);
    /* requestAnimationFrame answers 0 on nothing real, and 0 is also the
       marker for "no job pending". */
    if (!STAGE.thumbJob) STAGE.thumbJob = -1;
  } else {
    run();
  }
}

/* The drawing buffer follows the element, the same way the game's does and
   for the same reason: the stylesheet owns the size, and on a phone the
   element is the only thing that knows the truth during a rotation. */
function stageResize() {
  const canvas = STAGE.canvas, renderer = STAGE.renderer, cam = STAGE.camera;
  if (!canvas || !renderer || !cam) return false;
  const w = Math.max(1, Math.round(canvas.clientWidth || 0));
  const h = Math.max(1, Math.round(canvas.clientHeight || 0));
  if (w === STAGE.w && h === STAGE.h) return false;
  STAGE.w = w; STAGE.h = h;
  try { renderer.setSize(w, h, false); } catch (e) {}
  cam.aspect = w / h;
  if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix();
  return true;
}

function stageHasContent() {
  return STAGE.slots.some(s => !!s.node);
}

function stageStart() {
  if (STAGE.raf || !STAGE.can || !STAGE.renderer) return;
  if (typeof requestAnimationFrame !== 'function') return;
  if (!storeIsOpen() || !stageHasContent()) return;
  STAGE.last = 0;
  STAGE.raf = requestAnimationFrame(stageTick);
}

/* Closing the panel stops the case dead. This runs beside a live game on a
   phone, and a hidden canvas turning a character forever is a frame budget
   spent on something nobody is looking at. */
function stageStop() {
  if (STAGE.raf && typeof cancelAnimationFrame === 'function') {
    try { cancelAnimationFrame(STAGE.raf); } catch (e) {}
  }
  STAGE.raf = 0;
  STAGE.last = 0;
}

function stageTick() {
  STAGE.raf = 0;
  if (!STAGE.renderer || !STAGE.can) return;
  /* Belt as well as braces on the stop above: whatever route the panel was
     closed by, the loop ends on the next frame it is asked for. */
  if (!storeIsOpen() || !stageHasContent()) { STAGE.last = 0; return; }

  const now = Date.now();
  /* A tab that was in the background comes back with a huge gap on the
     clock, and a frame that advanced the turn by four seconds reads as a
     jump. Clamp it, and start from a standstill. */
  const dt = STAGE.last ? Math.min(0.05, Math.max(0, (now - STAGE.last) / 1000)) : 0;
  STAGE.last = now;
  STAGE.spin = (STAGE.spin + dt * STAGE_SPIN) % STAGE_TAU;

  if (stageResize()) stageLayout();
  for (const slot of STAGE.slots) {
    if (!slot.node) continue;
    /* A model turns on its stand; a thing that is already motion runs its
       own loop instead and is left facing the lens, because a wake seen
       edge-on is nothing to look at. Its loop is the store's alone — it
       is asked for a frame only while the panel is up, and the whole of
       this function stops when the panel closes. */
    const tick = slot.node.userData && slot.node.userData.pnTick;
    if (typeof tick === 'function') { try { tick(dt); } catch (e) {} }
    else slot.spinner.rotation.y = slot.yaw0 + STAGE.spin;
  }

  try {
    STAGE.renderer.render(STAGE.scene, STAGE.camera);
  } catch (e) {
    stageGiveUp();
    return;
  }

  if (typeof requestAnimationFrame === 'function') STAGE.raf = requestAnimationFrame(stageTick);
}

/* The item the case is showing, and everything written under it. Safe to
   call at any time: with no elements, no THREE or no builders it hides the
   case and returns, which is the whole of the fallback. */
function stageApply() {
  const wrap = stageEl('storeStage');
  if (!wrap) return;
  if (!stageInit()) { wrap.hidden = true; stageStop(); return; }
  wrap.hidden = false;

  const id = STAGE.itemId;
  const known = STORE_BY_ID.get(id);
  const listed = (ACCOUNT.items || []).find(entry => entry.id === id);
  const where = id ? stageKindOf(id, listed ? listed.type : (known ? known.type : '')) : null;
  const kind = where ? where.kind : null;

  /* An id whose kind cannot be worked out — a relay selling something this
     client has never heard of — reaches here as a null kind and comes out
     the other side as a sentence, not a throw. */
  const skin = kind ? stagePreviewNode(kind, where.slot, id) : null;
  const base = kind ? stagePreviewNode(kind, where.slot, null) : null;
  /* Comparing needs two different models. A skin whose renderer has not
     landed falls back to showing the default alone, which is still an
     honest answer to "what am I looking at". */
  const pair = !!skin && !!base && skin !== base;
  const rest = stageRestYaw(kind);

  stageMount(0, pair && STAGE.compare ? base : null, rest);
  stageMount(1, skin || base || null, rest);

  /* Guns are seen in your own hands and characters across the street, so
     each gets the rig it is really lit by. */
  if (STAGE.rigs.world) STAGE.rigs.world.visible = kind !== 'weapon';
  if (STAGE.rigs.view) STAGE.rigs.view.visible = kind === 'weapon';

  const name = listed && listed.name ? listed.name : (known ? known.name : (id || ''));
  const nameEl = stageEl('stageName');
  const kindEl = stageEl('stageKind');
  if (nameEl) nameEl.textContent = name;
  if (kindEl) kindEl.textContent = id ? storeKindLabel(id, listed ? listed.type : '') : '';

  const showing = stageHasContent();
  const empty = stageEl('stageEmpty');
  if (empty) {
    empty.hidden = showing;
    empty.textContent = showing ? '' : 'No preview for this one yet — it is still a surprise.';
  }
  const tagA = stageEl('stageTagA');
  const tagB = stageEl('stageTagB');
  if (tagA) tagA.hidden = !(showing && pair && STAGE.compare);
  if (tagB) {
    tagB.hidden = !showing;
    /* With nothing to compare against, the caption would be naming the only
       thing on screen twice — the row underneath already says what it is. */
    tagB.textContent = pair && STAGE.compare ? (name || 'THIS SKIN').toUpperCase()
      : (skin ? '' : 'DEFAULT');
    if (!tagB.textContent) tagB.hidden = true;
  }
  const toggle = stageEl('stageCompare');
  if (toggle) {
    toggle.hidden = !pair;
    toggle.textContent = STAGE.compare ? 'HIDE DEFAULT' : 'COMPARE';
    toggle.setAttribute('aria-pressed', String(STAGE.compare));
    toggle.setAttribute('aria-label',
      STAGE.compare ? 'Show this skin on its own' : 'Show the default beside this skin');
  }

  stageResize();
  stageLayout();
  if (showing) stageStart(); else stageStop();
}

/* Pressing a card. Deliberately not a re-render of the grid: the button
   that was pressed would be replaced under the player's finger and a
   keyboard would lose its place, so only the two classes that changed are
   touched. */
function stageSelect(id) {
  if (!id || id === STAGE.itemId) return;
  STAGE.itemId = id;
  stageApply();
  stageMarkSelected();
  if (typeof SFX === 'object' && SFX) SFX.ui();
}

function stageMarkSelected() {
  const grid = document.getElementById('storeGrid');
  if (!grid || typeof grid.querySelectorAll !== 'function') return;
  for (const card of grid.querySelectorAll('.sitem'))
    card.classList.toggle('sel', card.dataset && card.dataset.id === STAGE.itemId);
  for (const pick of grid.querySelectorAll('.spick'))
    pick.setAttribute('aria-pressed',
      String(!!(pick.dataset && pick.dataset.id === STAGE.itemId)));
}

function stageToggleCompare() {
  STAGE.compare = !STAGE.compare;
  stageApply();
  if (typeof SFX === 'object' && SFX) SFX.ui();
}

/* Opening the panel. The selection survives a close, so coming back lands
   on the item that was being looked at; an id that is no longer for sale
   falls back to the first card. */
function stageOpen() {
  const items = storeDisplayItems();
  if (!STAGE.itemId || !items.some(entry => entry.id === STAGE.itemId))
    STAGE.itemId = items.length ? items[0].id : null;
  stageApply();
}

/* =====================================================================
   DRAWING IT
   ===================================================================== */
function storeLockerNote(text) {
  const el = document.getElementById('lockerNote');
  if (el) el.textContent = text || '';
}

function storeNote(text, kind) {
  const el = document.getElementById('storeNote');
  if (!el) return;
  el.textContent = text || '';
  el.dataset.kind = kind || '';
}

function storeRenderAccount() {
  const signIn = document.getElementById('signIn');
  const who = document.getElementById('lockerWho');
  const name = document.getElementById('accountName');
  const inside = storeSignedIn();
  if (signIn) signIn.hidden = inside;
  if (who) who.hidden = !inside;
  if (name) name.textContent = inside ? ACCOUNT.user.displayName : '';
  const whoLine = document.getElementById('storeWho');
  if (whoLine) {
    whoLine.textContent = inside
      ? 'Signed in as ' + ACCOUNT.user.displayName
      : 'Skins for your guns and your fighter, and effects for your shots.';
  }
}

/* What the panel lists. The relay's catalog when there is one, the six we
   know about when there is not — an empty shelf reads as a broken game,
   where six cards and one plain sentence about the store being away reads
   as a store being away. */
function storeDisplayItems() {
  if (ACCOUNT.items && ACCOUNT.items.length) return ACCOUNT.items;
  return STORE_ITEMS.map(item => ({
    id: item.id, name: item.name, type: item.type, price: undefined, owned: false
  }));
}

function storeKindLabel(id, type) {
  const where = storeSlotOf(id, type);
  if (!where) return 'SKIN';
  if (where.kind === 'character') return 'CHARACTER SKIN';
  if (where.kind === 'effect') return 'SHOT EFFECT';
  const gun = typeof WBY === 'object' && WBY && WBY[where.slot] ? WBY[where.slot].name : where.slot;
  return gun + ' SKIN';
}

function storeRenderGrid() {
  const grid = document.getElementById('storeGrid');
  if (!grid) return;
  const inside = storeSignedIn();
  /* The case is only offered once a context has actually been made. Before
     the first open, and on any browser that could not give the store one,
     the cards are the plain blocks they have always been rather than
     buttons that load a picture nobody can see. */
  const staged = STAGE.can === true;
  const items = storeDisplayItems();
  /* The catalog can change under a selection — a relay coming back with a
     different six. Re-point at the first card rather than leave the case
     showing something no longer on the shelf. */
  if (staged && !items.some(entry => entry.id === STAGE.itemId)) {
    STAGE.itemId = items.length ? items[0].id : null;
    stageApply();
  }
  grid.innerHTML = '';

  for (const item of items) {
    const known = STORE_BY_ID.get(item.id);
    const owned = ACCOUNT.owned.has(item.id);
    const equipped = owned && storeIsEquipped(item.id);
    const selected = staged && item.id === STAGE.itemId;
    const card = document.createElement('div');
    card.className = 'sitem' + (owned ? ' owned' : '') + (equipped ? ' on' : '') +
      (selected ? ' sel' : '');
    card.dataset.id = item.id;

    /* The picture and the two lines of text are one control when there is a
       case to load, and plain text when there is not. Keeping BUY out of it
       is what lets this be a real <button> rather than a div wearing a role:
       nothing interactive is ever nested inside anything else. */
    const pick = staged ? document.createElement('button') : document.createElement('div');
    pick.className = 'spick';
    if (staged) {
      pick.type = 'button';
      pick.dataset.id = item.id;
      pick.setAttribute('aria-pressed', String(selected));
      pick.setAttribute('aria-label', 'Preview ' + item.name);
      pick.addEventListener('click', () => stageSelect(item.id));
    }
    card.appendChild(pick);

    /* The gradient is the backdrop the picture is drawn against, and on a
       browser with no context — or for an item whose model this client
       cannot build — it is the whole card, exactly as it was before any of
       this existed. */
    const swatch = document.createElement('div');
    swatch.className = 'swatch';
    swatch.dataset.id = item.id;
    const tint = known ? known.tint : ['#fff8f0', '#d4c5f9'];
    swatch.style.background = 'linear-gradient(150deg,' + tint[0] + ',' + tint[1] + ')';
    pick.appendChild(swatch);

    const name = document.createElement('div');
    name.className = 'sname';
    name.textContent = item.name;
    pick.appendChild(name);

    const kind = document.createElement('div');
    kind.className = 'skind';
    kind.textContent = storeKindLabel(item.id, item.type);
    pick.appendChild(kind);

    const foot = document.createElement('div');
    foot.className = 'sfoot';
    const price = document.createElement('span');
    price.className = 'sprice';
    price.textContent = owned ? 'OWNED' : storePriceText(item.price);
    foot.appendChild(price);

    const act = document.createElement('button');
    act.className = 'mini-btn';
    act.type = 'button';
    if (!inside) {
      act.textContent = 'SIGN IN';
      act.setAttribute('aria-label', 'Sign in to buy ' + item.name);
      act.addEventListener('click', () => storeBeginSignIn());
    } else if (owned) {
      act.textContent = equipped ? 'EQUIPPED' : 'EQUIP';
      act.setAttribute('aria-pressed', String(equipped));
      act.setAttribute('aria-label', (equipped ? 'Take off ' : 'Equip ') + item.name);
      act.addEventListener('click', () => storeEquip(item.id, item.type));
    } else {
      act.textContent = ACCOUNT.checkingOut ? 'WAIT…' : 'BUY';
      act.disabled = ACCOUNT.checkingOut;
      act.setAttribute('aria-label', 'Buy ' + item.name);
      act.addEventListener('click', () => storeBuy(item.id));
    }
    foot.appendChild(act);
    card.appendChild(foot);
    grid.appendChild(card);
  }

  /* Whatever pictures have already been taken go straight on; the rest are
     taken once, off the next frame. */
  stageFillThumbs();
  stageThumbsSoon(items);
}

/* =====================================================================
   OPENING AND CLOSING
   ===================================================================== */
function storeIsOpen() {
  const panel = document.getElementById('store');
  return !!panel && !panel.classList.contains('off');
}

/* =====================================================================
   THE KEYBOARD, WHILE THE PANEL IS UP

   The store is a dialog drawn over the title card, and the title card is
   still sitting behind it in DOM order. Without this, Tab from an opened
   store walks straight into the sensitivity slider, PLAY and the room
   controls — all of them under an opaque overlay, so the focus ring is
   somewhere the player cannot see. `inert` takes the whole title card out
   of the tab order where the browser supports it; the trap below is what
   holds the line everywhere else, and is also what makes Tab wrap at the
   ends of the dialog the way a dialog is supposed to.
   ===================================================================== */
const STORE_FOCUS = { opener: null };

function storeFocusables() {
  const panel = document.getElementById('store');
  if (!panel || typeof panel.querySelectorAll !== 'function') return [];
  const found = [];
  for (const el of panel.querySelectorAll('button,a[href],input,select,textarea,[tabindex]')) {
    if (el.disabled || el.hidden) continue;
    if (el.getAttribute && el.getAttribute('tabindex') === '-1') continue;
    found.push(el);
  }
  return found;
}

/* Tab is moved by hand rather than left to the browser, because on this page
   the browser never gets it: Tab is the scoreboard key, and 70-game.js takes
   it with preventDefault on every keydown there is. That is fine in a match
   and useless in a dialog, so while the panel is up this walks the ring
   itself — which is also, conveniently, exactly the wrap a modal wants. */
function storeTrapFocus(e) {
  if (e.code !== 'Tab' || !storeIsOpen()) return;
  const panel = document.getElementById('store');
  const items = storeFocusables();
  if (!panel || !items.length) return;
  e.preventDefault();
  const active = document.activeElement;
  const at = items.indexOf(active);
  /* Anywhere that is not one of the ring's stops — the card itself, or
     something behind the panel — starts the walk at the near end. */
  const next = at < 0
    ? (e.shiftKey ? items.length - 1 : 0)
    : (at + (e.shiftKey ? items.length - 1 : 1)) % items.length;
  items[next].focus();
}

function storeSetTitleInert(inert) {
  const title = document.getElementById('title');
  if (title && 'inert' in title) title.inert = inert;
}

function storeShow(open) {
  const panel = document.getElementById('store');
  if (!panel) return;
  const wasOpen = storeIsOpen();
  panel.classList.toggle('off', !open);
  storeSetTitleInert(!!open);

  if (!open) {
    /* The case goes still the moment the panel does. Every way out of the
       store — CLOSE, Escape, the wash — arrives here, so this is the one
       place that has to remember. */
    stageStop();
    /* Back where they came from. A dialog that drops focus on the body
       leaves a keyboard player at the top of the document, several Tabs
       from the button they just pressed. */
    if (wasOpen) {
      const opener = STORE_FOCUS.opener;
      STORE_FOCUS.opener = null;
      if (opener && typeof opener.focus === 'function') { try { opener.focus(); } catch (e) {} }
    }
    return;
  }

  if (!wasOpen) {
    STORE_FOCUS.opener = document.activeElement || null;
    const card = panel.querySelector ? panel.querySelector('.store-card') : null;
    const target = card || storeFocusables()[0];
    if (target && typeof target.focus === 'function') { try { target.focus(); } catch (e) {} }
  }
  if (typeof SFX === 'object' && SFX) SFX.ui();
  storeRenderAccount();
  /* Before the grid, because whether the cards are pressable pictures or
     plain blocks is decided by whether a context could be made — and that
     is decided here, on the first open and never again. */
  stageOpen();
  storeRenderGrid();
  if (!storeSignedIn() && !ACCOUNT.token)
    storeNote('Sign in to buy and equip skins. Everything else is free and always will be.');
  /* Opened is the only moment the catalog is actually wanted, so the first
     open is what pays for it. Every open after that re-asks anyway — a
     purchase may have completed in another tab since. */
  if (ACCOUNT.token) storeRefreshAll();
  else storeRefreshCatalog();
}

/* =====================================================================
   BOOT
   ===================================================================== */
function initStore() {
  const origin = storeAuthOrigin();
  /* A callback token is never adopted here, however valid it looks. By this
     point it has already been dealt with the only way it can be: if this
     window is the popup of a sign-in this browser asked for, it was posted to
     the opener and this window is closing; otherwise it was somebody else's
     link and it is gone. Either way the token that runs this page comes from
     storage, which is to say from a session this browser earned.

     Anything stored that is not a live token for this relay — expired, issued
     elsewhere, or hand-edited — is not a session. Drop it rather than carry it
     around waiting to fail a request. */
  const saved = origin ? storeLoadToken(origin) : null;
  if (saved) {
    ACCOUNT.token = saved.token;
    ACCOUNT.tokenOrigin = origin;
    ACCOUNT.expiresAt = saved.expiresAt;
  } else {
    storeErase(STORE_TOKEN_KEY);
  }

  const signIn = document.getElementById('signIn');
  const signOut = document.getElementById('signOut');
  const open = document.getElementById('storeOpen');
  const close = document.getElementById('storeClose');
  const panel = document.getElementById('store');
  if (signIn) signIn.addEventListener('click', () => storeBeginSignIn());
  if (signOut) signOut.addEventListener('click', () => storeSignOut());
  const compare = document.getElementById('stageCompare');
  if (compare) compare.addEventListener('click', () => stageToggleCompare());
  if (open) open.addEventListener('click', () => storeShow(true));
  if (close) close.addEventListener('click', () => { storeShow(false); if (typeof SFX === 'object' && SFX) SFX.ui(); });
  /* The wash around the card is a way out on a phone, where CLOSE sits at the
     top of a tall panel and a thumb is already at the bottom. */
  if (panel) panel.addEventListener('click', e => { if (e.target === panel) storeShow(false); });
  /* Escape is the other way out. Nothing else claims it here — the store only
     opens from the title menu, and the pause card's Escape handling is behind
     a started match. */
  addEventListener('keydown', e => { if (e.code === 'Escape' && storeIsOpen()) storeShow(false); });
  addEventListener('keydown', storeTrapFocus);
  /* The sign-in popup posts the token back here and closes itself. */
  addEventListener('message', storeOnAuthMessage);

  storeRenderAccount();
  storeApplyEquipped();

  /* Checkout takes the whole browser — Stripe's page is not ours to put in a
     frame — so coming back from one is a fresh load. This is what puts the
     player back in the panel they bought from and what makes the purchase
     show up without them reloading. Sign-in no longer needs it: that happens
     in a window of its own and this page never goes anywhere. */
  if (storeSessionRead(STORE_RETURN_KEY)) {
    storeSessionErase(STORE_RETURN_KEY);
    storeShow(true);
  } else if (ACCOUNT.token) {
    /* Entitlements are wanted on every load whether or not the panel is
       opened, because they are what decides what EQUIPPED may hold. */
    storeRefreshMe();
  }

  /* The other shape of the same trip: a checkout that opened in another tab,
     or a phone that only backgrounded us. There is no load to hang the
     re-check off, so the tab coming back into view is the signal. Rate
     limited because tab switching is not a rare event. */
  const wake = () => {
    /* A backgrounded tab gets no frames anyway on most browsers, but "most"
       is not "all" and a phone that keeps handing them out is a phone
       turning a character nobody can see. Stopping and restarting by hand
       costs nothing and is true everywhere. */
    if (document.visibilityState !== 'visible') { stageStop(); return; }
    if (storeIsOpen()) stageStart();
    if (!ACCOUNT.token) return;
    if (!storeIsOpen() && !ACCOUNT.user) return;
    if (Date.now() - ACCOUNT.lastRefresh < 5000) return;
    ACCOUNT.lastRefresh = Date.now();
    /* With the panel shut, entitlements are the only part that matters —
       nothing is drawing prices. */
    if (storeIsOpen()) storeRefreshAll(); else storeRefreshMe();
  };
  document.addEventListener('visibilitychange', wake);
  addEventListener('pageshow', wake);
}
