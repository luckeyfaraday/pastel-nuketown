/* =====================================================================
   PASTEL NUKETOWN — boot, camera, main loop, debug contract
   ===================================================================== */

const FIXED = 1 / 60;
let lastT = 0, titleOrbit = 0;
const PROF = { sim: 0, anim: 0, render: 0, frames: 0 };

/* Killcam placement. The state machine that decides WHOSE eyes these are
   lives in 70-game.js, next to the death and respawn it hangs off — and,
   more to the point, inside the part of the client net-sim.js actually
   loads, so its fallbacks can be tested. This is only the camera.

   Built exactly like the live first-person camera below, +PI and all, so what
   you see is framed the way the killer is seeing it and not a near-miss. */
function placeKillcam(k) {
  camera.position.set(k.pos.x, k.pos.y + ACT.eye, k.pos.z);
  camera.rotation.set(k.pitch, k.yaw + Math.PI, 0);
}

/* Death cam: up and BEHIND (forward is (sin yaw, cos yaw), so behind is the
   negative of that), and shortened if a wall is in the way — otherwise you
   die next to a house and spend the respawn staring at flat siding. */
function placeDeathCam(p) {
  const back = 4.2, up = 2.6;
  const dx = -Math.sin(p.yaw), dz = -Math.cos(p.yaw);
  const h = raycastMap(p.pos.x, p.pos.y + 1.2, p.pos.z, dx, 0, dz, back + 0.4);
  const d = h ? Math.max(0.9, h.dist - 0.45) : back;
  // if cover forced the camera in close, climb so it looks over it
  const y = up + (back - d) * 0.55;
  camera.position.set(p.pos.x + dx * d, p.pos.y + y, p.pos.z + dz * d);
  camera.lookAt(p.pos.x, p.pos.y + 0.9, p.pos.z);
}

/* ---------------------------------------------------------------- */
function updateCamera(dt) {
  if (G.frozen) return;                       // screenshotPose owns the camera
  const p = G.player;

  /* Resolved ahead of the early returns below, and the hidden body put back
     through the same call, so a match that ends or pauses mid-killcam does not
     leave one player invisible to somebody who can still see the world. The
     clock stops while paused for the same reason the simulation does. */
  let kc = null;
  if (p && !p.alive && G.started && !G.paused && !G.over) {
    KILLCAM.t += dt;
    kc = killcamActor();
  }
  killcamShow(kc);

  if (!G.started || G.paused) {               // slow orbit behind the title card
    titleOrbit += dt * 0.055;
    const r = 46, y = 19;
    camera.position.set(Math.cos(titleOrbit) * r, y + Math.sin(titleOrbit * 0.7) * 4, Math.sin(titleOrbit) * r * 0.72);
    camera.lookAt(0, 3.2, 0);
    return;
  }
  if (!p) return;

  if (!p.alive) { if (kc) placeKillcam(kc); else placeDeathCam(p); return; }

  const spd = Math.hypot(p.vel.x, p.vel.z);
  const bobA = p.onGround ? Math.min(spd / 7, 1) * 0.045 : 0;
  const bx = Math.cos(VM.bobT) * bobA * 0.6;
  const by = Math.abs(Math.sin(VM.bobT)) * -bobA;

  camera.position.set(p.pos.x + bx, p.pos.y + ACT.eye + by - VM.landDip * 0.16, p.pos.z);
  /* +PI because a three.js camera looks down -Z but engine yaw 0 means +Z.
     Without it you shoot and walk exactly opposite to where you're looking. */
  camera.rotation.set(p.pitch, p.yaw + Math.PI, 0);

  if (FX.shake > 0.001) {
    const s = FX.shake;
    camera.position.x += rand(-s, s) * 0.16;
    camera.position.y += rand(-s, s) * 0.16;
    camera.rotation.z += rand(-s, s) * 0.035;
  }
  /* Slight roll when strafing reads as weight. Read through the same
     function the simulation uses — this used to be a third transcription
     of "which way is the player leaning", and a stick would not have
     rolled the camera at all. Anything past the guards above is started
     and unpaused, so input is live by definition. */
  const str = readLocalInput(true).strafe;
  camera.rotation.z += damp(camera.rotation.z, -str * 0.022, 8, dt) * 0 + (-str * 0.022);
}

function animateAll(dt) {
  for (const a of G.actors) {
    updateBlobShadow(a.blob, a);
    updateBubble(a.bubble, a, G.time);
    if (a.isPlayer || !a.char) continue;
    a.char.root.position.set(a.pos.x, a.pos.y, a.pos.z);
    animateCharacter(a.char, a, dt, G.time);
    /* Re-asserted here, after updateCamera has decided whose eyes these are
       and after animateCharacter has posed the arms. This loop runs every
       frame and would otherwise put the head and torso straight back — which
       is what once filled the killcam with the inside of the killer's own
       skull. It is also what makes the restore in killcamShow safe. */
    if (!a.alive && a.deathT > 2.0) a.char.root.visible = false;
    else if (a.alive) a.char.root.visible = true;
    /* Deliberately last. The line above re-shows every live actor once a
       frame, so anything that hides one has to come after it or be undone
       before the frame is drawn — which is what once filled the killcam with
       the inside of the killer's own head. It is also what makes the restore
       in killcamShow safe: a body it misses comes back here on its own. */
    killcamDressActor(a, a === KILLCAM.shown);
  }
  updateMotes(G.time);
  updateMagic(G.time);
  updateFX(dt);
  updateFloaters(dt);
}

function renderAll() {
  renderer.autoClear = true;
  renderer.render(scene, camera);
  /* Dead normally means no viewmodel, because a corpse holds no gun. The
     killcam is the exception: the gun on screen is the killer's. */
  if (G.started && !G.paused && G.player && (G.player.alive || KILLCAM.shown) && !G.frozenNoVM) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(vmScene, vmCam);
    renderer.autoClear = true;
  }
}

/* =====================================================================
   ADAPTIVE RESOLUTION
   This renderer is fill-rate bound — measured on a software rasteriser,
   frame time tracks pixel count almost exactly (0.42x -> 20fps, 0.6x ->
   12fps) while geometry and particle counts barely register. So the one
   knob worth steering automatically is the drawing-buffer scale: aim for
   a playable frame time, and hand the pixels back when there's headroom.
   Flat cel colours upscale gracefully, which is what makes this viable.
   ===================================================================== */
const RES = {
  scale: 1, min: 0.4, max: 1, cool: 0, pinned: false,
  hist: [], target: 1 / 30, good: 1 / 55
};
/* Pin full resolution — the screenshot rig uses this so evidence frames show
   what a GPU user sees, not what this software rasteriser degraded to. */
function pinRes(on) {
  RES.pinned = !!on;
  renderer.setPixelRatio(on ? 1 : RES.scale);
  syncViewSize(true);
}
function initAdaptiveRes() {
  RES.max = SOFTWARE_GPU ? 0.72 : Math.min(devicePixelRatio || 1, 1.75);
  RES.min = SOFTWARE_GPU ? 0.38 : 0.6;
  RES.scale = SOFTWARE_GPU ? 0.5 : RES.max;
  renderer.setPixelRatio(RES.scale);
  syncViewSize(true);
}
function updateAdaptiveRes(dt) {
  RES.hist.push(dt);
  if (RES.hist.length > 24) RES.hist.shift();
  RES.cool -= dt;
  if (RES.pinned || RES.cool > 0 || RES.hist.length < 24) return;
  const med = RES.hist.slice().sort((a, b) => a - b)[12];
  let s = RES.scale;
  if (med > RES.target) s = Math.max(RES.min, s * 0.90);
  else if (med < RES.good) s = Math.min(RES.max, s * 1.06);
  if (Math.abs(s - RES.scale) > 0.005) {
    RES.scale = s;
    renderer.setPixelRatio(s);
    syncViewSize(true);
  }
  RES.cool = 0.7;
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!lastT) lastT = now;
  let dt = (now - lastT) / 1000;
  lastT = now;
  if (dt > 0.25) dt = 0.25;
  updateAdaptiveRes(dt);
  netFrame(now);

  if (!G.frozen) {
    /* A host owns the room simulation. Opening its local pause card must
       neutralise host input, but it must not freeze every connected guest. */
    if (G.started && !G.over && (!G.paused || netIsHost())) {
      G.fixedAcc += dt;
      let guard = 0;
      while (G.fixedAcc >= FIXED && guard++ < 6) { simulate(FIXED); G.fixedAcc -= FIXED; }
      if (guard >= 6) G.fixedAcc = 0;
    }
    IN.lookDX = damp(IN.lookDX, 0, 9, dt);
    IN.lookDY = damp(IN.lookDY, 0, 9, dt);
    updateCamera(dt);
    /* Whoever the camera belongs to this frame is whoever the gun belongs to.
       updateCamera ran just above, so KILLCAM.shown is already settled. */
    updateViewmodel(dt, KILLCAM.shown ? killcamViewmodelState(KILLCAM.shown, dt) : {
      vel: G.player ? G.player.vel : { x: 0, y: 0, z: 0 },
      onGround: G.player ? G.player.onGround : true,
      lookDX: IN.lookDX, lookDY: IN.lookDY,
      sprinting: !G.paused && IN.sprinting,
      firing: !G.paused && (IN.firing || IN.touchSemiArmed)
    });
    animateAll(dt);
    updateCrosshair(dt);
    updateFeed(dt);
    updateHint(dt);
    updateDamageDirs(dt);
    updateDeadScreen();
    updateHUD();
    updateTouchUI();
  }
  renderAll();
  PROF.frames++;
}

/* =====================================================================
   BOOT
   ===================================================================== */
function boot() {
  const bar = document.getElementById('lbar');
  const set = p => { if (bar) bar.style.width = p + '%'; };
  set(8);
  initRenderer();  set(18);
  initAdaptiveRes();
  initLights();    set(30);
  buildWorld();    set(60);
  initViewmodel(); set(74);
  initFX();        set(82);
  initInput();
  initTouch();     set(88);
  initAI();        set(96);
  initNetworkUI();
  const requestedMode = QS.get('mode');
  setGameMode(requestedMode === 'kc' || requestedMode === 'dm' ? requestedMode : 'dm');

  setupMatch();
  camera.position.set(40, 20, 30); camera.lookAt(0, 3, 0);

  document.getElementById('loading').classList.add('off');
  set(100);

  document.getElementById('play').addEventListener('click', () => {
    SFX.init(); SFX.resume(); SFX.ui();
    if (G.started && G.paused) { setPaused(false); requestLock(); }
    else {
      if (netHasTransport()) netLeaveLobby();
      startMatch();
    }
  });
  document.getElementById('again').addEventListener('click', () => {
    SFX.ui();
    if (netIsGuest()) {
      netStatus('Waiting for the host to start the rematch.');
      return;
    }
    if (netIsHost()) {
      netHostStart();
      return;
    }
    startMatch();
  });

  requestAnimationFrame(frame);
  if (AUTOSTART) startMatch();
}

/* =====================================================================
   DEBUG CONTRACT — headless verification hook.
   Pointer Lock can't be driven by synthetic input, so the rig freezes
   the world and poses the camera directly instead of "playing".
   ===================================================================== */
const POSES = {
  overview:  { pos: [0, 52, 62],      look: [0, 2, 0] },
  aerial:    { pos: [-40, 34, 40],    look: [2, 3, -2] },
  street:    { pos: [12, 1.75, 0.6],  look: [-26, 2.6, -0.4] },
  streetEast:{ pos: [-11, 1.75, 1.2], look: [24, 2.2, 0.2] },
  yard:      { pos: [-6.0, 1.7, 1.0], look: [-5.0, 2.4, -9.0] },
  porch:     { pos: [-4.5, 1.7, -0.9], look: [-4.6, 2.45, -6.6] },
  house:     { pos: [-5.0, 1.7, -11.8], look: [-10.4, 1.45, -16.0] },
  upstairs:  { pos: [-5.2, 4.92, -16.4], look: [-10.4, 4.35, -14.2] },
  balcony:   { pos: [3.6, 5.0, 5.2],  look: [-4.0, 3.4, -8.0] },
  bus:       { pos: [-29.3, 2.0, 4.6], look: [-22.0, 1.4, -0.4] },
  truck:     { pos: [13.2, 1.9, -3.6], look: [21.5, 1.3, 0.4] },
  tower:     { pos: [-4.0, 8.0, -19.5], look: [-6.0, 26.0, -70.0] },
  gun:       { pos: [-6.0, 1.7, 2.0], look: [-6.4, 1.9, -8.0] }
};

function poseCamera(name) {
  const p = POSES[name];
  if (!p) return false;
  camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
  camera.rotation.set(0, 0, 0);
  camera.lookAt(p.look[0], p.look[1], p.look[2]);
  return true;
}

/* Move bots somewhere the pose can actually see them, and make them shoot,
   so a "combat" screenshot shows combat instead of an empty street. */
function stageCombat(anchor) {
  const spots = [
    [-3.5, 0, -2.0, 1.2], [3.0, 0, 2.6, -2.0], [-9.0, 0, -1.2, 0.6],
    [6.5, 0, -2.2, 2.6], [-2.0, 3.3, -9.5, 0.2], [8.0, 0, 3.0, -1.4],
    [-13.0, 0, 1.5, 0.9], [1.0, 3.3, 9.5, 3.1]
  ];
  let i = 0;
  for (const a of G.actors) {
    if (a.isPlayer) continue;
    const s = spots[i++ % spots.length];
    a.pos.x = s[0]; a.pos.y = s[1]; a.pos.z = s[2];
    a.vel.x = Math.sin(s[3]) * 3.4; a.vel.z = Math.cos(s[3]) * 3.4; a.vel.y = 0;
    a.alive = true; a.health = a.maxHealth; a.spawnT = 0; a.deathT = 0;
    a.aimYaw = s[3]; a.aimPitch = -0.03; a.aiming = true; a.onGround = true;
    if (a.plate) a.plate.sprite.visible = true;
    if (a.char) { a.char.root.visible = true; a.char.root.scale.setScalar(1); }
  }
  // a couple of animation frames so limbs are mid-stride, not in T-pose
  for (let k = 0; k < 12; k++) animateAll(FIXED);
  // real shots so there are tracers, flashes and confetti in the frame
  for (const a of G.actors) {
    if (a.isPlayer || rng() < 0.35) continue;
    a.fireCd = 0; a.recoil = 1;
    fireWeapon(a);
  }
  for (let k = 0; k < 3; k++) { updateFX(FIXED); animateAll(FIXED); }
}

window.NUKETOWN_DEBUG = {
  THREE: THREE,
  get scene() { return scene; },
  get camera() { return camera; },
  get renderer() { return renderer; },
  get game() { return G; },
  poses: Object.keys(POSES).concat(['title', 'combat', 'death', 'victory']),

  /* run N fixed sim ticks with no rendering — deterministic and instant */
  step(n) {
    if (!G.started) { startMatch(); exitPointerLock(); }
    for (let i = 0; i < (n || 60); i++) simulate(FIXED);
    for (let i = 0; i < 4; i++) animateAll(FIXED);
    updateHUD(); refreshBoard();
    return this.state();
  },

  screenshotPose(name, opts) {
    opts = opts || {};
    const hud = document.getElementById('hud');
    if (!G.started) { startMatch(); exitPointerLock(); }
    G.frozen = false;
    G.frozenNoVM = true;

    // settle the match so bots have spread out and scores exist
    const warm = opts.warm === undefined ? 240 : opts.warm;
    for (let i = 0; i < warm; i++) simulate(FIXED);
    for (let i = 0; i < 8; i++) animateAll(FIXED);

    document.getElementById('title').classList.add('off');
    document.getElementById('dead').classList.add('off');
    document.getElementById('over').classList.add('off');
    restoreBoard();
    hud.classList.remove('hide');

    if (name === 'title') {
      document.getElementById('title').classList.remove('off');
      hud.classList.add('hide');
      titleOrbit = 2.15;
      camera.position.set(Math.cos(titleOrbit) * 46, 21, Math.sin(titleOrbit) * 33);
      camera.lookAt(0, 3.2, 0);
    } else if (name === 'death') {
      const killer = G.actors.find(a => !a.isPlayer);
      // die somewhere with a view, not wherever the warm-up left the player
      G.player.pos.x = 4.0; G.player.pos.y = 0; G.player.pos.z = 1.2;
      G.player.yaw = -1.5;
      G.player.alive = false; G.player.respawnT = 3; G.player.health = 0;
      showDeadScreen(killer);
      fxKillBurst(G.player.pos.x, G.player.pos.y, G.player.pos.z, C(0xffb7c5));
      placeDeathCam(G.player);
    } else if (name === 'victory') {
      G.player.kills = CFG.killsToWin;
      G.actors.forEach((a, i) => { if (!a.isPlayer) { a.kills = 4 + i * 2; a.deaths = 5 + i; } });
      G.player.deaths = 9; G.player.bestStreak = 7;
      endMatch(G.player);
      camera.position.set(Math.cos(2.4) * 40, 17, Math.sin(2.4) * 30);
      camera.lookAt(0, 3.2, 0);
    } else if (name === 'combat') {
      stageCombat();
      // first-person: stand in the street, weapon up, mid-firefight
      G.frozenNoVM = false;
      const p = G.player;
      p.pos.x = 11.5; p.pos.y = 0; p.pos.z = 1.4; p.alive = true; p.health = 72;
      p.yaw = -1.44; p.pitch = -0.02; p.aimYaw = p.yaw; p.aimPitch = p.pitch;
      p.vel.x = -2.2; p.vel.z = 0.2; p.onGround = true; p.kills = 7; p.deaths = 3;
      p.weapon = 'smg'; p.ammo = 17; p.reserve = 120;
      vmSetWeapon('smg', true);
      camera.position.set(p.pos.x, p.pos.y + ACT.eye, p.pos.z);
      camera.rotation.set(p.pitch, p.yaw + Math.PI, 0);
      vmFire(WBY.smg); VM.recoil = 0.014; VM.rot = 0.02;
      updateViewmodel(FIXED, { vel: p.vel, onGround: true, lookDX: 0.2, lookDY: 0, sprinting: false, firing: true });
      fireWeapon(p);
      updateHUD(); refreshBoard();
    } else if (name === 'gun') {
      /* Weapon showcase: stand in the street holding the chosen gun, calm
         pose, viewmodel on. opts.weapon picks which one. */
      G.frozenNoVM = false;
      const p = G.player;
      p.pos.x = -6.0; p.pos.y = 0; p.pos.z = 2.0; p.alive = true; p.health = 100;
      p.yaw = Math.PI; p.pitch = -0.02; p.aimYaw = p.yaw; p.aimPitch = p.pitch;
      p.vel.x = 0; p.vel.z = 0; p.onGround = true;
      p.weapon = opts.weapon || 'smg';
      const gw = WBY[p.weapon];
      p.ammo = gw.mag; p.reserve = gw.reserve;
      vmSetWeapon(p.weapon, true);
      VM.swapT = 0; VM.sprint = 0; VM.recoil = 0; VM.rot = 0;
      camera.position.set(p.pos.x, p.pos.y + ACT.eye, p.pos.z);
      camera.rotation.set(p.pitch, p.yaw + Math.PI, 0);
      updateViewmodel(FIXED, { vel: p.vel, onGround: true, lookDX: 0, lookDY: 0, sprinting: false, firing: false });
      updateHUD();
    } else if (!poseCamera(name)) {
      return { ok: false, error: 'unknown pose: ' + name, poses: this.poses };
    }

    if (opts.hud === false) hud.classList.add('hide');
    pinRes(opts.pinRes !== false);
    updateHUD();
    updateCrosshair(FIXED);
    G.frozen = true;
    camera.updateMatrixWorld(true);
    renderAll();
    return { ok: true, pose: name, state: this.state() };
  },

  unfreeze() { G.frozen = false; G.frozenNoVM = false; pinRes(false); },
  pinRes: pinRes,
  res() { return { scale: +RES.scale.toFixed(3), pinned: RES.pinned, min: RES.min, max: RES.max }; },

  /* Wall-clock FPS is meaningless headless (rAF is throttled), so time the
     stages directly instead. */
  profile(iters) {
    const N = iters || 60;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) simulate(FIXED);
    const t1 = performance.now();
    for (let i = 0; i < N; i++) animateAll(FIXED);
    const t2 = performance.now();
    for (let i = 0; i < Math.min(N, 20); i++) renderAll();
    const t3 = performance.now();
    return {
      simMs: +((t1 - t0) / N).toFixed(3),
      animMs: +((t2 - t1) / N).toFixed(3),
      renderMs: +((t3 - t2) / Math.min(N, 20)).toFixed(3),
      software: SOFTWARE_GPU, toon: TOON_OK,
      /* info.render is reset by every render() call, so read it straight
         after the world pass — otherwise you measure the viewmodel. */
      drawCalls: (renderer.render(scene, camera), renderer.info.render.calls),
      tris: renderer.info.render.triangles
    };
  },

  state() {
    return {
      booted: true,
      started: G.started, over: G.over, time: +G.time.toFixed(2),
      aiOK: G.aiOK, aiErr: G.aiErr, toon: TOON_OK, software: SOFTWARE_GPU,
      solids: MAP.solids.length,
      actors: G.actors.map(a => ({
        name: a.name, isPlayer: a.isPlayer, alive: a.alive,
        hp: Math.round(a.health), kills: a.kills, deaths: a.deaths,
        state: a.state, weapon: a.weapon,
        pos: [+a.pos.x.toFixed(2), +a.pos.y.toFixed(2), +a.pos.z.toFixed(2)]
      }))
    };
  },

  /* headless sanity: are the bots actually fighting each other? */
  botFightReport(seconds) {
    if (!G.started) { startMatch(); exitPointerLock(); }
    const p = G.player;
    p.pos.x = 0; p.pos.y = 60; p.pos.z = 0;      // park the player out of the fight
    const k0 = G.actors.map(a => a.kills);
    const d0 = Object.assign({}, G.donutStats);
    const n = Math.round((seconds || 45) / FIXED);
    const seen = new Set(); const levels = new Set(); const moved = [];
    const start = G.actors.map(a => ({ x: a.pos.x, z: a.pos.z, d: 0 }));
    for (let i = 0; i < n; i++) {
      simulate(FIXED);
      p.pos.y = 60;
      G.actors.forEach((a, j) => {
        if (a.isPlayer) return;
        seen.add(a.state);
        if (a.pos.y > 2.5) levels.add(a.id);
        const dx = a.pos.x - start[j].x, dz = a.pos.z - start[j].z;
        start[j].d += Math.hypot(dx, dz); start[j].x = a.pos.x; start[j].z = a.pos.z;
      });
    }
    G.actors.forEach((a, j) => { if (!a.isPlayer) moved.push({ name: a.name, dist: +start[j].d.toFixed(1), kills: a.kills - k0[j] }); });
    const report = {
      simSeconds: seconds || 45,
      botKills: moved.reduce((s, m) => s + m.kills, 0),
      statesSeen: Array.from(seen),
      botsThatReachedUpperFloor: levels.size,
      perBot: moved,
      nan: G.actors.some(a => !Number.isFinite(a.pos.x) || !Number.isFinite(a.pos.y) || !Number.isFinite(a.pos.z))
    };
    if (G.mode === 'kc') {
      const donutsSpawned = G.donutStats.spawned - (d0.spawned || 0);
      const donutsConfirmed = G.donutStats.confirmed - (d0.confirmed || 0);
      const donutsStolen = G.donutStats.stolen - (d0.stolen || 0);
      const donutsDenied = G.donutStats.denied - (d0.denied || 0);
      const donutsExpired = G.donutStats.expired - (d0.expired || 0);
      const donutsEvicted = G.donutStats.evicted - (d0.evicted || 0);
      const donutsCollected = donutsConfirmed + donutsStolen + donutsDenied;
      report.donutsSpawned = donutsSpawned;
      report.donutsConfirmed = donutsConfirmed;
      report.donutsStolen = donutsStolen;
      report.donutsDenied = donutsDenied;
      report.donutsExpired = donutsExpired;
      report.donutsEvicted = donutsEvicted;
      report.collectionRate = donutsSpawned ? donutsCollected / donutsSpawned : 0;
      report.donuts = {
        spawned: donutsSpawned, confirmed: donutsConfirmed, stolen: donutsStolen,
        denied: donutsDenied, expired: donutsExpired, evicted: donutsEvicted,
        collected: donutsCollected,
        collectionRate: report.collectionRate
      };
    }
    return report;
  }
};

boot();
