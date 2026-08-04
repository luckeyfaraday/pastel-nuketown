'use strict';

/* =====================================================================
   GEOBUILDER
   Two jobs here.

   1. Pin the original four methods. quad(), edge(), tri() and box() draw
      the whole game, so the first test replays a slice of the real world's
      call patterns and compares every emitted float against a baseline
      recorded from the committed builder (see geobuilder-fixture.js). Edit
      box() and this goes red.
   2. Cover the additions: per-corner colour in quad(), and solid()/prism()
      on top of it.
   ===================================================================== */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  loadGeoBuilder, buildBaselineFixture, snapshot, readBaseline, BUFFERS, CORE_PATH
} = require('./geobuilder-fixture.js');

const { GeoBuilder, EDGE_COL, C } = loadGeoBuilder(fs.readFileSync(CORE_PATH, 'utf8'));

const RED = { r: 1, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 1 };
const GREY = { r: 0.5, g: 0.5, b: 0.5 };

/* The builder runs in a vm realm, so everything it hands back has to be
   copied into host arrays before deepEqual will look at it. */
const at = (buf, i, n) => Array.from(buf).slice(i, i + n);
const verts = B => {
  const out = [];
  for (let i = 0; i < B.pos.length; i += 3) {
    out.push({ p: at(B.pos, i, 3), n: at(B.nrm, i, 3), c: at(B.col, i, 3) });
  }
  return out;
};
const lines = B => {
  const out = [];
  for (let i = 0; i < B.epos.length; i += 6) out.push([at(B.epos, i, 3), at(B.epos, i + 3, 3)]);
  return out;
};
const bufs = B => {
  const out = {};
  for (const key of BUFFERS) out[key] = Array.from(B[key]);
  return out;
};
const lengthOf = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

test('quad/tri/edge/box emit byte-for-byte what they emitted before', () => {
  const got = snapshot(buildBaselineFixture(GeoBuilder, C));
  const want = readBaseline();
  for (const key of ['pos', 'nrm', 'col', 'epos', 'ecol']) {
    assert.equal(got[key].length, want[key].length, `${key} changed length`);
    for (let i = 0; i < want[key].length; i++) {
      assert.ok(Object.is(got[key][i], want[key][i]),
        `${key}[${i}] is ${got[key][i]}, baseline says ${want[key][i]}`);
    }
  }
});

test('a single-colour quad is still flat, and the array path is opt-in', () => {
  const flat = new GeoBuilder();
  flat.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], RED);
  for (const v of verts(flat)) assert.deepEqual(v.c, [1, 0, 0]);

  // four identical corner colours must reproduce the flat buffers exactly
  const asArray = new GeoBuilder();
  asArray.quad([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [RED, RED, RED, RED]);
  assert.deepEqual(bufs(asArray), bufs(flat));
});

test('per-corner colours land on the right corners and share the seam', () => {
  const B = new GeoBuilder();
  const a = [0, 0, 0], b = [1, 0, 0], c = [1, 1, 0], d = [0, 1, 0];
  B.quad(a, b, c, d, [RED, BLUE, GREY, RED], true);
  const v = verts(B);
  assert.equal(v.length, 6);
  // triangle 1 is a,b,c and triangle 2 is a,c,d — the shared corners must
  // carry the same colour in both or the gradient creases along the seam
  assert.deepEqual(v.map(x => x.c), [
    [1, 0, 0], [0, 0, 1], [0.5, 0.5, 0.5],
    [1, 0, 0], [0.5, 0.5, 0.5], [1, 0, 0]
  ]);
  // one flat normal for the whole face, exactly as before
  for (const x of v) assert.deepEqual(x.n, [0, 0, 1]);
});

test('tri() reuses its third colour for the collapsed fourth corner', () => {
  const B = new GeoBuilder();
  B.tri([0, 0, 0], [1, 0, 0], [0, 1, 0], [RED, BLUE, GREY]);
  const v = verts(B);
  assert.deepEqual(v.slice(0, 3).map(x => x.c), [[1, 0, 0], [0, 0, 1], [0.5, 0.5, 0.5]]);
  // the degenerate second triangle takes a, c, c
  assert.deepEqual(v.slice(3).map(x => x.c), [[1, 0, 0], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);
});

test('an unrotated prism is exactly a box', () => {
  const opt = { top: RED, side: BLUE, bottom: GREY };
  const a = new GeoBuilder(); a.box([-1, 0, -2], [1, 3, 2], RED, opt);
  const b = new GeoBuilder(); b.prism([-1, 0, -2], [1, 3, 2], RED, opt);
  assert.deepEqual(bufs(b), bufs(a));
});

test('rotation is rigid: same edge lengths, normals still unit and outward', () => {
  const min = [-1, -0.5, -2], max = [1, 0.5, 2];
  const flat = new GeoBuilder(); flat.prism(min, max, RED);
  const spun = new GeoBuilder(); spun.prism(min, max, RED, { rot: [0.3, Math.PI / 9, -0.2] });

  const a = lines(flat).map(lengthOf).sort((x, y) => x - y);
  const b = lines(spun).map(lengthOf).sort((x, y) => x - y);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, 'rotation changed an edge length');

  const centre = [0, 0, 0];
  for (const v of verts(spun)) {
    assert.ok(Math.abs(Math.hypot(...v.n) - 1) < 1e-9, 'normal is not unit length');
    // every face points away from the centre it was built around
    const d = [v.p[0] - centre[0], v.p[1] - centre[1], v.p[2] - centre[2]];
    assert.ok(d[0] * v.n[0] + d[1] * v.n[1] + d[2] * v.n[2] > 0, 'a face is wound inward');
  }
});

test('a quarter turn about Y lands on the axis-aligned box it should', () => {
  const spun = new GeoBuilder();
  spun.prism([-1, 0, -2], [1, 2, 2], RED, { rot: [0, Math.PI / 2, 0] });
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const v of verts(spun)) {
    x0 = Math.min(x0, v.p[0]); x1 = Math.max(x1, v.p[0]);
    z0 = Math.min(z0, v.p[2]); z1 = Math.max(z1, v.p[2]);
  }
  for (const [got, want] of [[x0, -2], [x1, 2], [z0, -1], [z1, 1]]) {
    assert.ok(Math.abs(got - want) < 1e-9, `expected ${want}, got ${got}`);
  }
});

test('rotation turns about the pivot, not the centre', () => {
  const B = new GeoBuilder();
  B.prism([0, 0, -1], [4, 1, 1], RED, { rot: [0, Math.PI, 0], pivot: [0, 0, 0] });
  let x0 = Infinity, x1 = -Infinity;
  for (const v of verts(B)) { x0 = Math.min(x0, v.p[0]); x1 = Math.max(x1, v.p[0]); }
  assert.ok(Math.abs(x0 - -4) < 1e-9 && Math.abs(x1 - 0) < 1e-9, `swept to ${x0}..${x1}`);
});

test('a taper shrinks one end and leaves the other alone', () => {
  const B = new GeoBuilder();
  B.prism([-1, 0, -1], [1, 4, 1], RED, { taper: 0.25 });
  const wide = verts(B).filter(v => Math.abs(v.p[1]) < 1e-9);
  const narrow = verts(B).filter(v => Math.abs(v.p[1] - 4) < 1e-9);
  assert.ok(wide.length && narrow.length);
  for (const v of wide) assert.ok(Math.abs(Math.abs(v.p[0]) - 1) < 1e-9 && Math.abs(Math.abs(v.p[2]) - 1) < 1e-9);
  for (const v of narrow) assert.ok(Math.abs(Math.abs(v.p[0]) - 0.25) < 1e-9 && Math.abs(Math.abs(v.p[2]) - 0.25) < 1e-9);
});

test('taperEnd:min and a non-uniform taper down another axis', () => {
  const B = new GeoBuilder();
  // taper along Z, shrink the -Z end, X to a tenth and Y untouched
  B.prism([-1, -1, 0], [1, 1, 5], RED, { taperAxis: 'z', taperEnd: 'min', taper: [0.1, 1] });
  const tip = verts(B).filter(v => Math.abs(v.p[2]) < 1e-9);
  const base = verts(B).filter(v => Math.abs(v.p[2] - 5) < 1e-9);
  assert.ok(tip.length && base.length);
  for (const v of tip) assert.ok(Math.abs(Math.abs(v.p[0]) - 0.1) < 1e-9 && Math.abs(Math.abs(v.p[1]) - 1) < 1e-9);
  for (const v of base) assert.ok(Math.abs(Math.abs(v.p[0]) - 1) < 1e-9);
});

test('taper 0 makes a cone: no zero-area faces, no zero-length ink', () => {
  const B = new GeoBuilder();
  B.prism([-1, 0, -1], [1, 3, 1], RED, { taper: 0 });
  const apex = verts(B).filter(v => Math.abs(v.p[1] - 3) < 1e-9);
  for (const v of apex) assert.ok(Math.hypot(v.p[0], v.p[2]) < 1e-9, 'the tip did not collapse to a point');
  for (const v of verts(B)) assert.ok(Math.abs(Math.hypot(...v.n) - 1) < 1e-9, 'a face has no area');
  for (const l of lines(B)) assert.ok(lengthOf(l) > 1e-9, 'a zero-length ink line reached the line buffer');
});

test('new solids ink themselves into the same line buffer as everything else', () => {
  const B = new GeoBuilder();
  B.prism([-1, 0, -1], [1, 1, 1], RED, { rot: [0, 0.4, 0] });
  assert.equal(B.epos.length / 6, 24, 'a six-faced solid should ink four edges per face');
  for (let i = 0; i < B.ecol.length; i += 3) {
    assert.deepEqual(at(B.ecol, i, 3), [EDGE_COL.r, EDGE_COL.g, EDGE_COL.b]);
  }
  const silent = new GeoBuilder();
  silent.prism([-1, 0, -1], [1, 1, 1], RED, { rot: [0, 0.4, 0], noEdge: true });
  assert.equal(silent.epos.length, 0);
});

test('skip drops the same faces on a prism as it does on a box', () => {
  const B = new GeoBuilder();
  B.prism([-1, 0, -1], [1, 1, 1], RED, { skip: { py: true, ny: true } });
  assert.equal(B.pos.length / 9, 8, 'four side faces, two triangles each');
});

test('a gradient ramps across the solid and reaches both ends', () => {
  const B = new GeoBuilder();
  B.prism([-1, 0, -1], [1, 4, 1], RED, { gradient: { axis: 'y', from: RED, to: BLUE } });
  const bottom = verts(B).filter(v => Math.abs(v.p[1]) < 1e-9);
  const top = verts(B).filter(v => Math.abs(v.p[1] - 4) < 1e-9);
  for (const v of bottom) assert.deepEqual(v.c, [1, 0, 0]);
  for (const v of top) assert.deepEqual(v.c, [0, 0, 1]);
  // and the middle of a side face genuinely blends rather than banding
  const mid = verts(B).filter(v => v.p[1] > 0 && v.p[1] < 4);
  assert.equal(mid.length, 0, 'a box has no vertices between its ends');
  const tall = new GeoBuilder();
  tall.prism([-1, 0, -1], [1, 4, 1], RED, { gradient: { axis: 'y', from: RED, to: BLUE, min: 0, max: 8 } });
  const half = verts(tall).filter(v => Math.abs(v.p[1] - 4) < 1e-9)[0];
  assert.deepEqual(half.c, [0.5, 0, 0.5]);
});

test('solid() takes eight arbitrary corners and keeps box winding', () => {
  const B = new GeoBuilder();
  // a sheared cube: the top face slid +x by one unit
  const v = [];
  for (let i = 0; i < 8; i++) {
    v.push([((i & 1) ? 1 : -1) + ((i & 2) ? 1 : 0), (i & 2) ? 1 : -1, (i & 4) ? 1 : -1]);
  }
  B.solid(v, RED);
  const top = verts(B).filter(x => Math.abs(x.p[1] - 1) < 1e-9);
  assert.ok(top.length >= 6);
  const up = top.find(x => x.n[1] > 0.9);
  assert.ok(up, 'the top face still points up after a shear');
  assert.equal(B.epos.length / 6, 24);
});
