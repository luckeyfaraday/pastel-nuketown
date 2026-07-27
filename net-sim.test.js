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

test('a guest can win a duel against an equally quick host', () => {
  /* Both players track perfectly and draw a reaction time from the same
     distribution, so an even split is what fairness would look like and every
     departure from it is the netcode.

     Was 100 / 0 at 96ms: a guest never won one. With input replay and per-tick
     input it is about 63 / 37, ranging 54-75 across seeds at 24 trials. The
     host keeps a real edge -- its damage lands in its own simulation while a
     guest's has to cross the wire -- but the fight is winnable now.

     The bound is wide deliberately. The upper end catches a regression back
     toward saturation; the lower end catches the guest being handed an
     advantage, which would be its own bug. */
  const live = SIM.duelWinRate({ latencyMs: LIVE_LATENCY_MS, trials: 24, seed: 7 });

  assert.strictEqual(live.tally.timeout, 0, 'every duel should resolve');
  assert.ok(live.hostWinRate > 0.35,
    `the host should still hold an edge, got ${(live.hostWinRate * 100).toFixed(0)}%`);
  assert.ok(live.hostWinRate < 0.90,
    `host should no longer dominate at ${LIVE_LATENCY_MS}ms, got ${(live.hostWinRate * 100).toFixed(0)}%`);
  assert.ok(live.medianTtkMs > 200 && live.medianTtkMs < 2000,
    `time-to-kill should be plausible, got ${live.medianTtkMs}ms`);
});

test('a guest predicts its own position to the centimetre', () => {
  /* The mechanism behind everything above, and the one number that does not
     saturate. The old blind damp pulled the local player 16% toward an
     authoritative state a full round trip old, and that controller's fixed
     point is e = -v*RTT: it converges on cancelling the prediction outright.

     Measured while sprinting at 5.9m/s, before -> after:
       5ms    0.038m -> 0.000m
       48ms   0.191m -> 0.000m
       96ms   0.421m -> 0.000m
       150ms  0.720m -> 0.000m

     At duel range 0.42m of positional error is a clean miss: the guest aims
     from where it believes it is, and the host resolves that angle from
     somewhere else. */
  for (const latencyMs of [5, LIVE_LATENCY_MS]) {
    const result = SIM.measurePredictionErrorM({ latencyMs: latencyMs, seed: 5, seconds: 4 });
    assert.ok(result.samples > 50, `needed samples, got ${result.samples}`);
    assert.ok(result.medianM < 0.05,
      `prediction should converge at ${latencyMs}ms, got ${result.medianM.toFixed(3)}m`);
  }
});

test('a moving duel is not decided by the guest being dragged', () => {
  /* A stationary duel cannot see reconciliation at all: standing still, a
     mispredicted position costs nothing. Strafing, it costs everything --
     before this work a guest could not win a strafing duel at 96ms given an
     800ms head start, against 120ms standing still.

     Handicap in ms at 5 / 48 / 96ms, before -> after:
       stationary       40 / 80  / 120   ->  20 / 60 / 120
       strafing 700ms   40 / 80  / >800  ->  20 / 60 / 120
       strafing 1200ms  40 / 480 / >800  ->   0 /  0 /  20 */
  const moving = SIM.guestHandicapMs({
    latencyMs: LIVE_LATENCY_MS, seed: 7, strafePeriodMs: 700, maxHeadStartMs: 800
  });
  const still = SIM.guestHandicapMs({
    latencyMs: LIVE_LATENCY_MS, seed: 7, strafePeriodMs: 0, maxHeadStartMs: 800
  });

  assert.ok(moving !== null,
    'a strafing guest should be able to win at all, which it could not before');
  assert.ok(moving <= still * 2,
    `moving should not cost far more than standing still (moving ${moving}ms, still ${still}ms)`);
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

test('the seam\'s move-normalize change is exact for keyboard input', () => {
  /* 937e1ac replaced `if (ml > 1e-4) { normalize }` with `if (ml > 1) { clamp }`
     in both stepPlayer and stepRemotePlayer, and argued the two are bit-for-bit
     identical for keyboard play. Nothing could load src/70-game.js to check it,
     so the claim shipped unverified. This checks it exhaustively.

     The argument is that a key is either down or not, so every reachable
     magnitude is 0, 1 or sqrt(2) -- and dividing by 1 is identity, which is the
     only case where the two conditions disagree. That holds only if
     readLocalInput really does emit nothing else, which is the part worth
     testing rather than reasoning about. */
  const instance = SIM.createInstance({ ms: 0 });
  const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'];

  for (let mask = 0; mask < 16; mask++) {
    instance.run('KEY.KeyW = KEY.KeyA = KEY.KeyS = KEY.KeyD = false;');
    const held = KEYS.filter((_, bit) => mask & (1 << bit));
    for (const key of held) instance.run(`KEY.${key} = true;`);

    const input = instance.run('readLocalInput(true)');
    const ml = Math.hypot(input.fwd, input.strafe);

    const reachable = Math.abs(ml) < 1e-12 ||
      Math.abs(ml - 1) < 1e-12 ||
      Math.abs(ml - Math.SQRT2) < 1e-12;
    assert.ok(reachable,
      `keyboard should only ever produce 0, 1 or sqrt(2), got ${ml} for [${held}]`);

    /* Both formulas, applied to the same vector. */
    const oldWay = { x: input.strafe, z: input.fwd };
    if (ml > 1e-4) { oldWay.x /= ml; oldWay.z /= ml; }
    const newWay = { x: input.strafe, z: input.fwd };
    if (ml > 1) { newWay.x /= ml; newWay.z /= ml; }

    assert.strictEqual(newWay.x, oldWay.x, `strafe differs for [${held}]`);
    assert.strictEqual(newWay.z, oldWay.z, `forward differs for [${held}]`);
  }
});

test('neither peer outruns the relay\'s message budget', () => {
  /* server.mjs closes a peer that exceeds ratePerSecond (90). Sending input
     once per simulated tick puts a guest at 60/s, which is comfortable but no
     longer negligible -- and the failure mode is a closed socket that reads as
     a random disconnect rather than as a rate limit. Worth a guard.

     Measured: guest 60.0/s, host 27.0/s. */
  const BUDGET = 90;
  const seconds = 4;
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5 });
  match.run(1.0);

  const before = { guest: match.link.stats.fromGuest, host: match.link.stats.fromHost };
  match.guest.run('KEY.KeyW = true; pressFire();');
  match.host.run('KEY.KeyW = true; pressFire();');
  match.run(seconds);

  const guestRate = (match.link.stats.fromGuest - before.guest) / seconds;
  const hostRate = (match.link.stats.fromHost - before.host) / seconds;

  assert.ok(guestRate < BUDGET, `guest sends ${guestRate}/s against a ${BUDGET}/s budget`);
  assert.ok(hostRate < BUDGET, `host sends ${hostRate}/s against a ${BUDGET}/s budget`);
});
