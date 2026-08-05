'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadWeaponCosmetics() {
  const source = fs.readFileSync(path.join(__dirname, 'src/40-weapons.js'), 'utf8');
  const marker = '\n/* =====================================================================\n   VIEWMODEL SCENE';
  const pureSource = source.slice(0, source.indexOf(marker));
  const sandbox = {};
  vm.runInNewContext(`${pureSource}\nthis.api = { WBY, WEAPONS, WEAPON_SKINS, weaponForSkin };`, sandbox);
  return sandbox.api;
}

/* Every field any weapon record carries, not the smg's alone.
   The three records happen to agree today, which is what made reading the keys
   off one of them look safe — but a field added to the shotgun and nowhere else
   (pellets, say) would then never be given a poison value, and a skin leaking
   exactly that field would sail through a green test. The union cannot miss it,
   and the assertion below says so out loud if the records ever diverge. */
function statKeys(WBY, WEAPONS) {
  const ids = Object.keys(WBY);
  const union = new Set();
  for (const record of [...ids.map(id => WBY[id]), ...WEAPONS])
    for (const key of Object.keys(record)) union.add(key);
  for (const id of ids) {
    assert.deepEqual(Object.keys(WBY[id]).sort(), [...union].sort(),
      `${id} no longer carries the same fields as the other weapons — the guard ` +
      'below poisons the union, but a field only one weapon has is a field ' +
      'worth looking at twice');
  }
  return [...union];
}

/* What a skin is allowed to bring, and what it may never reach. Shared by both
   tests below so a new geometry field cannot be added to one and forgotten in
   the other. */
function hostileSkinBase() {
  return {
    weapon: 'smg',
    col: { body: 0xffffff, accent: 0xffffff, metal: 0xffffff, grip: 0xffffff },
    flash: 0xffffff, tracer: 0xffffff,
    // the three geometry fields a skin may carry: they reshape the viewmodel
    // only, and must never reach the record the simulation reads
    build() { throw new Error('a skin build hook ran outside the viewmodel'); },
    hands: [[0, 0, 0]],
    muzzle: [0, 0, -99],
  };
}

/* A value of the right shape that no real weapon holds, so a leak of `key` is
   visible as itself rather than as a coincidence. */
function poisonFor(key, sample, realValues) {
  if (typeof sample === 'number') {
    const numbers = realValues.filter(value => typeof value === 'number' && Number.isFinite(value));
    let poison = (numbers.length ? Math.max(...numbers) : 0) + 999;
    while (realValues.some(value => Object.is(value, poison))) poison++;
    return poison;
  }
  if (typeof sample === 'string' || typeof sample === 'boolean') {
    let poison = `__hostile_${key}__`;
    while (realValues.some(value => Object.is(value, poison))) poison += '_';
    return poison;
  }
  return { hostile: key };
}

test('weapon skins preserve every gameplay stat for every weapon pairing', () => {
  const { WBY, WEAPONS, WEAPON_SKINS, weaponForSkin } = loadWeaponCosmetics();
  const hostileSkinId = '__test-hostile-stat-skin__';
  const hostileSkin = hostileSkinBase();
  for (const key of statKeys(WBY, WEAPONS)) {
    if (Object.prototype.hasOwnProperty.call(hostileSkin, key)) continue;
    hostileSkin[key] = poisonFor(key, WBY.smg[key], WEAPONS.map(weapon => weapon[key]));
  }
  WEAPON_SKINS[hostileSkinId] = hostileSkin;

  try {
    for (const weapon of WEAPONS) {
      for (const skinId of Object.keys(WEAPON_SKINS)) {
        const base = WBY[weapon.id];
        const visual = weaponForSkin(base, skinId);
        for (const key of Object.keys(base)) {
          if (key === 'col' || key === 'flash' || key === 'tracer') continue;
          assert.strictEqual(visual[key], weapon[key],
            `${skinId} changed ${weapon.id}.${key}`);
        }
        // and nothing a skin carries may appear on the record at all — a
        // stray `build` or `speed` smuggled through would be a new weapon
        assert.deepEqual(Object.keys(visual).sort(), Object.keys(base).sort(),
          `${skinId} added or removed keys on ${weapon.id}`);
      }
    }
  } finally {
    delete WEAPON_SKINS[hostileSkinId];
  }
});

/* The test above asserts an absence: no field leaked. An absence passes just as
   well when the check is blind, and this one has been blind before — it read
   its key list off a single weapon, so a field the other two did not share was
   never poisoned at all.

   So this one asserts the detector instead of the code. For every field, it
   builds the record a leak of that field would produce — the shape
   `stat: skin.stat || base.stat` yields when a skin carries `stat` — and
   requires the comparison to reject it. A field that cannot be caught this way
   is a field the guard above cannot see, whether it exists today or arrives in
   a year. */
test('the stat guard detects a leak of any weapon field, not just the ones that exist now', () => {
  const { WBY, WEAPONS, weaponForSkin } = loadWeaponCosmetics();
  const skinned = Object.keys(hostileSkinBase());
  let checked = 0;

  for (const key of statKeys(WBY, WEAPONS)) {
    /* col, flash and tracer are the skin's to change — a "leak" of those is
       the feature. Everything else is the simulation's. */
    if (skinned.includes(key)) continue;
    for (const weapon of WEAPONS) {
      const base = WBY[weapon.id];
      const clean = weaponForSkin(base, null);
      const poison = poisonFor(key, base[key], WEAPONS.map(w => w[key]));
      const leaked = Object.assign({}, clean, { [key]: poison });

      let caught = false;
      try {
        for (const field of Object.keys(base)) {
          if (field === 'col' || field === 'flash' || field === 'tracer') continue;
          assert.strictEqual(leaked[field], weapon[field]);
        }
        assert.deepEqual(Object.keys(leaked).sort(), Object.keys(base).sort());
      } catch (e) { caught = true; }

      assert.ok(caught,
        `a skin leaking ${weapon.id}.${key} would pass the guard above unnoticed`);
      checked++;
    }
  }

  /* If a refactor ever empties the key list, every loop above passes by never
     running. Twenty-one fields across three weapons, less the four the skin
     owns. */
  assert.ok(checked >= 45, `the guard only exercised ${checked} field/weapon pairs`);
});

/* Two failures the store has already shipped once: an eight-digit literal
   that happened to mask into a plausible colour, and a skin so pale the gun
   stopped separating from the 0xffe0c8 mitten hands holding it. */
const MITTEN_TONES = [0xffe0c8, 0xfff8f0];
const rgb = hex => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const chroma = hex => { const p = rgb(hex); return (Math.max(...p) - Math.min(...p)) / 255; };
const nearMitten = hex => MITTEN_TONES.some(tone => {
  const a = rgb(hex), b = rgb(tone);
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) < 24;
});

test('every shipped skin uses six-digit colour and reads apart from the hands', () => {
  const { WEAPON_SKINS } = loadWeaponCosmetics();

  for (const [skinId, skin] of Object.entries(WEAPON_SKINS)) {
    const colours = [...Object.values(skin.col), skin.flash, skin.tracer];
    for (const hex of colours) {
      assert.equal(typeof hex, 'number', `${skinId} has a non-numeric colour`);
      assert.ok(Number.isInteger(hex) && hex >= 0 && hex <= 0xffffff,
        `${skinId} colour ${hex} is not a 24-bit 0xRRGGBB literal`);
    }
    assert.ok(!nearMitten(skin.col.body),
      `${skinId} body colour vanishes into the mitten hands`);
    assert.ok(colours.some(hex => chroma(hex) >= 0.35),
      `${skinId} has no committed colour — every value is a pastel wash`);
  }
});

/* The third failure: a skin that belongs to a different, harsher game. Two
   things gave that away — a near-black part (this town has no black in it,
   the darkest ink is 0x4a3f5c) and a palette with no light-to-dark range, so
   the whole gun read as one flat slab at viewmodel scale. */
const luma = hex => { const [r, g, b] = rgb(hex); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };

test('every shipped skin stays out of near-black and keeps a real value range', () => {
  const { WEAPON_SKINS } = loadWeaponCosmetics();

  for (const [skinId, skin] of Object.entries(WEAPON_SKINS)) {
    const values = Object.values(skin.col).map(luma);
    for (const [part, hex] of Object.entries(skin.col))
      assert.ok(luma(hex) >= 0.18,
        `${skinId} ${part} is near-black — no colour that dark appears in this game`);
    assert.ok(Math.max(...values) - Math.min(...values) >= 0.28,
      `${skinId} has no value range — it will read as one flat slab in the hand`);
  }
});

test('unknown or mismatched weapon skins return the exact default record', () => {
  const { WBY, WEAPON_SKINS, weaponForSkin } = loadWeaponCosmetics();

  for (const id of Object.keys(WBY)) {
    const base = WBY[id];
    assert.strictEqual(weaponForSkin(base), base, `${id} absent skin`);
    assert.strictEqual(weaponForSkin(base, undefined), base, `${id} undefined skin`);
    assert.strictEqual(weaponForSkin(base, null), base, `${id} null skin`);
    assert.strictEqual(weaponForSkin(base, 7), base, `${id} non-string skin`);
    assert.strictEqual(weaponForSkin(base, 'skin-does-not-exist'), base,
      `${id} unknown skin`);

    for (const [skinId, skin] of Object.entries(WEAPON_SKINS)) {
      if (skin.weapon !== id)
        assert.strictEqual(weaponForSkin(base, skinId), base,
          `${id} accepted wrong-weapon skin ${skinId}`);
    }
  }
});
