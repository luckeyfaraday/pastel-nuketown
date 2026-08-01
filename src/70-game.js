/* =====================================================================
   PASTEL NUKETOWN — game: actors, player control, combat, match flow
   ===================================================================== */

const CFG = {
  bots: 8,
  combatants: 9,
  killsToWin: 25,
  respawn: 3.0,
  spawnShield: 1.6,
  playerSpeed: 5.9,
  sprintMul: 1.42,
  botSpeed: 5.3,
  accelGround: 13,
  accelAir: 2.6
};

const G = {
  actors: [], player: null, nav: null, aiOK: false, aiErr: null,
  time: 0, started: false, over: false, paused: false,
  winner: null, frozen: false, hintT: 0,
  fixedAcc: 0, tick: 0
};

/* Impact debris takes the colour of what it hit, so sugar dust on a lawn is
   green and on a roof is pink. The material tag rides along on the raycast
   result; anything untagged falls back to the effect's own warm white. */
function impactSurfaceColor(hit) {
  if (!hit || !hit.mat) return null;
  if (hit.mat === 'house') return hit.house === 'A' ? PAL.houseA : PAL.houseB;
  if (hit.mat === 'trim') return hit.house === 'A' ? PAL.houseAtrim : PAL.houseBtrim;
  if (hit.mat === 'roof') return hit.house === 'A' ? PAL.roofA : PAL.roofB;
  if (hit.mat === 'slab') return PAL.slab;
  if (hit.mat === 'stair') return PAL.stair;
  if (hit.mat === 'post') return PAL.post;
  if (hit.mat === 'rail') return PAL.rail;
  if (hit.mat === 'picket') return PAL.picket;
  if (hit.mat === 'crate') return PAL.crate;
  if (hit.mat === 'perimeter') return PAL.perimeter;
  if (hit.mat === 'bus') return PAL.bus;
  if (hit.mat === 'truck') return PAL.truck;
  return null;
}

/* =====================================================================
   ACTOR
   ===================================================================== */
let _nextId = 1;
function makeActor(opts) {
  const id = opts.id === undefined ? _nextId++ : opts.id;
  if (id >= _nextId) _nextId = id + 1;
  const a = {
    id: id,
    netId: opts.netId || null,
    name: opts.name,
    isPlayer: !!opts.isPlayer,
    controller: opts.controller || (opts.isPlayer ? 'local' : 'bot'),
    isHuman: !!opts.isHuman || !!opts.isPlayer || opts.controller === 'remote',
    colors: opts.colors,
    skill: opts.skill || 'normal',
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, aimYaw: 0, aimPitch: 0,
    bodyYaw: 0, gait: 0, recoil: 0, flinch: 0, aimBlend: 0, aiming: false,
    health: 100, maxHealth: 100, alive: true,
    deathT: 0, deathDir: 1, spawnT: 0, respawnT: 0,
    weapon: opts.weapon || 'smg', ammo: 0, reserve: 0, reloadT: 0, fireCd: 0,
    kills: 0, deaths: 0, streak: 0, bestStreak: 0,
    onGround: false, stepPhase: 0,
    lastHitBy: null, lastHitT: -99, shield: 0,
    brain: null, char: null, plate: null, blob: null, bubble: null, state: 'idle',
    netInput: null, netTarget: null, lastInputSeq: -1, lastWeaponSeq: -1,
    inputAck: 0, weaponAck: 0,
    lastFireSeq: 0, lastReloadSeq: 0, pendingFireUntil: 0,
    pendingFireSeq: 0, pendingRenderTime: 0
  };
  const w = WBY[a.weapon];
  a.ammo = w.mag; a.reserve = w.reserve;
  return a;
}

function attachCharacter(a) {
  a.char = buildCharacter(a.colors);
  scene.add(a.char.root);
  a.blob = makeBlobShadow();
  a.bubble = makeBubble();
  a.plate = makePlate();
  a.plate.sprite.position.set(0, CH.headC + 0.55, 0);
  a.char.root.add(a.plate.sprite);
  drawPlate(a.plate, a.name, a.health, a.maxHealth, a.colors.body);
}

function disposeActorVisuals(a) {
  if (!a) return;
  if (a.char) {
    scene.remove(a.char.root);
    a.char.root.traverse(object => {
      if ((object.isMesh || object.isLine) && object.geometry) object.geometry.dispose();
      if ((object.isMesh || object.isLine) && object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
  }
  if (a.plate) {
    if (a.plate.sprite && a.plate.sprite.material) a.plate.sprite.material.dispose();
    if (a.plate.tex) a.plate.tex.dispose();
  }
  for (const object of [a.blob, a.bubble]) {
    if (!object) continue;
    scene.remove(object);
    if (object.geometry) object.geometry.dispose();
    if (object.material) object.material.dispose();
  }
  a.char = null;
  a.plate = null;
  a.blob = null;
  a.bubble = null;
}

function detachActor(a) {
  if (!a) return;
  disposeActorVisuals(a);
  const i = G.actors.indexOf(a);
  if (i >= 0) G.actors.splice(i, 1);
}

/* Indexed by jersey slot, so there are as many entries as there are jerseys.
   The first eight are what the solo eight have always been. */
const BOT_SKILLS = ['easy', 'normal', 'normal', 'hard', 'normal', 'hard', 'easy', 'normal', 'normal'];
const BOT_GUNS   = ['smg', 'shotgun', 'smg', 'rifle', 'smg', 'shotgun', 'rifle', 'smg', 'shotgun'];

/* One number decides everything about a bot: its jersey, its name, its gun,
   how well it shoots and the id the network knows it by. Bots are made and
   unmade mid-match now — evicted when somebody drops in, put back when
   somebody leaves — and a bot whose identity came from its position in the
   build loop would come back as a different bot each time. */
function makeBot(slot) {
  const colors = jerseyForSlot(slot);
  const b = makeActor({
    name: colors.name.toUpperCase(),
    netId: 'bot-' + slot,
    controller: 'bot',
    colors: colors,
    weapon: BOT_GUNS[slot % BOT_GUNS.length],
    skill: BOT_SKILLS[slot % BOT_SKILLS.length]
  });
  if (G.aiOK) {
    try { b.brain = AI.createBrain({ id: b.id, seed: 1000 + slot * 77, skill: b.skill }); }
    catch (e) { b.brain = null; G.aiErr = String(e); }
  }
  attachCharacter(b);
  return b;
}

function respawnActor(a, instant) {
  const sp = pickSpawn(G.actors, a.id);
  a.pos.x = sp.x; a.pos.y = sp.y; a.pos.z = sp.z;
  a.vel.x = a.vel.y = a.vel.z = 0;
  const spawnYaw = yawFlip(sp.yaw);          // mapspec yaws are contract-convention
  a.yaw = spawnYaw; a.pitch = 0;
  a.aimYaw = spawnYaw; a.aimPitch = 0; a.bodyYaw = spawnYaw + Math.PI;
  a.health = a.maxHealth; a.alive = true;
  a.deathT = 0; a.spawnT = 0.45; a.respawnT = 0;
  a.shield = CFG.spawnShield;
  a.streak = 0;
  const w = WBY[a.weapon];
  a.ammo = w.mag; a.reserve = w.reserve; a.reloadT = 0; a.fireCd = 0;
  refillAmmoStore(a);
  if (a.isPlayer) vmCancelReload();
  if (a.brain && G.aiOK && AI.resetBrain) { try { AI.resetBrain(a.brain); } catch (e) {} }
  if (a.char) { a.char.root.visible = true; a.char.root.scale.setScalar(0.001); }
  if (a.plate) drawPlate(a.plate, a.name, a.health, a.maxHealth, a.colors.body);
  fxSpawnPuff(a.pos.x, a.pos.y, a.pos.z, C(a.colors.body));
  if (a.isPlayer) { SFX.spawn(); setDamageDirsCleared(); }
  if (typeof netOnAuthoritativeRespawn === 'function') netOnAuthoritativeRespawn(a);
}

/* =====================================================================
   KILLCAM
   What the player who killed you is looking at, for the rest of your
   respawn. It follows them live rather than replaying the death, because
   the client keeps nothing a replay could be built from: the only actor
   history here is netRecordActorHistory, which exists for lag compensation
   — position and nothing else, over a 0.3s window (NETP.MAX_REWIND_SECONDS)
   — and no angles means no viewpoint. Replaying would also mean rewinding
   every actor's mesh, which animateAll drives straight from live state, for
   three seconds during which eight other people are still playing.

   The cut is held off for a moment first. Cutting on the same frame as the
   kill burst reads as a glitch rather than as a cut, and the burst is the
   feedback that tells you what just happened.

   This is state, not rendering: placeKillcam and the per-frame tick are in
   90-main.js with the rest of the camera.
   ===================================================================== */
const KILLCAM_HOLD = 0.55;
const KILLCAM = { killer: null, t: 0, shown: null };

function killcamBegin(killer) {
  /* A world death — or a shot with no attacker left to credit — arrives here
     as a null killer and simply never leaves the death cam. */
  KILLCAM.killer = killer && killer !== G.player ? killer : null;
  KILLCAM.t = 0;
}

function killcamEnd() {
  KILLCAM.killer = null;
  KILLCAM.t = 0;
  killcamShow(null);
}

/* The camera sits inside the killer's head, so their body has to come off or
   the view is the inside of their own skull. Every hide and every restore is
   routed through here, so the actor that was hidden is always the actor that
   gets put back — including when the view falls back part-way through because
   the killer died or left.

   Setting `shown` is what does the hiding, not the assignment below: animateAll
   re-asserts visibility for every live actor once a frame, so it reads `shown`
   and keeps this one off. That is also what makes the restore here safe rather
   than merely likely — the next frame puts a live body back on its own. */
function killcamShow(a) {
  if (KILLCAM.shown === a) return;
  if (KILLCAM.shown && KILLCAM.shown.char) KILLCAM.shown.char.root.visible = true;
  KILLCAM.shown = a;
  if (a && a.char) a.char.root.visible = false;
  /* Thinning the death card's wash is part of showing the killcam, so it is
     driven from the same transition rather than from a second timer that
     could disagree about when one is running. */
  const card = document.getElementById('dead');
  if (card) card.classList.toggle('killcam', !!a);
}

/* Re-decided every frame rather than trusted from the moment of death. Over
   three seconds the killer can leave the room, be pruned and replaced by the
   bot wearing their jersey, or be killed themselves — and a camera inside a
   corpse mid-ragdoll is worse than no killcam at all. Anything unresolved
   falls back to the death cam, which is what played here before. */
function killcamActor() {
  const k = KILLCAM.killer;
  if (!k || G.over) return null;
  if (KILLCAM.t < KILLCAM_HOLD) return null;
  if (k === G.player || !k.alive || !k.char) return null;
  if (G.actors.indexOf(k) < 0) return null;
  return k;
}

/* =====================================================================
   SETUP
   ===================================================================== */
function setupMatch() {
  /* Before the disposal below, not after: the killcam has a body hidden and
     has to put it back while there is still a mesh to put back, and it must
     not carry a reference to an actor this rebuild is about to discard. */
  killcamEnd();
  for (const a of G.actors) disposeActorVisuals(a);
  G.actors.length = 0;
  _nextId = 1;
  G.time = 0; G.tick = 0; G.over = false; G.winner = null;

  const localInfo = typeof netLocalPlayerInfo === 'function'
    ? netLocalPlayerInfo()
    : { id: null, name: 'YOU', colors: PLAYER_COLOR };
  const player = makeActor({
    name: localInfo.name || 'YOU',
    isPlayer: true,
    isHuman: true,
    controller: 'local',
    netId: localInfo.id || null,
    colors: localInfo.colors || PLAYER_COLOR,
    weapon: 'smg'
  });
  player.blob = makeBlobShadow();     // only ever seen in the death cam
  player.bubble = makeBubble();       // ditto, plus it shows in the death cam
  G.player = player;
  G.actors.push(player);

  const remoteRoster = typeof netAuthorityRoster === 'function' ? netAuthorityRoster() : [];
  for (let i = 0; i < remoteRoster.length; i++) {
    const member = remoteRoster[i];
    const h = makeActor({
      name: member.name,
      netId: member.id,
      isHuman: true,
      controller: 'remote',
      colors: member.colors,
      weapon: 'smg'
    });
    attachCharacter(h);
    G.actors.push(h);
  }

  /* Humans are seated first, so the jerseys still going spare are exactly the
     ones the bots may have — and in a room of nine real players there are
     none, which is the whole point: the bots do not get squeezed down to
     nothing, they are simply never made. */
  const botCount = typeof netBotCount === 'function' ? netBotCount(remoteRoster.length + 1) : CFG.bots;
  const spare = freeJerseys(G.actors);
  for (let i = 0; i < botCount && i < spare.length; i++) {
    G.actors.push(makeBot(spare[i]));
  }
  for (const a of G.actors) respawnActor(a, true);
  // stagger the initial spawns so nobody starts inside someone else
  updateHUD();
  refreshBoard();
}

function initAI() {
  try {
    if (!AI || typeof AI.buildNav !== 'function') throw new Error('NUKETOWN_AI missing');
    G.nav = AI.buildNav(MAP);
    G.aiOK = true;
  } catch (e) {
    G.aiOK = false; G.aiErr = String(e && e.message || e);
    console.warn('[nuketown] AI unavailable, using fallback wander brains:', G.aiErr);
  }
}

/* Minimal stand-in so a broken AI module degrades to "bots still move and
   shoot" instead of a lobby full of statues. */
function fallbackThink(a, dt) {
  a._fbT = (a._fbT || 0) - dt;
  if (a._fbT <= 0) { a._fbT = rand(1.2, 3.0); a._fbA = rand(0, TAU); }
  let tgt = null, bd = 1e9;
  for (const o of G.actors) {
    if (o === a || !o.alive) continue;
    const d = Math.hypot(o.pos.x - a.pos.x, o.pos.z - a.pos.z);
    if (d < bd && canSee(a.pos.x, a.pos.y + ACT.eye, a.pos.z, o.pos.x, o.pos.y + HIT.headY, o.pos.z)) { bd = d; tgt = o; }
  }
  /* NB: like bots.js, this emits CONTRACT yaw — stepBot flips it back. */
  const out = { moveX: Math.cos(a._fbA), moveZ: Math.sin(a._fbA), jump: false,
                aimYaw: yawFlip(a.aimYaw), aimPitch: 0, fire: false, reload: a.ammo <= 0, targetId: null, state: 'wander' };
  if (tgt) {
    const want = Math.atan2(tgt.pos.z - a.pos.z, tgt.pos.x - a.pos.x);
    out.aimYaw = approachAngle(yawFlip(a.aimYaw), want, dt * 3.4);
    out.aimPitch = Math.atan2((tgt.pos.y + HIT.headY) - (a.pos.y + ACT.eye), bd);
    out.fire = Math.abs(angDelta(out.aimYaw, want)) < 0.09;
    out.targetId = tgt.id; out.state = 'engage';
    out.moveX = Math.cos(a._fbA) * 0.5; out.moveZ = Math.sin(a._fbA) * 0.5;
  }
  return out;
}

/* =====================================================================
   COMBAT
   ===================================================================== */
function actorEye(a) { return a.pos.y + (a.isPlayer ? ACT.eye : HIT.headY); }

function tryReload(a) {
  if (a.reloadT > 0) return;
  const w = WBY[a.weapon];
  if (a.ammo >= w.mag || a.reserve <= 0) return;
  a.reloadT = w.reload;
  if (a.isPlayer) { vmStartReload(w.reload); SFX.reload(); }
  else SFX.reload(a.pos.x, a.pos.y + 1.2, a.pos.z);
}
function finishReload(a) {
  const w = WBY[a.weapon];
  const need = w.mag - a.ammo;
  const give = Math.min(need, a.reserve);
  a.ammo += give; a.reserve -= give;
  a.reloadT = 0;
  if (a.isPlayer) SFX.reloadDone(); else SFX.reloadDone(a.pos.x, a.pos.y + 1.2, a.pos.z);
}

function fireWeapon(a, fireSeq, renderTime) {
  const w = WBY[a.weapon];
  const visualOnly = a.isPlayer && typeof netIsGuest === 'function' && netIsGuest();
  if (a.fireCd > 0 || a.reloadT > 0 || !a.alive) return false;
  if (a.ammo <= 0) {
    if (a.isPlayer && a.fireCd <= 0) { SFX.empty(); a.fireCd = 0.25; }
    tryReload(a);
    return false;
  }
  a.ammo--;
  a.shield = 0;                        // shooting drops your own bubble
  a.fireCd = 60 / w.rpm;
  a.recoil = 1;
  a.aiming = true;

  const ex = a.pos.x, ey = actorEye(a), ez = a.pos.z;
  const moving = Math.hypot(a.vel.x, a.vel.z) > 1.6;
  const spread = moving ? w.spreadMove : w.spread;
  const spreadRng = Number.isSafeInteger(fireSeq) && fireSeq >= 0
    ? mulberry32(NETP.shotSpreadSeed(a.netId || a.id, fireSeq, a.ammo))
    : rng;
  const spreadRand = (lo, hi) => lo + (hi - lo) * spreadRng();

  // muzzle origin for tracers: bots use their gun, the player uses the viewmodel
  let mx = ex, my = ey, mz = ez;
  if (!a.isPlayer && a.char) {
    a.char.muzzle.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(a.char.muzzle.matrixWorld);
    mx = p.x; my = p.y; mz = p.z;
  }

  const shotLines = [], shotHits = [];
  const restoreActors = !visualOnly && a.controller === 'remote' &&
    typeof netBeginLagCompensation === 'function'
    ? netBeginLagCompensation(a, renderTime)
    : null;
  try {
    for (let p = 0; p < w.pellets; p++) {
      const yaw = a.aimYaw + spreadRand(-spread, spread) * (p ? 1.6 : 0.35);
      const pit = a.aimPitch + spreadRand(-spread, spread) * (p ? 1.6 : 0.35);
      const cp = Math.cos(pit);
      const dx = Math.sin(yaw) * cp, dy = Math.sin(pit), dz = Math.cos(yaw) * cp;
      const hit = hitscan(ex, ey, ez, dx, dy, dz, w.range, G.actors, a.id);
      const endX = hit ? hit.px : ex + dx * w.range;
      const endY = hit ? hit.py : ey + dy * w.range;
      const endZ = hit ? hit.pz : ez + dz * w.range;
      shotHits.push(hit);
      shotLines.push([mx, my, mz, endX, endY, endZ]);
    }
  } finally {
    if (restoreActors) restoreActors();
  }

  fxMuzzle(mx, my, mz);
  for (let p = 0; p < shotLines.length; p++) {
    const hit = shotHits[p];
    const endX = shotLines[p][3], endY = shotLines[p][4], endZ = shotLines[p][5];
    if (p === 0 || w.pellets <= 3 || p % 3 === 0)
      fxTracer(mx, my, mz, endX, endY, endZ, C(a.isPlayer ? (w.tracer || 0xfff0c0) : a.colors.trim));

    if (!hit) continue;
    if (hit.kind === 'actor') {
      const dmg = w.dmg * (hit.head ? w.headMul : 1);
      /* A guest owns none of this damage, but it does own the feedback. Waiting
         for the host to confirm costs a full round trip, which is the whole of
         why shooting feels dead as a guest. Show the marker now against the
         replicas the player actually aimed at -- the host rewinds to that same
         instant, so the two nearly always agree -- and let the authoritative
         event redeem the prediction instead of repeating it. */
      if (visualOnly) {
        if (typeof netPredictHit === 'function')
          netPredictHit(hit.actor, dmg, hit.head, endX, endY, endZ, fireSeq);
      } else applyDamage(hit.actor, dmg, a, hit.head, endX, endY, endZ, fireSeq);
      fxImpact(endX, endY, endZ, hit.nx, hit.ny, hit.nz, 'actor', hit.actor.colors.body);
    } else if (hit.kind === 'mannequin') {
      hit.obj.userData.spin += rand(3, 7) * (rng() < 0.5 ? -1 : 1);
      hit.obj.userData.lean = Math.min(1.2, hit.obj.userData.lean + 0.4);
      fxImpact(endX, endY, endZ, hit.nx, hit.ny, hit.nz, 'map', PAL.mannequin);
      SFX.tone(520, 300, 0.12, 0.14, 'triangle', endX, endY, endZ);
    } else {
      fxImpact(endX, endY, endZ, hit.nx, hit.ny, hit.nz, 'map', impactSurfaceColor(hit));
    }
  }

  if (a.isPlayer) {
    vmFire(w);
    SFX.shoot(w.id);
    fxShake(w.id === 'shotgun' ? 0.34 : (w.id === 'rifle' ? 0.24 : 0.09));
    // view kick
    G.player.pitch = clamp(G.player.pitch + w.kickRot * rand(0.7, 1.15), -1.45, 1.45);
    G.player.yaw += rand(-1, 1) * w.kickRot * 0.35;
    setCrosshairPunch(w.id === 'shotgun' ? 14 : 7);
  } else {
    SFX.shoot(w.id, a.pos.x, a.pos.y + 1.3, a.pos.z);
  }
  if (!visualOnly && typeof netOnAuthoritativeShot === 'function')
    netOnAuthoritativeShot(a, w, shotLines);
  return true;
}

/* `fireSeq` is carried only so the resulting event can name the shot that
   caused it, letting a guest match the answer to the hit it already predicted.
   It plays no part in resolving the damage itself. */
function applyDamage(target, dmg, from, head, hx, hy, hz, fireSeq) {
  if (!target.alive) return;
  /* Spawn shield. Eight bots on a map this small means you can be dead
     within a second of appearing — playtesting gave three deaths in ~14s.
     A short bubble makes respawns survivable; it pops the moment you shoot,
     so it can't be camped behind. */
  if (target.shield > 0) {
    if (from) fxShieldHit(target, hx, hy, hz);
    if (typeof netOnAuthoritativeShieldHit === 'function')
      netOnAuthoritativeShieldHit(target, from, hx, hy, hz, fireSeq);
    return;
  }
  target.health -= dmg;
  target.flinch = 1;
  target.lastHitBy = from ? from.id : null;
  target.lastHitT = G.time;
  if (target.plate) drawPlate(target.plate, target.name, Math.max(0, target.health), target.maxHealth, target.colors.body);

  if (from && from.isPlayer) {
    SFX.hit(head);
    showHitmarker(head);
    addFloater(head ? Math.round(dmg) + '!' : String(Math.round(dmg)), hx, hy, hz,
               head ? '#fff0a8' : '#ffffff', head);
  }
  if (target.isPlayer) {
    SFX.hurt();
    flashDamage();
    if (from) addDamageDir(from);
    fxShake(0.18);
  }
  if (typeof netOnAuthoritativeDamage === 'function')
    netOnAuthoritativeDamage(target, from, dmg, head, hx, hy, hz, fireSeq);
  if (target.health <= 0) killActor(target, from);
}

function killActor(target, from) {
  target.alive = false;
  target.health = 0;
  target.deathT = 0;
  target.deathDir = rng() < 0.5 ? -1 : 1;
  target.respawnT = CFG.respawn;
  target.deaths++;
  target.streak = 0;
  target.aiming = false;
  fxKillBurst(target.pos.x, target.pos.y, target.pos.z, C(target.colors.body));
  if (target.plate) target.plate.sprite.visible = false;

  if (from && from !== target) {
    from.kills++;
    from.streak++;
    from.bestStreak = Math.max(from.bestStreak, from.streak);
    if (from.isPlayer) {
      SFX.kill();
      addFloater('+1', target.pos.x, target.pos.y + 1.6, target.pos.z, '#b8f2d8', true);
      if (from.streak >= 3) showHint(from.streak + ' IN A ROW!');
    }
  }
  addKillFeed(from, target);
  if (typeof netOnAuthoritativeKill === 'function') netOnAuthoritativeKill(target, from);
  if (target.isPlayer) { SFX.die(); showDeadScreen(from); }
  refreshBoard();

  const top = G.actors.reduce((m, a) => a.kills > m.kills ? a : m, G.actors[0]);
  if (top.kills >= CFG.killsToWin && !G.over) endMatch(top);
}

function endMatch(winner) {
  G.over = true;
  G.winner = winner;
  G.paused = false;
  document.getElementById('title').classList.add('off');
  const dead = document.getElementById('dead');
  dead.classList.add('off');
  delete dead.dataset.wasUp;
  showOverScreen(winner);
  if (winner.isPlayer) SFX.win();
  if (typeof netOnAuthoritativeMatchOver === 'function') netOnAuthoritativeMatchOver(winner);
  exitPointerLock();
}

/* =====================================================================
   PLAYER INPUT
   ===================================================================== */
const KEY = {};
/* A second movement source, left at rest for keyboard play. Filled in by the
   touch layer; merged into intent by readLocalInput rather than by teaching
   every consumer about it. `on` is the mode flag the touch layer raises once
   it takes over — pointer lock in particular has to stand down when it does. */
const TOUCH = { on: false, fwd: 0, strafe: 0, jump: false, sprint: false };
const IN = {
  lookDX: 0, lookDY: 0, firing: false, sprinting: false, locked: false,
  fireSeq: 0, fireRenderTime: 0, reloadSeq: 0,
  touchSemiArmed: false, _releaseFireAfterTick: false
};
/* What the slider stores is the multiplier, not the product, so the base can
   be retuned later without silently changing the feel for everyone who already
   saved a value. Desktop only: the touch layer's drag sensitivity is in
   different units (radians per CSS pixel, not per mouse count) and keeps its
   own constant. */
const MOUSE_SENS_BASE = 0.0021;
const SENS_MIN = 0.4, SENS_MAX = 2.8;
let mouseSens = MOUSE_SENS_BASE;

function setSensMultiplier(mult) {
  const m = clamp(Number(mult) || 1, SENS_MIN, SENS_MAX);
  mouseSens = MOUSE_SENS_BASE * m;
  return m;
}

/* Held as the multiplier the maths wants rather than the boolean the checkbox
   has, so applyLook stays one multiply and no second site has to remember
   which way round the flag reads. Applies to both input sources, unlike
   sensitivity: a thumb drag can be upside down just as a mouse can. */
let invertY = 1;

function setInvertY(on) {
  invertY = on ? -1 : 1;
  return !!on;
}

/* Firing is an edge, not a level: `fireSeq` is how the host names a shot and
   how a guest matches the answer back to it. So pressing has to go through a
   call that owns the increment, not a flag another input source can set behind
   the game's back and skip the sequence. */
function pressFire() {
  if (!IN.firing) {
    IN.fireSeq++;
    if (typeof netDisplayedRenderTime === 'function')
      IN.fireRenderTime = netDisplayedRenderTime();
  }
  IN.firing = true;
}

function releaseFire() { IN.firing = false; }

/* A release-fired touch shot has to remain a level for the simulation tick
   that sees its edge. Clearing it in the pointer handler would make solo and
   guest prediction miss the shot entirely. */
function pulseFireForTick() {
  if (IN.firing) return false;
  pressFire();
  IN._releaseFireAfterTick = true;
  return true;
}

function cancelFirePulse() {
  IN._releaseFireAfterTick = false;
  releaseFire();
}

/* The one place player intent is read. It used to be read straight off KEY/IN
   at each use site, which meant the local simulation and the guest's input
   packet each had their own copy of what "moving forward" means -- two copies
   that had to be kept in agreement by hand.

   The movement fields are floats, not -1/0/1, because a thumbstick can push
   part way. A key cannot: it is either down or not, and down means full
   deflection. So a held key wins and touch fills in underneath it, which keeps
   a hybrid laptop from cancelling one source against the other. */
function readLocalInput(accepts) {
  if (!accepts) return { fwd: 0, strafe: 0, jump: false, sprint: false, fire: false };
  const kFwd = (KEY.KeyW ? 1 : 0) - (KEY.KeyS ? 1 : 0);
  const kStrafe = (KEY.KeyD ? 1 : 0) - (KEY.KeyA ? 1 : 0);
  return {
    fwd: kFwd || TOUCH.fwd,
    strafe: kStrafe || TOUCH.strafe,
    jump: !!KEY.Space || TOUCH.jump,
    sprint: !!KEY.ShiftLeft || !!KEY.ShiftRight || TOUCH.sprint,
    fire: !!IN.firing
  };
}

/* Shared by mouse-look and touch-drag; they differ only in sensitivity. */
function applyLook(dx, dy, sens) {
  if (!G.player) return;
  /* Flipped here rather than on the pitch line below, because IN.lookDY is
     also what the viewmodel sways against -- the gun trailing the camera it
     is attached to. Invert the pitch alone and an inverted player's gun
     swings the wrong way on every vertical flick. */
  dy *= invertY;
  G.player.yaw -= dx * sens;
  G.player.pitch = clamp(G.player.pitch - dy * sens, -1.45, 1.45);
  IN.lookDX = clamp(IN.lookDX + dx * 0.006, -1, 1);
  IN.lookDY = clamp(IN.lookDY + dy * 0.006, -1, 1);
}

function initInput() {
  addEventListener('keydown', e => {
    if (e.code === 'Tab') e.preventDefault();
    KEY[e.code] = true;
    if (!G.started) return;
    if (e.code === 'KeyR' && !e.repeat) { IN.reloadSeq++; tryReload(G.player); }
    if (e.code === 'Digit1') switchWeapon('smg');
    if (e.code === 'Digit2') switchWeapon('shotgun');
    if (e.code === 'Digit3') switchWeapon('rifle');
    if (e.code === 'Tab') setBoard(true);
    if (e.code === 'Escape') { /* browser exits lock; handled below */ }
  });
  addEventListener('keyup', e => {
    KEY[e.code] = false;
    if (e.code === 'Tab') setBoard(false);
  });
  addEventListener('mousedown', e => {
    if (IN.locked && e.button === 0) pressFire();
  });
  addEventListener('mouseup', e => { if (e.button === 0) releaseFire(); });
  addEventListener('wheel', e => {
    if (!IN.locked) return;
    const order = ['smg', 'shotgun', 'rifle'];
    const i = order.indexOf(G.player.weapon);
    switchWeapon(order[(i + (e.deltaY > 0 ? 1 : order.length - 1)) % order.length]);
  }, { passive: true });

  addEventListener('mousemove', e => {
    if (!IN.locked) return;
    applyLook(e.movementX || 0, e.movementY || 0, mouseSens);
  });

  document.addEventListener('pointerlockchange', () => {
    IN.locked = document.pointerLockElement === canvas;
    /* Losing the lock is the desktop pause gesture, because on desktop it
       means the cursor is loose and the player has stopped playing. Once
       the on-screen controls are up that inference is wrong — a phone
       never holds the lock in the first place, so honouring it there
       would pause the match on the way in and never let it resume. The
       touch layer has its own pause button. */
    if (TOUCH.on) return;
    if (!IN.locked && G.started && !G.over) setPaused(true);
    else if (IN.locked) setPaused(false);
  });

  initSensSlider();
  initInvertToggle();
}

/* The slider lives in #menu without `setup-only`, so the same control serves
   the title screen and the pause card — which is where you actually notice
   the aim is wrong. Clamped on read: a hand-edited localStorage value must
   not be able to leave someone unable to turn around. */
function initSensSlider() {
  const el = document.getElementById('sensRange');
  const out = document.getElementById('sensVal');
  if (!el) return;
  let saved = null;
  try { saved = localStorage.getItem('pastel-nuketown-sens'); } catch (e) {}
  const show = m => { el.value = m; if (out) out.textContent = m.toFixed(2) + '×'; };
  show(setSensMultiplier(saved === null ? 1 : parseFloat(saved)));
  el.addEventListener('input', () => {
    const m = setSensMultiplier(el.value);
    if (out) out.textContent = m.toFixed(2) + '×';
    try { localStorage.setItem('pastel-nuketown-sens', String(m)); } catch (e) {}
  });
}

/* Sits against the slider for the same reason it sits in #menu at all: this is
   a setting you go looking for next to the other aim setting, and the moment
   you notice you want it is mid-match, with the pause card up. Anything that
   is not '1' reads as off, so a hand-edited value can only ever mean normal. */
function initInvertToggle() {
  const el = document.getElementById('invertY');
  if (!el) return;
  let saved = null;
  try { saved = localStorage.getItem('pastel-nuketown-invert-y'); } catch (e) {}
  el.checked = setInvertY(saved === '1');
  el.addEventListener('change', () => {
    setInvertY(el.checked);
    try { localStorage.setItem('pastel-nuketown-invert-y', el.checked ? '1' : '0'); } catch (e) {}
  });
}
/* Pointer Lock throws if there was no user gesture (autostart, headless).
   That's not fatal — the match still runs, you just aren't mouse-looking. */
function requestLock() {
  try {
    /* Not merely pointless on touch — actively harmful. Mobile Chrome
       grants the lock, and a locked pointer routes every pointermove to
       the canvas with frozen clientX/clientY. That is precisely the
       stream the stick and look zones read, so the controls go dead
       while looking like they were pressed. */
    if (TOUCH.on) return;
    if (!canvas.requestPointerLock) return;
    const r = canvas.requestPointerLock();       // newer Chrome returns a Promise
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) {}
}
function exitPointerLock() { try { if (document.exitPointerLock) document.exitPointerLock(); } catch (e) {} }

function switchWeapon(id) {
  if (!WBY[id] || G.player.weapon === id) return;
  if (typeof netOnLocalWeaponChanged === 'function') netOnLocalWeaponChanged();
  G.player.weapon = id;
  const w = WBY[id];
  if (G.player.ammo > w.mag) G.player.ammo = w.mag;
  if (!G.player._ammoBy) G.player._ammoBy = {};
  // keep per-weapon ammo so switching isn't a free reload
  const store = G.player._ammoBy;
  if (store[id] === undefined) store[id] = { ammo: w.mag, reserve: w.reserve };
  G.player.ammo = store[id].ammo; G.player.reserve = store[id].reserve;
  G.player.reloadT = 0;
  vmSetWeapon(id);
  SFX.swap();
  updateHUD();
}
function syncPlayerAmmoStore() {
  const p = G.player;
  if (!p._ammoBy) p._ammoBy = {};
  p._ammoBy[p.weapon] = { ammo: p.ammo, reserve: p.reserve };
}
/* A new life arrives with every gun topped up, not just the one in your hands.
   The per-weapon store outlives the death that emptied it, so refilling only
   the held weapon meant the first swap after a respawn handed back the dry
   magazine you died holding — with no reserve left to reload it from. */
function refillAmmoStore(a) {
  if (!a._ammoBy) a._ammoBy = {};
  for (const w of WEAPONS) a._ammoBy[w.id] = { ammo: w.mag, reserve: w.reserve };
}

/* =====================================================================
   SIMULATION STEP  (fixed 1/60)
   ===================================================================== */
/* The one place a human actor's movement is integrated.

   stepPlayer runs it for the player at the controls, stepRemotePlayer runs it
   on the authority for everyone else, and a guest's reconciliation replays
   unacknowledged input back through it. Three callers that must agree exactly:
   drift between them is not a bug that shows up as a wrong number, it is a
   correction the player feels as their own body being dragged. Two of them
   used to be hand-kept transcriptions of the same arithmetic. */
function applyMovement(a, input, dt) {
  const fwd = clamp(input.fwd || 0, -1, 1);
  const str = clamp(input.strafe || 0, -1, 1);
  const w = WBY[a.weapon];
  let speed = CFG.playerSpeed * w.speed;
  const sprinting = !!input.sprint && fwd > 0 && !input.fire && a.reloadT <= 0;
  if (sprinting) speed *= CFG.sprintMul;

  /* forward = (sin y, cos y); right = cross(forward, up) = (-cos y, sin y).
     Getting this sign wrong makes D strafe left, which is subtle enough to
     ship: you still move sideways, just the wrong way. */
  const sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
  let mx = sy * fwd - cy * str;
  let mz = cy * fwd + sy * str;
  const ml = Math.hypot(mx, mz);
  /* Clamp rather than normalize. Normalizing scaled every non-zero push up to
     full speed, which is identical for keys -- straight is 1, diagonal is
     sqrt(2), both meant "go" -- but flattened a half-pushed thumbstick into a
     sprint. Dividing only when the vector is longer than unit leaves keyboard
     movement bit-for-bit unchanged and lets an analog push mean what it says. */
  if (ml > 1) { mx /= ml; mz /= ml; }
  mx *= speed; mz *= speed;

  const acc = a.onGround ? CFG.accelGround : CFG.accelAir;
  a.vel.x = damp(a.vel.x, mx, acc, dt);
  a.vel.z = damp(a.vel.z, mz, acc, dt);
  if (input.jump && a.onGround) { a.vel.y = JUMP_V; a.onGround = false; }

  const res = moveActor(a.pos, a.vel, dt, {});
  const wasGround = a.onGround;
  a.onGround = res.onGround;
  return { sprinting: sprinting, landed: !wasGround && a.onGround };
}

function stepPlayer(a, dt) {
  a.aimYaw = a.yaw; a.aimPitch = a.pitch;
  if (!a.alive) {
    /* The tick that would have spent this pulse never ran, and the branch below
       returns before it can be cleared. Left set, it survives the respawn and
       spends itself on a shot nobody asked for -- which also pops the spawn
       shield the moment it is granted. */
    if (IN._releaseFireAfterTick) cancelFirePulse();
    if (typeof netIsGuest === 'function' && netIsGuest()) return;
    a.respawnT -= dt;
    if (a.respawnT <= 0) { respawnActor(a); hideDeadScreen(); }
    return;
  }
  const inp = readLocalInput(!G.paused);
  const firing = inp.fire;
  IN.sprinting = inp.sprint;

  /* Booked before the step, so a replay re-applies exactly what this tick was
     given rather than a later sample of the same keys. */
  if (typeof netRecordPredictedStep === 'function') netRecordPredictedStep(inp, dt);

  const moved = applyMovement(a, inp, dt);
  const sprinting = moved.sprinting;
  if (moved.landed) { VM.landDip = 1; SFX.step(); fxShake(0.05); }

  // footsteps
  const spd = Math.hypot(a.vel.x, a.vel.z);
  if (a.onGround && spd > 1.2) {
    a.stepPhase += dt * (spd * 0.62);
    if (a.stepPhase > 1) { a.stepPhase -= 1; SFX.step(); }
  }

  if (a.reloadT > 0) { a.reloadT -= dt; if (a.reloadT <= 0) finishReload(a); }
  if (a.fireCd > 0) a.fireCd -= dt;
  a.aiming = firing || IN.touchSemiArmed || (!sprinting && spd < 4.5);

  if (firing && !sprinting) {
    const w2 = WBY[a.weapon];
    if (w2.auto) fireWeapon(a, IN.fireSeq);
    else if (!IN._heldSemi) { if (fireWeapon(a, IN.fireSeq)) IN._heldSemi = true; }
  }
  if (!firing) IN._heldSemi = false;
  if (firing && IN._releaseFireAfterTick) {
    IN._releaseFireAfterTick = false;
    releaseFire();
  }
  syncPlayerAmmoStore();
}

function switchRemoteWeapon(a, id) {
  if (!WBY[id] || a.weapon === id) return;
  if (!a._ammoBy) a._ammoBy = {};
  a._ammoBy[a.weapon] = { ammo: a.ammo, reserve: a.reserve };
  a.weapon = id;
  const w = WBY[id];
  const saved = a._ammoBy[id] || { ammo: w.mag, reserve: w.reserve };
  a.ammo = clamp(saved.ammo, 0, w.mag);
  a.reserve = Math.max(0, saved.reserve);
  a.reloadT = 0;
  if (typeof netOnAuthoritySlowStateChanged === 'function')
    netOnAuthoritySlowStateChanged();
}

/* The host simulates remote humans from their latest sequenced input.
   This intentionally mirrors local movement, but omits camera/viewmodel UI. */
function stepRemotePlayer(a, dt) {
  /* Consume one queued input per tick, matching the rate the guest predicted
     with, so the two simulations apply the same stream in the same order.
     Falling behind is worse than skipping: if the queue has run long, take the
     extra now rather than replaying old intent late. */
  if (a.netInputQueue && a.netInputQueue.length) {
    if (a.netInputQueue.length > 3) a.netInputQueue.splice(0, a.netInputQueue.length - 3);
    a.netInput = a.netInputQueue.shift();
    a.netInputAt = G.time;
  }
  const fresh = a.netInput && G.time - (a.netInputAt || 0) <= 0.45;
  const it = fresh ? a.netInput : {
    fwd: 0, strafe: 0, jump: false, sprint: false, fire: false,
    fireSeq: a.lastFireSeq, reloadSeq: a.lastReloadSeq,
    yaw: a.yaw, pitch: a.pitch, weapon: a.weapon,
    seq: a.inputAck, weaponSeq: a.weaponAck, renderTime: G.time
  };
  if (fresh) {
    a.inputAck = it.seq;
    if (it.weaponSeq > a.weaponAck) switchRemoteWeapon(a, it.weapon);
    a.weaponAck = it.weaponSeq;
  }

  const fireEdge = it.fireSeq > a.lastFireSeq;
  /* Death is a permanent blocker for this life. Consume its edges before
     returning so a late tap cannot turn into a shot immediately on respawn. */
  if (!a.alive) {
    if (fireEdge) a.lastFireSeq = it.fireSeq;
    a.pendingFireUntil = 0;
    a.pendingFireSeq = 0;
    a.pendingRenderTime = 0;
    a.respawnT -= dt;
    if (a.respawnT <= 0) {
      respawnActor(a);
      if (a.plate) a.plate.sprite.visible = true;
    }
    return;
  }

  a.yaw = Number.isFinite(it.yaw) ? it.yaw : a.yaw;
  a.pitch = Number.isFinite(it.pitch) ? clamp(it.pitch, -1.45, 1.45) : a.pitch;
  a.aimYaw = a.yaw; a.aimPitch = a.pitch;

  if (it.reloadSeq > a.lastReloadSeq) {
    a.lastReloadSeq = it.reloadSeq;
    tryReload(a);
  }

  /* The same integrator the sender predicted with, which is the only reason a
     guest's replay can converge on this. */
  const w = WBY[a.weapon];
  const sprinting = applyMovement(a, it, dt).sprinting;
  if (a.reloadT > 0) { a.reloadT -= dt; if (a.reloadT <= 0) finishReload(a); }
  if (a.fireCd > 0) a.fireCd -= dt;

  const spd = Math.hypot(a.vel.x, a.vel.z);
  a.aiming = !!it.fire || (!sprinting && spd < 4.5);
  /* A guest samples its input roughly every 33ms, so a click that starts and
     ends inside one packet never appears as a held `fire`. The fireSeq edge is
     what carries a fast tap across the wire — auto weapons need to honour it
     too, or the SMG silently eats quick taps. */
  /* Acknowledge the tap even when sprinting swallowed it. Leaving it unacked
     buffers the shot, which then goes off by itself the instant sprint ends. */
  if (fireEdge) {
    a.lastFireSeq = it.fireSeq;
    const decision = NETP.classifyFireIntent(
      a.alive, sprinting, a.fireCd, a.reloadT, a.ammo);
    if (decision === 'retain') {
      a.pendingFireUntil = G.time + NETP.FIRE_INTENT_TTL;
      a.pendingFireSeq = it.fireSeq;
      a.pendingRenderTime = it.renderTime;
    } else {
      a.pendingFireUntil = 0;
      a.pendingFireSeq = 0;
      a.pendingRenderTime = 0;
      /* Empty-magazine taps still start the normal automatic reload, but the
         tap itself is not kept waiting for that reload to finish. */
      if (!sprinting) fireWeapon(a, it.fireSeq, it.renderTime);
    }
  }

  if (a.pendingFireUntil > 0) {
    const decision = NETP.classifyFireIntent(
      a.alive, sprinting, a.fireCd, a.reloadT, a.ammo);
    if (G.time > a.pendingFireUntil || decision === 'drop') {
      a.pendingFireUntil = 0;
      a.pendingFireSeq = 0;
      a.pendingRenderTime = 0;
    } else if (decision === 'fire') {
      a.pendingFireUntil = 0;
      const pendingSeq = a.pendingFireSeq;
      const pendingTime = a.pendingRenderTime;
      a.pendingFireSeq = 0;
      a.pendingRenderTime = 0;
      fireWeapon(a, pendingSeq, pendingTime);
    }
  }
  if (!sprinting && w.auto && it.fire) fireWeapon(a, it.fireSeq, it.renderTime);

  if (!a._ammoBy) a._ammoBy = {};
  a._ammoBy[a.weapon] = { ammo: a.ammo, reserve: a.reserve };
  if (a.onGround && spd > 1.2) {
    a.stepPhase += dt * (spd * 0.62);
    if (a.stepPhase > 1) {
      a.stepPhase -= 1;
      SFX.step(a.pos.x, a.pos.y, a.pos.z);
    }
  }
}

const _viewSelf = { id: 0, pos: null, vel: null, yaw: 0, pitch: 0, health: 0, maxHealth: 0,
                    ammo: 0, magSize: 0, reserve: 0, onGround: false, reloading: false };
const _viewOthers = [];
const _view = { time: 0, nav: null, rng: rng, self: _viewSelf, actors: _viewOthers, canSee: canSee };

function stepBot(a, dt) {
  if (!a.alive) {
    a.respawnT -= dt;
    if (a.respawnT <= 0) { respawnActor(a); if (a.plate) a.plate.sprite.visible = true; }
    return;
  }
  const w = WBY[a.weapon];

  _viewOthers.length = 0;
  for (const o of G.actors) if (o !== a) _viewOthers.push(o);
  _viewSelf.id = a.id; _viewSelf.pos = a.pos; _viewSelf.vel = a.vel;
  _viewSelf.yaw = yawFlip(a.aimYaw); _viewSelf.pitch = a.aimPitch;   // -> contract yaw
  _viewSelf.health = a.health; _viewSelf.maxHealth = a.maxHealth;
  _viewSelf.ammo = a.ammo; _viewSelf.magSize = w.mag; _viewSelf.reserve = a.reserve;
  _viewSelf.onGround = a.onGround; _viewSelf.reloading = a.reloadT > 0;
  _view.time = G.time; _view.nav = G.nav;

  let it;
  if (a.brain && G.aiOK) {
    try { it = AI.think(a.brain, _view, dt); }
    catch (e) { G.aiErr = String(e && e.message || e); a.brain = null; it = fallbackThink(a, dt); }
  } else it = fallbackThink(a, dt);
  if (!it) it = fallbackThink(a, dt);

  // sanitise: a NaN here would silently teleport a bot out of the world
  let mvx = Number.isFinite(it.moveX) ? clamp(it.moveX, -1, 1) : 0;
  let mvz = Number.isFinite(it.moveZ) ? clamp(it.moveZ, -1, 1) : 0;
  a.aimYaw = Number.isFinite(it.aimYaw) ? yawFlip(it.aimYaw) : a.aimYaw;   // contract -> engine
  a.aimPitch = Number.isFinite(it.aimPitch) ? clamp(it.aimPitch, -1.5, 1.5) : 0;
  a.state = it.state || '';

  const ml = Math.hypot(mvx, mvz);
  const speed = CFG.botSpeed * w.speed;
  if (ml > 1e-4) { mvx = mvx / ml * speed; mvz = mvz / ml * speed; }
  const acc = a.onGround ? CFG.accelGround : CFG.accelAir;
  a.vel.x = damp(a.vel.x, mvx, acc, dt);
  a.vel.z = damp(a.vel.z, mvz, acc, dt);
  if (it.jump && a.onGround) { a.vel.y = JUMP_V; a.onGround = false; }

  const res = moveActor(a.pos, a.vel, dt, {});
  a.onGround = res.onGround;

  if (a.reloadT > 0) { a.reloadT -= dt; if (a.reloadT <= 0) finishReload(a); }
  if (a.fireCd > 0) a.fireCd -= dt;
  if (it.reload) tryReload(a);
  a.aiming = !!it.targetId;
  if (it.fire) fireWeapon(a);

  const spd = Math.hypot(a.vel.x, a.vel.z);
  if (a.onGround && spd > 1.2) {
    a.stepPhase += dt * (spd * 0.6);
    if (a.stepPhase > 1) { a.stepPhase -= 1; SFX.step(a.pos.x, a.pos.y, a.pos.z); }
  }
}

function simulate(dt) {
  G.time += dt;
  G.tick++;
  for (const a of G.actors) if (a.shield > 0) a.shield = Math.max(0, a.shield - dt);
  stepPlayer(G.player, dt);
  const guest = typeof netIsGuest === 'function' && netIsGuest();
  for (const a of G.actors) {
    if (a.isPlayer) continue;
    if (guest) {
      if (typeof netStepReplica === 'function') netStepReplica(a, dt);
    } else if (a.controller === 'remote') {
      stepRemotePlayer(a, dt);
    } else if (a.controller === 'bot') {
      stepBot(a, dt);
    }
  }

  // mannequins settle back upright after being shot
  for (const m of WORLD.mannequins) {
    const u = m.userData;
    if (Math.abs(u.spin) > 0.001) {
      m.rotation.y += u.spin * dt;
      u.spin *= Math.exp(-2.6 * dt);
      if (Math.abs(u.spin) < 0.02) u.spin = 0;
    }
    if (u.lean > 0.001) {
      u.lean = Math.max(0, u.lean - dt * 0.9);
      m.rotation.z = Math.sin(u.lean * 9) * u.lean * 0.28;
    }
  }
  if (typeof netAfterSimulation === 'function') netAfterSimulation(dt);
}

/* =====================================================================
   MATCH / SCREEN FLOW
   ===================================================================== */
function startMatch() {
  SFX.init(); SFX.resume();
  setupMatch();
  G.started = true; G.over = false;
  G.paused = false; G.fixedAcc = 0;
  document.getElementById('title').classList.add('off');
  const dead = document.getElementById('dead');
  dead.classList.add('off');
  delete dead.dataset.wasUp;
  document.getElementById('over').classList.add('off');
  setDamageDirsCleared();
  restoreBoard();                       // put the scoreboard back on the HUD
  document.getElementById('hud').classList.remove('hide');
  vmSetWeapon('smg', true);
  document.getElementById('play').textContent = 'SOLO';
  const again = document.getElementById('again');
  again.disabled = false;
  again.textContent = 'REMATCH';
  showHint('FIRST TO ' + CFG.killsToWin + ' KILLS');
  touchEnterImmersive();                  // no-op unless this is a phone
  requestLock();
}
