'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const nuketown = require('./mapspec.js');
const maps = require('./map-registry.js');
const runtimeSource = fs.readFileSync('./src/35-map-runtime.js', 'utf8');

test('shared map registry exposes Nuketown as the sole default map', () => {
  assert.equal(maps.DEFAULT_ID, 'nuketown');
  assert.deepEqual(maps.ids(), ['nuketown']);
  assert.equal(maps.get('nuketown'), nuketown);
  assert.equal(maps.get('terminal'), null);
  assert.equal(maps.get(null), null);
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
    const MAPS = { get(id) { return specs[id] || null; } };
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
