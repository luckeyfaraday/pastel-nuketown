'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('./bots.js');
const MAP = require('./mapspec.js');

const nav = AI.buildNav(MAP);

function makeRng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function baseSelf(overrides) {
  return Object.assign({
    id: 1,
    pos: { x: 0, y: 0, z: 8 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    health: 100,
    maxHealth: 100,
    ammo: 30,
    magSize: 30,
    reserve: 90,
    onGround: true,
    reloading: false
  }, overrides || {});
}

function actor(id, x, y, z) {
  return {
    id,
    pos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    health: 100,
    alive: true,
    isPlayer: false
  };
}

function viewAt(time, self, actors, canSee, rng) {
  return {
    time,
    nav,
    rng: rng || makeRng(17),
    self,
    actors: actors || [],
    canSee: canSee || (() => true)
  };
}

test('nav grid has a plausible fraction and every ground cell is spawn-reachable', () => {
  const totalGroundCells = nav.width * nav.height;
  const ground = nav.nodes.filter((node) => node.level === 0);
  const fraction = ground.length / totalGroundCells;
  assert.ok(fraction > 0.55 && fraction < 0.96, `ground walkable fraction ${fraction}`);

  const queue = [];
  const seen = new Uint8Array(nav.nodes.length);
  for (const spawn of MAP.spawns) {
    const id = nav.nearest(spawn.x, spawn.y, spawn.z);
    if (!seen[id]) {
      seen[id] = 1;
      queue.push(id);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    for (const edge of nav.nodes[queue[head]].edges) {
      if (!seen[edge.to]) {
        seen[edge.to] = 1;
        queue.push(edge.to);
      }
    }
  }
  for (const node of ground) assert.equal(seen[node.id], 1, `unreachable ground node ${node.id}`);
});

test('upper floors are reachable from ground through two-way stair edges', () => {
  const stairEdges = [];
  for (const node of nav.nodes) {
    for (const edge of node.edges) {
      if (edge.type === 'stair') stairEdges.push([node.id, edge.to]);
    }
  }
  assert.ok(stairEdges.length >= MAP.links.length * 2);
  for (const [from, to] of stairEdges) {
    const reverse = nav.nodes[to].edges.find((edge) => edge.to === from && edge.type === 'stair');
    assert.ok(reverse, `stair ${from}->${to} is not two-way`);
  }
  const spawn = MAP.spawns[0];
  const start = nav.nearest(spawn.x, spawn.y, spawn.z);
  const upper = nav.nodes.find((node) => node.level === 1);
  const path = nav.findPath(start, upper.id, 2400);
  assert.equal(path.at(-1).nodeId, upper.id);
  assert.ok(path.some((waypoint) => waypoint.via === 'stair'));
});

test('A* crosses the map and every smoothed waypoint segment is traversable', () => {
  const a = MAP.spawns[0];
  let b = MAP.spawns[0];
  for (const spawn of MAP.spawns) {
    if (Math.hypot(spawn.x - a.x, spawn.z - a.z) >
        Math.hypot(b.x - a.x, b.z - a.z)) b = spawn;
  }
  const start = nav.nearest(a.x, a.y, a.z);
  const goal = nav.nearest(b.x, b.y, b.z);
  const path = nav.findPath(start, goal, 2400);
  assert.equal(path[0].nodeId, start);
  assert.equal(path.at(-1).nodeId, goal);
  assert.ok(path.length >= 2);
  for (let i = 1; i < path.length; i++) {
    assert.ok(nav.isSegmentTraversable(path[i - 1], path[i]),
      `untraversable segment ${path[i - 1].nodeId}->${path[i].nodeId}`);
  }
});

test('drop-down edges exist and never create an implicit upward reverse edge', () => {
  const drops = [];
  for (const node of nav.nodes) {
    for (const edge of node.edges) {
      if (edge.type === 'drop') drops.push([node, nav.nodes[edge.to]]);
    }
  }
  assert.ok(drops.length > 0);
  for (const [upper, lower] of drops) {
    assert.ok(upper.y > lower.y);
    const reverseDrop = lower.edges.find((edge) => edge.to === upper.id && edge.type === 'drop');
    assert.equal(reverseDrop, undefined);
    const illegalWalk = lower.edges.find((edge) => edge.to === upper.id && edge.type === 'walk');
    assert.equal(illegalWalk, undefined);
  }
});

test('target hysteresis does not flip-flop under a jittering distance tie', () => {
  const brain = AI.createBrain({ id: 1, seed: 7, skill: 'hard' });
  const self = baseSelf({ pos: { x: 0, y: 0, z: 0 } });
  const rng = makeRng(5);
  let firstTarget = null;
  for (let i = 0; i < 80; i++) {
    const jitter = i % 2 ? 0.08 : -0.08;
    const actors = [
      actor(2, 10 + jitter, 0, 0),
      actor(3, 10 - jitter, 0, 0.05)
    ];
    const intent = AI.think(brain, viewAt(i * 0.04, self, actors, () => true, rng), 0.04);
    if (intent.targetId != null && firstTarget == null) firstTarget = intent.targetId;
    if (firstTarget != null) assert.equal(intent.targetId, firstTarget);
  }
  assert.notEqual(firstTarget, null);
});

test('a bot at ten percent health retreats from a visible threat', () => {
  const brain = AI.createBrain({ id: 4, seed: 11, skill: 'normal' });
  const self = baseSelf({
    id: 4,
    health: 10,
    pos: { x: 0, y: 0, z: 8 }
  });
  const intent = AI.think(brain, viewAt(1, self, [actor(8, 0, 0, 1)], () => true), 1 / 60);
  assert.equal(intent.state, 'retreat');
  assert.equal(intent.targetId, 8);
});

test('fire is never requested when line of sight is false', () => {
  const brain = AI.createBrain({ id: 5, seed: 99, skill: 'hard' });
  const self = baseSelf({ id: 5, pos: { x: 0, y: 0, z: 0 }, yaw: 0 });
  const enemy = actor(6, 8, 0, 0);
  for (let i = 0; i < 240; i++) {
    const intent = AI.think(brain, viewAt(i / 60, self, [enemy], () => false), 1 / 60);
    assert.equal(intent.fire, false);
  }
});

test('randomized views never produce non-finite intent numbers', () => {
  const brain = AI.createBrain({ id: 21, seed: 1234, skill: 'easy' });
  const rng = makeRng(123);
  for (let i = 0; i < 1200; i++) {
    const px = MAP.bounds.minX - 4 + rng() * (MAP.bounds.maxX - MAP.bounds.minX + 8);
    const pz = MAP.bounds.minZ - 4 + rng() * (MAP.bounds.maxZ - MAP.bounds.minZ + 8);
    const self = baseSelf({
      id: 21,
      pos: { x: px, y: rng() < 0.15 ? 2.1 : (rng() < 0.2 ? 3.3 : 0), z: pz },
      vel: { x: rng() * 8 - 4, y: 0, z: rng() * 8 - 4 },
      yaw: rng() * Math.PI * 2 - Math.PI,
      pitch: rng() - 0.5,
      health: rng() * 100,
      ammo: Math.floor(rng() * 31),
      reserve: Math.floor(rng() * 91)
    });
    const others = [];
    const count = Math.floor(rng() * 6);
    for (let j = 0; j < count; j++) {
      const other = actor(100 + j, rng() * 50 - 25, rng() < 0.2 ? 3.3 : 0, rng() * 34 - 17);
      other.alive = rng() > 0.1;
      other.health = rng() * 100;
      other.vel.x = rng() * 6 - 3;
      other.vel.z = rng() * 6 - 3;
      others.push(other);
    }
    const intent = AI.think(brain, viewAt(i / 30, self, others, () => rng() > 0.35, rng),
      i % 77 === 0 ? 0.25 : 1 / 30);
    for (const key of ['moveX', 'moveZ', 'aimYaw', 'aimPitch']) {
      assert.ok(Number.isFinite(intent[key]), `${key} was ${intent[key]} at iteration ${i}`);
    }
    assert.ok(intent.moveX >= -1 && intent.moveX <= 1);
    assert.ok(intent.moveZ >= -1 && intent.moveZ <= 1);
    assert.ok(intent.aimPitch >= -1.5 && intent.aimPitch <= 1.5);
  }
});

test('think tolerates empty actors, dt spikes, dead targets, and off-grid positions', () => {
  const brain = AI.createBrain({ id: 31, seed: 1, skill: 'normal' });
  const rng = makeRng(2);
  const outside = baseSelf({
    id: 31,
    pos: { x: 999, y: 1.7, z: -999 },
    vel: { x: 0, y: 0, z: 0 }
  });
  const frozenView = Object.freeze(viewAt(0, Object.freeze(outside), [], () => false, rng));
  assert.doesNotThrow(() => AI.think(brain, frozenView, 0.25));
  const dead = actor(55, 0, 0, 0);
  dead.alive = false;
  dead.health = 0;
  const intent = AI.think(brain, viewAt(0.25, outside, [dead], () => true, rng), NaN);
  assert.equal(intent.targetId, null);
  assert.equal(intent.fire, false);

  const missingPos = Object.freeze(baseSelf({ id: 31, pos: undefined }));
  const degenerate = Object.freeze(viewAt(0.5, missingPos, [], null, rng));
  assert.doesNotThrow(() => AI.think(brain, degenerate, Infinity));
});
