/* =====================================================================
   PASTEL NUKETOWN — game: actors, player control, combat, match flow
   ===================================================================== */

const CFG = {
  bots: 8,
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

/* =====================================================================
   ACTOR
   ===================================================================== */
let _nextId = 1;
function makeActor(opts) {
  const a = {
    id: _nextId++,
    name: opts.name,
    isPlayer: !!opts.isPlayer,
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
    brain: null, char: null, plate: null, blob: null, bubble: null, state: 'idle'
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
  if (a.brain && G.aiOK && AI.resetBrain) { try { AI.resetBrain(a.brain); } catch (e) {} }
  if (a.char) { a.char.root.visible = true; a.char.root.scale.setScalar(0.001); }
  if (a.plate) drawPlate(a.plate, a.name, a.health, a.maxHealth, a.colors.body);
  fxSpawnPuff(a.pos.x, a.pos.y, a.pos.z, C(a.colors.body));
  if (a.isPlayer) { SFX.spawn(); setDamageDirsCleared(); }
}

/* =====================================================================
   SETUP
   ===================================================================== */
function setupMatch() {
  for (const a of G.actors) {
    if (a.char) scene.remove(a.char.root);
    if (a.blob) scene.remove(a.blob);
    if (a.bubble) scene.remove(a.bubble);
  }
  G.actors.length = 0;
  _nextId = 1;
  G.time = 0; G.over = false; G.winner = null;

  const player = makeActor({ name: 'YOU', isPlayer: true, colors: PLAYER_COLOR, weapon: 'smg' });
  player.blob = makeBlobShadow();     // only ever seen in the death cam
  player.bubble = makeBubble();       // ditto, plus it shows in the death cam
  G.player = player;
  G.actors.push(player);

  const skills = ['easy', 'normal', 'normal', 'hard', 'normal', 'hard', 'easy', 'normal'];
  const guns   = ['smg', 'shotgun', 'smg', 'rifle', 'smg', 'shotgun', 'rifle', 'smg'];
  for (let i = 0; i < CFG.bots; i++) {
    const col = BOT_COLORS[i % BOT_COLORS.length];
    const b = makeActor({ name: col.name.toUpperCase(), colors: col, weapon: guns[i % guns.length], skill: skills[i % skills.length] });
    if (G.aiOK) {
      try { b.brain = AI.createBrain({ id: b.id, seed: 1000 + i * 77, skill: b.skill }); }
      catch (e) { b.brain = null; G.aiErr = String(e); }
    }
    attachCharacter(b);
    G.actors.push(b);
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
  if (a.isPlayer) SFX.reloadDone(); else SFX.reloadDone(a.pos.x, a.pos.y + 1.2, a.pos.z);
}

function fireWeapon(a) {
  const w = WBY[a.weapon];
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

  // muzzle origin for tracers: bots use their gun, the player uses the viewmodel
  let mx = ex, my = ey, mz = ez;
  if (!a.isPlayer && a.char) {
    a.char.muzzle.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(a.char.muzzle.matrixWorld);
    mx = p.x; my = p.y; mz = p.z;
  }

  for (let p = 0; p < w.pellets; p++) {
    const yaw = a.aimYaw + rand(-spread, spread) * (p ? 1.6 : 0.35);
    const pit = a.aimPitch + rand(-spread, spread) * (p ? 1.6 : 0.35);
    const cp = Math.cos(pit);
    const dx = Math.sin(yaw) * cp, dy = Math.sin(pit), dz = Math.cos(yaw) * cp;
    const hit = hitscan(ex, ey, ez, dx, dy, dz, w.range, G.actors, a.id);
    const endX = hit ? hit.px : ex + dx * w.range;
    const endY = hit ? hit.py : ey + dy * w.range;
    const endZ = hit ? hit.pz : ez + dz * w.range;

    if (p === 0 || w.pellets <= 3 || p % 3 === 0)
      fxTracer(mx, my, mz, endX, endY, endZ, C(a.isPlayer ? (w.tracer || 0xfff0c0) : a.colors.trim));

    if (!hit) continue;
    if (hit.kind === 'actor') {
      const dmg = w.dmg * (hit.head ? w.headMul : 1);
      applyDamage(hit.actor, dmg, a, hit.head, endX, endY, endZ);
      fxImpact(endX, endY, endZ, hit.nx, hit.ny, hit.nz, 'actor');
    } else if (hit.kind === 'mannequin') {
      hit.obj.userData.spin += rand(3, 7) * (rng() < 0.5 ? -1 : 1);
      hit.obj.userData.lean = Math.min(1.2, hit.obj.userData.lean + 0.4);
      fxImpact(endX, endY, endZ, hit.nx, hit.ny, hit.nz, 'map');
      SFX.tone(520, 300, 0.12, 0.14, 'triangle', endX, endY, endZ);
    } else {
      fxImpact(endX, endY, endZ, hit.nx, hit.ny, hit.nz, 'map');
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
  return true;
}

function applyDamage(target, dmg, from, head, hx, hy, hz) {
  if (!target.alive) return;
  /* Spawn shield. Eight bots on a map this small means you can be dead
     within a second of appearing — playtesting gave three deaths in ~14s.
     A short bubble makes respawns survivable; it pops the moment you shoot,
     so it can't be camped behind. */
  if (target.shield > 0) {
    if (from) fxShieldHit(target, hx, hy, hz);
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
  if (target.isPlayer) { SFX.die(); showDeadScreen(from); }
  refreshBoard();

  const top = G.actors.reduce((m, a) => a.kills > m.kills ? a : m, G.actors[0]);
  if (top.kills >= CFG.killsToWin && !G.over) endMatch(top);
}

function endMatch(winner) {
  G.over = true;
  G.winner = winner;
  showOverScreen(winner);
  if (winner.isPlayer) SFX.win();
  exitPointerLock();
}

/* =====================================================================
   PLAYER INPUT
   ===================================================================== */
const KEY = {};
const IN = { lookDX: 0, lookDY: 0, firing: false, sprinting: false, locked: false };
let mouseSens = 0.0021;

function initInput() {
  addEventListener('keydown', e => {
    if (e.code === 'Tab') e.preventDefault();
    KEY[e.code] = true;
    if (!G.started) return;
    if (e.code === 'KeyR') tryReload(G.player);
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
  addEventListener('mousedown', e => { if (IN.locked && e.button === 0) IN.firing = true; });
  addEventListener('mouseup', e => { if (e.button === 0) IN.firing = false; });
  addEventListener('wheel', e => {
    if (!IN.locked) return;
    const order = ['smg', 'shotgun', 'rifle'];
    const i = order.indexOf(G.player.weapon);
    switchWeapon(order[(i + (e.deltaY > 0 ? 1 : order.length - 1)) % order.length]);
  }, { passive: true });

  addEventListener('mousemove', e => {
    if (!IN.locked) return;
    const dx = e.movementX || 0, dy = e.movementY || 0;
    G.player.yaw -= dx * mouseSens;
    G.player.pitch = clamp(G.player.pitch - dy * mouseSens, -1.45, 1.45);
    IN.lookDX = clamp(IN.lookDX + dx * 0.006, -1, 1);
    IN.lookDY = clamp(IN.lookDY + dy * 0.006, -1, 1);
  });

  document.addEventListener('pointerlockchange', () => {
    IN.locked = document.pointerLockElement === canvas;
    if (!IN.locked && G.started && !G.over) setPaused(true);
    else if (IN.locked) setPaused(false);
  });
}
/* Pointer Lock throws if there was no user gesture (autostart, headless).
   That's not fatal — the match still runs, you just aren't mouse-looking. */
function requestLock() {
  try {
    if (!canvas.requestPointerLock) return;
    const r = canvas.requestPointerLock();       // newer Chrome returns a Promise
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (e) {}
}
function exitPointerLock() { try { if (document.exitPointerLock) document.exitPointerLock(); } catch (e) {} }

function switchWeapon(id) {
  if (!WBY[id] || G.player.weapon === id) return;
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

/* =====================================================================
   SIMULATION STEP  (fixed 1/60)
   ===================================================================== */
function stepPlayer(a, dt) {
  a.aimYaw = a.yaw; a.aimPitch = a.pitch;
  if (!a.alive) {
    a.respawnT -= dt;
    if (a.respawnT <= 0) { respawnActor(a); hideDeadScreen(); }
    return;
  }
  const fwd = (KEY.KeyW ? 1 : 0) - (KEY.KeyS ? 1 : 0);
  const str = (KEY.KeyD ? 1 : 0) - (KEY.KeyA ? 1 : 0);
  IN.sprinting = !!KEY.ShiftLeft || !!KEY.ShiftRight;

  const w = WBY[a.weapon];
  let speed = CFG.playerSpeed * w.speed;
  const sprinting = IN.sprinting && fwd > 0 && !IN.firing && a.reloadT <= 0;
  if (sprinting) speed *= CFG.sprintMul;

  /* forward = (sin y, cos y); right = cross(forward, up) = (-cos y, sin y).
     Getting this sign wrong makes D strafe left, which is subtle enough to
     ship: you still move sideways, just the wrong way. */
  const sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
  let mx = sy * fwd - cy * str;
  let mz = cy * fwd + sy * str;
  const ml = Math.hypot(mx, mz);
  if (ml > 1e-4) { mx = mx / ml * speed; mz = mz / ml * speed; }

  const acc = a.onGround ? CFG.accelGround : CFG.accelAir;
  a.vel.x = damp(a.vel.x, mx, acc, dt);
  a.vel.z = damp(a.vel.z, mz, acc, dt);
  if (KEY.Space && a.onGround) { a.vel.y = JUMP_V; a.onGround = false; }

  const res = moveActor(a.pos, a.vel, dt, {});
  const wasGround = a.onGround;
  a.onGround = res.onGround;
  if (!wasGround && a.onGround) { VM.landDip = 1; SFX.step(); fxShake(0.05); }

  // footsteps
  const spd = Math.hypot(a.vel.x, a.vel.z);
  if (a.onGround && spd > 1.2) {
    a.stepPhase += dt * (spd * 0.62);
    if (a.stepPhase > 1) { a.stepPhase -= 1; SFX.step(); }
  }

  if (a.reloadT > 0) { a.reloadT -= dt; if (a.reloadT <= 0) finishReload(a); }
  if (a.fireCd > 0) a.fireCd -= dt;
  a.aiming = IN.firing || (!sprinting && spd < 4.5);

  if (IN.firing && !sprinting) {
    const w2 = WBY[a.weapon];
    if (w2.auto) fireWeapon(a);
    else if (!IN._heldSemi) { if (fireWeapon(a)) IN._heldSemi = true; }
  }
  if (!IN.firing) IN._heldSemi = false;
  syncPlayerAmmoStore();
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
  for (const a of G.actors) if (a.shield > 0) a.shield = Math.max(0, a.shield - dt);
  stepPlayer(G.player, dt);
  for (const a of G.actors) if (!a.isPlayer) stepBot(a, dt);

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
}

/* =====================================================================
   MATCH / SCREEN FLOW
   ===================================================================== */
function startMatch() {
  SFX.init(); SFX.resume();
  setupMatch();
  G.started = true; G.over = false;
  document.getElementById('title').classList.add('off');
  document.getElementById('over').classList.add('off');
  restoreBoard();                       // put the scoreboard back on the HUD
  document.getElementById('hud').classList.remove('hide');
  vmSetWeapon('smg', true);
  showHint('FIRST TO ' + CFG.killsToWin + ' KILLS');
  requestLock();
}
