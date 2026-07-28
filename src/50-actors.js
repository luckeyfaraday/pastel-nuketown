/* =====================================================================
   PASTEL NUKETOWN — characters: chunky cartoon bots, animated by hand
   No skeletons, no clips: a few pivots driven by speed / aim / state.
   ===================================================================== */

/* proportions — the hitboxes in 30-physics.js reference HIT, keep in sync */
const CH = {
  legTop: 0.74, torsoTop: 1.40, headC: 1.60, headR: 0.235,
  shoulder: 1.28, armLen: 0.50, hipW: 0.115, legW: 0.155
};

function partMesh(build, withLines) {
  const B = new GeoBuilder();
  build(B);
  const g = new THREE.Group();
  const m = B.mesh(); g.add(m);
  if (withLines) { const l = B.lines(0.5); if (l) g.add(l); }
  return g;
}

function buildCharacter(colors) {
  const body = colors.body, trim = colors.trim;
  const cB = C(body), cT = C(trim), cD = Cx(body, 0.9), skin = C(0xffe0c8), boot = C(0x6b5f80);

  const root = new THREE.Group();          // origin at the feet
  const hips = new THREE.Group();
  root.add(hips);

  // ---- torso (+ a little backpack + collar) ----
  const torso = partMesh(B => {
    B.box([-0.235, CH.legTop - 0.06, -0.145], [0.235, CH.torsoTop, 0.145], cB, { top: Cx(body, 1.05) });
    B.box([-0.245, CH.torsoTop - 0.10, -0.155], [0.245, CH.torsoTop, 0.155], cT);        // collar
    B.box([-0.165, CH.legTop + 0.10, 0.145], [0.165, CH.torsoTop - 0.12, 0.255], cD);    // backpack
    B.box([-0.10, CH.legTop + 0.16, -0.16], [0.10, CH.legTop + 0.30, -0.145], cT);       // chest badge
    B.box([-0.25, CH.legTop - 0.10, -0.15], [0.25, CH.legTop + 0.02, 0.15], cT);         // belt
  }, true);
  hips.add(torso);

  // ---- head: rounded cube + cap + big cartoon eyes ----
  const headPiv = new THREE.Group();
  headPiv.position.set(0, CH.headC, 0);
  const head = partMesh(B => {
    const r = CH.headR;
    B.box([-r, -r, -r], [r, r, r], skin, { top: Cx(0xffe0c8, 1.03) });
    B.box([-r - 0.022, r - 0.03, -r - 0.022], [r + 0.022, r + 0.055, r + 0.022], cT);    // cap
    B.box([-r - 0.02, r - 0.055, -r - 0.115], [r + 0.02, r + 0.012, -r + 0.01], cT);     // brim
    for (const s of [-1, 1]) {                                                            // eyes
      B.box([s * 0.075 - 0.048, -0.015, -r - 0.012], [s * 0.075 + 0.048, 0.075, -r + 0.01], C(0xfffdf8));
      B.box([s * 0.075 - 0.024, 0.005, -r - 0.024], [s * 0.075 + 0.024, 0.052, -r - 0.006], C(0x4a3f5c));
    }
    B.box([-0.055, -0.115, -r - 0.014], [0.055, -0.085, -r + 0.005], C(0xe8a0a8));       // mouth
    B.box([-r - 0.03, -0.06, -0.05], [-r, 0.03, 0.05], skin);                            // ears
    B.box([r, -0.06, -0.05], [r + 0.03, 0.03, 0.05], skin);
  }, true);
  headPiv.add(head);
  hips.add(headPiv);

  // ---- limbs ----
  const mkLeg = () => partMesh(B => {
    B.box([-CH.legW, -CH.legTop + 0.10, -0.10], [CH.legW, 0, 0.10], cD);
    B.box([-CH.legW - 0.012, -CH.legTop, -0.145], [CH.legW + 0.012, -CH.legTop + 0.14, 0.115], boot);
  }, false);
  const mkArm = (isRight) => partMesh(B => {
    B.box([-0.088, -CH.armLen + 0.10, -0.088], [0.088, 0, 0.088], cB);
    B.box([-0.075, -CH.armLen + 0.06, -0.075], [0.075, -CH.armLen + 0.14, 0.075], cT);   // cuff
    B.box([-0.082, -CH.armLen, -0.082], [0.082, -CH.armLen + 0.075, 0.082], skin);       // mitt
  }, false);

  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(-CH.hipW, CH.legTop, 0); legL.add(mkLeg());
  legR.position.set( CH.hipW, CH.legTop, 0); legR.add(mkLeg());
  hips.add(legL, legR);

  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.30, CH.shoulder, 0); armL.add(mkArm(false));
  armR.position.set( 0.30, CH.shoulder, 0); armR.add(mkArm(true));
  hips.add(armL, armR);

  // ---- third-person gun, parented to the right arm ----
  const gun = partMesh(B => {
    B.box([-0.045, -0.045, -0.36], [0.045, 0.045, 0.10], C(0xe9e2f2));
    B.box([-0.030, -0.020, -0.52], [0.030, 0.028, -0.36], C(0xd6cee6));
    B.box([-0.038, -0.16, -0.10], [0.038, -0.035, 0.02], cT);
    B.box([-0.036, 0.045, -0.20], [0.036, 0.070, 0.02], cT);
    B.box([-0.040, -0.02, 0.10], [0.040, 0.055, 0.26], C(0xe9e2f2));
  }, false);
  gun.position.set(0, -CH.armLen + 0.02, -0.10);
  gun.rotation.x = -Math.PI / 2;   // barrel down the arm and out of the mitt
  armR.add(gun);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.54);
  gun.add(muzzle);

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  return { root, hips, torso, headPiv, legL, legR, armL, armR, gun, muzzle };
}

/* ---- name + health plate that hovers over each bot ---- */
/* =====================================================================
   BLOB SHADOWS
   Real shadow mapping is switched off on software renderers, and without
   any contact shadow the characters read as stickers floating over the
   street. A soft dark ellipse under each actor costs one small alpha quad
   and puts them back on the ground. It also survives on GPU: it lands
   under the real shadow and just reads as ambient occlusion.
   ===================================================================== */
let BLOB_TEX = null;
function blobTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0.00, 'rgba(74,63,92,.55)');
  rg.addColorStop(0.55, 'rgba(74,63,92,.30)');
  rg.addColorStop(1.00, 'rgba(74,63,92,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}
function makeBlobShadow() {
  if (!BLOB_TEX) BLOB_TEX = blobTexture();
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5, 1.5),
    new THREE.MeshBasicMaterial({ map: BLOB_TEX, transparent: true, depthWrite: false,
                                  fog: true, opacity: 1 })
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = -5;                 // under everything else that blends
  scene.add(m);
  return m;
}
/* Drop it onto whatever surface is under the actor (street, porch, upper
   floor), and fade + spread it the higher they are — a jumping character
   should cast a big faint blob, not a hard one stuck to their boots. */
function updateBlobShadow(blob, a) {
  if (!blob) return;
  if (!a.alive && a.deathT > 1.6) { blob.visible = false; return; }
  const hit = raycastMap(a.pos.x, a.pos.y + 0.4, a.pos.z, 0, -1, 0, 9);
  const gy = hit ? (a.pos.y + 0.4 - hit.dist) : 0;
  const air = clamp(a.pos.y - gy, 0, 4);
  blob.visible = air < 3.6;
  if (!blob.visible) return;
  blob.position.set(a.pos.x, gy + 0.035, a.pos.z);
  const s = 1 + air * 0.30;
  blob.scale.set(s, s, 1);
  blob.material.opacity = (1 - air / 4.2) * (a.alive ? 1 : Math.max(0, 1 - a.deathT / 1.6));
}

/* =====================================================================
   SPAWN BUBBLE
   The gameplay job is "don't die in the first second". The look is a soap
   bubble: additive, back-faces only so it reads as a shell you see THROUGH
   rather than a solid ball, with a fresnel rim so the silhouette glows and
   the middle stays clear. Iridescence comes from shifting the rim hue with
   view angle — cheap, and it is the most overtly magical thing on screen.
   ===================================================================== */
const BUBBLE_VS = `
varying vec3 vN; varying vec3 vV;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const BUBBLE_FS = `
uniform float uT; uniform float uFade;
varying vec3 vN; varying vec3 vV;
void main(){
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));   // fresnel rim
  float rim = pow(f, 2.2);
  // iridescent band that drifts around the shell over time
  float band = sin(f * 11.0 - uT * 2.4);
  vec3 tint = vec3(0.55 + 0.45 * sin(band + 0.0),
                   0.55 + 0.45 * sin(band + 2.1),
                   0.55 + 0.45 * sin(band + 4.2));
  vec3 col = mix(vec3(0.75, 0.90, 1.0), tint, 0.55);
  float a = (rim * 0.85 + 0.06) * uFade;
  gl_FragColor = vec4(col * a, a);
}`;
function makeBubble() {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 20, 14),
    new THREE.ShaderMaterial({
      vertexShader: BUBBLE_VS, fragmentShader: BUBBLE_FS,
      uniforms: { uT: { value: 0 }, uFade: { value: 1 } },
      transparent: true, depthWrite: false, side: THREE.BackSide,
      blending: THREE.AdditiveBlending, fog: false
    })
  );
  m.visible = false;
  m.renderOrder = 6;
  scene.add(m);
  return m;
}
function updateBubble(bub, a, t) {
  if (!bub) return;
  const on = a.alive && a.shield > 0;
  bub.visible = on;
  if (!on) return;
  bub.position.set(a.pos.x, a.pos.y + 0.95, a.pos.z);
  // a slow wobble so it feels like surface tension, not a hard sphere
  const w = 1 + Math.sin(t * 3.1 + a.id) * 0.035;
  bub.scale.set(w, 1 / w, w);
  bub.material.uniforms.uT.value = t;
  // pop out over the last third rather than vanishing on a frame boundary
  bub.material.uniforms.uFade.value = clamp(a.shield / (CFG.spawnShield * 0.45), 0, 1);
}
/* a ripple where a shot was absorbed */
function fxShieldHit(a, hx, hy, hz) {
  if (hx === undefined) return;
  fxRing(hx, hy, hz, hx - a.pos.x, hy - (a.pos.y + 0.95), hz - a.pos.z, C(0xbfe8ff), 0.75);
  SFX.tone(880, 620, 0.10, 0.10, 'sine', hx, hy, hz);
}

function makePlate() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 72;
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: true, fog: false
  }));
  sp.scale.set(1.5, 0.42, 1);
  sp.center.set(0.5, 0);
  return { sprite: sp, canvas: cv, tex, last: -1 };
}
function drawPlate(plate, name, hp, maxHp, color) {
  const g = plate.canvas.getContext('2d');
  g.clearRect(0, 0, 256, 72);
  g.font = '800 30px "Baloo 2", Trebuchet MS, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 7; g.strokeStyle = '#4a3f5c'; g.lineJoin = 'round';
  g.strokeText(name, 128, 22); g.fillStyle = '#fffdf8'; g.fillText(name, 128, 22);
  const w = 190, x = (256 - w) / 2, y = 46, h = 15;
  g.fillStyle = '#4a3f5c';
  g.beginPath(); g.roundRect ? g.roundRect(x - 4, y - 4, w + 8, h + 8, 9) : g.rect(x - 4, y - 4, w + 8, h + 8); g.fill();
  g.fillStyle = '#efe3f2';
  g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, 6) : g.rect(x, y, w, h); g.fill();
  const f = clamp(hp / maxHp, 0, 1);
  g.fillStyle = f > 0.35 ? '#7fe6b4' : '#ff8fa3';
  if (f > 0.01) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w * f, h, 6) : g.rect(x, y, w * f, h); g.fill(); }
  plate.tex.needsUpdate = true;
}

/* =====================================================================
   ANIMATION — everything is driven from a handful of scalars
   ===================================================================== */
function animateCharacter(ch, a, dt, t) {
  const spd = Math.hypot(a.vel.x, a.vel.z);
  const moving = spd > 0.35;

  // --- death: topple sideways, sink, fade out ---
  if (!a.alive) {
    a.deathT += dt;
    const u = clamp(a.deathT / 0.55, 0, 1);
    ch.root.rotation.z = a.deathDir * smoothstep(u) * 1.62;
    ch.root.position.y = a.pos.y - smoothstep(clamp((a.deathT - 0.5) / 1.4, 0, 1)) * 1.1;
    const sc = 1 - smoothstep(clamp((a.deathT - 1.1) / 0.7, 0, 1));
    ch.root.scale.setScalar(Math.max(0.001, sc));
    ch.legL.rotation.x = -0.5; ch.legR.rotation.x = 0.35;
    ch.armL.rotation.z = 0.9; ch.armR.rotation.z = -1.1;
    ch.armL.rotation.x = 0.6; ch.armR.rotation.x = 0.4;
    return;
  }

  // --- spawn pop: squash-stretch overshoot ---
  ch.root.rotation.z = 0;
  ch.root.position.y = a.pos.y;
  if (a.spawnT > 0) {
    a.spawnT = Math.max(0, a.spawnT - dt);
    const u = 1 - a.spawnT / 0.45;
    const s = u < 1 ? 1 + Math.sin(u * Math.PI) * 0.28 * (1 - u) : 1;
    ch.root.scale.set(s * (2 - s), Math.pow(smoothstep(u), 0.6) * s, s * (2 - s));
  } else ch.root.scale.set(1, 1, 1);

  // --- facing: body turns toward travel, torso/head lead toward aim ---
  /* +PI: the rig models face -Z locally, engine forward is +Z (see yawFlip). */
  const moveYaw = moving ? Math.atan2(a.vel.x, a.vel.z) + Math.PI : a.bodyYaw;
  a.bodyYaw = approachAngle(a.bodyYaw, moving ? moveYaw : (a.aimYaw + Math.PI), dt * (moving ? 9 : 4.5));
  ch.root.rotation.y = a.bodyYaw;

  const lead = angDelta(a.bodyYaw, a.aimYaw + Math.PI);
  ch.hips.rotation.y = damp(ch.hips.rotation.y, clamp(lead, -1.1, 1.1) * 0.55, 12, dt);
  ch.headPiv.rotation.y = damp(ch.headPiv.rotation.y, clamp(lead, -1.3, 1.3) * 0.45, 14, dt);
  ch.headPiv.rotation.x = damp(ch.headPiv.rotation.x, clamp(a.aimPitch, -0.6, 0.6), 12, dt);

  // --- gait ---
  const stride = clamp(spd / 6.2, 0, 1.35);
  a.gait += dt * (2.0 + spd * 1.85);
  const sw = Math.sin(a.gait) * stride;
  const sw2 = Math.cos(a.gait * 2) * stride;

  if (a.onGround) {
    ch.legL.rotation.x = damp(ch.legL.rotation.x,  sw * 0.95, 20, dt);
    ch.legR.rotation.x = damp(ch.legR.rotation.x, -sw * 0.95, 20, dt);
    ch.hips.position.y = damp(ch.hips.position.y, Math.abs(sw2) * 0.035 - stride * 0.02, 16, dt);
  } else {
    ch.legL.rotation.x = damp(ch.legL.rotation.x, -0.45, 9, dt);
    ch.legR.rotation.x = damp(ch.legR.rotation.x,  0.30, 9, dt);
    ch.hips.position.y = damp(ch.hips.position.y, 0, 9, dt);
  }

  /* --- arms: raised into a firing pose when engaged, swinging otherwise ---
     The rig faces -Z, so rotating a shoulder by +X swings that arm forward,
     past +PI/2 tips it skyward. Every sign below reads from that: the fire
     pose sits just under the horizontal, aiming up adds pitch, recoil adds
     more, and the swing puts each arm opposite the leg on its own side. */
  const aimUp = a.aiming ? 1 : 0;
  a.aimBlend = damp(a.aimBlend, aimUp, 10, dt);
  const rest = sw * 0.62, restL = -sw * 0.62;
  const fireX = 1.42 + clamp(a.aimPitch, -0.7, 0.7);
  ch.armR.rotation.x = damp(ch.armR.rotation.x, lerp(rest, fireX, a.aimBlend) + a.recoil * 0.55, 16, dt);
  ch.armL.rotation.x = damp(ch.armL.rotation.x, lerp(restL, fireX - 0.12, a.aimBlend) + a.recoil * 0.35, 16, dt);
  ch.armR.rotation.z = damp(ch.armR.rotation.z, lerp(0.06, -0.30, a.aimBlend), 14, dt);
  ch.armL.rotation.z = damp(ch.armL.rotation.z, lerp(-0.06, 0.46, a.aimBlend), 14, dt);
  ch.armL.rotation.y = damp(ch.armL.rotation.y, lerp(0, 0.55, a.aimBlend), 14, dt);

  // recoil + flinch decay
  a.recoil = Math.max(0, a.recoil - dt * 6.5);
  a.flinch = Math.max(0, a.flinch - dt * 5);
  ch.hips.rotation.x = damp(ch.hips.rotation.x, stride * 0.10 + a.recoil * 0.16 + a.flinch * 0.25, 14, dt);
  ch.hips.rotation.z = damp(ch.hips.rotation.z, -a.flinch * 0.3, 12, dt);
  // idle breathe
  if (!moving) ch.hips.position.y += Math.sin(t * 1.9 + a.id) * 0.006;
}
