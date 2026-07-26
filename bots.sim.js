'use strict';

const { performance } = require('node:perf_hooks');
const AI = require('./bots.js');
const MAP = require('./mapspec.js');

const DT = 1 / 60;
const DURATION = 90;
const BOT_COUNT = 9;
const SPEED = 4.8;
const MOVING = new Set(['patrol', 'hunt', 'engage', 'reposition', 'retreat']);
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

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

function circleHitsBox(x, z, radius, solid) {
  const cx = clamp(x, solid.min[0], solid.max[0]);
  const cz = clamp(z, solid.min[2], solid.max[2]);
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < radius * radius - 1e-8;
}

function canOccupy(x, z, y, options) {
  if (x < MAP.bounds.minX + MAP.actor.radius || x > MAP.bounds.maxX - MAP.actor.radius ||
      z < MAP.bounds.minZ + MAP.actor.radius || z > MAP.bounds.maxZ - MAP.actor.radius) {
    return false;
  }
  const top = y + MAP.actor.height;
  for (const solid of MAP.solids) {
    if (solid.max[1] <= y + 0.02 || solid.min[1] >= top - 0.02) continue;
    if (options.stair && (solid.mat === 'stair' || solid.mat === 'slab')) continue;
    if (options.vault && (solid.mat === 'rail' || solid.mat === 'picket')) continue;
    if (circleHitsBox(x, z, MAP.actor.radius, solid)) return false;
  }
  return true;
}

function segmentIntersectsBox(a, b, solid) {
  let lo = 0;
  let hi = 1;
  const mins = solid.min;
  const maxs = solid.max;
  const av = [a.x, a.y, a.z];
  const bv = [b.x, b.y, b.z];
  for (let axis = 0; axis < 3; axis++) {
    const delta = bv[axis] - av[axis];
    if (Math.abs(delta) < 1e-10) {
      if (av[axis] < mins[axis] || av[axis] > maxs[axis]) return false;
      continue;
    }
    let t0 = (mins[axis] - av[axis]) / delta;
    let t1 = (maxs[axis] - av[axis]) / delta;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
    if (lo > hi) return false;
  }
  return hi > 0.002 && lo < 0.998;
}

function mapCanSee(ax, ay, az, bx, by, bz) {
  const a = { x: ax, y: ay, z: az };
  const b = { x: bx, y: by, z: bz };
  for (const solid of MAP.solids) {
    if (segmentIntersectsBox(a, b, solid)) return false;
  }
  return true;
}

function platformSupport(x, z) {
  for (const platform of MAP.platforms) {
    if (Math.abs(platform.y - MAP.levels[1]) > 0.05) continue;
    if (x >= platform.min[0] && x <= platform.max[0] &&
        z >= platform.min[1] && z <= platform.max[1]) return platform.y;
  }
  return null;
}

function stairFloor(x, z) {
  let best = null;
  let bestDistance = Infinity;
  for (const link of MAP.links) {
    const ax = link.a[0];
    const az = link.a[2];
    const bx = link.b[0];
    const bz = link.b[2];
    const dx = bx - ax;
    const dz = bz - az;
    const lengthSq = dx * dx + dz * dz;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / lengthSq, 0, 1);
    const px = ax + dx * t;
    const pz = az + dz * t;
    const distance = Math.hypot(x - px, z - pz);
    if (distance <= link.w * 0.5 + MAP.actor.radius && distance < bestDistance) {
      bestDistance = distance;
      best = link.a[1] + (link.b[1] - link.a[1]) * t;
    }
  }
  return best;
}

function spawnBot(index) {
  const spawn = MAP.spawns[(index * 3) % MAP.spawns.length];
  const skill = ['easy', 'normal', 'hard'][index % 3];
  return {
    id: index + 1,
    brain: AI.createBrain({ id: index + 1, seed: 1009 + index * 7919, skill }),
    rng: makeRng(0xabc123 + index * 65537),
    skill,
    pos: { x: spawn.x, y: spawn.y, z: spawn.z },
    vel: { x: 0, y: 0, z: 0 },
    yaw: spawn.yaw,
    pitch: 0,
    health: 100,
    alive: true,
    ammo: 30,
    magSize: 30,
    reserve: 120,
    reloading: false,
    reloadDone: 0,
    nextShot: 0,
    respawnAt: 0,
    kills: 0,
    deaths: 0,
    stateChanges: 0,
    lastState: 'spawn',
    states: new Set(['spawn']),
    floors: new Set([0]),
    maxY: 0,
    travel: 0,
    movingSince: null,
    movingTravel: 0,
    stuckFailures: 0,
    lastIntent: null
  };
}

function actorView(bot) {
  return {
    id: bot.id,
    pos: { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z },
    vel: { x: bot.vel.x, y: bot.vel.y, z: bot.vel.z },
    health: bot.health,
    alive: bot.alive,
    isPlayer: false
  };
}

function selfView(bot) {
  return {
    id: bot.id,
    pos: { x: bot.pos.x, y: bot.pos.y, z: bot.pos.z },
    vel: { x: bot.vel.x, y: bot.vel.y, z: bot.vel.z },
    yaw: bot.yaw,
    pitch: bot.pitch,
    health: bot.health,
    maxHealth: 100,
    ammo: bot.ammo,
    magSize: bot.magSize,
    reserve: bot.reserve,
    onGround: bot.pos.y <= 0.01 || Math.abs(bot.pos.y - MAP.levels[1]) < 0.05,
    reloading: bot.reloading
  };
}

function respawn(bot, time) {
  const spawn = MAP.spawns[(bot.id * 5 + bot.deaths * 3) % MAP.spawns.length];
  bot.pos.x = spawn.x;
  bot.pos.y = 0;
  bot.pos.z = spawn.z;
  bot.vel.x = 0;
  bot.vel.y = 0;
  bot.vel.z = 0;
  bot.yaw = spawn.yaw;
  bot.pitch = 0;
  bot.health = 100;
  bot.alive = true;
  bot.ammo = bot.magSize;
  bot.reserve = 120;
  bot.reloading = false;
  bot.reloadDone = 0;
  bot.nextShot = time + 0.3;
  bot.brain = AI.createBrain({
    id: bot.id,
    seed: 1009 + bot.id * 7919 + bot.deaths * 104729,
    skill: bot.skill
  });
}

function applyMovement(bot, intent) {
  let mx = intent.moveX;
  let mz = intent.moveZ;
  const length = Math.hypot(mx, mz);
  if (length > 1) {
    mx /= length;
    mz /= length;
  }
  const oldX = bot.pos.x;
  const oldY = bot.pos.y;
  const oldZ = bot.pos.z;
  const pathWaypoint = bot.brain.path && bot.brain.path[bot.brain.pathIndex];
  const currentStairFloor = stairFloor(oldX, oldZ);
  const onStairPath = (!!pathWaypoint && pathWaypoint.via === 'stair') ||
    currentStairFloor != null;
  const vaulting = intent.jump && oldY > 2.2;
  const options = {
    stair: onStairPath || (oldY > 0.02 && oldY < MAP.levels[1] - 0.02),
    vault: vaulting
  };
  const nextX = oldX + mx * SPEED * DT;
  const nextZ = oldZ + mz * SPEED * DT;

  let resolvedX = oldX;
  let resolvedZ = oldZ;
  if (canOccupy(nextX, nextZ, oldY, options)) {
    resolvedX = nextX;
    resolvedZ = nextZ;
  } else {
    if (canOccupy(nextX, oldZ, oldY, options)) resolvedX = nextX;
    if (canOccupy(resolvedX, nextZ, oldY, options)) resolvedZ = nextZ;
  }
  bot.pos.x = resolvedX;
  bot.pos.z = resolvedZ;

  if (onStairPath) {
    const floor = stairFloor(bot.pos.x, bot.pos.z);
    if (floor != null) {
      bot.pos.y = floor;
      bot.vel.y = 0;
    } else if (pathWaypoint && pathWaypoint.y > 2) {
      bot.pos.y = Math.min(MAP.levels[1], bot.pos.y + 3.0 * DT);
    } else {
      bot.pos.y = Math.max(0, bot.pos.y - 3.0 * DT);
    }
  } else {
    const support = platformSupport(bot.pos.x, bot.pos.z);
    if (support != null && bot.pos.y > 2.35 && bot.vel.y <= 0) {
      bot.pos.y = support;
      bot.vel.y = 0;
    } else if (bot.pos.y > 0.001) {
      bot.vel.y -= 14 * DT;
      bot.pos.y = Math.max(0, bot.pos.y + bot.vel.y * DT);
      if (bot.pos.y === 0) bot.vel.y = 0;
    } else {
      bot.pos.y = 0;
      bot.vel.y = 0;
    }
  }

  bot.vel.x = (bot.pos.x - oldX) / DT;
  bot.vel.z = (bot.pos.z - oldZ) / DT;
  const travelled = Math.hypot(bot.pos.x - oldX, bot.pos.y - oldY, bot.pos.z - oldZ);
  bot.travel += travelled;
  bot.yaw = intent.aimYaw;
  bot.pitch = intent.aimPitch;
  return travelled;
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) * 0.5;
}

const bots = Array.from({ length: BOT_COUNT }, (_, index) => spawnBot(index));
const thinkTimesUs = [];
let nonFiniteFailures = 0;
let totalKills = 0;
const simStarted = performance.now();

for (let frame = 0; frame < DURATION / DT; frame++) {
  const time = frame * DT;

  for (const bot of bots) {
    if (!bot.alive && time >= bot.respawnAt) respawn(bot, time);
    if (bot.reloading && time >= bot.reloadDone) {
      const needed = bot.magSize - bot.ammo;
      const loaded = Math.min(needed, bot.reserve);
      bot.ammo += loaded;
      bot.reserve -= loaded;
      bot.reloading = false;
    }
  }

  const intents = new Map();
  for (const bot of bots) {
    if (!bot.alive) continue;
    const actors = bots.filter((other) => other !== bot).map(actorView);
    const view = {
      time,
      nav,
      rng: bot.rng,
      self: selfView(bot),
      actors,
      canSee: mapCanSee
    };
    const began = performance.now();
    const intent = AI.think(bot.brain, view, DT);
    thinkTimesUs.push((performance.now() - began) * 1000);
    intents.set(bot.id, intent);

    if (![intent.moveX, intent.moveZ, intent.aimYaw, intent.aimPitch].every(Number.isFinite)) {
      nonFiniteFailures++;
    }
    if (intent.state !== bot.lastState) {
      bot.stateChanges++;
      bot.lastState = intent.state;
    }
    bot.states.add(intent.state);
    bot.lastIntent = intent;
  }

  for (const bot of bots) {
    if (!bot.alive) continue;
    const intent = intents.get(bot.id);
    const travelled = applyMovement(bot, intent);
    bot.maxY = Math.max(bot.maxY, bot.pos.y);
    bot.floors.add(bot.pos.y > 2.5 ? 1 : 0);

    if (MOVING.has(intent.state)) {
      if (bot.movingSince == null) {
        bot.movingSince = time;
        bot.movingTravel = 0;
      }
      bot.movingTravel += travelled;
      if (time - bot.movingSince >= 4) {
        if (bot.movingTravel < 0.35) bot.stuckFailures++;
        bot.movingSince = time;
        bot.movingTravel = 0;
      }
    } else {
      bot.movingSince = null;
      bot.movingTravel = 0;
    }

    if (intent.reload && !bot.reloading && bot.reserve > 0 && bot.ammo < bot.magSize) {
      bot.reloading = true;
      bot.reloadDone = time + 1.15;
    }
  }

  for (const bot of bots) {
    if (!bot.alive || bot.reloading) continue;
    const intent = intents.get(bot.id);
    if (!intent.fire || bot.ammo <= 0 || time < bot.nextShot || intent.targetId == null) continue;
    const victim = bots.find((other) => other.id === intent.targetId && other.alive);
    if (!victim) continue;
    const visible = mapCanSee(
      bot.pos.x, bot.pos.y + MAP.actor.eye, bot.pos.z,
      victim.pos.x, victim.pos.y + MAP.actor.eye, victim.pos.z
    );
    if (!visible) continue;
    bot.nextShot = time + 0.115;
    bot.ammo--;
    victim.health -= 6;
    if (victim.health <= 0) {
      victim.health = 0;
      victim.alive = false;
      victim.deaths++;
      victim.respawnAt = time + 1.25;
      bot.kills++;
      totalKills++;
    }
  }

  for (const bot of bots) {
    if (![bot.pos.x, bot.pos.y, bot.pos.z, bot.vel.x, bot.vel.y, bot.vel.z].every(Number.isFinite)) {
      nonFiniteFailures++;
    }
  }
}

const wallMs = performance.now() - simStarted;
const failures = [];
if (nonFiniteFailures > 0) failures.push(`${nonFiniteFailures} non-finite position/intent values`);
if (totalKills <= 0) failures.push('no bot-vs-bot kills');
for (const bot of bots) {
  if (bot.stuckFailures > 0) failures.push(`bot ${bot.id} failed ${bot.stuckFailures} stuck window(s)`);
  if (bot.stateChanges < 2) failures.push(`bot ${bot.id} changed state only ${bot.stateChanges} time(s)`);
}
if (!bots.some((bot) => bot.floors.has(1))) failures.push('no bot reached an upper floor');

console.log('Nuketown AI soak summary');
console.log(`  simulated: ${DURATION}s at ${Math.round(1 / DT)} Hz, bots: ${BOT_COUNT}`);
console.log(`  bot-vs-bot kills: ${totalKills}`);
console.log(`  median think: ${median(thinkTimesUs).toFixed(3)} us/call`);
console.log(`  wall time: ${(wallMs / 1000).toFixed(3)} s`);
for (const bot of bots) {
  console.log(
    `  bot ${bot.id} ${bot.skill.padEnd(6)} kills=${bot.kills} deaths=${bot.deaths} ` +
    `changes=${bot.stateChanges} floors=${[...bot.floors].sort().join('/')} ` +
    `maxY=${bot.maxY.toFixed(2)} ` +
    `travel=${bot.travel.toFixed(1)}m states=${[...bot.states].join(',')}`
  );
}

if (failures.length) {
  console.error('SOAK FAILED');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('SOAK PASSED');
