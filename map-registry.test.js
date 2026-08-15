'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nuketown = require('./mapspec.js');
const terminal = require('./terminal-mapspec.js');
const maps = require('./map-registry.js');
const runtimeSource = fs.readFileSync('./src/35-map-runtime.js', 'utf8');

test('shared map registry exposes the rotation pool, Nuketown first', () => {
  assert.equal(maps.DEFAULT_ID, 'nuketown');
  assert.deepEqual(maps.ids(), ['nuketown', 'terminal']);
  assert.equal(maps.get('nuketown'), nuketown);
  assert.equal(maps.get('terminal'), terminal);
  assert.equal(maps.get('bogus'), null);
  assert.equal(maps.get(null), null);
});

test('the rotation is a cycle and always lands on a real map', () => {
  assert.equal(maps.nextId('nuketown'), 'terminal');
  assert.equal(maps.nextId('terminal'), 'nuketown');
  // An id nobody recognises must still yield something playable rather than
  // stalling the rotation on the map that is already loaded.
  assert.equal(maps.nextId('bogus'), 'nuketown');
  for (const id of maps.ids()) assert.ok(maps.get(maps.nextId(id)));
});

test('legacy mapspec exports and renderer extension remain compatible', () => {
  assert.equal(globalThis.NUKETOWN_MAP, nuketown);
  for (const key of ['solids', 'platforms', 'links', 'spawns', 'bounds', 'levels', 'consts', 'actor'])
    assert.ok(Object.prototype.hasOwnProperty.call(nuketown, key), key);
  assert.deepEqual(nuketown.render.chunkCuts, [-16, -5, 5, 16]);
  assert.equal(typeof nuketown.render.buildGeometry, 'function');
  assert.equal(typeof nuketown.render.buildDecorations, 'function');
});

function runtimeHarness() {
  const context = vm.createContext({});
  vm.runInContext(`
    const specs = { nuketown: { id: 'nuketown' }, terminal: { id: 'terminal' }, broken: { id: 'broken' } };
    const order = ['nuketown', 'terminal'];
    const MAPS = {
      get(id) { return specs[id] || null; },
      nextId(id) { const at = order.indexOf(id); return at === -1 ? 'nuketown' : order[(at + 1) % order.length]; }
    };
    let NET = null;
    let ACTIVE_MAP_ID = 'nuketown';
    let MAP = specs.nuketown;
    const WORLD = { group: {} };
    const events = [];
    function bindPhysicsMap(map) { events.push('bind:' + map.id); }
    function disposeWorld() { events.push('dispose'); WORLD.group = null; }
    function buildWorld() {
      events.push('build:' + MAP.id);
      if (MAP.id === 'broken') throw new Error('broken hook');
      WORLD.group = {};
    }
    function initAI() { events.push('nav:' + MAP.id); }
  ` + runtimeSource, context);
  return context;
}

test('runtime map API validates first, swaps all bindings, and is idempotent', () => {
  const context = runtimeHarness();
  assert.equal(context.setActiveMap('missing'), false);
  assert.equal(context.setActiveMap('nuketown'), true);
  assert.deepEqual(Array.from(vm.runInContext('events', context)), []);

  assert.equal(context.setActiveMap('terminal'), true);
  assert.equal(context.activeMapId(), 'terminal');
  assert.deepEqual(Array.from(vm.runInContext('events', context)),
    ['bind:terminal', 'dispose', 'build:terminal', 'nav:terminal']);
});

test('a broken registered map rolls the complete active binding back', () => {
  const context = runtimeHarness();
  assert.throws(() => context.setActiveMap('broken'), /broken hook/);
  assert.equal(context.activeMapId(), 'nuketown');
  assert.equal(vm.runInContext('MAP.id', context), 'nuketown');
  assert.equal(vm.runInContext('!!WORLD.group', context), true);
  assert.deepEqual(Array.from(vm.runInContext('events', context)), [
    'bind:broken', 'dispose', 'build:broken', 'dispose',
    'bind:nuketown', 'build:nuketown', 'nav:nuketown'
  ]);
});

test('the map rotation is deferred, spent once, and skipped in a room', () => {
  const context = runtimeHarness();

  /* Queueing must not swap. endMatch runs it while the player is still
     standing in the map reading the scoreboard. */
  context.queueMapRotation();
  assert.equal(context.activeMapId(), 'nuketown');
  assert.deepEqual(Array.from(vm.runInContext('events', context)), []);

  assert.equal(context.applyPendingMapRotation(), true);
  assert.equal(context.activeMapId(), 'terminal');

  // The flag is spent: leaving the match AND pressing REMATCH both call this.
  assert.equal(context.applyPendingMapRotation(), false);
  assert.equal(context.activeMapId(), 'terminal');

  // ...and it cycles rather than sticking on the last map.
  context.queueMapRotation();
  assert.equal(context.applyPendingMapRotation(), true);
  assert.equal(context.activeMapId(), 'nuketown');
});

test('a peer in a room never rotates its own map', () => {
  // The map is the host's to announce. A guest rotating on its own would be
  // playing different geometry from everyone else in the room.
  const context = runtimeHarness();
  vm.runInContext("NET = { mode: 'guest' }", context);
  context.queueMapRotation();
  assert.equal(context.applyPendingMapRotation(), false);
  assert.equal(context.activeMapId(), 'nuketown');

  vm.runInContext("NET = { mode: 'host' }", context);
  context.queueMapRotation();
  assert.equal(context.applyPendingMapRotation(), false);
  assert.equal(context.activeMapId(), 'nuketown');

  // Back in solo the rotation is ours again.
  vm.runInContext("NET = { mode: 'solo' }", context);
  context.queueMapRotation();
  assert.equal(context.applyPendingMapRotation(), true);
  assert.equal(context.activeMapId(), 'terminal');
});
