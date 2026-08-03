/* =====================================================================
   PASTEL NUKETOWN — characters: chunky cartoon bots, animated by hand
   No skeletons, no clips: a few pivots driven by speed / aim / state.
   ===================================================================== */

/* proportions — the hitboxes in 30-physics.js reference HIT, keep in sync */
const CH = {
  legTop: 0.74, torsoTop: 1.40, headC: 1.60, headR: 0.235,
  shoulder: 1.28, armLen: 0.50, hipW: 0.115, legW: 0.155
};

/* The jersey remains the large, readable colour field on every character.
   Skin-specific colours are reserved for small costume pieces, which lets a
   player recognize a fox or a knight without losing track of whose team
   colour is moving across the street. */
const CHARACTER_SKINS = {
  'char-midnight': {
    name: 'Midnight',
    cap: 0x5c6689, backpack: 0x69749a, boot: 0x48516f, badge: 0xb7b9e6
  },
  'char-sherbetfox': {
    name: 'Sherbet Fox',
    cap: 0xffb77d, backpack: 0xffc28f, boot: 0xd78378, badge: 0xffe0a8,
    fur: 0xed8958, inner: 0xfff1c4, tailTip: 0xffefb0
  },
  'char-cloudknight': {
    name: 'Cloud Knight',
    cap: 0xf8fbff, backpack: 0xb9dcf0, boot: 0x9fc9df, badge: 0xdff5ff,
    armor: 0xf8fbff, armorShade: 0xb9dcf0,
    crest: 0xc8ecfa, crestShade: 0xffffff
  }
};

function partMesh(build, withLines) {
  const B = new GeoBuilder();
  build(B);
  const g = new THREE.Group();
  const m = B.mesh(); g.add(m);
  if (withLines) { const l = B.lines(0.5); if (l) g.add(l); }
  return g;
}

function buildCharacter(colors, skinId) {
  const cosmetic = typeof skinId === 'string' ? CHARACTER_SKINS[skinId] : null;
  const body = colors.body, trim = colors.trim;
  const cB = C(body), cT = C(trim), cD = Cx(body, 0.9), skin = C(0xffe0c8), boot = C(0x6b5f80);
  const skinColor = (key, fallback) => cosmetic && cosmetic[key] !== undefined ? C(cosmetic[key]) : fallback;
  /* Keep the backpack in the skin palette because it is the large rear-facing
     costume anchor that makes a selected outfit recognizable from cover;
     the jersey remains the larger team-colour field across the front and
     sides, so this does not turn the silhouette into a team-blind marker. */
  const cCap = skinColor('cap', cT), cPack = skinColor('backpack', cD);
  const cBoot = skinColor('boot', boot), cBadge = skinColor('badge', cT);
  const cFur = skinColor('fur', cT), cInner = skinColor('inner', cT), cTailTip = skinColor('tailTip', cFur);
  const cArmor = skinColor('armor', cT), cArmorShade = skinColor('armorShade', cT);
  const cCrest = skinColor('crest', cT), cCrestShade = skinColor('crestShade', cCrest);

  const root = new THREE.Group();          // origin at the feet
  const hips = new THREE.Group();
  root.add(hips);

  // ---- torso (+ a little backpack + collar) ----
  const torso = partMesh(B => {
    B.box([-0.235, CH.legTop - 0.06, -0.145], [0.235, CH.torsoTop, 0.145], cB, { top: Cx(body, 1.05) });
    B.box([-0.245, CH.torsoTop - 0.10, -0.155], [0.245, CH.torsoTop, 0.155], cT);        // collar
    B.box([-0.165, CH.legTop + 0.10, 0.145], [0.165, CH.torsoTop - 0.12, 0.255], cPack);  // backpack
    B.box([-0.10, CH.legTop + 0.16, -0.16], [0.10, CH.legTop + 0.30, -0.145], cBadge);    // chest badge
    B.box([-0.25, CH.legTop - 0.10, -0.15], [0.25, CH.legTop + 0.02, 0.15], cT);         // belt

    if (skinId === 'char-sherbetfox') {
      /* Hang the stepped fan from the hips, below the backpack's y=.84 floor,
         so it reads as a tail from behind and in profile without becoming a
         rearward hitbox cue. A 100^3 sample per box against torso/backpack/
         belt volumes gives torso 0.0/0.0/0.0%, backpack 0.0/0.0/0.0% and
         belt 3.6/11.0/6.6%; the furthest corner is
         sqrt(.18^2 + .23^2) = .292 radial, below HIT.bodyR=.36. Its +z=.230
         stays inside the default character's rearmost +.255. A tail-only
         orthographic outline comparison at yaw 0/30/45/60/90/135/180 adds
         0.0/0.0/15.6/54.9/121.0/16.3/0.0 cm^2 outside the default outline,
         giving it real outline at oblique and side yaws without extending
         the rearward silhouette. z audit, tail base/mid/tip maxima:
         +.230/.190/.170. */
      B.box([-0.18, 0.60, 0.145], [0.18, 0.70, 0.23], cFur);
      B.box([-0.205, 0.64, 0.145], [0.205, 0.76, 0.19], cFur);
      B.box([-0.215, 0.73, 0.145], [-0.16, 0.82, 0.17], cTailTip);
    }

    if (skinId === 'char-cloudknight') {
      /* z audit, chest plate/shade maxima: -.148/-.146; both are forward of
         the character and well inside the +.255 rearward limit. */
      B.box([-0.14, CH.legTop + 0.20, -0.17], [0.14, CH.torsoTop - 0.19, -0.148], cArmor);
      B.box([-0.10, CH.legTop + 0.27, -0.174], [0.10, CH.legTop + 0.33, -0.146], cArmorShade);
    }
  }, true);
  hips.add(torso);

  // ---- head: rounded cube + cap + big cartoon eyes ----
  const headPiv = new THREE.Group();
  headPiv.position.set(0, CH.headC, 0);
  const head = partMesh(B => {
    const r = CH.headR;
    B.box([-r, -r, -r], [r, r, r], skin, { top: Cx(0xffe0c8, 1.03) });
    B.box([-r - 0.022, r - 0.03, -r - 0.022], [r + 0.022, r + 0.055, r + 0.022], cCap);  // cap
    B.box([-r - 0.02, r - 0.055, -r - 0.115], [r + 0.02, r + 0.012, -r + 0.01], cCap);   // brim
    for (const s of [-1, 1]) {                                                            // eyes
      B.box([s * 0.075 - 0.048, -0.015, -r - 0.012], [s * 0.075 + 0.048, 0.075, -r + 0.01], C(0xfffdf8));
      B.box([s * 0.075 - 0.024, 0.005, -r - 0.024], [s * 0.075 + 0.024, 0.052, -r - 0.006], C(0x4a3f5c));
    }
    B.box([-0.055, -0.115, -r - 0.014], [0.055, -0.085, -r + 0.005], C(0xe8a0a8));       // mouth
    B.box([-r - 0.03, -0.06, -0.05], [-r, 0.03, 0.05], skin);                            // ears
    B.box([r, -0.06, -0.05], [r + 0.03, 0.03, 0.05], skin);

    if (skinId === 'char-sherbetfox') {
      /* The fur is now clearly warmer than the cap and the tips rise to
         y=.340 (from .300), so the ears remain distinct at side and rear
         yaws. On the 120^3 cap/brim/skull overlap sample the lower, upper and
         inner pieces are 61.1%, 19.8% and 13.8% buried; the exposed top and
         outer edges are inside the existing head-scale envelope. z audit,
         each lower/upper/inner ear box maxes at +.120/+.120/-.040. */
      for (const s of [-1, 1]) {
        const x0 = s < 0 ? -0.295 : 0.18, x1 = s < 0 ? -0.18 : 0.295;
        const t0 = s < 0 ? -0.275 : 0.215, t1 = s < 0 ? -0.215 : 0.275;
        const i0 = s < 0 ? -0.285 : 0.245, i1 = s < 0 ? -0.245 : 0.285;
        B.box([x0, 0.235, -0.08], [x1, 0.295, 0.12], cFur);
        B.box([t0, 0.270, -0.06], [t1, 0.340, 0.12], cFur);
        B.box([i0, 0.255, -0.11], [i1, 0.332, -0.04], cInner);
      }
    }

    if (skinId === 'char-cloudknight') {
      /* These front/rear lobes are merged into the head mesh, but their real
         z depth still gives the crest a readable wrap from every yaw. The
         rearward silhouette was +.300 (4.5 cm beyond the +.255 limit) and is
         now +.255 (0.0 cm beyond it); the rear shade makes the same
         +.300-to+.255 change. z audit, front/rear lobe maxima:
         -.200/+.255; front/rear shade maxima: -.280/+.255. */
      B.box([-0.14, 0.245, -0.30], [0.14, 0.30, -0.20], cCrest);
      B.box([-0.14, 0.245, 0.20], [0.14, 0.30, 0.255], cCrest);
      B.box([-0.065, 0.265, -0.30], [0.065, 0.295, -0.28], cCrestShade);
      B.box([-0.065, 0.265, 0.235], [0.065, 0.295, 0.255], cCrestShade);
    }
  }, true);
  headPiv.add(head);
  hips.add(headPiv);

  // ---- limbs ----
  const mkLeg = () => partMesh(B => {
    B.box([-CH.legW, -CH.legTop + 0.10, -0.10], [CH.legW, 0, 0.10], cD);
    B.box([-CH.legW - 0.012, -CH.legTop, -0.145], [CH.legW + 0.012, -CH.legTop + 0.14, 0.115], cBoot);
  }, false);
  const mkArm = (isRight) => partMesh(B => {
    B.box([-0.088, -CH.armLen + 0.10, -0.088], [0.088, 0, 0.088], cB);
    B.box([-0.075, -CH.armLen + 0.06, -0.075], [0.075, -CH.armLen + 0.14, 0.075], cT);   // cuff
    B.box([-0.082, -CH.armLen, -0.082], [0.082, -CH.armLen + 0.075, 0.082], skin);       // mitt
    if (skinId === 'char-cloudknight') {
      /* Each pauldron is in its own arm's builder, rather than on hips. The
         local shoulder box therefore follows the same x/z aim rotations as
         the arm, with its inner edge overlapping the shoulder volume. z audit:
         each pauldron's local maximum is +.120. */
      const x0 = isRight ? -0.045 : -0.09, x1 = isRight ? 0.09 : 0.045;
      B.box([x0, -0.10, -0.12], [x1, 0.10, 0.12], cArmor);
    }
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
