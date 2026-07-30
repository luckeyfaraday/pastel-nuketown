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

test('touch tap decisions reject drags, long holds, and cancellations', () => {
  const match = SIM.createMatch({ latencyMs: 0, seed: 3 });

  assert.strictEqual(match.host.call('touchTapShouldFire', 9.9, 250, false), true);
  assert.strictEqual(match.host.call('touchTapShouldFire', 10, 100, false), false);
  assert.strictEqual(match.host.call('touchTapShouldFire', 2, 251, false), false);
  assert.strictEqual(match.host.call('touchTapShouldFire', 2, 100, true), false);
});

test('a touch tap holds fire for one tick and shoots exactly once', () => {
  const match = SIM.createMatch({ latencyMs: 0, seed: 3 });
  match.host.run("switchWeapon('rifle'); G.player.fireCd = 0;");
  const ammo = match.host.get('G.player.ammo');
  const seq = match.host.get('IN.fireSeq');

  match.host.run('pulseFireForTick();');
  assert.strictEqual(match.host.get('IN.firing'), true);
  match.host.run(`simulate(${SIM.FIXED})`);

  assert.strictEqual(match.host.get('G.player.ammo'), ammo - 1);
  assert.strictEqual(match.host.get('IN.fireSeq'), seq + 1);
  assert.strictEqual(match.host.get('IN.firing'), false);
  match.host.run(`simulate(${SIM.FIXED * 30})`);
  assert.strictEqual(match.host.get('G.player.ammo'), ammo - 1);
});

test('a tap that lands as the player dies is not spent on the respawn', () => {
  const match = SIM.createMatch({ latencyMs: 0, seed: 3 });
  match.host.run("switchWeapon('rifle'); G.player.fireCd = 0;");

  /* The dead branch of stepPlayer returns before the pulse can be spent, so a
     tap in the frame the player dies used to survive the whole death and fire
     itself off on respawn -- popping the spawn shield on arrival. */
  match.host.run('pulseFireForTick(); killActor(G.player, null);');
  match.host.run(`simulate(${SIM.FIXED})`);
  assert.strictEqual(match.host.get('IN.firing'), false);
  assert.strictEqual(match.host.get('IN._releaseFireAfterTick'), false);

  match.host.run(`G.player.respawnT = 0; simulate(${SIM.FIXED * 2})`);
  assert.strictEqual(match.host.get('G.player.alive'), true);
  assert.strictEqual(match.host.get('G.player.ammo'),
    match.host.get("WBY[G.player.weapon].mag"),
    'the respawn must not open with an unasked-for shot');
  assert.ok(match.host.get('G.player.shield') > 0,
    'and must not pop its own spawn shield');
});

test('a respawn refills every weapon, not just the one in hand', () => {
  const match = SIM.createMatch({ latencyMs: 0, seed: 3 });

  /* Run the rifle dry and stow it. The per-weapon store outlives the death
     that emptied it, so a respawn that only tops up the held weapon hands the
     dry magazine straight back on the next swap. */
  match.host.run(`
    switchWeapon('rifle');
    G.player.ammo = 0; G.player.reserve = 0;
    syncPlayerAmmoStore();
    switchWeapon('smg');
    G.player.ammo = 4; syncPlayerAmmoStore();
    tryReload(G.player);
  `);
  assert.ok(match.host.get('VM.reloadT') > 0, 'the viewmodel should be reloading');

  match.host.run(`killActor(G.player, null); G.player.respawnT = 0;`);
  match.host.run(`simulate(${SIM.FIXED * 2})`);
  assert.strictEqual(match.host.get('G.player.alive'), true);
  assert.strictEqual(match.host.get('VM.reloadT'), 0,
    'a death mid-reload must not leave the new life swapping a full magazine');

  match.host.run("switchWeapon('rifle');");
  assert.strictEqual(match.host.get('G.player.ammo'), match.host.get('WBY.rifle.mag'),
    'the stowed weapon must come back loaded');
  assert.strictEqual(match.host.get('G.player.reserve'),
    match.host.get('WBY.rifle.reserve'),
    'and with its reserve restored, or it cannot be reloaded either');
});

test("a guest's own respawn refills the weapons it is not holding", () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5 });
  match.run(1.0);
  const onHost = `G.actors.find(a => a.netId === ${JSON.stringify(SIM.GUEST_ID)})`;

  /* A guest never runs respawnActor for itself -- the snapshot brings it back
     -- so its own store needs topping up on the alive edge. Empty the rifle on
     both sides so the two simulations start from the same magazine. */
  match.guest.run("switchWeapon('rifle');");
  match.run(0.4);
  match.host.run(`{
    const a = ${onHost};
    a.ammo = 0; a.reserve = 0;
    a._ammoBy[a.weapon] = { ammo: 0, reserve: 0 };
  }`);
  match.guest.run('G.player.ammo = 0; G.player.reserve = 0; syncPlayerAmmoStore();');
  match.guest.run("switchWeapon('smg');");
  match.run(0.4);

  match.host.run(`killActor(${onHost}, null);`);
  match.run(4.0);      // death, the 3s respawn timer, and a snapshot to carry it
  assert.strictEqual(match.guest.get('G.player.alive'), true,
    'the guest should be back on its feet');

  match.guest.run("switchWeapon('rifle');");
  assert.strictEqual(match.guest.get('G.player.ammo'), match.guest.get('WBY.rifle.mag'),
    'the guest must predict a loaded magazine rather than the one it died with');
  assert.strictEqual(match.guest.get('G.player.reserve'),
    match.guest.get('WBY.rifle.reserve'));

  match.run(0.5);
  assert.strictEqual(match.guest.get('G.player.ammo'), match.guest.get('WBY.rifle.mag'),
    'and the host must agree once the swap is acknowledged');
});

test('hiding touch controls cancels an armed semi-auto without firing', () => {
  const match = SIM.createMatch({ latencyMs: 0, seed: 3 });
  match.host.run(`
    switchWeapon('shotgun');
    IN.touchSemiArmed = true;
  `);
  const seq = match.host.get('IN.fireSeq');

  match.host.run('touchReleaseAll();');

  assert.strictEqual(match.host.get('IN.touchSemiArmed'), false);
  assert.strictEqual(match.host.get('IN.firing'), false);
  assert.strictEqual(match.host.get('IN.fireSeq'), seq);
});

test('semi-auto touch holds to aim, releases to fire, and cancels safely', () => {
  const match = SIM.createMatch({ latencyMs: 0, seed: 3 });
  match.host.run(`
    switchWeapon('rifle');
    G.player.vel.x = 6;
    touchFirePress({ pointerId: 8, clientX: 900, clientY: 400,
      preventDefault() {} });
  `);
  const ammo = match.host.get('G.player.ammo');
  const seq = match.host.get('IN.fireSeq');
  match.host.run(`simulate(${SIM.FIXED})`);

  assert.strictEqual(match.host.get('G.player.ammo'), ammo,
    'holding a semi-auto must not fire early');
  assert.strictEqual(match.host.get('G.player.aiming'), true,
    'the held trigger should keep the aiming pose active');

  match.host.run('touchFireRelease(null, false);');
  match.host.run(`simulate(${SIM.FIXED})`);
  assert.strictEqual(match.host.get('G.player.ammo'), ammo - 1);
  assert.strictEqual(match.host.get('IN.fireSeq'), seq + 1);

  match.host.run(`
    touchFirePress({ pointerId: 9, clientX: 900, clientY: 400,
      preventDefault() {} });
    touchFireRelease(null, true);
  `);
  assert.strictEqual(match.host.get('IN.fireSeq'), seq + 1,
    'pointercancel must abort rather than discharge');
});

test('the touch FIRE button keeps the SMG press-and-hold path', () => {
  const match = SIM.createMatch({ latencyMs: 0, seed: 3 });
  match.host.run(`
    touchFirePress({ pointerId: 8, clientX: 900, clientY: 400,
      preventDefault() {} });
  `);
  const ammo = match.host.get('G.player.ammo');
  for (let i = 0; i < 12; i++) match.host.run(`simulate(${SIM.FIXED})`);
  assert.ok(match.host.get('G.player.ammo') < ammo - 1,
    'holding FIRE should sustain an SMG burst');

  match.host.run('touchFireRelease(null, false);');
  const releasedAmmo = match.host.get('G.player.ammo');
  for (let i = 0; i < 12; i++) match.host.run(`simulate(${SIM.FIXED})`);
  assert.strictEqual(match.host.get('G.player.ammo'), releasedAmmo);
});

test('the harness runs the real client and converges host and guest', () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5 });
  match.run(1.5);

  assert.strictEqual(match.host.get('NET.mode'), 'host');
  assert.strictEqual(match.guest.get('NET.mode'), 'guest');
  assert.strictEqual(match.guest.get('G.actors.length'), 2,
    'guest should have itself plus a replica of the host');
  assert.ok(match.guest.get('NET.lastRawSnapshot && NET.lastRawSnapshot.tick > 0'),
    'guest must retain the validated raw migration image');
  assert.ok(match.guest.get('NET.lastCheckpoint && NET.lastCheckpoint.tick > 0'),
    'guest must retain the validated low-rate checkpoint');

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

test('a promoted guest resumes the same authoritative round from the cached checkpoint', () => {
  const match = SIM.createMatch({
    latencyMs: LIVE_LATENCY_MS, seed: 9, combatants: 4
  });
  match.run(1.0);

  match.host.run(`
    {
      const a = G.actors.find(actor => actor.netId === ${JSON.stringify(SIM.GUEST_ID)});
      a.pos.x = 2.345; a.pos.y = 0; a.pos.z = -4.567;
      a.vel.x = 0.75; a.vel.y = 0; a.vel.z = -0.25;
      a.kills = 11; a.deaths = 4; a.streak = 3; a.bestStreak = 6;
      a.weapon = 'smg'; a.ammo = 7; a.reserve = 41;
      a._ammoBy = {
        smg: { ammo: 7, reserve: 41 },
        rifle: { ammo: 9, reserve: 22 }
      };
      NET.eventSeq = 17;
      NET.checkpointDirty = true;
      netAfterSimulation(0, true);
    }
  `);
  const cached = match.link.latestSnapshot();
  const cachedActor = cached.actors.find(actor => actor.netId === SIM.GUEST_ID);
  assert.ok(cachedActor, 'the migration image should contain the promoted actor');
  assert.strictEqual(match.link.latestCheckpoint().tick, cached.tick,
    'the forced checkpoint should be available at the same boundary');

  /* Deliberately put prediction somewhere visibly different. Hydration must
     choose the last authority everybody observed, not this private display. */
  match.guest.run('G.player.pos.x = 19; G.player.pos.z = 19;');
  match.migrateHost();
  for (let i = 0; i < 30 && match.guest.get('NET.phase') !== 'migrating'; i++)
    match.tick();

  assert.strictEqual(match.guest.get('NET.phase'), 'migrating');
  assert.strictEqual(match.guest.get('G.tick'), cached.tick,
    'hydration must restore the exact authoritative tick');
  assert.strictEqual(match.guest.get('G.time'), cached.time,
    'hydration must restore the exact authoritative time');
  assert.strictEqual(match.guest.get('G.player.pos.x'), cachedActor.pos[0],
    'the promoted player deliberately rewinds to the shared authority');
  assert.strictEqual(match.guest.get('G.player.pos.z'), cachedActor.pos[2]);
  assert.strictEqual(match.guest.get('G.player.kills'), 11);
  assert.strictEqual(match.guest.get('G.player.deaths'), 4);
  assert.strictEqual(match.guest.get('G.player.ammo'), 7);
  assert.strictEqual(match.guest.get('G.player._ammoBy.rifle.ammo'), 9,
    'slow per-weapon ammo must come from the low-rate checkpoint');
  assert.strictEqual(match.guest.get('G.player._ammoBy.rifle.reserve'), 22);
  assert.strictEqual(match.guest.get('G.fixedAcc'), 0,
    'hydration must not carry a render-loop catch-up backlog');
  assert.strictEqual(match.guest.get(`
    (() => {
      const actor = G.actors.find(a => a.netId === 'bot-2');
      const expected = AI.createBrain({
        id: actor.id, seed: 1000 + 1 * 77, skill: actor.skill
      });
      return actor.brain.phase === expected.phase &&
        actor.brain.phase2 === expected.phase2 &&
        actor.brain.strafeSign === expected.strafeSign;
    })()
  `), true, 'bot brain seed must come from stable bot-N, not shifted array position');

  for (let i = 0; i < 30 &&
       !(match.guest.get('NET.mode') === 'host' &&
         match.guest.get('NET.phase') === 'playing'); i++) match.tick();

  assert.strictEqual(match.guest.get('NET.mode'), 'host');
  assert.strictEqual(match.guest.get('NET.phase'), 'playing');
  const resumedTick = match.guest.get('G.tick');
  match.run(0.25);
  assert.ok(match.guest.get('G.tick') > resumedTick,
    'the promoted authority should continue ticking rather than restart');
  assert.strictEqual(match.guest.get('NET.round'), 1,
    'seamless migration must preserve the round');
  assert.strictEqual(match.guest.get('NET.authorityEpoch'), 2,
    'the authority fence must still advance');
  assert.strictEqual(match.guest.get('G.player.kills'), 11,
    'scores must survive continued simulation');
  assert.ok(match.guest.get('G.player.ammo') <= 7,
    'ammo must continue from the restored magazine, never refill');
});

test('an event raced by normal flush and checkpoint replay is visible exactly once', () => {
  const match = SIM.createMatch({ latencyMs: 5, seed: 4 });
  match.run(0.3);
  SIM.probeFeedback(match.guest);
  const event = {
    id: 44,
    kind: 'damage',
    target: SIM.HOST_ID,
    from: SIM.GUEST_ID,
    damage: 10,
    head: false,
    at: [0, 1, 0],
    seq: null
  };
  match.guest.context.__wire = JSON.stringify({
    t: 'event', v: SIM.NETP.VERSION,
    authorityEpoch: 1, round: 1, events: [event]
  });
  match.guest.run('netHandleWire(__wire)');
  assert.strictEqual(match.guest.get('__feedback.markers.length'), 1);

  /* The same id can be replayed from the checkpoint under the new authority
     epoch after its ordinary 30Hz flush won the race. */
  match.guest.run('NET.authorityEpoch = 2;');
  match.guest.context.__wire = JSON.stringify({
    t: 'event', v: SIM.NETP.VERSION,
    authorityEpoch: 2, round: 1, events: [event]
  });
  match.guest.run('netHandleWire(__wire)');
  assert.strictEqual(match.guest.get('__feedback.markers.length'), 1,
    'event id deduplication must span authority epochs');
  assert.strictEqual(match.guest.get('NET.lastEventSeq'), 44);
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
  const match = SIM.createMatch({
    latencyMs: LIVE_LATENCY_MS, seed: 5, combatants: 9
  });
  match.run(1.0);

  const before = { guest: match.link.stats.fromGuest, host: match.link.stats.fromHost };
  match.guest.run('KEY.KeyW = true; pressFire();');
  match.host.run('KEY.KeyW = true; pressFire();');
  match.run(seconds);

  const guestRate = (match.link.stats.fromGuest - before.guest) / seconds;
  const hostRate = (match.link.stats.fromHost - before.host) / seconds;

  assert.ok(guestRate < BUDGET, `guest sends ${guestRate}/s against a ${BUDGET}/s budget`);
  assert.ok(hostRate < BUDGET, `host sends ${hostRate}/s against a ${BUDGET}/s budget`);
  const migrationBytes = Buffer.byteLength(JSON.stringify({
    snapshot: match.link.latestSnapshot(),
    checkpoint: match.link.latestCheckpoint()
  }));
  assert.ok(migrationBytes < SIM.NETP.MAX_MESSAGE_BYTES,
    `cached migration state is ${migrationBytes} bytes against a ` +
    `${SIM.NETP.MAX_MESSAGE_BYTES}-byte message limit`);
});

/* ---------------------------------------------------------------------
   Matchmaking

   These drive the real client's matchmaking functions in a bare instance --
   no link, no match. The point is that the decisions PLAY makes on the
   player's behalf are decisions the repo can check, rather than something
   that only ever ran in a browser nobody was measuring.
   --------------------------------------------------------------------- */

function matchmakingClient() {
  return SIM.createInstance({ ms: 0 });
}

/* A client whose clock the test drives and whose DOM writes it can read back:
   the harness hands out a fresh stub per getElementById call, so a countdown
   that only exists as text on a button is otherwise invisible. */
function countdownClient() {
  const clock = { ms: 0 };
  const client = SIM.createInstance(clock);
  client.run(`
    var SIM_ELS = new Map();
    document.getElementById = function (id) {
      if (!SIM_ELS.has(id)) SIM_ELS.set(id, {
        id: id, textContent: '', hidden: false, disabled: false, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, appendChild(child) { return child; }, innerHTML: ''
      });
      return SIM_ELS.get(id);
    };
  `);
  client.advance = (ms) => { clock.ms += ms; };
  client.text = (id) => client.get(`document.getElementById(${JSON.stringify(id)}).textContent`);
  client.hidden = (id) => client.get(`document.getElementById(${JSON.stringify(id)}).hidden`);
  return client;
}

test('quick play offers the busiest room with a seat free', () => {
  const client = matchmakingClient();
  const pick = (rooms) =>
    client.run(`netQuickCandidates(${JSON.stringify(rooms)})`);

  assert.deepEqual(pick([
    { code: 'AAAAAA', host: 'A', players: 1, max: 4, inProgress: false },
    { code: 'BBBBBB', host: 'B', players: 3, max: 4, inProgress: false },
    { code: 'CCCCCC', host: 'C', players: 2, max: 4, inProgress: false }
  ]), ['BBBBBB', 'CCCCCC', 'AAAAAA'],
  'a thin population belongs in one match, so the fullest room goes first');

  assert.deepEqual(pick([
    { code: 'AAAAAA', host: 'A', players: 3, max: 4, inProgress: true },
    { code: 'BBBBBB', host: 'B', players: 4, max: 4, inProgress: true },
    { code: 'CCCCCC', host: 'C', players: 1, max: 4, inProgress: false }
  ]), ['AAAAAA', 'CCCCCC'],
  'a running room with a seat is the better answer to PLAY, not the worse one');

  assert.deepEqual(pick([]), [], 'nothing to join is answered by hosting');
  assert.deepEqual(pick(null), [], 'an unreachable browser is not a crash');
});

/* The clock itself belongs to the relay, and net-protocol.test.js tests it
   there. What is left in the page is a display, so what is worth asserting
   here is that it displays the relay's number and starts nothing of its own. */
test('the lobby countdown shows the relay\'s clock and starts nothing itself', () => {
  const client = countdownClient();
  const shown = () => client.text('countdownText');
  client.run(`
    var SIM_STARTS = 0;
    netHostStart = function () { SIM_STARTS++; };
    NET.mode = 'host';
    NET.phase = 'lobby';
    NET.members = [
      { id: 'a', name: 'A', role: 'host' },
      { id: 'b', name: 'B', role: 'guest' }
    ];
  `);

  try {
    client.run('netUpdateAutoStart(null);');
    assert.strictEqual(client.get('NET.countdownTimer'), 0,
      'a room the relay is not counting shows no clock');
    assert.strictEqual(client.hidden('lobbyCountdown'), true);

    client.run('netUpdateAutoStart(5000);');
    assert.strictEqual(shown(), 'Starting in 5…', 'the relay says five, the page says five');
    assert.strictEqual(client.hidden('holdStart'), false,
      'and the host is offered the deferral');

    /* Wall-clock, not tick-counting: a throttled tab that missed three
       quarters of its ticks still shows the right number when it wakes. */
    client.advance(3200);
    client.run('netTickAutoStart();');
    assert.strictEqual(shown(), 'Starting in 2…');

    client.advance(2000);
    client.run('netTickAutoStart();');
    assert.strictEqual(shown(), 'Starting in 0…', 'it runs out rather than going negative');
    assert.strictEqual(client.get('SIM_STARTS'), 0,
      'and reaching zero starts nothing: that is the relay\'s call, not this page\'s');

    /* A roster change re-syncs to whatever the relay now says, in either
       direction — a HOLD granted by the relay arrives exactly this way. */
    client.run('netUpdateAutoStart(30000);');
    assert.strictEqual(shown(), 'Starting in 30…');
  } finally {
    client.run('netCancelAutoStart();');
  }
});

test('a guest sees the same clock as the host', () => {
  const client = countdownClient();
  client.run(`
    var SIM_STARTS = 0;
    netHostStart = function () { SIM_STARTS++; };
    NET.mode = 'guest';
    NET.phase = 'lobby';
    NET.members = [
      { id: 'a', name: 'A', role: 'host' },
      { id: 'b', name: 'B', role: 'guest' }
    ];
    netUpdateAutoStart(5000);
  `);

  try {
    /* A guest used to be told the rule and left to trust it. It gets the
       number now — the same number, off the same clock. */
    assert.strictEqual(client.text('countdownText'), 'Starting in 5…');
    assert.strictEqual(client.hidden('holdStart'), true,
      'but only the host may push it back');
    assert.strictEqual(client.get('SIM_STARTS'), 0,
      'and only the authority starts a round');
  } finally {
    client.run('netCancelAutoStart();');
  }
});

test('between rounds the clock lands on the rematch button', () => {
  const client = countdownClient();
  const label = () => client.text('again');
  client.run(`
    NET.mode = 'guest';
    NET.phase = 'playing';
    G.over = true;
    NET.members = [
      { id: 'a', name: 'A', role: 'host' },
      { id: 'b', name: 'B', role: 'guest' }
    ];
    netUpdateAutoStart(12000);
  `);

  try {
    assert.strictEqual(label(), 'REMATCH IN 12',
      'a scoreboard is the whole screen, so the clock goes on the button that is on it');
    client.run("NET.mode = 'host'; netTickAutoStart();");
    assert.strictEqual(label(), 'START REMATCH (12)',
      'the host is told it can skip the wait');

    client.run("NET.starting = true; netTickAutoStart();");
    assert.strictEqual(label(), 'START REMATCH (12)',
      'a start already in flight owns the label; a countdown must not talk over it');

    /* The round beginning is what stops it — the same call netBeginMatch makes. */
    client.run("NET.starting = false; G.over = false; netTickAutoStart();");
    assert.strictEqual(client.get('NET.countdownTimer'), 0);
  } finally {
    client.run('netCancelAutoStart();');
  }
});

/* ---------------------------------------------------------------------
   Drop-in

   The claim worth testing is that seating a player mid-round needs no new
   message: the host adds an actor and bumps the manifest, and the existing
   snapshot stream carries it to everyone. These run against the real client
   in a real host/guest match rather than a stub of one.
   --------------------------------------------------------------------- */

const LATE_ID = 'late-0001';
const ARRIVE = `
  NET.members.push({ id: '${LATE_ID}', name: 'Latecomer', role: 'guest' });
  netAdmitArrivals();
`;

test('a player who drops in takes a bot\'s slot rather than a spare one', () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5, combatants: 9 });
  match.run(1.0);

  const bots = () => match.host.get("G.actors.filter(a => a.controller === 'bot').length");
  const before = {
    actors: match.host.get('G.actors.length'),
    bots: bots(),
    manifest: match.host.get('NET.manifestVersion')
  };
  assert.ok(before.bots > 0, 'the fixture needs a bot to give up');

  match.host.run(ARRIVE);

  assert.strictEqual(match.host.get('G.actors.length'), before.actors,
    'a match people are already playing does not quietly get busier');
  assert.strictEqual(bots(), before.bots - 1, 'a bot paid for the seat');
  assert.ok(match.host.get('NET.manifestVersion') > before.manifest,
    'and the roster change is versioned, which is what guests key off');

  const seated = (field) =>
    match.host.get(`G.actors.find(a => a.netId === '${LATE_ID}').${field}`);
  assert.strictEqual(seated('controller'), 'remote');
  assert.strictEqual(seated('isHuman'), true);
  assert.ok(seated('shield') > 0,
    'walking into a live firefight with no shield is the one way this is worse than waiting');
  assert.strictEqual(seated('alive'), true);
});

test('the arrival reaches a guest on the ordinary snapshot stream', () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5, combatants: 9 });
  match.run(1.0);

  assert.strictEqual(match.guest.get(`!!G.actors.find(a => a.netId === '${LATE_ID}')`), false);
  match.host.run(ARRIVE);
  match.run(0.6);

  assert.strictEqual(match.guest.get(`!!G.actors.find(a => a.netId === '${LATE_ID}')`), true,
    'no new message type was needed — the manifest bump carried it');
  /* Everything a guest does not drive is a 'replica'; `isHuman` is what says
     there is a person behind it, and it is what the killfeed reads. */
  assert.strictEqual(
    match.guest.get(`G.actors.find(a => a.netId === '${LATE_ID}').isHuman`), true,
    'and the guest knows it is a person, not a bot');
  assert.strictEqual(match.link.stats.staleEpoch, 0);
});

test('a decided round seats nobody', () => {
  const match = SIM.createMatch({ latencyMs: LIVE_LATENCY_MS, seed: 5, combatants: 9 });
  match.run(1.0);

  /* Scores are final and the host is about to put the room back in the
     lobby; dropping someone into that is a worse welcome than the wait. */
  match.host.run('G.over = true;');
  const before = match.host.get('G.actors.length');
  match.host.run(ARRIVE);

  assert.strictEqual(match.host.get('G.actors.length'), before);
  assert.strictEqual(match.host.get(`!!G.actors.find(a => a.netId === '${LATE_ID}')`), false);
});

test('the deploy card a drop-in lands on can actually be clicked', () => {
  const client = SIM.createInstance({ ms: 0 });

  /* The harness hands back a fresh stub per getElementById call, so DOM state
     is invisible by default. Memoise it for this test: the regression being
     guarded is entirely about the state left on one button. */
  client.run(`
    var SIM_ELS = new Map();
    document.getElementById = function (id) {
      if (!SIM_ELS.has(id)) SIM_ELS.set(id, {
        id: id, textContent: '', hidden: false, disabled: false, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, appendChild(child) { return child; }, innerHTML: ''
      });
      return SIM_ELS.get(id);
    };
    startMatch = function () { G.started = true; };
    setPaused = function () {};
    showHint = function () {};
    NET.mode = 'guest';
    NET.id = 'late-0001';
    NET.room = 'ABCDEF';
    NET.members = [
      { id: 'host-0001', name: 'Host', role: 'host' },
      { id: 'late-0001', name: 'Latecomer', role: 'guest' }
    ];
  `);

  /* netConnect disables these while it dials. A player who joins a lobby gets
     them back when the lobby renders; a drop-in never sees a lobby. */
  client.run('netSetMenuBusy(true); netBeginMatch();');

  assert.strictEqual(client.get("SIM_ELS.get('play').textContent"), 'ENTER MATCH');
  assert.strictEqual(client.get("SIM_ELS.get('play').disabled"), false,
    'a deploy card nobody can click is a player frozen at the door');
});
