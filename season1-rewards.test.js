'use strict';

/* Season 1 battle-pass rewards must be real, renderable cosmetics: every
   id resolves in the catalog and matching renderer, while the client's
   reward and XP mirrors match the server ladder exactly. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const DEAD_KINDS = ['spray', 'charm', 'banner', 'sticker'];

function kindFromId(id) {
  const m = String(id).match(/-(smg|shotgun|rifle|char|fx)-/);
  return m ? m[1] : null;
}

function loadWeaponSkins() {
  const source = fs.readFileSync(path.join(__dirname, 'src/40-weapons.js'), 'utf8');
  const marker = '\n/* =====================================================================\n   VIEWMODEL SCENE';
  const pureSource = source.slice(0, source.indexOf(marker));
  const sandbox = {};
  vm.runInNewContext(`${pureSource}\nthis.api = { WEAPON_SKINS };`, sandbox);
  return sandbox.api.WEAPON_SKINS;
}

function loadCharacterSkins() {
  const source = fs.readFileSync(path.join(__dirname, 'src/50-actors.js'), 'utf8');
  function GeoBuilder() { this.boxes = []; }
  GeoBuilder.prototype.box = function () { this.boxes.push(1); };
  GeoBuilder.prototype.mesh = function () {
    return { isMesh: true, children: [], position: { set() {} }, add() {}, traverse() {} };
  };
  GeoBuilder.prototype.lines = function () { return null; };
  function stubNode() {
    return {
      children: [],
      position: { x: 0, y: 0, z: 0, set() {} },
      rotation: { x: 0, y: 0, z: 0 },
      add(...kids) { this.children.push(...kids); },
      traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
    };
  }
  const sandbox = {
    THREE: { Group: function () { return stubNode(); }, Object3D: function () { return stubNode(); } },
    GeoBuilder,
    C: () => ({}),
    Cx: () => ({}),
    Math
  };
  vm.runInNewContext(
    `${source}\nthis.api = { CHARACTER_SKINS, SKIN_PARTS, characterSkin };`,
    sandbox);
  return sandbox.api;
}

function loadShotEffects() {
  const source = fs.readFileSync(path.join(__dirname, 'src/60-fx.js'), 'utf8');
  class FakeColor {
    constructor(hex) { this.hex = hex >>> 0; }
    setHex(hex) { this.hex = hex >>> 0; return this; }
    convertSRGBToLinear() { return this; }
    getHex() { return this.hex; }
    copy() { return this; }
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
    C: (hex) => new FakeColor(hex),
    Cx: (hex) => new FakeColor(hex),
    TAU: Math.PI * 2,
    lerp: (a, b, t) => a + (b - a) * t,
    clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),
    smoothstep: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)),
    mulberry32: () => () => 0.5,
    SOFTWARE_GPU: false,
    document: { getElementById: () => null, createElement: () => null },
    window: {},
    Math
  };
  vm.runInNewContext(
    `${source}\nthis.api = { SHOT_EFFECTS, fxEffectFor };`,
    sandbox);
  return sandbox.api;
}

function loadClientBpMirror() {
  const source = fs.readFileSync(path.join(__dirname, 'src/82-store.js'), 'utf8');
  /* Pull only the battle-pass mirror literals — the rest of the file needs
     DOM and the earlier store globals. */
  const thresholdsMatch = source.match(/const BP_XP_THRESHOLDS = (\[[\s\S]*?\n\]);/);
  const rewardsMatch = source.match(/const BP_REWARDS = (\[[\s\S]*?\n\]);/);
  const kindsMatch = source.match(/const BP_KINDS = (\{[\s\S]*?\n\});/);
  assert.ok(thresholdsMatch, 'BP_XP_THRESHOLDS not found in 82-store.js');
  assert.ok(rewardsMatch, 'BP_REWARDS not found in 82-store.js');
  assert.ok(kindsMatch, 'BP_KINDS not found in 82-store.js');
  const sandbox = {};
  vm.runInNewContext(
    `this.BP_XP_THRESHOLDS = ${thresholdsMatch[1]}; ` +
    `this.BP_REWARDS = ${rewardsMatch[1]}; this.BP_KINDS = ${kindsMatch[1]};`,
    sandbox);
  return sandbox;
}

test('validateSeason1Rewards passes for the shipped catalog', async () => {
  const catalog = await import('./season1.mjs');
  const cosmetics = await import('./cosmetics.mjs');
  assert.deepEqual(
    catalog.validateSeason1Rewards(cosmetics.COSMETICS_BY_ID),
    { valid: true, unknownIds: [] }
  );
});

test('no reward id uses spray, charm, banner, or sticker', async () => {
  const catalog = await import('./season1.mjs');
  const cosmetics = await import('./cosmetics.mjs');
  const client = loadClientBpMirror();
  const ids = catalog.SEASON_1_TIERS.flatMap((t) => [t.freeReward, t.premiumReward]);
  for (const id of ids) {
    for (const dead of DEAD_KINDS)
      assert.ok(!id.includes(`-${dead}-`), `${id} still uses dead kind ${dead}`);
    assert.ok(kindFromId(id), `${id} has no renderable kind token`);
  }
  for (const dead of DEAD_KINDS) {
    assert.equal(client.BP_KINDS[dead], undefined,
      `BP_KINDS still lists dead kind ${dead}`);
  }
  const sourceBundle = [
    fs.readFileSync(path.join(__dirname, 'season1.mjs'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'cosmetics.mjs'), 'utf8'),
    fs.readFileSync(path.join(__dirname, 'src/82-store.js'), 'utf8')
  ].join('\n');
  for (const dead of DEAD_KINDS) {
    assert.ok(
      !new RegExp(`s1-(free|premium)-${dead}-`).test(sourceBundle),
      `source still contains an s1-*-${dead}-* id`
    );
  }
  for (const item of cosmetics.BATTLEPASS_COSMETICS)
    for (const dead of DEAD_KINDS)
      assert.ok(!item.id.includes(`-${dead}-`), `catalog ${item.id} uses ${dead}`);
});

test('all 50 battle-pass ids are unique and miss the nine shop cosmetics', async () => {
  const catalog = await import('./season1.mjs');
  const cosmetics = await import('./cosmetics.mjs');
  const ids = catalog.SEASON_1_TIERS.flatMap((t) => [t.freeReward, t.premiumReward]);
  assert.equal(ids.length, 50);
  assert.equal(new Set(ids).size, 50, 'duplicate reward ids');
  for (const shop of cosmetics.SHOP_COSMETICS)
    assert.ok(!ids.includes(shop.id), `reward collides with shop cosmetic ${shop.id}`);
  assert.equal(cosmetics.BATTLEPASS_COSMETICS.length, 50);
  assert.equal(cosmetics.SHOP_COSMETICS.length, 9);
});

test('every battle-pass reward resolves to a renderer for its type', async () => {
  const catalog = await import('./season1.mjs');
  const cosmetics = await import('./cosmetics.mjs');
  const weapons = loadWeaponSkins();
  const characters = loadCharacterSkins();
  const effects = loadShotEffects();

  const ids = catalog.SEASON_1_TIERS.flatMap((t) => [t.freeReward, t.premiumReward]);
  assert.equal(ids.length, 50);

  for (const id of ids) {
    const item = cosmetics.COSMETICS_BY_ID.get(id);
    assert.ok(item, `${id} missing from catalog`);
    const kind = kindFromId(id);
    assert.ok(kind, `${id} has no kind token`);

    if (kind === 'smg' || kind === 'shotgun' || kind === 'rifle') {
      assert.equal(item.type, 'weapon', `${id} catalog type`);
      assert.equal(item.slot, kind, `${id} catalog slot`);
      const skin = weapons[id];
      assert.ok(skin, `${id} missing from WEAPON_SKINS`);
      assert.equal(skin.weapon, kind, `${id} WEAPON_SKINS.weapon`);
      assert.ok(skin.col && skin.col.body != null, `${id} has no palette`);
    } else if (kind === 'char') {
      assert.equal(item.type, 'character', `${id} catalog type`);
      assert.equal(item.slot, null, `${id} must be slotless`);
      assert.ok(characters.CHARACTER_SKINS[id], `${id} missing from CHARACTER_SKINS`);
      assert.ok(characters.SKIN_PARTS[id], `${id} missing from SKIN_PARTS`);
      assert.ok(characters.characterSkin(id), `${id} characterSkin lookup failed`);
    } else if (kind === 'fx') {
      assert.equal(item.type, 'effect', `${id} catalog type`);
      assert.equal(item.slot, null, `${id} must be slotless`);
      assert.ok(effects.SHOT_EFFECTS[id], `${id} missing from SHOT_EFFECTS`);
      assert.ok(effects.fxEffectFor(id), `${id} fxEffectFor lookup failed`);
    } else {
      assert.fail(`${id}: unexpected kind ${kind}`);
    }
  }
});

test('server reward ladder and client BP_REWARDS mirror are identical', async () => {
  const catalog = await import('./season1.mjs');
  const client = loadClientBpMirror();
  assert.equal(client.BP_REWARDS.length, catalog.SEASON_1_TIERS.length);
  assert.equal(client.BP_REWARDS.length, 25);
  for (let i = 0; i < catalog.SEASON_1_TIERS.length; i++) {
    const tier = catalog.SEASON_1_TIERS[i];
    const pair = client.BP_REWARDS[i];
    assert.equal(pair.free, tier.freeReward,
      `tier ${tier.tier} free: client ${pair.free} != server ${tier.freeReward}`);
    assert.equal(pair.premium, tier.premiumReward,
      `tier ${tier.tier} premium: client ${pair.premium} != server ${tier.premiumReward}`);
  }
});

test('server XP curve and client BP_XP_THRESHOLDS mirror are identical', async () => {
  const catalog = await import('./season1.mjs');
  const client = loadClientBpMirror();
  assert.deepEqual(
    Array.from(client.BP_XP_THRESHOLDS),
    Array.from(catalog.SEASON_1_XP_CURVE)
  );
  for (let index = 0; index < catalog.SEASON_1_TIERS.length; index++)
    assert.equal(client.BP_XP_THRESHOLDS[index], catalog.SEASON_1_TIERS[index].xpRequired);
});

test('battle-pass cosmetics are earn-only products with catalogued shape metadata', async () => {
  const cosmetics = await import('./cosmetics.mjs');
  for (const item of cosmetics.BATTLEPASS_COSMETICS) {
    assert.equal(item.priceEnvVar, null, `${item.id} has a price env var`);
    assert.equal(cosmetics.STORE_PRODUCTS_BY_ID.has(item.id), false,
      `${item.id} is listed as a store product`);
    assert.ok(cosmetics.COSMETICS_BY_ID.has(item.id),
      `${item.id} must resolve for relay shape validation`);
  }
  for (const item of cosmetics.SHOP_COSMETICS) {
    assert.equal(typeof item.priceEnvVar, 'string');
    assert.ok(cosmetics.STORE_PRODUCTS_BY_ID.has(item.id));
  }
});

test('tier-one lanes have distinct player-facing names', async () => {
  const cosmetics = await import('./cosmetics.mjs');
  const free = cosmetics.COSMETICS_BY_ID.get('s1-free-smg-first-light');
  const premium = cosmetics.COSMETICS_BY_ID.get('s1-premium-smg-first-light');
  assert.notEqual(free.displayName, premium.displayName);
});

test('weapon rewards require a slot; characters and effects are slotless', async () => {
  const cosmetics = await import('./cosmetics.mjs');
  for (const item of cosmetics.BATTLEPASS_COSMETICS) {
    if (item.type === 'weapon') {
      assert.ok(['smg', 'shotgun', 'rifle'].includes(item.slot),
        `${item.id} weapon slot ${item.slot}`);
    } else {
      assert.equal(item.slot, null, `${item.id} (${item.type}) must have slot: null`);
    }
  }
});
