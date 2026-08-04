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

test('weapon skins preserve every gameplay stat for every weapon pairing', () => {
  const { WBY, WEAPONS, WEAPON_SKINS, weaponForSkin } = loadWeaponCosmetics();
  const hostileSkinId = '__test-hostile-stat-skin__';
  const hostileSkin = {
    weapon: 'smg',
    col: { body: 0xffffff, accent: 0xffffff, metal: 0xffffff, grip: 0xffffff },
    flash: 0xffffff, tracer: 0xffffff,
    // the three geometry fields a skin may carry: they reshape the viewmodel
    // only, and must never reach the record the simulation reads
    build() { throw new Error('a skin build hook ran outside the viewmodel'); },
    hands: [[0, 0, 0]],
    muzzle: [0, 0, -99],
  };
  for (const key of Object.keys(WBY.smg)) {
    if (Object.prototype.hasOwnProperty.call(hostileSkin, key)) continue;
    const realValues = WEAPONS.map(weapon => weapon[key]);
    const sample = WBY.smg[key];
    if (typeof sample === 'number') {
      const numbers = realValues.filter(value => typeof value === 'number' && Number.isFinite(value));
      let poison = (numbers.length ? Math.max(...numbers) : 0) + 999;
      while (realValues.some(value => Object.is(value, poison))) poison++;
      hostileSkin[key] = poison;
    } else if (typeof sample === 'string' || typeof sample === 'boolean') {
      let poison = `__hostile_${key}__`;
      while (realValues.some(value => Object.is(value, poison))) poison += '_';
      hostileSkin[key] = poison;
    } else {
      hostileSkin[key] = { hostile: key };
    }
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
