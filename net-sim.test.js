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

test('a stale authority epoch gets the guest\'s input dropped', () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5 });
  match.run(1.0);

  match.guest.run('NET.authorityEpoch = 99;');
  /* Input already on the wire when the epoch changed carried a live one and is
     still delivered, so the ack keeps climbing briefly. Let that drain before
     taking the reading, or the test is asserting against packets that were
     legitimately in flight. */
  match.run(0.4);
  const ackBefore = match.host.get("G.actors.find(a => a.controller === 'remote').inputAck");
  match.run(1.0);

  assert.ok(match.link.stats.staleEpoch > 0, 'relay model should have rejected input');
  assert.strictEqual(
    match.host.get("G.actors.find(a => a.controller === 'remote').inputAck"),
    ackBefore,
    'host must not advance the ack for input sent under a dead epoch');
});

test('a guest sees its own hit immediately instead of a round trip later', () => {
  function feedbackDelayMs(predict) {
    const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5 });
    match.run(1.0);
    SIM.faceOff(match, { distance: 8 });
    SIM.probeFeedback(match.guest);
    if (!predict) SIM.disableHitPrediction(match.guest);

    const firedAt = match.clock.ms;
    match.guest.run('pressFire()');
    match.run(1.0);

    const markers = match.guest.get('__feedback.markers');
    assert.ok(markers.length > 0, 'the guest should have registered a hit at all');
    return { first: markers[0] - firedAt, count: markers.length };
  }

  const predicted = feedbackDelayMs(true);
  const authoritative = feedbackDelayMs(false);

  /* Measured: predicted 16.7ms (one tick), authoritative 233.3ms. */
  assert.ok(predicted.first < 50,
    `predicted feedback should be immediate, was ${predicted.first}ms`);
  assert.ok(authoritative.first > 150,
    `waiting for the host should cost most of a round trip, was ${authoritative.first}ms`);
  assert.ok(authoritative.first - predicted.first > 120,
    'prediction should remove the bulk of the wait');
});

test('an authoritative hit the guest already predicted is not shown twice', () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5 });
  match.run(1.0);
  SIM.faceOff(match, { distance: 8 });
  SIM.probeFeedback(match.guest);

  match.guest.run('pressFire()');
  match.run(0.4);
  match.guest.run('releaseFire()');
  /* Long enough for every authoritative answer to those shots to arrive. */
  match.run(1.2);

  const predicted = match.guest.get('__feedback.predicted').length;
  const shown = match.guest.get('__feedback.markers').length;
  assert.ok(predicted > 0, 'the guest should have predicted at least one hit');
  assert.strictEqual(shown, predicted,
    `every marker should come from prediction exactly once ` +
    `(predicted ${predicted}, shown ${shown})`);
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

test('the guest\'s handicap grows with latency', () => {
  /* Milliseconds of head start the guest needs before it stops losing.
     Measured: 40ms at 5ms one-way, 80ms at 48ms, 120ms at 96ms.

     This is the number to watch. The win rate saturates near 100% and stops
     being able to show an improvement; the handicap keeps moving. */
  const lan = SIM.guestHandicapMs({ latencyMs: 5, seed: 7 });
  const live = SIM.guestHandicapMs({ latencyMs: LIVE_LATENCY_MS, seed: 7 });

  assert.ok(lan !== null && live !== null, 'the guest should win given enough head start');
  assert.ok(live > lan,
    `handicap should grow with latency (${lan}ms at 5ms, ${live}ms at ${LIVE_LATENCY_MS}ms)`);
  assert.ok(live >= 60,
    `handicap at ${LIVE_LATENCY_MS}ms should be substantial, got ${live}ms`);
});

test('the guest renders other players in the past, but less than it used to', () => {
  /* Measured against the host's own position history rather than derived from
     the constants, so it reports what the renderer does.

     A/B on this build: pinned back to the old flat two-interval buffer the
     guest sees 100.0ms into the past; adaptive, 66.7ms. That 33ms is reaction
     time the host was being given for free in every fight, and no amount of
     lag compensation addresses it -- compensation fixes where your bullets
     land, not when you first see someone. */
  const view = SIM.measureViewLatencyMs({ latencyMs: LIVE_LATENCY_MS, seed: 5, seconds: 3 });
  assert.ok(view.samples > 20, `needed usable samples, got ${view.samples}`);
  assert.ok(view.medianMs > 30,
    `the guest is necessarily behind the host's truth, got ${view.medianMs}ms`);

  const OLD_FIXED_BUFFER_MS = 100;
  assert.ok(view.medianMs < OLD_FIXED_BUFFER_MS,
    `should beat the old flat ${OLD_FIXED_BUFFER_MS}ms buffer, got ${view.medianMs}ms`);

  /* On a clean link the buffer should collapse toward its floor of one
     interval plus a slim margin, not sit at the old two. */
  const delayMs = view.match.guest.get('netInterpDelay()') * 1000;
  assert.ok(delayMs > 50 && delayMs < 70,
    `steady-link buffer should be near one interval, got ${delayMs}ms`);
});
