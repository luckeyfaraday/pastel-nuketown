'use strict';

/* =====================================================================
   Headless host + guest harness.

   The point of this file is to make "is the guest's experience worse, and
   did that change help?" a number instead of an opinion. Three rounds of
   netcode fixes shipped without one, and their effect turned out to be
   marginal in a way nothing in the repo could have caught.

   It runs THE REAL CLIENT. bots.sim.js, the other headless simulation here,
   reimplements the physics it exercises -- fine for AI behaviour, useless as
   evidence about netcode, because the number would move when you fixed the
   copy and stay put in the shipped game. This loads src/*.js instead.

   That works because index.html is a series of separate <script> tags, and a
   vm context evaluating one script per file reproduces those semantics
   exactly: `var` and function declarations land on the global object, and
   top-level `const`/`let` land in the shared global lexical scope. The files
   see each other exactly as they do in the browser, and nothing in src/ has
   to change to become testable.

   Everything visual or audible is stubbed to a no-op. Everything that decides
   where a body is, whether a bullet connects, or what crosses the wire is the
   real code.
   ===================================================================== */

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const NETP = require('./net-protocol.js');

const ROOT = __dirname;
const FIXED = 1 / 60;

/* Load order is build.sh's order and has to stay that way: these files depend
   on each other's top-level constants in exactly this sequence.

   src/90-main.js is deliberately absent. It is boot plus the render loop, and
   it calls boot() on load -- which builds a WebGL renderer and the whole map
   geometry. None of that decides where a body is or whether a bullet
   connects, so the harness would be paying for a Three.js emulation detailed
   enough to survive it and getting no fidelity in return. Nothing the
   simulation needs lives there: requestLock and exitPointerLock are in
   70-game.js, setPaused is in 80-ui.js, and 70-game.js's only mention of
   `camera` is in a comment. WORLD is declared in 20-world.js with the empty
   `mannequins` array hitscan reads, and map collision comes from mapspec. */
const FILES = [
  'mapspec.js', 'bots.js', 'net-protocol.js',
  'src/10-core.js', 'src/20-world.js', 'src/30-physics.js', 'src/40-weapons.js',
  'src/50-actors.js', 'src/60-fx.js', 'src/70-game.js', 'src/75-network.js',
  'src/78-touch.js', 'src/80-ui.js'
];

const SOURCE = new Map();
function sourceOf(file) {
  if (!SOURCE.has(file)) SOURCE.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return SOURCE.get(file);
}

function noop() {}

/* ---------------------------------------------------------------------
   Browser stubs

   Deliberately dumb. A stub that tried to model the DOM or Three.js would be
   one more thing that can be wrong; these only have to not throw, and never
   to hand back a number anyone could mistake for simulation state.
   --------------------------------------------------------------------- */

function stubNode(name) {
  const call = function () { return stubNode(name); };
  return new Proxy(call, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return undefined;
      if (prop === 'then') return undefined;
      if (prop === 'toString') return () => '[stub ' + name + ']';
      if (prop === 'length') return 0;
      if (prop === 'visible') return true;
      if (prop === 'x' || prop === 'y' || prop === 'z' || prop === 'w') return 0;
      return stubNode(name + '.' + String(prop));
    },
    set() { return true; },
    has() { return true; },
    apply() { return stubNode(name); }
  });
}

function fakeElement(id) {
  return {
    id: id, tagName: 'DIV', textContent: '', innerHTML: '', value: '',
    hidden: false, disabled: false, checked: false, width: 1280, height: 720,
    style: new Proxy({}, { get: () => '', set: () => true }),
    dataset: {},
    children: [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild: child => child, removeChild: noop, remove: noop,
    insertBefore: child => child,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => fakeElement('q'), querySelectorAll: () => [],
    getContext: () => stubNode('ctx2d'),
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1280, height: 720, top: 0, left: 0 }),
    setAttribute: noop, getAttribute: () => null,
    focus: noop, blur: noop, click: noop, requestPointerLock: noop
  };
}

/* Vector3 and Color are real because game code computes with them --
   fireWeapon reads a bot's muzzle through a Vector3. The rest of Three.js
   only has to absorb calls. */
class SimVector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new SimVector3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  setFromMatrixPosition() { return this; }
  applyQuaternion() { return this; }
  applyMatrix4() { return this; }
}

class SimColor {
  constructor(hex) { this.hex = hex >>> 0; }
  convertSRGBToLinear() { return this; }
  getHex() { return this.hex; }
  setHex(hex) { this.hex = hex >>> 0; return this; }
  clone() { return new SimColor(this.hex); }
}

function makeThree() {
  const real = {
    Vector3: SimVector3,
    Color: SimColor,
    MathUtils: {
      lerp: (a, b, t) => a + (b - a) * t,
      clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
    }
  };
  return new Proxy(real, {
    get: (target, prop) => (prop in target ? target[prop] : stubNode('THREE.' + String(prop))),
    has: () => true
  });
}

class SimAudioContext {
  constructor() { this.destination = {}; this.currentTime = 0; this.state = 'running'; }
  resume() {}
  close() {}
  createGain() { return stubNode('gain'); }
  createOscillator() { return stubNode('osc'); }
  createBufferSource() { return stubNode('bufsrc'); }
  createBuffer() { return stubNode('buf'); }
  createBiquadFilter() { return stubNode('filter'); }
  createDynamicsCompressor() { return stubNode('comp'); }
  createPanner() { return stubNode('panner'); }
  createStereoPanner() { return stubNode('stereo'); }
}

function makeGlobals(clock) {
  const g = {
    console: console,
    Math, JSON, Date, Object, Array, Number, String, Boolean, RegExp,
    Map, Set, WeakMap, WeakSet, Error, TypeError, RangeError,
    Promise, Symbol, Proxy, Reflect, isNaN, isFinite, parseInt, parseFloat,
    Float32Array, Uint8Array, Uint16Array, Uint32Array, Int32Array, ArrayBuffer,
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => clock.ms },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
    location: {
      search: '', protocol: 'http:', host: 'localhost:3000',
      hostname: 'localhost', href: 'http://localhost:3000/'
    },
    navigator: { userAgent: 'node', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    addEventListener: noop, removeEventListener: noop,
    document: {
      getElementById: id => fakeElement(id),
      createElement: tag => fakeElement(tag),
      createTextNode: text => ({ nodeValue: String(text), textContent: String(text) }),
      createDocumentFragment: () => fakeElement('fragment'),
      querySelector: () => fakeElement('q'),
      querySelectorAll: () => [],
      addEventListener: noop, removeEventListener: noop,
      body: fakeElement('body'),
      documentElement: fakeElement('html'),
      exitPointerLock: noop,
      pointerLockElement: null,
      hidden: false
    },
    THREE: makeThree(),
    AudioContext: SimAudioContext
  };
  g.globalThis = g;
  g.window = g;
  g.self = g;
  g.webkitAudioContext = SimAudioContext;
  /* Sockets come from the link, never dialled. WebSocket.OPEN has to carry the
     real constant because netSocketOpen() compares against it. */
  g.WebSocket = class { constructor() { this.readyState = 3; } send() {} close() {} };
  g.WebSocket.CONNECTING = 0;
  g.WebSocket.OPEN = 1;
  g.WebSocket.CLOSING = 2;
  g.WebSocket.CLOSED = 3;
  return g;
}

/* ---------------------------------------------------------------------
   One player's whole world
   --------------------------------------------------------------------- */

/* initRenderer() would have assigned these, and it lives in the boot path the
   harness skips. Actor setup still calls scene.add() to hang a body in the
   world, so they have to exist -- they just have nothing to do. */
const RENDER_STANDINS = `
  scene = { add() {}, remove() {}, traverse() {}, children: [] };
  camera = {
    position: { set() {}, copy() {}, x: 0, y: 0, z: 0 },
    rotation: { set() {} },
    quaternion: { copy() {}, setFromEuler() {} },
    matrixWorld: {},
    lookAt() {}, updateProjectionMatrix() {}, updateMatrixWorld() {},
    getWorldDirection(target) {
      if (target && typeof target.set === 'function') target.set(0, 0, -1);
      return target;
    },
    aspect: 16 / 9
  };
  renderer = null;
`;

function createInstance(clock) {
  const context = vm.createContext(makeGlobals(clock));
  for (const file of FILES) {
    vm.runInContext(sourceOf(file), context, { filename: file });
  }
  vm.runInContext(RENDER_STANDINS, context, { filename: 'net-sim:render-standins' });
  return {
    context: context,
    run(source) { return vm.runInContext(source, context); },
    get(name) { return vm.runInContext(name, context); },
    call(name, ...args) { return vm.runInContext(name, context)(...args); }
  };
}

/* The init calls boot() makes that the simulation actually depends on.
   buildWorld() is not among them: it decorates the map, and the collision the
   harness cares about comes from mapspec. The visible cost is that
   WORLD.mannequins stays empty, so a shot that would have stopped on a
   mannequin flies on -- immaterial between two players in a duel, but it is a
   real divergence from the browser and worth knowing when reading a number. */
const SIM_BOOT = 'initViewmodel(); initFX(); initInput(); initAI();';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOST_ID = 'host-0001';
const GUEST_ID = 'guest-001';

/* ---------------------------------------------------------------------
   The link

   Models the relay, not just a delay line. The relay does not forward a
   guest's input verbatim: it runs it through Protocol.sanitizeInput and
   forwards the sanitized value with `from` stamped on. That clamps and
   canonicalises the payload, so a harness that skipped it would be measuring
   a wire contract nobody actually ships.
   --------------------------------------------------------------------- */
function createLink(clock, opts) {
  const latency = opts.latencyMs === undefined ? 96 : opts.latencyMs;
  const jitter = opts.jitterMs === undefined ? 0 : opts.jitterMs;
  const loss = opts.lossPct === undefined ? 0 : opts.lossPct;
  const rng = mulberry32(opts.seed === undefined ? 1 : opts.seed);

  const inflight = [];
  const stats = { sent: 0, dropped: 0, delivered: 0, rejected: 0, staleEpoch: 0 };
  let relayLastSeq = -1;
  /* Rooms open at epoch 1 (server.mjs), and the relay drops a message whose
     epoch does not match -- for guest input, silently, with no error back.
     Modelling that is the point: a message that forgot the field would sail
     through a plain delay line and read as a latency regression rather than
     the dropped packet it is. staleEpoch makes it a number instead. */
  let authorityEpoch = opts.authorityEpoch === undefined ? 1 : opts.authorityEpoch;

  function epochCurrent(message) {
    if (message.authorityEpoch === authorityEpoch) return true;
    stats.staleEpoch++;
    return false;
  }

  function enqueue(to, payload) {
    stats.sent++;
    if (loss > 0 && rng() * 100 < loss) { stats.dropped++; return; }
    /* Jitter is one-sided: a packet can be late, never early. Allowing
       negative jitter would let packets overtake each other, which a single
       TCP stream cannot do -- and head-of-line blocking is precisely the
       guest-side pain this is here to reproduce honestly. */
    const delay = latency + (jitter > 0 ? rng() * jitter : 0);
    inflight.push({ at: clock.ms + delay, to: to, raw: JSON.stringify(payload) });
  }

  return {
    stats: stats,
    /* Guest -> relay -> host. */
    fromGuest(message) {
      if (message.t !== 'input') { enqueue('host', message); return; }
      if (!epochCurrent(message)) return;
      const sanitized = NETP.sanitizeInput(message, relayLastSeq);
      if (!sanitized.ok) { stats.rejected++; return; }
      relayLastSeq = sanitized.value.seq;
      enqueue('host', Object.assign({}, sanitized.value, { from: GUEST_ID }));
    },
    /* Host -> relay -> guest, forwarded as-is once the epoch checks out. */
    fromHost(message) {
      if (!epochCurrent(message)) return;
      enqueue('guest', message);
    },
    /* Host departure and promotion bump the room's epoch. Exposed so a future
       migration scenario can drive it; nothing calls it yet. */
    epoch: () => authorityEpoch,
    bumpEpoch() { return ++authorityEpoch; },
    /* Deliver everything due, oldest first. */
    pump(deliver) {
      inflight.sort((a, b) => a.at - b.at);
      while (inflight.length && inflight[0].at <= clock.ms) {
        const packet = inflight.shift();
        stats.delivered++;
        deliver(packet.to, packet.raw);
      }
    },
    reset() { inflight.length = 0; relayLastSeq = -1; }
  };
}

/* ---------------------------------------------------------------------
   A match: two real clients joined by the link
   --------------------------------------------------------------------- */
function createMatch(opts = {}) {
  const clock = { ms: 0 };
  const link = createLink(clock, opts);
  const host = createInstance(clock);
  const guest = createInstance(clock);
  const combatants = opts.combatants === undefined ? 2 : opts.combatants;

  const members = [
    { id: HOST_ID, name: 'HOST', role: 'host' },
    { id: GUEST_ID, name: 'GUEST', role: 'guest' }
  ];

  function socketFor(side) {
    return {
      readyState: 1,
      bufferedAmount: 0,
      send(raw) {
        const message = JSON.parse(raw);
        if (side === 'host') link.fromHost(message);
        else link.fromGuest(message);
      },
      close() { this.readyState = 3; }
    };
  }

  function begin(instance, mode) {
    instance.context.__socket = socketFor(mode);
    instance.context.__members = members;
    instance.run(SIM_BOOT);
    instance.run(`
      CFG.combatants = ${combatants};
      NET.mode = ${JSON.stringify(mode)};
      NET.id = ${JSON.stringify(mode === 'host' ? HOST_ID : GUEST_ID)};
      NET.room = 'SIMRUN';
      NET.round = 1;
      /* The relay hands this out in the room reply; the harness skips the
         lobby, so it is set here. Leaving it at 0 would have every guest
         input silently dropped for a stale epoch. */
      NET.authorityEpoch = ${link.epoch()};
      NET.members = __members.map(m => ({ id: m.id, name: m.name, role: m.role }));
      NET.socket = __socket;
      netBeginMatch();
      /* netBeginMatch leaves a click-to-deploy card up, because a message from
         the host is not a user gesture. Nobody is going to click it here. */
      G.paused = false;
      G.frozen = false;
    `);
  }

  begin(host, 'host');
  begin(guest, 'guest');

  function deliver(to, raw) {
    const target = to === 'host' ? host : guest;
    target.context.__wire = raw;
    target.run('netHandleWire(__wire)');
  }

  let ticks = 0;
  function tick() {
    clock.ms += FIXED * 1000;
    link.pump(deliver);
    guest.run(`netFrame(${clock.ms})`);
    host.run(`simulate(${FIXED})`);
    guest.run(`simulate(${FIXED})`);
    ticks++;
  }

  return {
    clock, link, host, guest, members,
    HOST_ID, GUEST_ID,
    tick,
    ticks: () => ticks,
    /* Advance whole seconds of simulated time at the fixed step. */
    run(seconds) {
      const steps = Math.round(seconds / FIXED);
      for (let i = 0; i < steps; i++) tick();
      return this;
    }
  };
}

/* ---------------------------------------------------------------------
   Scenarios
   --------------------------------------------------------------------- */

const EYE = 1.62;          // actorEye() for a standing actor
const CHEST = 1.05;
const FACING_EAST = Math.PI / 2;   // forward is (sin yaw, cos yaw)
const FACING_WEST = -Math.PI / 2;

/* Stand the two humans a fixed distance apart on the open street, facing each
   other, aiming at the chest. Aim is deliberately not level: an SMG kicks the
   pitch up per shot, and from eye height a level shot at this range clears the
   head sphere entirely -- correct game behaviour that would otherwise read as
   a broken harness. */
function faceOff(match, opts = {}) {
  const distance = opts.distance === undefined ? 8 : opts.distance;
  const z = opts.z === undefined ? 0 : opts.z;
  const half = distance / 2;
  const pitch = Math.atan2(CHEST - EYE, distance);

  const pose = (x, yaw) =>
    `a.pos.x=${x}; a.pos.y=0; a.pos.z=${z}; a.vel.x=a.vel.y=a.vel.z=0;
     a.yaw=${yaw}; a.pitch=${pitch}; a.aimYaw=${yaw}; a.aimPitch=${pitch};
     a.shield=0; a.health=a.maxHealth; a.alive=true; a.fireCd=0;`;

  match.host.run(`{ const a = G.player; ${pose(half, FACING_WEST)} }`);
  match.host.run(`{ const a = G.actors.find(x => x.controller === 'remote'); ${pose(-half, FACING_EAST)} }`);
  match.guest.run(`{ const a = G.player; ${pose(-half, FACING_EAST)} }`);
  /* Let the placement reach the guest before anyone shoots at a replica that
     is still standing where the host spawned. */
  match.run(opts.settle === undefined ? 0.4 : opts.settle);
  return match;
}

/* Reproduces the pre-prediction behaviour on the same build, so an A/B is a
   change of one behaviour rather than a comparison across two checkouts. */
function disableHitPrediction(instance) {
  instance.run('netPredictHit = function () {};');
}

/* Records when the guest's HUD actually reacts, which is the thing a player
   experiences -- not when the damage was decided. */
function probeFeedback(instance) {
  instance.run(`
    globalThis.__feedback = { markers: [], predicted: [] };
    const __realMarker = showHitmarker;
    showHitmarker = function (head) {
      __feedback.markers.push(performance.now());
      return __realMarker(head);
    };
    const __realPredict = netPredictHit;
    netPredictHit = function () {
      __feedback.predicted.push(performance.now());
      return __realPredict.apply(null, arguments);
    };
  `);
}

/* Point the local player at a target's chest. Each side is given perfect
   tracking rather than a fixed pose, and that is the whole design of the duel.

   Left to recoil, the two sides diverge for a reason that has nothing to do
   with latency: the host's pitch climbs per shot inside its own 60Hz
   simulation, while a guest only reports pitch every 33ms, so the authority
   sees a coarser and slightly staler climb and the guest's shots stay on
   target longer. Measured before this was fixed, that artifact alone handed
   the guest every decided duel at 5ms -- an apparent guest advantage that was
   pure recoil bookkeeping. Perfect tracking removes it from both sides.

   Crucially each side aims at what IT can see: the host at the truth, the
   guest at a replica it is shown late. The view lag stays in the measurement;
   only the recoil artifact leaves. */
const AIM_AT = `(function (target) {
  if (!target) return;
  const a = G.player;
  const dx = target.pos.x - a.pos.x;
  const dz = target.pos.z - a.pos.z;
  const dy = (target.pos.y + ${CHEST}) - (a.pos.y + ${EYE});
  const yaw = Math.atan2(dx, dz);
  const pitch = Math.atan2(dy, Math.hypot(dx, dz));
  a.yaw = yaw; a.pitch = pitch; a.aimYaw = yaw; a.aimPitch = pitch;
})`;

const HOST_AIM = `${AIM_AT}(G.actors.find(a => a.controller === 'remote'))`;
const GUEST_AIM = `${AIM_AT}(G.actors.find(a => a.netId === ${JSON.stringify(HOST_ID)}))`;

/* Both sides open fire at the same instant, at the same range, with the same
   weapon, both tracking perfectly. Every remaining difference is how long each
   side's damage takes to reach the authority: the host's lands in its own
   simulation immediately, the guest's has to cross the wire first. That gap is
   the host advantage, in the only currency that matters -- who is alive at the
   end. */
function duel(opts = {}) {
  const match = createMatch(opts);
  match.run(opts.warmup === undefined ? 1.0 : opts.warmup);
  faceOff(match, opts);

  /* Each side gets a reaction time, and the caller is expected to draw both
     from the SAME distribution. Without that the duel is degenerate: two
     players firing continuously from one instant at equal damage rates means
     whoever starts first always wins, so the rate is 100% or 0% and moves for
     nothing. Equal reaction distributions make any departure from an even
     split attributable to the netcode rather than to the player. */
  const hostReaction = opts.hostReactionMs === undefined ? 0 : opts.hostReactionMs;
  const guestReaction = opts.guestReactionMs === undefined ? 0 : opts.guestReactionMs;

  const started = match.clock.ms;
  const limit = opts.timeoutMs === undefined ? 4000 : opts.timeoutMs;
  let hostFiring = false;
  let guestFiring = false;
  let hostAlive = true;
  let guestAlive = true;

  while (match.clock.ms - started < limit) {
    const elapsed = match.clock.ms - started;
    if (!hostFiring && elapsed >= hostReaction) { match.host.run('pressFire()'); hostFiring = true; }
    if (!guestFiring && elapsed >= guestReaction) { match.guest.run('pressFire()'); guestFiring = true; }
    match.host.run(HOST_AIM);
    match.guest.run(GUEST_AIM);
    match.tick();
    hostAlive = match.host.get('G.player.alive');
    guestAlive = match.host.get("G.actors.find(a => a.controller === 'remote').alive");
    if (!hostAlive || !guestAlive) break;
  }

  return {
    winner: hostAlive && !guestAlive ? 'host'
      : guestAlive && !hostAlive ? 'guest'
        : hostAlive && guestAlive ? 'timeout' : 'trade',
    ttkMs: match.clock.ms - started,
    hostHealth: match.host.get('G.player.health'),
    guestHealth: match.host.get("G.actors.find(a => a.controller === 'remote').health"),
    match
  };
}

/* The guest's handicap in milliseconds: how big a head start it needs before
   it stops losing. Continuous where the win rate saturates, so it stays
   informative at latencies where the guest simply never wins. */
function guestHandicapMs(opts = {}) {
  const step = opts.step === undefined ? 20 : opts.step;
  const max = opts.maxHeadStartMs === undefined ? 600 : opts.maxHeadStartMs;
  for (let headStart = 0; headStart <= max; headStart += step) {
    const outcome = duel(Object.assign({}, opts, {
      hostReactionMs: headStart,
      guestReactionMs: 0
    }));
    if (outcome.winner === 'guest') return headStart;
  }
  return null;
}

function duelWinRate(opts = {}) {
  const trials = opts.trials === undefined ? 30 : opts.trials;
  const meanReaction = opts.reactionMeanMs === undefined ? 250 : opts.reactionMeanMs;
  const spread = opts.reactionSpreadMs === undefined ? 120 : opts.reactionSpreadMs;
  const rng = mulberry32(opts.seed === undefined ? 1 : opts.seed);
  const tally = { host: 0, guest: 0, trade: 0, timeout: 0 };
  const ttk = [];

  for (let i = 0; i < trials; i++) {
    /* Both draws come from one distribution, so the players are equally good
       and only the netcode can bias the result. */
    const outcome = duel(Object.assign({}, opts, {
      distance: 7 + (i % 4),
      seed: (opts.seed === undefined ? 1 : opts.seed) + i,
      hostReactionMs: meanReaction + (rng() - 0.5) * 2 * spread,
      guestReactionMs: meanReaction + (rng() - 0.5) * 2 * spread
    }));
    tally[outcome.winner]++;
    ttk.push(outcome.ttkMs);
  }

  const decided = tally.host + tally.guest;
  return {
    trials, tally,
    hostWinRate: decided ? tally.host / decided : 0,
    guestWinRate: decided ? tally.guest / decided : 0,
    medianTtkMs: ttk.sort((a, b) => a - b)[Math.floor(ttk.length / 2)]
  };
}

/* How far into the past the guest renders the host's body. Sampled against
   the host's own position history rather than assumed from the constants, so
   it measures what the renderer does and not what the code says it does. */
function measureViewLatencyMs(opts = {}) {
  const match = createMatch(opts);
  match.run(1.0);
  /* The host has to be moving or every past position matches equally well. */
  match.host.run('KEY.KeyW = true;');

  const history = [];
  const samples = [];
  const steps = Math.round((opts.seconds === undefined ? 3 : opts.seconds) / FIXED);
  for (let i = 0; i < steps; i++) {
    match.tick();
    history.push({
      ms: match.clock.ms,
      pos: match.host.get('({x: G.player.pos.x, y: G.player.pos.y, z: G.player.pos.z})')
    });
    if (history.length < 30) continue;
    const seen = match.guest.get(
      `(() => { const a = G.actors.find(x => x.netId === ${JSON.stringify(HOST_ID)});
                return a ? {x: a.pos.x, y: a.pos.y, z: a.pos.z} : null; })()`);
    if (!seen) continue;
    let best = null;
    for (const entry of history) {
      const d = Math.hypot(entry.pos.x - seen.x, entry.pos.y - seen.y, entry.pos.z - seen.z);
      if (!best || d < best.d) best = { d: d, ms: entry.ms };
    }
    /* Only count instants where the match is unambiguous. A stationary host
       makes every past position equally good and would report noise. */
    if (best && best.d < 0.05) samples.push(match.clock.ms - best.ms);
  }
  samples.sort((a, b) => a - b);
  return {
    samples: samples.length,
    medianMs: samples.length ? samples[Math.floor(samples.length / 2)] : null,
    match
  };
}

module.exports = {
  FIXED,
  FILES,
  HOST_ID,
  GUEST_ID,
  faceOff,
  duel,
  duelWinRate,
  guestHandicapMs,
  disableHitPrediction,
  probeFeedback,
  measureViewLatencyMs,
  createInstance,
  createLink,
  createMatch,
  makeGlobals,
  mulberry32,
  stubNode,
  NETP
};
