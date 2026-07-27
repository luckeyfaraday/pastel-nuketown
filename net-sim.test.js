'use strict';

/* Measurements of the guest experience, run as assertions.

   The bounds here are deliberately loose. The point is to catch a direction
   changing or a magnitude moving by a lot, not to pin an exact figure that
   fails whenever a weapon is retuned. Every number in a comment is what the
   harness actually reported when the test was written, so a future reader can
   see how much headroom a bound has. */

const test = require('node:test');
const assert = require('node:assert');

const SIM = require('./net-sim.js');

const LIVE_LATENCY_MS = 96;   // measured on the production relay, commit 60ab2e6

test('the harness runs the real client and converges host and guest', () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5 });
  match.run(1.5);

  assert.strictEqual(match.host.get('NET.mode'), 'host');
  assert.strictEqual(match.guest.get('NET.mode'), 'guest');
  assert.strictEqual(match.guest.get('G.actors.length'), 2,
    'guest should have itself plus a replica of the host');

  /* Nothing was dropped for a stale epoch: the harness models the relay's
     check, so this failing means an outbound message lost authorityEpoch. */
  assert.strictEqual(match.link.stats.staleEpoch, 0);
  assert.ok(match.host.get("G.actors.find(a => a.controller === 'remote').inputAck") > 10,
    'host should be acknowledging guest input');

  const truth = match.host.get('G.player.pos.x');
  const seen = match.guest.get(
    `G.actors.find(a => a.netId === ${JSON.stringify(SIM.HOST_ID)}).pos.x`);
  assert.ok(Math.abs(truth - seen) < 1.0,
    `guest replica should track the host (truth ${truth}, seen ${seen})`);
});

test('the host wins a duel against an equally quick guest', () => {
  /* THE BASELINE. Both players track perfectly, both draw a reaction time from
     the same distribution, so an even split is what fairness would look like.

     Measured at 96ms one-way: host 96% / guest 4%, median time-to-kill 617ms.
     At 5ms it is still 79/21 -- that residue is not the network but the guest
     sampling its own input every 33ms before anything is sent. */
  const live = SIM.duelWinRate({ latencyMs: LIVE_LATENCY_MS, trials: 16, seed: 7 });

  assert.strictEqual(live.tally.timeout, 0, 'every duel should resolve');
  assert.ok(live.hostWinRate > 0.80,
    `host should dominate at ${LIVE_LATENCY_MS}ms, got ${(live.hostWinRate * 100).toFixed(0)}%`);
  assert.ok(live.medianTtkMs > 200 && live.medianTtkMs < 2000,
    `time-to-kill should be plausible, got ${live.medianTtkMs}ms`);
});

