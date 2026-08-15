'use strict';

/* Terminal is authored by hand as a list of AABBs, so the failures worth
   guarding are geometric, not logical: a spawn buried in a wall, a platform
   that no level supports, a lane the nav graph cannot reach. All of those
   look fine in the source and are only visible once you are standing in it. */

const test = require('node:test');
const assert = require('node:assert');

const NUKETOWN = require('./mapspec.js');
const TERMINAL = require('./terminal-mapspec.js');
const AI = require('./bots.js');

const F1 = 3.3;

function insideSolid(x, y, z, radius, height, solid) {
  const [sx0, sy0, sz0] = solid.min, [sx1, sy1, sz1] = solid.max;
  if (y + height <= sy0 || y >= sy1) return false;
  const nx = Math.max(sx0, Math.min(x, sx1));
  const nz = Math.max(sz0, Math.min(z, sz1));
  return (x - nx) * (x - nx) + (z - nz) * (z - nz) < radius * radius;
}

test('terminal exposes the same contract as nuketown', () => {
  for (const key of ['solids', 'platforms', 'links', 'spawns', 'bounds', 'levels', 'consts', 'actor'])
    assert.ok(key in TERMINAL, 'missing ' + key);
  // The collision cylinder is shared engine-wide; a map may not redefine it.
  assert.deepStrictEqual(TERMINAL.actor, NUKETOWN.actor);
  assert.deepStrictEqual(TERMINAL.levels, [0, F1]);
});

test('every solid is a well-formed, non-inverted box', () => {
  for (const s of TERMINAL.solids) {
    assert.ok(Array.isArray(s.min) && Array.isArray(s.max), 'solid needs min/max');
    for (let i = 0; i < 3; i++) {
      assert.ok(Number.isFinite(s.min[i]) && Number.isFinite(s.max[i]),
        'non-finite bound in ' + s.mat);
      assert.ok(s.max[i] > s.min[i],
        'inverted or zero-thickness axis ' + i + ' in ' + s.mat + ' ' + JSON.stringify(s.min));
    }
  }
});

test('no spawn is buried in geometry', () => {
  const { radius, height } = TERMINAL.actor;
  for (const sp of TERMINAL.spawns) {
    for (const solid of TERMINAL.solids) {
      assert.ok(!insideSolid(sp.x, sp.y, sp.z, radius, height, solid),
        'spawn ' + JSON.stringify([sp.x, sp.y, sp.z]) +
        ' is inside a ' + solid.mat + ' at ' + JSON.stringify(solid.min));
    }
  }
});

test('every spawn is inside the play bounds', () => {
  const b = TERMINAL.bounds;
  for (const sp of TERMINAL.spawns) {
    assert.ok(sp.x > b.minX && sp.x < b.maxX, 'spawn x out of bounds: ' + sp.x);
    assert.ok(sp.z > b.minZ && sp.z < b.maxZ, 'spawn z out of bounds: ' + sp.z);
  }
});

test('every platform sits on a declared nav level', () => {
  for (const p of TERMINAL.platforms) {
    const near = TERMINAL.levels.some(y => Math.abs(p.y - y) <= 0.08);
    assert.ok(near, 'platform at y=' + p.y + ' matches no level; bots.js ' +
      'supported() uses a 0.08 tolerance, so this surface is invisible to nav');
  }
});

test('a full container stack tops out exactly on the upper level', () => {
  // The whole two-level design rests on this number. If CONT drifts, the
  // container tops silently drop out of the nav graph.
  assert.strictEqual(Number((TERMINAL.consts.CONT * 3).toFixed(6)), F1);
});

test('nav builds and stays within budget of nuketown', () => {
  const nav = AI.buildNav(TERMINAL);
  assert.ok(nav.nodes.length > 0, 'nav produced no nodes');
  const base = AI.buildNav(NUKETOWN);
  const ratio = nav.nodes.length / base.nodes.length;
  // Two levels, ~1.7x the floor area. Anything near 3x means a third level
  // crept in and the phone build will feel it.
  assert.ok(ratio < 2.4, 'nav grew ' + ratio.toFixed(2) + 'x over nuketown');
});

test('every spawn lands on the nav graph', () => {
  const nav = AI.buildNav(TERMINAL);
  for (const sp of TERMINAL.spawns) {
    const id = nav.nearest(sp.x, sp.y, sp.z);
    assert.ok(id >= 0, 'no nav node near spawn ' + JSON.stringify([sp.x, sp.y, sp.z]));
    const node = nav.nodes[id];
    const d = Math.hypot(node.x - sp.x, node.z - sp.z);
    assert.ok(d < 2.0, 'nearest nav node is ' + d.toFixed(2) + 'm from spawn ' +
      JSON.stringify([sp.x, sp.y, sp.z]) + ' — spawn is probably walled in');
    assert.ok(Math.abs(node.y - sp.y) < 0.5,
      'spawn at y=' + sp.y + ' snapped to a node at y=' + node.y);
  }
});

/* nav.findPath() snaps its target to the nearest node, so it returns a path
   for a destination that is unreachable or not even on the map. It cannot be
   used to prove connectivity. Walk the edge graph directly instead. */
function reachableSet(nav, from) {
  const start = nav.nearest(from.x, from.y, from.z);
  const seen = new Uint8Array(nav.nodes.length);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const node = nav.nodes[queue.pop()];
    for (const edge of node.edges) {
      if (!seen[edge.to]) { seen[edge.to] = 1; queue.push(edge.to); }
    }
  }
  return seen;
}

const ZONES = {
  security:  n => n.level === 0 && n.x < -24 && n.z < -9,
  shopping:  n => n.level === 0 && n.x >= -24 && n.x < 6 && n.z < -9,
  lounge:    n => n.level === 0 && n.x >= 6 && n.z < -9,
  apron:     n => n.level === 0 && n.z > -2,
  mezzanine: n => n.level === 1 && n.z < -9,
  jetbridge: n => n.level === 1 && n.x > 13 && n.x < 19 && n.z > -9 && n.z < 10,
  cabin:     n => n.level === 1 && n.x > -6 && n.x < 22 && n.z > 9.8 && n.z < 14.2,
  portwing:  n => n.level === 1 && n.x > 2 && n.x < 10 && n.z > 2 && n.z < 9.8,
  stbdwing:  n => n.level === 1 && n.x > 2 && n.x < 10 && n.z > 14.2 && n.z < 21,
  shedroof:  n => n.level === 1 && n.x > 24 && n.x < 32 && n.z > -6 && n.z < 1
};

test('every named zone exists on the nav graph', () => {
  const nav = AI.buildNav(TERMINAL);
  for (const [name, pred] of Object.entries(ZONES)) {
    const count = nav.nodes.filter(pred).length;
    assert.ok(count >= 20, 'zone "' + name + '" has only ' + count + ' nav nodes');
  }
});

test('no zone is orphaned from the spawn graph', () => {
  // The failure this catches is a surface that exists, looks walkable, and
  // that nothing can actually get to — an island. It is invisible in source.
  const nav = AI.buildNav(TERMINAL);
  const seen = reachableSet(nav, TERMINAL.spawns[0]);
  const bad = [];
  for (const [name, pred] of Object.entries(ZONES)) {
    const zone = nav.nodes.filter(pred);
    const share = zone.filter(n => seen[n.id]).length / zone.length;
    if (share < 0.85) bad.push(name + ' ' + (share * 100).toFixed(0) + '%');
  }
  assert.deepStrictEqual(bad, [], 'zones cut off from the rest of the map: ' + bad.join(', '));
});

test('every spawn reaches every other spawn', () => {
  const nav = AI.buildNav(TERMINAL);
  const seen = reachableSet(nav, TERMINAL.spawns[0]);
  for (const sp of TERMINAL.spawns) {
    const id = nav.nearest(sp.x, sp.y, sp.z);
    assert.ok(seen[id], 'spawn ' + JSON.stringify([sp.x, sp.y, sp.z]) +
      ' is in a disconnected component');
  }
});

test('the map is one connected space', () => {
  const nav = AI.buildNav(TERMINAL);
  const seen = reachableSet(nav, TERMINAL.spawns[0]);
  let reached = 0;
  for (let i = 0; i < seen.length; i++) reached += seen[i];
  const share = reached / nav.nodes.length;
  assert.ok(share > 0.97, 'only ' + (share * 100).toFixed(1) +
    '% of nav nodes are reachable from spawn 0');
});

test('every climb is short enough to actually jump', () => {
  /* JUMP_V 8.4 against GRAVITY 26 gives an apex of 1.357m, and step-up only
     assists while grounded. Any single riser taller than that is a wall the
     map is pretending is a route. */
  const apex = (8.4 * 8.4) / (2 * 26.0);
  assert.ok(TERMINAL.consts.CONT < apex,
    'container height ' + TERMINAL.consts.CONT + ' exceeds the jump apex ' +
    apex.toFixed(3) + ' — the stacks are unclimbable');
  assert.strictEqual(Number((TERMINAL.consts.CONT * 3).toFixed(6)), F1);
});
