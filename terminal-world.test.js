'use strict';

/* =====================================================================
   TERMINAL — THE MAP MADE VISIBLE
   terminal-map.test.js proves the AABBs are a fair map. This proves the
   geometry drawn over them is the same map, which is the half nothing
   else can see: the renderer builds one opaque mesh, so a mistake here
   does not throw and does not fail a physics test. It just means the
   thing you are standing in is not the thing you are looking at.

   Both failures guarded below shipped, and both were only visible from
   inside the plane:

     - the livery cheatline was ONE box across the whole fuselage section,
       so in the cabin — which is walkable at F1 — it read as an opaque
       pink floor 0.9m above the real one, hiding your feet, any pickup,
       and the bottom half of every body in there;

     - 'fuselage' and 'bridge' solids are skipped by the renderer in
       favour of bespoke meshes, and the bespoke meshes drew the outside
       only. The cabin floor and the jet bridge deck had no geometry at
       all, so CROSSING 3 was a walkway you crossed on thin air.
   ===================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert');

const TERMINAL = require('./terminal-mapspec.js');

const F1 = TERMINAL.consts.F1;
const CZ = 12.0, CR = 2.2, CY = 4.3, ROT = 0.22, SIDES = 14;   // the hull prism
const EYE = TERMINAL.actor.eye, BODY = TERMINAL.actor.height;

/* Run the renderer against a builder that only records extents. Colour is
   irrelevant here, so C() and colorScale() hand the hex straight back.
   solid() and the two swept helpers are recorded as their bounding box:
   good enough to answer "is anything drawn here", and never used to claim
   something is CLEAR, which would let a curved mesh alibi a straight one. */
function drawTerminal() {
  const boxes = [], hulls = [];
  const bbox = (pts) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]);
    }
    return { min: lo, max: hi };
  };
  const noop = () => {};
  const B = {
    box: (min, max) => boxes.push({ min: min.slice(), max: max.slice() }),
    solid: (pts) => hulls.push(bbox(pts)),
    quad: (a, b, c, d) => hulls.push(bbox([a, b, c, d])),
    tri: (a, b, c) => hulls.push(bbox([a, b, c])),
    edge: noop
  };
  const H = {
    bevelBox: (_b, min, max) => boxes.push({ min: min.slice(), max: max.slice() }),
    /* The prisms and arcs sweep a profile; record the swept extent so the
       coverage test can see them, and leave them out of `boxes` so the
       clearance test never asks a bounding box whether a curve is in the way. */
    ngonPrism: (_b, axis, c0, c1, cu, cv, r) => {
      const lo = [Math.min(c0, c1), cu - r, cv - r], hi = [Math.max(c0, c1), cu + r, cv + r];
      if (axis === 'z') { hulls.push({ min: [lo[1], lo[2], lo[0]], max: [hi[1], hi[2], hi[0]] }); }
      else hulls.push({ min: lo, max: hi });
    },
    arcBand: (_b, _axis, t0, t1, cu, cv, _rIn, rOut) =>
      hulls.push({ min: [cu - rOut, cv - rOut, Math.min(t0, t1)],
                   max: [cu + rOut, cv + rOut, Math.max(t0, t1)] })
  };
  const sandbox = { lerp: (a, b, t) => a + (b - a) * t };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'src/25-terminal-world.js'), 'utf8'),
                  sandbox, { filename: 'src/25-terminal-world.js' });
  sandbox.buildTerminalGeometry({
    builder: B, color: (h) => h, colorScale: (h) => h, helpers: H, map: TERMINAL
  });
  return { boxes: boxes, all: boxes.concat(hulls) };
}

const DRAWN = drawTerminal();

function overlaps(b, lo, hi) {
  for (let i = 0; i < 3; i++) if (b.max[i] <= lo[i] || b.min[i] >= hi[i]) return false;
  return true;
}

/* The hull is a 14-gon swept along X. Convex, so a point is inside when it
   is on the same side of every edge. Works in the (y, z) profile plane. */
function insideHull(y, z, r) {
  let sign = 0;
  for (let i = 0; i < SIDES; i++) {
    const a0 = ROT + (i / SIDES) * Math.PI * 2, a1 = ROT + ((i + 1) / SIDES) * Math.PI * 2;
    const p = [CY + Math.cos(a0) * r, CZ + Math.sin(a0) * r];
    const q = [CY + Math.cos(a1) * r, CZ + Math.sin(a1) * r];
    const cross = (q[0] - p[0]) * (z - p[1]) - (q[1] - p[1]) * (y - p[0]);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}

test('nothing is drawn through the volume a player walks in inside the cabin', () => {
  /* The cabin is 3.8m wide in collision and the eye stops 0.38 short of
     that, so this is the space a standing player owns, bulkhead to
     bulkhead. Dressing belongs
     outboard of it or overhead — anything crossing it is, from in there,
     a wall you cannot see past and can walk through. */
  const lo = [-5.7, F1, CZ - 1.6], hi = [21.7, F1 + BODY, CZ + 1.6];
  const blocking = DRAWN.boxes.filter((b) => overlaps(b, lo, hi));
  assert.deepStrictEqual(blocking, [],
    'geometry crosses the cabin at standing height: ' + JSON.stringify(blocking));
});

test('every surface the spec says you can stand on has something drawn on it', () => {
  /* platforms[] is the contract the renderer has to honour. A platform with
     no top face under it is a floor made of nothing: you hang in the air,
     and with the hull culled from inside you watch the map through your
     own feet. Sampled on a 0.6m grid, inset so a shared edge is not asked
     to cover the neighbour's first sample. */
  const missing = [];
  for (const p of TERMINAL.platforms) {
    for (let x = p.min[0] + 0.4; x < p.max[0] - 0.3; x += 0.6)
      for (let z = p.min[1] + 0.4; z < p.max[1] - 0.3; z += 0.6) {
        const covered = DRAWN.all.some((b) =>
          Math.abs(b.max[1] - p.y) < 0.02 &&
          b.min[0] <= x && b.max[0] >= x && b.min[2] <= z && b.max[2] >= z);
        if (!covered) missing.push([+x.toFixed(1), p.y, +z.toFixed(1)]);
      }
  }
  assert.deepStrictEqual(missing, [],
    'walkable but undrawn: ' + JSON.stringify(missing.slice(0, 12)));
});

test('the cabin liner stays inside the hull it is lining', () => {
  /* The spec's cabin AABB is 2.2 half-width at every height; the hull is a
     14-gon of that radius, so it has closed to 1.84 by the door headers.
     Anything built on the AABB pokes out through the curve as a fin. Only
     the flank skins are allowed out, and only just — they are the livery,
     and they are meant to sit proud of the surface. */
  const strays = [];
  for (const b of DRAWN.boxes) {
    if (b.max[0] <= -6 || b.min[0] >= 22) continue;            // outside the cabin bay
    /* The floor pan and its door sills are the exception and are checked by
       eye, not here: a sill has to reach the wing root at 2.0 to close the
       threshold, which is outside the curve by design — that is what makes
       it read as a sill rather than a slot. Everything standing on the pan
       has no such excuse. */
    if (b.max[1] <= F1 + 0.01 || b.min[1] >= 5.7) continue;
    const far = Math.max(Math.abs(b.min[2] - CZ), Math.abs(b.max[2] - CZ));
    if (far >= CR - 0.05) continue;                            // livery skins and door surrounds
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]])
        if (!insideHull(y, z, CR)) strays.push([y, z]);
  }
  assert.deepStrictEqual(strays, [],
    'liner corners outside the hull: ' + JSON.stringify(strays));
});
