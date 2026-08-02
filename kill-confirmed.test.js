'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SIM = require('./net-sim.js');
const AI = require('./bots.js');
const MAP = require('./mapspec.js');

function solo() {
  const client = SIM.createInstance();
  client.run('initViewmodel(); initFX(); initInput(); initAI();');
  client.run("setGameMode('kc'); startMatch(); exitPointerLock();");
  return client;
}

function spawnAt(client, expression) {
  client.run(`
    {
      const victim = G.actors.find(a => !a.isPlayer);
      const killer = G.player;
      ${expression}
      killActor(victim, killer);
    }
  `);
  return client.get('G.donuts[0]');
}

test('kill-confirmed creates one grounded donut per death', () => {
  const client = solo();
  const donut = spawnAt(client, `victim.pos.x = -20; victim.pos.y = 3; victim.pos.z = 0;`);

  assert.equal(client.get('G.donuts.length'), 1);
  assert.equal(donut.owner, client.get('G.actors.find(a => !a.isPlayer).id'));
  assert.equal(donut.killer, client.get('G.player.id'));
  assert.equal(donut.ownerNetId, client.get('G.actors.find(a => !a.isPlayer).netId'));
  assert.equal(donut.killerNetId, null);
  assert.ok(Math.abs(donut.y - 3.35) < 1e-6, `donut y was ${donut.y}`);
});

test('the killer confirms once and cannot collect the same donut twice', () => {
  const client = solo();
  spawnAt(client, `victim.pos.x = 0; victim.pos.y = 0; victim.pos.z = 0;`);
  client.run('G.player.pos.x = 0; G.player.pos.y = 0; G.player.pos.z = 0; updateDonuts(1 / 60);');

  assert.equal(client.get('G.player.confirms'), 1);
  assert.equal(client.get('G.donuts.length'), 0);
  assert.equal(client.get('G.donutStats.confirmed'), 1);
  client.run('updateDonuts(1 / 60);');
  assert.equal(client.get('G.player.confirms'), 1);
});

test('the owner denies their donut without scoring', () => {
  const client = solo();
  client.run(`
    {
      const owner = G.actors.find(a => !a.isPlayer);
      const killer = G.player;
      owner.pos.x = 4; owner.pos.y = 0; owner.pos.z = 0;
      killActor(owner, killer);
      owner.alive = true;
      G.player.pos.x = 20; G.player.pos.y = 0; G.player.pos.z = 20;
      owner.pos.x = 4; owner.pos.y = 0; owner.pos.z = 0;
      updateDonuts(1 / 60);
    }
  `);

  assert.equal(client.get('G.donuts.length'), 0);
  assert.equal(client.get('G.actors.find(a => !a.isPlayer).confirms'), 0);
  assert.equal(client.get('G.player.confirms'), 0);
  assert.equal(client.get('G.donutStats.denied'), 1);
});

test('an untouched donut expires after twelve seconds', () => {
  const client = solo();
  spawnAt(client, `victim.pos.x = 0; victim.pos.y = 0; victim.pos.z = 0;`);
  client.run(`
    G.actors.forEach(a => { a.pos.x = 50; a.pos.y = 0; a.pos.z = 50; });
    updateDonuts(12);
  `);

  assert.equal(client.get('G.donuts.length'), 0);
  assert.equal(client.get('G.donutStats.expired'), 1);
});

test('the donut list caps at 24 and evicts its oldest entry', () => {
  const client = solo();
  client.run(`
    {
      const owner = G.actors.find(a => !a.isPlayer);
      G.actors.forEach(a => { a.pos.x = 100; a.pos.y = 0; a.pos.z = 100; });
      for (let i = 0; i < 25; i++) {
        owner.pos.x = i - 12; owner.pos.y = 0; owner.pos.z = 0;
        spawnDonut(owner, G.player);
        owner.pos.x = 100; owner.pos.y = 0; owner.pos.z = 100;
        updateDonuts(0.25);
      }
    }
  `);

  assert.equal(client.get('G.donuts.length'), 24);
  assert.equal(client.get('G.donuts.map(d => d.id).join(",")'),
    Array.from({ length: 24 }, (_, i) => i + 2).join(','));
  assert.equal(client.get('G.donutStats.evicted'), 1);
});

test('the pickup band separates the upper slab from the floor below', () => {
  const client = solo();
  client.run(`
    {
      const owner = G.actors.find(a => !a.isPlayer);
      G.actors.forEach(a => { a.pos.x = 100; a.pos.y = 0; a.pos.z = 100; });
      owner.alive = false;
      owner.pos.x = -8; owner.pos.y = 3.3; owner.pos.z = -12;
      spawnDonut(owner, G.player);
      G.player.pos.x = -8; G.player.pos.y = 0; G.player.pos.z = -12;
      updateDonuts(1 / 60);
    }
  `);

  assert.ok(Math.abs(client.get('G.donuts[0].y') - 3.65) < 1e-6);
  assert.equal(client.get('G.donuts.length'), 1);
  assert.equal(client.get('G.player.confirms'), 0);

  client.run('G.player.pos.y = 3.3; updateDonuts(1 / 60);');
  assert.equal(client.get('G.donuts.length'), 0);
  assert.equal(client.get('G.player.confirms'), 1);
});

test('a third actor can steal a donut and score the confirm', () => {
  const client = solo();
  client.run(`
    {
      const owner = G.actors.find(a => !a.isPlayer);
      const collector = G.actors.find(a => !a.isPlayer && a !== owner);
      G.actors.forEach(a => { a.pos.x = 100; a.pos.y = 0; a.pos.z = 100; });
      owner.alive = false;
      owner.pos.x = 0; owner.pos.y = 0; owner.pos.z = 0;
      collector.pos.x = 0; collector.pos.y = 0; collector.pos.z = 0;
      spawnDonut(owner, G.player);
      updateDonuts(1 / 60);
    }
  `);

  assert.equal(client.get('G.donuts.length'), 0);
  assert.equal(client.get('G.actors.find(a => !a.isPlayer && a.id !== 2).confirms'), 1);
  assert.equal(client.get('G.player.confirms'), 0);
  assert.equal(client.get('G.donutStats.confirmed'), 0);
  assert.equal(client.get('G.donutStats.stolen'), 1);
});

test('a pickup, rather than the kill, can win kill-confirmed', () => {
  const client = solo();
  spawnAt(client, `victim.pos.x = 0; victim.pos.y = 0; victim.pos.z = 0;`);
  client.run(`
    G.player.confirms = 19;
    G.player.pos.x = 0; G.player.pos.y = 0; G.player.pos.z = 0;
    updateDonuts(1 / 60);
  `);

  assert.equal(client.get('G.player.confirms'), 20);
  assert.equal(client.get('G.over'), true);
  assert.equal(client.get('G.winner.id'), client.get('G.player.id'));
});

function botSelf(overrides) {
  return Object.assign({
    id: 1, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, health: 100, maxHealth: 100,
    ammo: 30, magSize: 30, reserve: 90, onGround: true, reloading: false
  }, overrides || {});
}

test('bots seek nearby donuts by skill, keep retreat priority, and commit to one', () => {
  const nav = AI.buildNav(MAP);
  const donut = { id: 7, x: 15, y: 0.35, z: 0, owner: 3, killer: 4, t: 0 };
  const view = (self, donuts) => ({
    time: 1, mode: 'kc', nav, rng: () => 0.5, self, actors: [], donuts,
    canSee: () => true
  });

  const easy = AI.createBrain({ id: 1, seed: 4, skill: 'easy' });
  const hard = AI.createBrain({ id: 2, seed: 4, skill: 'hard' });
  assert.notEqual(AI.think(easy, view(botSelf(), [donut]), 1 / 60).state, 'donut');
  assert.equal(AI.think(hard, view(botSelf(), [donut]), 1 / 60).state, 'donut');

  const other = {
    id: 8, pos: { x: 4, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    health: 100, alive: true, isPlayer: false
  };
  const retreatBrain = AI.createBrain({ id: 3, seed: 5, skill: 'normal' });
  const retreat = AI.think(retreatBrain, Object.assign(view(
    botSelf({ id: 3, health: 10 }), [donut]), { actors: [other] }), 1 / 60);
  assert.equal(retreat.state, 'retreat');

  const first = AI.createBrain({ id: 4, seed: 6, skill: 'hard' });
  const firstIntent = AI.think(first, view(botSelf({ id: 4 }), [donut]), 1 / 60);
  const secondIntent = AI.think(first, view(botSelf({ id: 4 }), [donut,
    { id: 8, x: 1, y: 0.35, z: 0, owner: 5, killer: 6, t: 0 }]), 1 / 60);
  assert.equal(firstIntent.state, 'donut');
  assert.equal(secondIntent.state, 'donut');
  assert.equal(first.donutId, 7);
  assert.equal(Object.prototype.hasOwnProperty.call(secondIntent, 'donutId'), false);
});
