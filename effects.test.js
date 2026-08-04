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
      /* The sizes the footprint test measures with, and the pool table the
         contrast floor measures with — a pool carries the blend mode, and
         the blend mode is the whole of why an effect can be invisible. They
         have to cross the vm boundary or the yardstick computes NaN and the
         rule goes untested while still reporting a failure. */
      FX_POOLS, FX_CONF_SIZE, FX_SPARK_SIZE, FX_SPRITE_MAX_H,
      FX_HIT_RING, FX_RING_GROW, FX_RING_INNER, FX_EFFECT_CLEAR,
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
    'push', 'lift'
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
    /* Every pool, not the two an effect happened to use when this was
       written: an effect that moved to a pool nobody counts would look
       exactly like an effect that drew nothing. */
    particles: client.get('Object.keys(FX_POOLS).reduce((n, k) => n + FX[k].n, 0)'),
    confMax: client.get('Object.keys(FX_POOLS).every(k => FX[k].n <= FX[k].max)')
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
    for (const hex of colours) {
      assert.ok(Number.isInteger(hex) && hex >= 0 && hex <= 0xffffff,
        `${id} colour ${hex} is not a 24-bit 0xRRGGBB literal`);
      /* Particles in this town are light. Anything below this is ink, and
         the darkest ink here is PAL.ink at luma 0.27; the darkest thing
         that is not ink is the tyre grey at 0.52.

         This bound was 0.6, and 0.6 is what put two invisible effects on
         screen. Its stated reason was to keep a wake from passing for the
         town's outlines, and that reason supports a number just above the
         ink, not one above every mid-tone the town owns: a pastel that has
         been taken two steps down the value ramp is still a pastel, and it
         is the only way a single-hue effect gets seen on a cream wall. The
         floor test below is what now decides whether a colour is worth
         drawing; this one only keeps it out of the ink. */
      assert.ok(luma(hex) >= 0.45, `${id} ${hex.toString(16)} is ink, not a wake`);
      /* And nothing arrives from a harsher game: a fully saturated
         primary is the tell every rejected weapon skin had. */
      assert.ok(chroma(hex) <= 0.5, `${id} ${hex.toString(16)} is neon`);
    }
    assert.ok(colours.some((hex) => chroma(hex) >= 0.15),
      `${id} has no committed colour — every value is a white wash`);
  }
});

/* ---------------------------------------------------------------------
   THE FOOTPRINT

   The rule this exists to hold: an effect covers no more of the screen
   than the default hit does. It is a fairness rule, not a taste one. An
   effect that blankets your own view while you fire is a bought
   disadvantage; one that blankets an opponent's view when your shots land
   near them is a bought advantage. The first cut of these effects drew
   four-pointed stars four hundred pixels wide, six at a time, over most of
   the viewport, against a default that is a 150px hit-ring — so this is
   measured in pixels rather than argued about in adjectives.

   The model, which is the arithmetic the comment in src/60-fx.js states:
   a 1600x900 viewport, the camera's 74-degree vertical field, a wall six
   metres off. A point sprite of world size s is s * (H/2) / d pixels wide,
   because that is literally the gl_PointSize the shader computes. Areas
   are whole sprite quads — pessimistic, since the star texture inks about
   23% of its quad — and every term scales as 1/d, so a ratio taken at six
   metres is the ratio at every distance.
   --------------------------------------------------------------------- */

const VIEW_H = 900;                       // CSS px, the reference viewport
const VIEW_FOV = 74;                      // src/10-core.js
const REF_DIST = 6;                       // m — a wall across the road
/* Pixels per metre of world, across the frame, at REF_DIST. */
const PX_PER_M = (VIEW_H / 2) / (REF_DIST * Math.tan(VIEW_FOV * Math.PI / 360));
/* And the width in pixels of a point sprite of world size s, which is a
   different constant because gl_PointSize has the field of view baked out
   of it: gl_PointSize = size * scale / -mvPosition.z. */
const spritePx = (size) => size * (VIEW_H / 2) / REF_DIST;
const quad = (size) => spritePx(size) ** 2;
/* A ring is an annulus, not a disc: only the band between the two radii
   is ink, which is most of why the default can be that wide and still not
   obscure anything. */
const annulus = (outerM, innerRatio) =>
  Math.PI * (outerM * PX_PER_M) ** 2 * (1 - innerRatio * innerRatio);
const disc = (radiusM) => Math.PI * (radiusM * PX_PER_M) ** 2;

test('no effect covers more of the screen than the default hit does', () => {
  const {
    SHOT_EFFECTS, FX_POOLS, FX_SPRITE_MAX_H,
    FX_HIT_RING, FX_RING_GROW, FX_RING_INNER, FX_EFFECT_CLEAR
  } = loadEffects();

  /* THE YARDSTICK: what a BUBBLEGUN pellet already draws on a wall with no
     effect worn at all — fxBubbleImpact's ring at its widest, plus nine
     droplets. This is the "crisp white hit-ring" the screenshots compare
     against, and it comes to ~7900 px^2. */
  const defaultRing = annulus(FX_HIT_RING * (1 + FX_RING_GROW), FX_RING_INNER);
  const defaultHit = defaultRing + 9 * disc(0.047);
  assert.ok(defaultHit > 5000 && defaultHit < 12000,
    `the yardstick itself moved: the default hit is now ${Math.round(defaultHit)} px^2`);

  /* Off the pool table rather than off a list of pool names kept here: an
     effect that moved to a pool this line had not heard of used to be
     measured at the default pool's size, which is a fairness rule quietly
     measuring the wrong sprite. */
  const sizeOf = (sys) => {
    assert.ok(FX_POOLS[sys], `an effect draws into a pool named ${sys}, which does not exist`);
    return FX_POOLS[sys].size;
  };

  for (const [id, effect] of Object.entries(SHOT_EFFECTS)) {
    /* Worst case: every particle of all three stages alive on the same
       frame. They are not, in practice — the muzzle puff is half dead
       before the burst exists — which is slack in the right direction. */
    const wake = effect.wake.count * quad(sizeOf(effect.wake.sys));
    const muzzle = effect.muzzle.count * quad(sizeOf(effect.wake.sys));
    const burst = effect.burst.count * quad(sizeOf(effect.burst.sys));
    const bloom = (effect.burst.bloom || 0) * disc(0.044);
    const total = wake + muzzle + burst + bloom;

    assert.ok(total <= defaultHit,
      `${id} covers ${Math.round(total)} px^2 against the default's ` +
      `${Math.round(defaultHit)} — it is bought screen space`);

    /* And no single sprite may be a hit-ring on its own, however the
       counts are shuffled. Every pool, including the ones added since. */
    const widest = Math.max(...Object.values(FX_POOLS).map((p) => spritePx(p.size)));
    assert.ok(widest * 4 <= 2 * FX_HIT_RING * (1 + FX_RING_GROW) * PX_PER_M,
      `${id} sprites are ${widest.toFixed(1)}px wide against a ${Math.round(
        2 * FX_HIT_RING * (1 + FX_RING_GROW) * PX_PER_M)}px default ring`);
  }

  /* THE NEAR FIELD, which is where the first cut actually failed: at six
     metres these sprites were always small, and at six centimetres from
     the lens the same 0.16m sprite is 1200px. Two things bound it, and
     both have to hold. */
  assert.ok(FX_SPRITE_MAX_H > 0 && FX_SPRITE_MAX_H <= 1 / 8,
    `a sprite may cover ${FX_SPRITE_MAX_H} of the viewport height`);
  const cappedPx = VIEW_H * FX_SPRITE_MAX_H;
  assert.ok(cappedPx * cappedPx * 20 <= defaultHit * 30,
    'the clamp is too loose to matter');
  /* The clamp has to actually bind at the closest an effect may draw,
     otherwise it is decoration: an uncapped sprite at FX_EFFECT_CLEAR must
     be wider than the ceiling. */
  for (const { size } of Object.values(FX_POOLS)) {
    const uncapped = size * (VIEW_H / 2) / FX_EFFECT_CLEAR;
    assert.ok(uncapped > cappedPx,
      `a ${size}m sprite is ${uncapped.toFixed(0)}px at the clear radius and ` +
      `the clamp lets ${cappedPx.toFixed(0)}px through, so it never binds`);
  }
});

/* ---------------------------------------------------------------------
   THE FLOOR

   The ceiling above says an effect may cover no more of the screen than
   the default hit does. It is a ceiling, and the round that introduced it
   discovered what a ceiling with nothing under it buys: two effects that
   passed every test by drawing nothing anybody could see. Bubble Trail
   read as a faint white smudge and Starfall as a single pale star, and a
   cosmetic nobody can see is not a cosmetic. So the same yardstick binds
   from below.

   WHY CONTRAST AND NOT CHROMA. The old palette check asked each colour for
   chroma above 0.15 and Bubble Trail's mint passed it at 0.23 while being
   invisible, because chroma is a property of a colour on its own and
   visibility is a property of a colour ON SOMETHING. This town is painted
   in pastels — the perimeter wall is 0xdcd3e8, the houses are cream and
   butter and sky — and a pale particle on a pale wall is nothing however
   saturated the swatch looks in isolation.

   Additive blending makes it worse, and that is the specific mechanism
   that sank Bubble Trail. Additive adds the particle's light to the wall's;
   the wall is already near the top of the range; every channel clips to
   white. So an additive near-white particle leaves the SAME PIXEL the
   default's own white hit-ring leaves, and it leaves it whatever colour
   the particle claimed to be. The measurement below reproduces that
   exactly, and scores the shipped palette at 0.000.

   THE MODEL, and it is the ceiling's model run through the pipeline rather
   than a new one:

     the wall     PAL.perimeter 0xdcd3e8, the pale lilac the screenshots
                  were taken against, in linear light
     the particle the effect's colour mixed FX_TRIM_MIX of the way to the
                  shooter's — every particle is tinted, so the untinted hex
                  is not what anybody sees — then composited over the wall
                  with its pool's blend mode
     the default  the hit-ring: white, additive, gain 1.20 and opacity 0.48
                  (fxImpactMaterial in src/60-fx.js), over the same wall
     the distance CIE-style perceptual difference in OKLab, which is the
                  cheapest space that treats a change of hue and a change
                  of lightness on the same scale

   An effect colour "reads" by the smaller of two distances: how far the
   pixel it draws is from the bare wall (is it there at all?) and how far
   it is from the pixel the default already draws (is it anything the
   player did not already have?). Both have to hold, and the smaller one is
   the honest score.

   THE FLOOR: a third of the default hit-ring's own contrast against the
   same wall. The ring scores 0.123, so the floor is 0.041. A third rather
   than all of it because the ring is a metre wide and an effect particle
   is twelve pixels — asking a sparkle to hit a wall as hard as the ring
   does would be asking for the bought advantage the ceiling forbids. Two
   of an effect's colours have to clear it, so no effect passes on one
   lucky hue in a palette of washes.
   --------------------------------------------------------------------- */

/* PAL.perimeter, src/10-core.js — and the surface in fx-*-*.png. */
const WALL = 0xdcd3e8;
/* fxImpactMaterial(1.20, 0.48) on FX.ringMesh, in FX_WHITE. */
const RING_GAIN = 1.20;
const RING_OPACITY = 0.48;
/* Everyone a particle can be tinted toward: the nine jerseys' trim
   (src/50-actors.js) and the three tracer colours the local player's own
   gun fires in (src/40-weapons.js), which is the case the screenshots are.
   The score is the worst of them, because an effect that only reads for
   some shooters is an effect that does not read. */
const OWNERS = JERSEYS.concat([0xffb7c5, 0xffc79a, 0xbcd8ff]);

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linear = (hex) => [
  toLinear(((hex >> 16) & 255) / 255),
  toLinear(((hex >> 8) & 255) / 255),
  toLinear((hex & 255) / 255)
];
/* Björn Ottosson's OKLab, from linear sRGB. */
function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  ];
}
const deltaE = (a, b) => {
  const x = oklab(a), y = oklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

const wallLinear = linear(WALL);
/* What the default hit-ring leaves on that wall. Additive and white, so it
   clips: this is very nearly paper. */
const defaultPixel = wallLinear.map((v) => Math.min(1, v + RING_GAIN * RING_OPACITY));
const DEFAULT_CONTRAST = deltaE(defaultPixel, wallLinear);

/* One effect colour, worn by one shooter, drawn by one pool, on the wall. */
function drawnPixel(hex, owner, additive, mix) {
  const c = linear(hex), o = linear(owner);
  const tinted = c.map((v, i) => v + (o[i] - v) * mix);
  return additive ? tinted.map((v, i) => Math.min(1, wallLinear[i] + v)) : tinted;
}
function readsAs(hex, additive, mix) {
  let worst = Infinity;
  for (const owner of OWNERS) {
    const px = drawnPixel(hex, owner, additive, mix);
    worst = Math.min(worst, deltaE(px, wallLinear), deltaE(px, defaultPixel));
  }
  return worst;
}

test('every effect is visible on a pastel wall — the floor under the footprint', () => {
  const { SHOT_EFFECTS, FX_POOLS, FX_TRIM_MIX } = loadEffects();

  /* The yardstick, checked the way the ceiling checks its own. */
  assert.ok(DEFAULT_CONTRAST > 0.10 && DEFAULT_CONTRAST < 0.15,
    `the yardstick moved: the default ring now reads ${DEFAULT_CONTRAST.toFixed(3)}`);
  const FLOOR = DEFAULT_CONTRAST / 3;
  const CARRIERS = 2;

  for (const [id, effect] of Object.entries(SHOT_EFFECTS)) {
    /* An effect's three stages may sit in two pools, and a pool carries the
       blend. Score each colour in the harshest pool the effect uses — the
       one whose particles are hardest to see. */
    const pools = [effect.wake.sys, effect.burst.sys]
      .map((sys) => FX_POOLS[sys]);
    const additive = pools.some((p) => p.additive);

    const scores = effect.colors
      .map((hex) => [hex, readsAs(hex, additive, FX_TRIM_MIX)])
      .sort((a, b) => b[1] - a[1]);
    const carrying = scores.filter(([, s]) => s >= FLOOR);

    assert.ok(carrying.length >= CARRIERS,
      `${id} has ${carrying.length} colour(s) that change the pixel they cover ` +
      `by the floor of ${FLOOR.toFixed(3)}; it needs ${CARRIERS}. Its palette scores ` +
      scores.map(([hex, s]) => `${hex.toString(16)}=${s.toFixed(3)}`).join(' ') +
      ' — a bought effect nobody can see is not a bought effect');
  }

  /* AND THE TEST HAS TEETH. The exact palette that shipped invisible: three
     near-whites on the additive pool. Every one of them scores zero — not
     "low", zero — because the pixel it leaves on this wall is bit-for-bit
     the pixel the default's white ring leaves. If this ever passes, the
     measurement above has stopped measuring blending. */
  for (const hex of [0xb8f2d8, 0xa8dcf0, 0xd8f6ff]) {
    assert.ok(readsAs(hex, true, FX_TRIM_MIX) < 0.001,
      `${hex.toString(16)} additive on a pastel wall now reads as something, ` +
      'which means the composite is no longer being modelled');
    /* Off the additive pool the same colours are merely weak rather than
       absent — which is the point: the blend was the mechanism, and it is
       not enough on its own to fix them either. */
    assert.ok(readsAs(hex, false, FX_TRIM_MIX) < FLOOR,
      `${hex.toString(16)} normal-blended clears the floor, so the palette ` +
      'that shipped invisible would ship again');
  }

  /* And no pool an effect draws into may be additive at all, which is the
     rule the scores above are the evidence for. The additive pool keeps its
     job — glints and kill bursts, seen against the sky and against each
     other — but nothing sold draws flat onto a wall through it. */
  for (const [id, effect] of Object.entries(SHOT_EFFECTS))
    for (const sys of [effect.wake.sys, effect.burst.sys])
      assert.equal(FX_POOLS[sys].additive, false,
        `${id} draws into the additive pool ${sys}, where a pastel wall eats it`);
});

test('the three effects are three products, not one sold three times', () => {
  const { SHOT_EFFECTS, FX_POOLS, FX_TRIM_MIX } = loadEffects();

  /* SILHOUETTE. A pool is a texture and a gravity, so three pools is three
     shapes going three ways: the fat four-point candy sparkle that falls,
     the six-ray needle star that falls harder, and the round bubble that
     rises. Sharing one would make two of these the same effect in two
     colours, which is the same product sold twice. */
  const wakePools = EFFECT_IDS.map((id) => SHOT_EFFECTS[id].wake.sys);
  assert.equal(new Set(wakePools).size, EFFECT_IDS.length,
    `two effects lay the same wake sprite: ${wakePools.join(', ')}`);

  /* DIRECTION. Exactly one of them goes up, and it is the one whose name
     says so — the read that survives being seen across the map. */
  const rising = EFFECT_IDS.filter((id) => FX_POOLS[SHOT_EFFECTS[id].wake.sys].grav < 0);
  assert.deepEqual(rising, ['fx-bubbletrail'],
    'exactly one effect is supposed to be buoyant, and it is Bubble Trail');

  /* HUE. Each effect's strongest colour, on the wall, has to be a different
     colour from the other two's — measured after the tint, because two
     effects that converge once a jersey is mixed in have converged. */
  const carrier = (id) => {
    const effect = SHOT_EFFECTS[id];
    const additive = FX_POOLS[effect.wake.sys].additive;
    return effect.colors
      .slice()
      .sort((a, b) => readsAs(b, additive, FX_TRIM_MIX) - readsAs(a, additive, FX_TRIM_MIX))[0];
  };
  const carriers = EFFECT_IDS.map(carrier);
  for (let i = 0; i < carriers.length; i++)
    for (let j = i + 1; j < carriers.length; j++)
      for (const owner of OWNERS) {
        const a = drawnPixel(carriers[i], owner, false, FX_TRIM_MIX);
        const b = drawnPixel(carriers[j], owner, false, FX_TRIM_MIX);
        assert.ok(deltaE(a, b) > 0.05,
          `${EFFECT_IDS[i]} and ${EFFECT_IDS[j]} are the same colour on a ` +
          `${owner.toString(16)} shooter`);
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
