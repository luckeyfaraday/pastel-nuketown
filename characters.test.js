'use strict';

/* =====================================================================
   CHARACTER SKINS — the two things a paid character must never buy you
   1. a different envelope: hit detection in 30-physics.js is analytic and
      reads no mesh, so a character that is fatter, taller or further
      forward than the default is one that shows up around cover first,
      and one that is thinner than the r=.36 capsule makes an opponent's
      hits look like misses. Every measurement below is against the
      default character, which is the honest shape by definition.
   2. a jersey you cannot read: nine team colours are what keep nine
      players apart, so the skin's own palette may own the head and the
      costume but not the torso and arms.
   The numbers quoted in src/50-actors.js come out of `measure()` here.
   ===================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SKIN_IDS = ['char-midnight', 'char-sherbetfox', 'char-cloudknight'];
const JERSEY = { body: 0x123456, trim: 0x654321 };

/* A stub scene graph: enough THREE for buildCharacter to run under node, and
   nothing more. Colours become plain records so a box can be traced back to
   the hex it was asked for, and GeoBuilder just keeps the boxes. */
function stubNode(extra) {
  const n = Object.assign({
    children: [],
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { x: 0, y: 0, z: 0 },
    add(...kids) { this.children.push(...kids); },
    traverse(fn) { fn(this); for (const c of this.children) c.traverse(fn); }
  }, extra || {});
  return n;
}

function loadCharacters() {
  const source = fs.readFileSync(path.join(__dirname, 'src/50-actors.js'), 'utf8');

  function GeoBuilder() { this.boxes = []; }
  GeoBuilder.prototype.box = function (min, max, color) {
    this.boxes.push({ min: min.slice(), max: max.slice(), color });
  };
  GeoBuilder.prototype.mesh = function () { return stubNode({ isMesh: true, boxes: this.boxes }); };
  GeoBuilder.prototype.lines = function () { return stubNode({ isLine: true }); };

  const sandbox = {
    THREE: { Group: function () { return stubNode(); }, Object3D: function () { return stubNode(); } },
    GeoBuilder,
    C: (hex) => ({ hex, mul: null }),
    Cx: (hex, r, g, b) => ({ hex, mul: [r, g === undefined ? r : g, b === undefined ? r : b] }),
    Math
  };
  vm.runInNewContext(
    `${source}\nthis.api = { buildCharacter, CHARACTER_SKINS, characterSkin, CH };`, sandbox);

  const api = sandbox.api;
  const build = (id) => api.buildCharacter(JERSEY, id);
  return Object.assign({ build, boxesOf, measure, area, jerseyShare }, api);
}

/* Every group in the rig is a pure translation at build time, so world-space
   boxes are just the accumulated offsets. `skip` drops the gun, which is the
   same weapon prop on every character. */
function boxesOf(node, skip, ox, oy, oz, out) {
  out = out || [];
  if (node === skip) return out;
  ox = (ox || 0) + node.position.x;
  oy = (oy || 0) + node.position.y;
  oz = (oz || 0) + node.position.z;
  if (node.boxes) {
    for (const b of node.boxes) {
      out.push({
        min: [b.min[0] + ox, b.min[1] + oy, b.min[2] + oz],
        max: [b.max[0] + ox, b.max[1] + oy, b.max[2] + oz],
        color: b.color
      });
    }
  }
  for (const c of node.children) boxesOf(c, skip, ox, oy, oz, out);
  return out;
}

function extent(boxes) {
  const m = { maxX: 0, top: 0, forward: 0, rear: -Infinity, radial: 0 };
  for (const b of boxes) {
    m.maxX = Math.max(m.maxX, Math.abs(b.min[0]), Math.abs(b.max[0]));
    m.top = Math.max(m.top, b.max[1]);
    m.forward = Math.max(m.forward, -b.min[2]);
    m.rear = Math.max(m.rear, b.max[2]);
    for (const x of [b.min[0], b.max[0]]) {
      for (const z of [b.min[2], b.max[2]]) m.radial = Math.max(m.radial, Math.hypot(x, z));
    }
  }
  return m;
}

/* The published envelope of one character. */
function measure(ch) {
  const all = boxesOf(ch.root, ch.gun);
  const arms = boxesOf(ch.armL, ch.gun).concat(boxesOf(ch.armR, ch.gun));
  const armSet = new Set(arms.map(b => b.min.join() + b.max.join()));
  const noArms = all.filter(b => !armSet.has(b.min.join() + b.max.join()));
  const e = extent(all), t = extent(boxesOf(ch.torso)), h = extent(boxesOf(ch.headPiv));
  const headBoxes = boxesOf(ch.headPiv);
  return {
    height: e.top,
    maxAbsX: e.maxX,
    maxAbsXNoArms: extent(noArms).maxX,
    forward: e.forward,
    rear: e.rear,
    radial: e.radial,
    torsoHalfWidth: t.maxX,
    torsoHalfDepth: Math.max(t.forward, t.rear),
    headTop: h.top,
    headBottom: Math.min(...headBoxes.map(b => b.min[1])),
    headHalfWidth: h.maxX,
    boxes: all.length
  };
}

function area(boxes) {
  let a = 0;
  for (const b of boxes) {
    const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1], d = b.max[2] - b.min[2];
    a += 2 * (w * h + w * d + h * d);
  }
  return a;
}

/* Fraction of a surface painted in the team's colour. cD / cTop are the
   jersey shaded, so anything derived from body or trim counts. */
function jerseyShare(boxes) {
  const team = boxes.filter(b => b.color.hex === JERSEY.body || b.color.hex === JERSEY.trim);
  return area(team) / area(boxes);
}

const geom = (b) => b.min.map(n => n.toFixed(4)).join() + '|' + b.max.map(n => n.toFixed(4)).join();
const full = (b) => geom(b) + '|' + b.color.hex + '|' + b.color.mul;

test('the default character is untouched by every non-id', () => {
  const api = loadCharacters();
  const baseline = boxesOf(api.build(undefined).root).map(full);
  assert.ok(baseline.length > 20, 'default character built no geometry');

  for (const id of [undefined, null, 0, 7, '', 'nope', 'char-', {}, [], true,
                    'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const got = boxesOf(api.build(id).root).map(full);
    assert.deepEqual(got, baseline, `id ${JSON.stringify(id)} changed the default character`);
    assert.equal(api.characterSkin(id), null, `id ${JSON.stringify(id)} resolved to a skin`);
  }
});

test('every skin id is a known character and builds a full rig', () => {
  const api = loadCharacters();
  assert.deepEqual(Object.keys(api.CHARACTER_SKINS).sort(), SKIN_IDS.slice().sort());
  for (const id of SKIN_IDS) {
    const ch = api.build(id);
    for (const pivot of ['root', 'hips', 'torso', 'headPiv', 'legL', 'legR', 'armL', 'armR', 'gun', 'muzzle'])
      assert.ok(ch[pivot], `${id} is missing the ${pivot} pivot`);
  }
});

/* The fairness rule. Nothing may reach further than the default in any
   horizontal direction, and nothing may be meaningfully thinner than it. */
test('every skin fills the default character envelope', () => {
  const api = loadCharacters();
  const def = api.measure(api.build());

  for (const id of SKIN_IDS) {
    const m = api.measure(api.build(id));
    const near = (got, want, over, under, what) => {
      assert.ok(got <= want + over, `${id} ${what} ${got.toFixed(3)} exceeds default ${want.toFixed(3)} by more than ${over}`);
      assert.ok(got >= want - under, `${id} ${what} ${got.toFixed(3)} falls short of default ${want.toFixed(3)} by more than ${under}`);
    };
    /* Reach: never further out than the default in any direction. The lower
       bounds are looser forwards and on the diagonal because the default's
       own extremes there are one thin part — the cap brim, at -.350 and at
       .433 radial across its front corners — and a character is not unfair
       for lacking a peaked cap. What may not shrink is mass, checked below. */
    near(m.maxAbsX, def.maxAbsX, 0.005, 0.02, 'max |x|');
    near(m.forward, def.forward, 0.005, 0.05, 'forward reach');
    near(m.rear, def.rear, 0.005, 0.05, 'rearward reach');
    near(m.radial, def.radial, 0.01, 0.05, 'max radial extent');
    near(m.height, def.height, 0.005, 0.02, 'height');
    // torso mass: still as thick as the r=.36 capsule the bullets use
    near(m.torsoHalfWidth, def.torsoHalfWidth, 0.02, 0.005, 'torso half-width');
    near(m.torsoHalfDepth, def.torsoHalfDepth, 0.02, 0.02, 'torso half-depth');
    // head mass: still wrapped around the r=.30 sphere centred on y 1.60
    assert.ok(m.headBottom <= 1.60 - 0.15, `${id} head does not reach below the hit sphere's centre`);
    assert.ok(m.headTop >= 1.60 + 0.15, `${id} head does not reach above the hit sphere's centre`);
    near(m.headHalfWidth, def.headHalfWidth, 0.01, 0.02, 'head half-width');
  }
});

test('the jersey stays the dominant colour on torso and arms', () => {
  const api = loadCharacters();
  for (const id of [undefined].concat(SKIN_IDS)) {
    const ch = api.build(id);
    const torso = boxesOf(ch.torso);
    const arms = boxesOf(ch.armL, ch.gun).concat(boxesOf(ch.armR, ch.gun));
    const name = id || 'default';
    assert.ok(api.jerseyShare(torso) > 0.5,
      `${name} torso is only ${(api.jerseyShare(torso) * 100).toFixed(0)}% team colour`);
    assert.ok(api.jerseyShare(arms) > 0.5,
      `${name} arms are only ${(api.jerseyShare(arms) * 100).toFixed(0)}% team colour`);
    assert.ok(api.jerseyShare(torso.concat(arms)) > 0.5,
      `${name} torso+arms are only ${(api.jerseyShare(torso.concat(arms)) * 100).toFixed(0)}% team colour`);
  }
});

/* The product requirement: a different character, not a recoloured one. */
test('every skin is a different character, not a repaint', () => {
  const api = loadCharacters();
  const parts = (ch) => ({
    head: boxesOf(ch.headPiv).map(geom),
    torso: boxesOf(ch.torso).map(geom),
    leg: boxesOf(ch.legL).map(geom),
    arm: boxesOf(ch.armL, ch.gun).map(geom)
  });
  const def = parts(api.build());
  const built = SKIN_IDS.map(id => [id, parts(api.build(id))]);

  for (const [id, p] of built) {
    // the head is the whole read at range: nothing of the default's may survive
    const shared = p.head.filter(b => def.head.includes(b));
    assert.equal(shared.length, 0, `${id} reuses ${shared.length} of the default head's boxes`);
    for (const key of ['head', 'torso', 'leg', 'arm']) {
      const same = p[key].filter(b => def[key].includes(b)).length;
      assert.ok(same / p[key].length < 0.25,
        `${id} ${key} is ${(same / p[key].length * 100).toFixed(0)}% the default's geometry`);
      assert.ok(p[key].length >= 3, `${id} ${key} is too simple to read as a character`);
    }
  }
  // ...and different from each other, too
  for (let i = 0; i < built.length; i++) {
    for (let j = i + 1; j < built.length; j++) {
      const a = built[i][1].head, b = built[j][1].head;
      const same = a.filter(x => b.includes(x)).length;
      assert.ok(same / Math.min(a.length, b.length) < 0.25,
        `${built[i][0]} and ${built[j][0]} share a head`);
    }
  }
});

/* Nine of these render at once on a phone: a skin swaps geometry into the
   existing builders, it never adds a mesh or a draw call. */
test('no skin costs more meshes than the default character', () => {
  const api = loadCharacters();
  const meshes = (ch) => { let n = 0; ch.root.traverse(o => { if (o.isMesh) n++; }); return n; };
  const def = meshes(api.build());
  for (const id of SKIN_IDS)
    assert.equal(meshes(api.build(id)), def, `${id} adds meshes to the character`);
});

module.exports = { loadCharacters, boxesOf, measure, area, jerseyShare, JERSEY };
