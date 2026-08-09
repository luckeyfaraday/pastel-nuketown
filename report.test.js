'use strict';

/* The client half of reporting: who the death card is willing to name, and
   what it puts on the wire when you press the button.

   The relay half — what a report does once it arrives, and what it
   deliberately does not do — is in net-protocol.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const SIM = require('./net-sim.js');

const HOST_ID = 'host-0001';
const GUEST_ID = 'guest-001';

/* A guest mid-match, with its own socket replaced by a recorder. The real one
   would put the message on a link that models the relay, and the relay's
   answer is exactly what these tests are here to stand in for by hand. */
function guestInMatch() {
  const client = SIM.createInstance();
  client.run('initViewmodel(); initFX(); initInput(); initAI();');
  client.run('startMatch(); exitPointerLock();');
  client.run(`
    globalThis.SENT = [];
    NET.mode = 'guest';
    NET.id = ${JSON.stringify(GUEST_ID)};
    NET.room = 'SIMRUN';
    NET.round = 1;
    NET.phase = 'playing';
    NET.members = [
      { id: ${JSON.stringify(HOST_ID)}, name: 'HOST', role: 'host', slot: 0 },
      { id: ${JSON.stringify(GUEST_ID)}, name: 'GUEST', role: 'guest', slot: 1 }
    ];
    NET.socket = {
      readyState: 1,
      bufferedAmount: 0,
      send(raw) { SENT.push(JSON.parse(raw)); },
      close() {}
    };
  `);
  return client;
}

/* Kills the local player and hands the killer the identity the roster knows
   them by, which is the only thing that makes them reportable. */
function killedBy(client, netId) {
  client.run(`
    {
      const killer = G.actors.find(a => !a.isPlayer);
      killer.netId = ${JSON.stringify(netId)};
      killer.name = 'HOST';
      killActor(G.player, killer);
    }
  `);
}

test('a solo death offers nobody to report', () => {
  const client = SIM.createInstance();
  client.run('initViewmodel(); initFX(); initInput(); initAI();');
  client.run('startMatch(); exitPointerLock();');
  client.run('killActor(G.player, G.actors.find(a => !a.isPlayer));');

  assert.equal(client.call('reportTarget'), null);
});

test('a bot kill in a real room is still not reportable', () => {
  const client = guestInMatch();
  killedBy(client, 'bot-2');

  assert.equal(client.call('reportTarget'), null,
    'a bot is not in the roster, which is the whole test');
});

test('dying to your own hand or the world names nobody', () => {
  const client = guestInMatch();
  client.run('killActor(G.player, null);');
  assert.equal(client.call('reportTarget'), null);

  client.run('G.player.alive = true; killActor(G.player, G.player);');
  assert.equal(client.call('reportTarget'), null, 'and never yourself');
});

test('the killer is reportable once, and the wire carries only their id', () => {
  const client = guestInMatch();
  killedBy(client, HOST_ID);

  assert.equal(client.call('reportTarget'), HOST_ID);

  client.run('sendReport();');
  /* Through JSON because SENT is built inside the sandbox realm, where an
     object literal is not reference-equal to one out here however identical
     it reads. */
  assert.equal(client.get('JSON.stringify(SENT)'), JSON.stringify([{
    t: 'report',
    v: client.get('NETP.VERSION'),
    target: HOST_ID
  }]));

  /* Held down, mashed, or pressed once on the key and once on the button: the
     report in flight is the only one that goes. */
  client.run('sendReport(); sendReport();');
  assert.equal(client.get('SENT').length, 1, 'nothing goes while one is in flight');

  client.run(`netHandleWire(JSON.stringify({ t: 'reported', v: NETP.VERSION, target: ${JSON.stringify(HOST_ID)} }));`);
  assert.equal(client.get('netHasReported')(HOST_ID), true);
  assert.equal(client.get('NET.reportSending'), '');

  client.run('sendReport();');
  assert.equal(client.get('SENT').length, 1, 'and none after the relay has it');
});

test('a refused report frees the button without touching the match', () => {
  const client = guestInMatch();
  killedBy(client, HOST_ID);
  client.run('sendReport();');
  assert.equal(client.get('NET.reportSending'), HOST_ID);

  client.run(`netHandleWire(JSON.stringify({
    t: 'error', v: NETP.VERSION, code: 'no-such-player', message: 'gone'
  }));`);
  assert.equal(client.get('NET.reportSending'), '', 'no longer in flight');
  assert.equal(client.get('netHasReported')(HOST_ID), false, 'and not counted as sent');
  assert.equal(client.get('NET.phase'), 'playing', 'the match is untouched');
});

test('a killer who leaves the room takes the button with them', () => {
  const client = guestInMatch();
  killedBy(client, HOST_ID);
  assert.equal(client.call('reportTarget'), HOST_ID);

  client.run(`NET.members = NET.members.filter(m => m.id !== ${JSON.stringify(HOST_ID)});`);
  assert.equal(client.call('reportTarget'), null);
});

test('a reconnect does not carry the last connection\'s reports', () => {
  const client = guestInMatch();
  killedBy(client, HOST_ID);
  client.run('sendReport();');
  client.run(`netHandleWire(JSON.stringify({ t: 'reported', v: NETP.VERSION, target: ${JSON.stringify(HOST_ID)} }));`);
  assert.equal(client.get('netHasReported')(HOST_ID), true);

  client.run('netResetTransport();');
  assert.equal(client.get('netHasReported')(HOST_ID), false,
    'peer ids belong to a connection, so the list cannot outlive one');
});
