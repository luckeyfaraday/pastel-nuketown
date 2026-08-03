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
      }
    }
  } finally {
    delete WEAPON_SKINS[hostileSkinId];
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
