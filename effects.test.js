'use strict';

/* =====================================================================
   SHOT EFFECTS — the three things a paid effect must never buy you

   1. a gameplay value. Damage, spread, rate of fire, range and hit
      registration are the weapon record's and nothing else's; hit
      detection in 30-physics.js is analytic and reads no mesh, no
      particle and no light. The same shot fired wearing each of the
      three effects has to land in the same place for the same damage,
      and leave the weapon table byte-for-byte where it was.
   2. the "who is shooting" signal. A remote player's shot is drawn in
      their jersey trim, and in a nine-player match that colour is the
      only thing telling two attackers apart. An effect may restyle the
      wake; it may not swallow the trim.
   3. an advantage through noise. Nothing an effect draws may be bigger,
      brighter, longer-lived or further-reaching than the default —
      pay-to-win through visual clutter is still pay-to-win.
   ===================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SIM = require('./net-sim.js');

const EFFECT_IDS = ['fx-starfall', 'fx-confettipop', 'fx-bubbletrail'];

/* ---------------------------------------------------------------------
   src/60-fx.js, top level only

   The effect table, the tint rule and the store's preview builder are
   pure: they need a Color, a random source and enough of THREE to hold a
   node. Loading the file this way — rather than through the headless
   client — is what lets the numbers below be checked as numbers.
   --------------------------------------------------------------------- */
function loadEffects() {
  const source = fs.readFileSync(path.join(__dirname, 'src/60-fx.js'), 'utf8');

  /* Linear-light, the way src/10-core.js's C() hands colours to three.js,
     because that is the space the tint is mixed in. */
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  class FakeColor {
    constructor(hex) { this.setHex(hex === undefined ? 0xffffff : hex); }
    setHex(hex) {
      this.hex = hex >>> 0;
      this.r = ((hex >> 16) & 255) / 255;
      this.g = ((hex >> 8) & 255) / 255;
      this.b = (hex & 255) / 255;
      return this;
    }
    convertSRGBToLinear() {
      this.r = toLinear(this.r); this.g = toLinear(this.g); this.b = toLinear(this.b);
      return this;
    }
    getHex() { return this.hex; }
    copy(o) { this.r = o.r; this.g = o.g; this.b = o.b; return this; }
  }
  class FakeVec3 {
    constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(v) { return this.set(v, v, v); }
  }
  class FakeNode {
    constructor() {
      this.children = []; this.visible = true; this.userData = {};
      this.position = new FakeVec3();
      this.rotation = new FakeVec3();
      this.scale = new FakeVec3(1, 1, 1);
    }
    add(...kids) { this.children.push(...kids); return this; }
  }

  const sandbox = {
    THREE: {
      Color: FakeColor,
      Vector3: FakeVec3,
      Group: FakeNode,
      Mesh: class extends FakeNode {
        constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
      },
      SphereGeometry: class { constructor(r) { this.radius = r; } },
      MeshBasicMaterial: class { constructor(opts) { Object.assign(this, opts || {}); } },
      Matrix4: class { compose() { return this; } makeScale() { return this; } identity() { return this; } },
      Quaternion: class {
        identity() { return this; }
        copy() { return this; }
        multiply() { return this; }
        setFromAxisAngle() { return this; }
        setFromUnitVectors() { return this; }
        setFromEuler() { return this; }
      },
      Euler: class { set() { return this; } }
    },
    C: (hex) => new FakeColor(hex).convertSRGBToLinear(),
    Cx: (hex) => new FakeColor(hex).convertSRGBToLinear(),
    TAU: Math.PI * 2,
    lerp: (a, b, t) => a + (b - a) * t,
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
    smoothstep: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)),
    mulberry32: (seed) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    SOFTWARE_GPU: false,
    document: { getElementById: () => null, createElement: () => null },
    window: {},
    Math: Math
  };

  vm.runInNewContext(`${source}
    this.api = {
      SHOT_EFFECTS, fxEffectFor, fxEffectTint, fxEffectCount,
      FX_TRIM_MIX, FX_PREVIEW, buildEffectPreview,
      setSoftware(on) { SOFTWARE_GPU = on; }
    };`, sandbox);
  return sandbox.api;
}

const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const luma = (hex) => { const [r, g, b] = rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
const chroma = (hex) => { const p = rgb(hex); return (Math.max(...p) - Math.min(...p)) / 255; };

/* ---------------------------------------------------------------------
   The catalog contract
   --------------------------------------------------------------------- */

test('the shipped effects are exactly the effects the catalog sells', async () => {
  const { COSMETICS } = await import('./cosmetics.mjs');
  const { SHOT_EFFECTS } = loadEffects();

  const sold = COSMETICS.filter((item) => item.type === 'effect');
  assert.deepEqual(sold.map((item) => item.id).sort(), EFFECT_IDS.slice().sort());
  assert.deepEqual(Object.keys(SHOT_EFFECTS).sort(), EFFECT_IDS.slice().sort(),
    'the renderer and the shop disagree about what an effect is');

  for (const item of sold) {
    /* Slotless, like a character: one effect themes every gun, which is
       what makes it one purchase. A slot here would let the relay accept
       an effect into a weapon slot. */
    assert.equal(item.slot, null, `${item.id} claims a slot`);
    assert.equal(item.displayName, SHOT_EFFECTS[item.id].name,
      `${item.id} is called something different in the shop`);
    assert.match(item.priceEnvVar, /^STRIPE_PRICE_FX_[A-Z]+$/, `${item.id} price variable`);
  }
});

/* ---------------------------------------------------------------------
   1. No gameplay value
   --------------------------------------------------------------------- */

test('no effect record carries anything a weapon record would be read for', () => {
  const { SHOT_EFFECTS } = loadEffects();
  const weaponSource = fs.readFileSync(path.join(__dirname, 'src/40-weapons.js'), 'utf8');
  const marker = '\n/* =====================================================================\n   VIEWMODEL SCENE';
  const box = {};
  vm.runInNewContext(
    `${weaponSource.slice(0, weaponSource.indexOf(marker))}\nthis.api = { WBY };`,
    Object.assign(box, { C: () => ({}), Cx: () => ({}) }));
  const statKeys = Object.keys(box.api.WBY.smg).filter((key) => key !== 'name');

  /* Every key an effect may carry, anywhere in it. Anything outside this
     list is a field somebody added without deciding whether it is paint,
     and the whole point of the list is that the decision cannot be
     skipped. */
  const ALLOWED = new Set([
    'name', 'muzzleTint', 'colors', 'wake', 'muzzle', 'burst',
    'sys', 'count', 'jitter', 'sway', 'rise', 'life', 'out',
    'push', 'lift', 'ring', 'ringScale', 'bloom'
  ]);

  const walk = (value, id, trail) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      assert.ok(ALLOWED.has(key), `${id} carries an unvetted field ${trail}${key}`);
      assert.ok(!statKeys.includes(key),
        `${id} carries ${trail}${key}, which is a weapon stat`);
      /* A muzzle tint is a Color and a Color is a leaf; walking into it
         would be checking three.js's field names, not ours. */
      if (key === 'muzzleTint') {
        assert.equal(typeof value[key].getHex, 'function', `${id} muzzleTint is not a colour`);
        continue;
      }
      walk(value[key], id, `${trail}${key}.`);
    }
  };
  for (const [id, effect] of Object.entries(SHOT_EFFECTS)) walk(effect, id, '');
});

/* The real thing, through the real client: the same shot at the same
   target, once per effect and once bare, has to land identically. */
function firedShot(effectId) {
  const client = SIM.createInstance({ ms: 0 });
  client.run(`
    globalThis.EQUIPPED = {
      character: null,
      effect: ${JSON.stringify(effectId)},
      weapons: { smg: null, shotgun: null, rifle: null }
    };
    initViewmodel(); initFX(); initInput(); initAI();
    CFG.combatants = 2;
    NET.mode = 'solo';
    netBeginMatch();
    globalThis.TARGET = G.actors.find(a => a !== G.player);
    G.player.pos.x = -6; G.player.pos.y = 0; G.player.pos.z = 0;
    /* Down the middle of the road, which is the one line across this map
       with nothing standing in it. */
    G.player.aimYaw = Math.PI / 2; G.player.aimPitch = 0;
    G.player.weapon = 'rifle';
    G.player.ammo = 10; G.player.fireCd = 0; G.player.reloadT = 0;
    TARGET.pos.x = 6; TARGET.pos.y = 0; TARGET.pos.z = 0;
    TARGET.alive = true; TARGET.health = TARGET.maxHealth;
    /* The respawn bubble absorbs the first hit, and this test is about the
       second thing that happens to a shot, not the first. */
    TARGET.shield = 0; G.player.shield = 0;
    fireWeapon(G.player, 0, 0);
    /* Long enough for every queued impact to have fired. */
    for (let i = 0; i < 60; i++) updateFX(1 / 60);
  `);
  return {
    damage: client.get('TARGET.maxHealth - TARGET.health'),
    alive: client.get('TARGET.alive'),
    ammo: client.get('G.player.ammo'),
    fireCd: client.get('G.player.fireCd'),
    weapons: client.get('JSON.stringify(WEAPONS)'),
    effect: client.get('FX.activeEffect && FX.activeEffect.name'),
    particles: client.get('FX.conf.n + FX.spark.n'),
    confMax: client.get('FX.conf.n <= FX.conf.max && FX.spark.n <= FX.spark.max')
  };
}

test('an effect cannot change what a shot does, only what it looks like', () => {
  const plain = firedShot(null);
  assert.ok(plain.damage > 0, 'the control shot missed, so it proves nothing');
  assert.equal(plain.effect, null);

  for (const id of EFFECT_IDS) {
    const shot = firedShot(id);
    assert.equal(shot.damage, plain.damage, `${id} changed the damage`);
    assert.equal(shot.alive, plain.alive, `${id} changed whether the target lived`);
    assert.equal(shot.ammo, plain.ammo, `${id} changed the ammunition spent`);
    assert.equal(shot.fireCd, plain.fireCd, `${id} changed the rate of fire`);
    assert.equal(shot.weapons, plain.weapons, `${id} rewrote the weapon table`);
    /* And it really was worn — otherwise the four assertions above are
       four ways of saying nothing happened. */
    assert.ok(shot.effect, `${id} never reached the renderer`);
    assert.ok(shot.particles > plain.particles, `${id} drew no wake at all`);
    assert.ok(shot.confMax, `${id} overran a particle pool`);
  }
});

test('an unowned, unknown or damaged effect id is simply the default look', () => {
  const { fxEffectFor } = loadEffects();
  for (const bad of [null, undefined, '', 7, {}, [], 'fx-does-not-exist',
                     'char-midnight', 'toString', '__proto__', 'constructor'])
    assert.equal(fxEffectFor(bad), null, JSON.stringify(bad));
  for (const id of EFFECT_IDS) assert.ok(fxEffectFor(id), id);
});

/* ---------------------------------------------------------------------
   2. The jersey stays readable
   --------------------------------------------------------------------- */

/* Two jerseys far apart in the nine, and the cream the player's own gun
   fires in. src/50-actors.js's table is where these come from. */
const JERSEYS = [0xffc9d6, 0x9fd8ff, 0xb8f2d8, 0xffe9a8];

test('an effect tints toward the shooter rather than painting over them', () => {
  const { SHOT_EFFECTS, fxEffectTint, FX_TRIM_MIX } = loadEffects();
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const owner = (hex) => ({
    r: toLinear(((hex >> 16) & 255) / 255),
    g: toLinear(((hex >> 8) & 255) / 255),
    b: toLinear((hex & 255) / 255)
  });
  const out = { r: 0, g: 0, b: 0, setHex() { return this; }, convertSRGBToLinear() { return this; } };
  /* fxEffectTint writes through setHex/convertSRGBToLinear, so give it a
     real target rather than a spy. */
  const tint = (hex, jersey) => {
    const target = {
      r: 0, g: 0, b: 0,
      setHex(h) {
        this.r = ((h >> 16) & 255) / 255;
        this.g = ((h >> 8) & 255) / 255;
        this.b = (h & 255) / 255;
        return this;
      },
      convertSRGBToLinear() {
        this.r = toLinear(this.r); this.g = toLinear(this.g); this.b = toLinear(this.b);
        return this;
      }
    };
    fxEffectTint(target, hex, owner(jersey));
    return target;
  };
  const apart = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  void out;

  assert.ok(FX_TRIM_MIX > 0 && FX_TRIM_MIX < 1,
    'a mix of 0 loses the effect and a mix of 1 loses the shooter');

  for (const [id, effect] of Object.entries(SHOT_EFFECTS)) {
    for (const hex of effect.colors) {
      /* THE SHOOTER SURVIVES. Two jerseys wearing the same effect still
         land on visibly different colours. */
      for (let i = 0; i < JERSEYS.length; i++) {
        for (let j = i + 1; j < JERSEYS.length; j++) {
          const gap = apart(tint(hex, JERSEYS[i]), tint(hex, JERSEYS[j]));
          assert.ok(gap > 0.04,
            `${id} washes ${JERSEYS[i].toString(16)} and ${JERSEYS[j].toString(16)} together`);
        }
      }
    }
  }

  /* AND THE EFFECT SURVIVES. One jersey, three effects: the wake still
     says which of the three it is. */
  for (const jersey of JERSEYS) {
    const seen = EFFECT_IDS.map((id) => tint(SHOT_EFFECTS[id].colors[0], jersey));
    for (let i = 0; i < seen.length; i++)
      for (let j = i + 1; j < seen.length; j++)
        assert.ok(apart(seen[i], seen[j]) > 0.04,
          `${EFFECT_IDS[i]} and ${EFFECT_IDS[j]} are the same wake on ${jersey.toString(16)}`);
  }
});

/* ---------------------------------------------------------------------
   3. No advantage through noise, and the house palette
   --------------------------------------------------------------------- */

test('every effect stays in the house palette — no near-black, no imported neon', () => {
  const { SHOT_EFFECTS } = loadEffects();
  for (const [id, effect] of Object.entries(SHOT_EFFECTS)) {
    const colours = effect.colors.slice();
    if (effect.burst.ring) colours.push(effect.burst.ring);
    for (const hex of colours) {
      assert.ok(Number.isInteger(hex) && hex >= 0 && hex <= 0xffffff,
        `${id} colour ${hex} is not a 24-bit 0xRRGGBB literal`);
      /* Particles in this town are light. Anything below this is ink, and
         the darkest ink here is 0x4a3f5c. */
      assert.ok(luma(hex) >= 0.6, `${id} ${hex.toString(16)} is too dark for a pastel wake`);
      /* And nothing arrives from a harsher game: a fully saturated
         primary is the tell every rejected weapon skin had. */
      assert.ok(chroma(hex) <= 0.5, `${id} ${hex.toString(16)} is neon`);
    }
    assert.ok(colours.some((hex) => chroma(hex) >= 0.15),
      `${id} has no committed colour — every value is a white wash`);
  }
});

test('an effect is bounded per shot however far the shot goes', () => {
  const { SHOT_EFFECTS, fxEffectCount } = loadEffects();
  for (const [id, effect] of Object.entries(SHOT_EFFECTS)) {
    for (const [where, block] of Object.entries({
      wake: effect.wake, muzzle: effect.muzzle, burst: effect.burst
    })) {
      assert.ok(Number.isInteger(block.count) && block.count > 0 && block.count <= 12,
        `${id} ${where} emits ${block.count} particles a shot`);
      /* Nothing may outlive the shot that made it by long enough to hang
         in the air and mark a position. */
      assert.ok(block.life[0] > 0 && block.life[1] <= 0.7,
        `${id} ${where} particles linger for ${block.life[1]}s`);
      assert.ok(block.life[0] <= block.life[1], `${id} ${where} life range is backwards`);
    }
    /* The wake is the part drawn on every single trigger pull, so it is
       the one with the tight budget. */
    assert.ok(effect.wake.count <= 5, `${id} lays ${effect.wake.count} particles per shot`);
    assert.ok(effect.wake.jitter <= 0.12,
      `${id} throws its wake ${effect.wake.jitter}m off the line the shot took`);
  }

  /* A phone gets half of everything, and never zero of anything. */
  for (const n of [1, 2, 4, 5, 6, 10, 12]) assert.equal(fxEffectCount(n), n);
  const { fxEffectCount: cheap } = (() => {
    const api = loadEffects();
    api.setSoftware(true);
    return api;
  })();
  for (const n of [1, 2, 4, 5, 6, 10, 12]) {
    assert.ok(cheap(n) <= Math.max(1, n >> 1), `${n} did not halve`);
    assert.ok(cheap(n) >= 1, `${n} halved to nothing`);
  }
});

/* ---------------------------------------------------------------------
   The display case

   An effect is motion, so it has no model to hand the shop. What it
   hands over instead still has to behave like one: framed by the same
   arithmetic, thrown away by the same failure path.
   --------------------------------------------------------------------- */

test('every effect previews as a loop, and an unknown id previews as nothing', () => {
  const { buildEffectPreview, FX_PREVIEW } = loadEffects();

  assert.equal(buildEffectPreview('fx-not-a-thing'), null);
  assert.equal(buildEffectPreview('char-midnight'), null);

  /* null is the default look — a bare shot — and the case needs it to
     have something to compare against. */
  for (const id of [null, ...EFFECT_IDS]) {
    const node = buildEffectPreview(id);
    assert.ok(node, `${id} built nothing`);
    assert.equal(typeof node.userData.pnTick, 'function', `${id} does not animate`);
    assert.ok(node.children.length > 1, `${id} is an empty case`);

    /* Run it well past a full loop. Nothing may drift out of the case,
       and nothing may throw on the frame after the loop wraps. */
    for (let i = 0; i < 400; i++) node.userData.pnTick(1 / 60);
    for (const mote of node.children) {
      assert.ok(Math.abs(mote.position.x) <= FX_PREVIEW.span,
        `${id} left the case sideways`);
      assert.ok(Math.abs(mote.position.y) <= 2 && Math.abs(mote.position.z) <= 1,
        `${id} left the case`);
      assert.ok(Number.isFinite(mote.position.x + mote.position.y + mote.position.z),
        `${id} produced a position that is not a number`);
    }
  }

  /* Two of the three fall and one rises, which is the read that survives
     distance. Sample the same mote in each and compare where it went. */
  const drop = (id) => {
    const node = buildEffectPreview(id);
    /* The youngest mote still on screen: the last one the shot laid down,
       which is the one with the most of its life left to move in. The very
       last child is the shot itself, not a mote. */
    const laid = node.children.slice(0, -1).filter((m) => m.visible);
    const mote = laid[laid.length - 1];
    assert.ok(mote, `${id} shows nothing on the frame the card is drawn from`);
    const before = mote.position.y;
    for (let i = 0; i < 12; i++) node.userData.pnTick(1 / 60);
    assert.ok(mote.visible, `${id} lost the mote before it had moved`);
    return mote.position.y - before;
  };
  assert.ok(drop('fx-bubbletrail') > drop('fx-starfall'),
    'Bubble Trail is supposed to be the one that goes up');
  assert.ok(drop('fx-bubbletrail') > drop('fx-confettipop'),
    'Bubble Trail is supposed to be the one that goes up');
});

/* ---------------------------------------------------------------------
   Nobody has to sign in
   --------------------------------------------------------------------- */

test('a client with no selection at all still shoots, with the default effect', () => {
  const client = SIM.createInstance({ ms: 0 });
  client.run(`
    initViewmodel(); initFX(); initInput(); initAI();
    CFG.combatants = 2;
    NET.mode = 'solo';
    netBeginMatch();
    G.player.fireCd = 0; G.player.reloadT = 0;
    fireWeapon(G.player, 0, 0);
    for (let i = 0; i < 60; i++) updateFX(1 / 60);
  `);
  assert.equal(client.get('typeof EQUIPPED'), 'undefined');
  assert.equal(client.get('G.started'), true);
  assert.equal(client.get('FX.activeEffect'), null);
});
