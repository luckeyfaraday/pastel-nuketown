'use strict';

/* =====================================================================
   GEOBUILDER BASELINE FIXTURE
   GeoBuilder builds the entire game — every house, the bus, the fence, the
   weapons, the players. A change to quad(), edge(), tri() or box() does not
   break one prop, it breaks the world, and it breaks it silently: the mesh
   still builds, it just comes out shaded or wound or inked differently.

   So the four original methods are pinned. This module replays a slice of
   the call patterns the real world code uses (src/20-world.js: gable(),
   ngonPrism(), bevelBox(), windowPanel(); src/50-actors.js: plain tinted
   boxes) and geobuilder.test.js asserts the emitted pos/nrm/col/epos/ecol
   match geobuilder-baseline.json exactly.

   The baseline was recorded from the committed builder, before any of this
   round's additions:

       node geobuilder-fixture.js --from-head     # re-record from git HEAD
       node geobuilder-fixture.js --from-worktree # DANGER: blesses local edits

   Only the first form is a legitimate regeneration.
   ===================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const BASELINE_PATH = path.join(__dirname, 'geobuilder-baseline.json');
const CORE_PATH = path.join(__dirname, 'src/10-core.js');

const START = '/* =====================================================================\n   GEOMETRY BUILDER';
const END = '/* =====================================================================\n   RENDERER / SCENE';

/* The exact sRGB->linear curve THREE.Color.convertSRGBToLinear applies, so a
   colour authored as a hex lands in the buffer as the number the game would
   have put there. */
function srgbToLinear(c) {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

function makeC() {
  return function C(hex) {
    return {
      r: srgbToLinear(((hex >> 16) & 255) / 255),
      g: srgbToLinear(((hex >> 8) & 255) / 255),
      b: srgbToLinear((hex & 255) / 255)
    };
  };
}

/* Pull just the builder out of 10-core.js. Everything above it touches
   document/location/THREE at load time; the builder itself only needs C()
   for EDGE_COL, plus the two math helpers the new solids use. */
function loadGeoBuilder(source) {
  const from = source.indexOf(START);
  const to = source.indexOf(END);
  if (from < 0 || to < 0 || to <= from) throw new Error('GeoBuilder section markers not found in 10-core.js');
  const C = makeC();
  const sandbox = {
    C, Math, Infinity,
    clamp: (v, a, b) => v < a ? a : (v > b ? b : v),
    lerp: (a, b, t) => a + (b - a) * t,
    THREE: {}
  };
  vm.runInNewContext(
    `'use strict';\n${source.slice(from, to)}\nthis.api = { GeoBuilder, EDGE_COL };`, sandbox);
  return { GeoBuilder: sandbox.api.GeoBuilder, EDGE_COL: sandbox.api.EDGE_COL, C };
}

/* ---------------------------------------------------------------------
   The fixture. Every call below is shaped like a call the game already
   makes; none of them may use anything added after the baseline. */
function buildBaselineFixture(GeoBuilder, C) {
  const B = new GeoBuilder();
  const PAL = { cream: 0xfff8f0, mint: 0xbfe8d4, rose: 0xf7c9d3, ink: 0x4a3f5c, glass: 0xcfe8f5 };
  const body = C(PAL.cream), roof = C(PAL.rose), trim = C(PAL.mint), dark = C(PAL.ink);

  // a plain axis-aligned solid — the shape 110 of these make the map out of
  B.box([-2, 0, -3], [2, 2.4, 3], body);
  // tinted faces + a skipped face, as the houses and the bus do
  B.box([-2.2, 2.4, -3.2], [2.2, 2.7, 3.2], body, { top: trim, side: roof, bottom: dark, skip: { ny: true } });
  // an inner box with no ink at all — window glass, hatches, decals
  B.box([-1.9, 0.9, 3.0], [-0.4, 1.9, 3.1], C(PAL.glass), { noEdge: true });
  // bevelBox(): two interpenetrating boxes
  const c = 0.12;
  B.box([-1 + c, 0, -1 + c], [1 - c, 1.6, 1 - c], trim);
  B.box([-1, 0 + c, -1], [1, 1.6 - c, 1], trim);

  // gable(): four raw quad()s and two tri()s, winding included
  const L = [-2.4, 2.7, -3.6], R = [2.4, 2.7, -3.6], L2 = [-2.4, 2.7, 3.6], R2 = [2.4, 2.7, 3.6];
  const PL = [-2.4, 4.1, 0], PR = [2.4, 4.1, 0];
  B.quad(PL, PR, R, L, roof);
  B.quad(PR, PL, L2, R2, roof);
  B.tri(L, L2, PL, roof);
  B.tri(R2, R, PR, roof);
  B.quad(L, R, R2, L2, roof, true);

  // ngonPrism(): quads with explicit edges, plus the fan caps
  const sides = 6, r = 0.5, TAU = Math.PI * 2;
  const pts = [];
  for (let i = 0; i < sides; i++) pts.push([Math.cos(i / sides * TAU) * r, Math.sin(i / sides * TAU) * r]);
  const P = (t, u, v) => [u, t, v];
  for (let i = 0; i < sides; i++) {
    const p = pts[i], q = pts[(i + 1) % sides];
    B.quad(P(0, p[0], p[1]), P(0, q[0], q[1]), P(1.4, q[0], q[1]), P(1.4, p[0], p[1]), dark, true);
    B.edge(P(0, p[0], p[1]), P(0, q[0], q[1]));
    B.edge(P(1.4, p[0], p[1]), P(1.4, q[0], q[1]));
  }
  for (let i = 1; i < sides - 1; i++) {
    B.tri(P(1.4, pts[0][0], pts[0][1]), P(1.4, pts[i][0], pts[i][1]), P(1.4, pts[i + 1][0], pts[i + 1][1]), dark, true);
    B.tri(P(0, pts[0][0], pts[0][1]), P(0, pts[i + 1][0], pts[i + 1][1]), P(0, pts[i][0], pts[i][1]), dark, true);
  }

  // a hand-coloured ink line, the one edge() overload in use
  B.edge([-2, 0.01, -3], [2, 0.01, -3], C(PAL.ink));

  return B;
}

/* The builder runs in a vm realm, so its arrays are not the host's Array;
   copy them out before anything compares them. Negative zero is a real
   distinction in a normal buffer and JSON cannot hold it, so it travels as
   a string. */
function snapshot(B) {
  const out = {};
  for (const key of BUFFERS) out[key] = Array.from(B[key]);
  return out;
}

const BUFFERS = ['pos', 'nrm', 'col', 'epos', 'ecol'];

function encode(v) { return Object.is(v, -0) ? '-0' : v; }
function decode(v) { return v === '-0' ? -0 : v; }

function serialize(snap) {
  const out = {};
  for (const key of BUFFERS) out[key] = snap[key].map(encode);
  return JSON.stringify(out) + '\n';
}

function readBaseline() {
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const out = {};
  for (const key of BUFFERS) out[key] = raw[key].map(decode);
  return out;
}

module.exports = { loadGeoBuilder, buildBaselineFixture, snapshot, readBaseline, BUFFERS, BASELINE_PATH, CORE_PATH };

if (require.main === module) {
  const mode = process.argv[2];
  let source;
  if (mode === '--from-head') {
    source = require('node:child_process')
      .execFileSync('git', ['show', 'HEAD:src/10-core.js'], { cwd: __dirname, encoding: 'utf8' });
  } else if (mode === '--from-worktree') {
    source = fs.readFileSync(CORE_PATH, 'utf8');
  } else {
    process.stderr.write('usage: node geobuilder-fixture.js --from-head | --from-worktree\n');
    process.exit(2);
  }
  const { GeoBuilder, C } = loadGeoBuilder(source);
  const out = snapshot(buildBaselineFixture(GeoBuilder, C));
  fs.writeFileSync(BASELINE_PATH, serialize(out));
  process.stdout.write(`recorded ${out.pos.length / 3} vertices and ${out.epos.length / 6} ink lines from ${mode}\n`);
}
