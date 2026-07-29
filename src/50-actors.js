/* =====================================================================
   PASTEL NUKETOWN — characters: chunky cartoon bots, animated by hand
   No skeletons, no clips: a few pivots driven by speed / aim / state.
   ===================================================================== */

/* proportions — the hitboxes in 30-physics.js reference HIT, keep in sync */
const CH = {
  legTop: 0.74, torsoTop: 1.40, headC: 1.60, headR: 0.235,
  shoulder: 1.28, armLen: 0.50, hipW: 0.115, legW: 0.155
};

function partMesh(build, lineOpacity) {
  const B = new GeoBuilder();
  build(B);
  const g = new THREE.Group();
  const m = B.mesh(); g.add(m);
  if (lineOpacity) {
    const l = B.lines(lineOpacity === true ? 0.88 : lineOpacity);
    if (l) g.add(l);
  }
  return g;
}

function buildCharacter(colors) {
  const body = colors.body, trim = colors.trim;
  const cB = C(body), cT = C(trim), cD = Cx(body, 0.78, 0.72, 0.86);
  const cS = Cx(body, 0.72, 0.68, 0.78);
  const ink = C(0x3a2b4a), skin = C(0xffd8bd);
  const skinShadow = Cx(0xffd8bd, 0.78, 0.72, 0.70), white = C(0xfff8f0);
  const variant = ((body >>> 8) ^ body) & 3;

  const root = new THREE.Group();          // origin at the feet
  const hips = new THREE.Group();
  const upper = new THREE.Group();
  root.add(hips);
  hips.add(upper);

  // Candy shadows carry volume; aubergine is reserved for edges and recesses.
  const torso = partMesh(B => {
    B.box([-0.285, CH.legTop - 0.10, -0.165], [0.285, CH.torsoTop + 0.015, 0.175], cS);
    B.box([-0.235, CH.legTop - 0.015, -0.190], [0.235, CH.torsoTop - 0.055, 0.145],
          cB, { top: Cx(body, 1.05), bottom: ink });
    B.box([-0.275, CH.torsoTop - 0.115, -0.185], [0.275, CH.torsoTop + 0.015, 0.175], cS);
    B.box([-0.235, CH.torsoTop - 0.080, -0.202], [0.235, CH.torsoTop - 0.005, 0.150], cT);
    B.box([-0.235, CH.legTop + 0.045, 0.145], [0.235, CH.torsoTop - 0.075, 0.285], cS);
    B.box([-0.195, CH.legTop + 0.095, 0.170], [0.195, CH.torsoTop - 0.125, 0.310], cB);
    B.box([-0.150, CH.legTop + 0.235, 0.286], [0.150, CH.legTop + 0.315, 0.325], cT);
    B.box([-0.115, CH.legTop + 0.17, -0.218], [0.115, CH.legTop + 0.35, -0.185], ink);
    B.box([-0.078, CH.legTop + 0.205, -0.234], [0.078, CH.legTop + 0.315, -0.210], cT);
    B.box([-0.29, CH.legTop - 0.105, -0.19], [0.29, CH.legTop + 0.035, 0.19], cS);
    B.box([-0.225, CH.legTop - 0.060, -0.208], [0.225, CH.legTop - 0.005, 0.175], cT);
    B.box([-0.305, CH.legTop + 0.080, -0.135], [-0.282, CH.torsoTop - 0.105, 0.135], ink);
    B.box([-0.320, CH.legTop + 0.135, -0.095], [-0.300, CH.torsoTop - 0.160, 0.095], cB);
    B.box([0.282, CH.legTop + 0.080, -0.135], [0.305, CH.torsoTop - 0.105, 0.135], ink);
    B.box([0.300, CH.legTop + 0.135, -0.095], [0.320, CH.torsoTop - 0.160, 0.095], cB);
    for (const s of [-1, 1]) {
      B.box([s * 0.305 - 0.105, CH.shoulder - 0.135, -0.185],
            [s * 0.305 + 0.105, CH.shoulder + 0.135, 0.185], cS);
      B.box([s * 0.305 - 0.075, CH.shoulder - 0.090, -0.210],
            [s * 0.305 + 0.075, CH.shoulder + 0.095, 0.160], cT);
      B.box([s * 0.305 - 0.070, CH.shoulder - 0.075, 0.168],
            [s * 0.305 + 0.070, CH.shoulder + 0.080, 0.208], cT);
      B.box([s * 0.245 - 0.065, CH.legTop - 0.050, 0.170],
            [s * 0.245 + 0.065, CH.legTop + 0.145, 0.275], cS);
      B.box([s * 0.245 - 0.040, CH.legTop - 0.015, 0.190],
            [s * 0.245 + 0.040, CH.legTop + 0.110, 0.292], cT);
    }
  }, 0.92);
  upper.add(torso);

  // The visor remains a directional face cue after its details collapse to pixels.
  const headPiv = new THREE.Group();
  headPiv.position.set(0, CH.headC, 0);
  const head = partMesh(B => {
    const r = CH.headR;
    B.box([-r - 0.030, -r - 0.035, -r - 0.010], [r + 0.030, r + 0.035, r + 0.030], skinShadow);
    B.box([-r, -r, -r - 0.040], [r, r - 0.020, r - 0.010],
          skin, { top: Cx(0xffd8bd, 1.03), bottom: ink });
    B.box([-r - 0.040, r - 0.055, -r - 0.040], [r + 0.040, r + 0.065, r + 0.040], cS);
    B.box([-r - 0.010, r - 0.025, -r - 0.065], [r + 0.010, r + 0.045, r + 0.015], cT);
    B.box([-r - 0.045, -0.045, -r - 0.092], [r + 0.045, 0.120, -r - 0.045], ink);
    for (const s of [-1, 1]) {
      B.box([s * 0.080 - 0.060, -0.006, -r - 0.112],
            [s * 0.080 + 0.060, 0.082, -r - 0.085], white);
      B.box([s * 0.080 - 0.026, 0.006, -r - 0.126],
            [s * 0.080 + 0.026, 0.070, -r - 0.108], cT);
      B.box([s * 0.080 - 0.012, 0.025, -r - 0.135],
            [s * 0.080 + 0.012, 0.058, -r - 0.122], ink);
    }
    B.box([-0.072, -0.140, -r - 0.080], [0.072, -0.090, -r - 0.045], ink);
    B.box([-0.038, -0.132, -r - 0.094], [0.038, -0.105, -r - 0.078], C(0xff8fa3));
    B.box([-r - 0.045, -0.075, -0.065], [-r - 0.010, 0.045, 0.065], cT);
    B.box([r + 0.010, -0.075, -0.065], [r + 0.045, 0.045, 0.065], cT);
  }, 0.96);
  headPiv.add(head);

  const gearPiv = new THREE.Group();
  gearPiv.position.set(0, CH.headR + 0.035, 0);
  const gear = partMesh(B => {
    if (variant === 0) {
      B.box([-0.032, 0, -0.032], [0.032, 0.205, 0.032], cS);
      B.box([-0.092, 0.165, -0.092], [0.092, 0.345, 0.092], cS);
      B.box([-0.060, 0.195, -0.110], [0.060, 0.315, 0.075], cT);
    } else if (variant === 1) {
      for (const s of [-1, 1]) {
        B.box([s * 0.185 - 0.070, -0.005, -0.070],
              [s * 0.185 + 0.070, 0.175, 0.070], cS);
        B.box([s * 0.185 - 0.042, 0.025, -0.090],
              [s * 0.185 + 0.042, 0.145, 0.050], cT);
      }
    } else if (variant === 2) {
      B.box([0.085, -0.005, -0.032], [0.145, 0.285, 0.032], cS);
      B.box([0.125, 0.105, -0.055], [0.335, 0.285, 0.055], cS);
      B.box([0.145, 0.135, -0.075], [0.300, 0.255, 0.035], cT);
    } else {
      for (let i = -1; i <= 1; i++) {
        const h = i === 0 ? 0.275 : 0.205;
        B.box([i * 0.115 - 0.052, -0.005, -0.060],
              [i * 0.115 + 0.052, h, 0.060], cS);
        B.box([i * 0.115 - 0.027, 0.025, -0.080],
              [i * 0.115 + 0.027, h - 0.030, 0.040], cT);
      }
    }
  }, 0.95);
  gearPiv.add(gear);
  headPiv.add(gearPiv);
  upper.add(headPiv);

  // ---- limbs ----
  const mkLeg = () => partMesh(B => {
    B.box([-CH.legW - 0.018, -CH.legTop + 0.09, -0.115],
          [CH.legW + 0.018, 0, 0.115], cS);
    B.box([-CH.legW + 0.018, -CH.legTop + 0.175, -0.140],
          [CH.legW - 0.018, -0.025, 0.080], cB);
    B.box([-CH.legW + 0.026, -CH.legTop + 0.205, 0.096],
          [CH.legW - 0.026, -0.055, 0.142], cB);
    B.box([-CH.legW + 0.010, -0.285, -0.165],
          [CH.legW - 0.010, -0.145, -0.125], cT);
    B.box([-CH.legW - 0.035, -CH.legTop, -0.195],
          [CH.legW + 0.035, -CH.legTop + 0.175, 0.130], ink);
    B.box([-CH.legW + 0.010, -CH.legTop + 0.055, -0.218],
          [CH.legW - 0.010, -CH.legTop + 0.125, -0.185], cT);
  }, 0.82);
  const mkArm = (isRight) => partMesh(B => {
    const ix0 = isRight ? -0.108 : 0.068, ix1 = isRight ? -0.068 : 0.108;
    B.box([-0.108, -CH.armLen + 0.075, -0.108], [0.108, 0, 0.108], cS);
    B.box([-0.074, -CH.armLen + 0.155, -0.132], [0.074, -0.025, 0.078], cB);
    B.box([-0.068, -CH.armLen + 0.180, 0.088], [0.068, -0.050, 0.138], cB);
    B.box([ix0, -CH.armLen + 0.12, -0.125], [ix1, -0.045, 0.115], ink);
    B.box([-0.092, -CH.armLen + 0.045, -0.118], [0.092, -CH.armLen + 0.165, 0.100], cS);
    B.box([-0.068, -CH.armLen + 0.075, -0.140], [0.068, -CH.armLen + 0.135, 0.075], cT);
    B.box([-0.108, -CH.armLen, -0.135], [0.108, -CH.armLen + 0.090, 0.115], skinShadow);
    B.box([-0.060, -CH.armLen + 0.018, -0.153], [0.060, -CH.armLen + 0.064, -0.132], cT);
  }, 0.80);

  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(-CH.hipW, CH.legTop, 0); legL.add(mkLeg());
  legR.position.set( CH.hipW, CH.legTop, 0); legR.add(mkLeg());
  hips.add(legL, legR);

  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(-0.32, CH.shoulder, 0); armL.add(mkArm(false));
  armR.position.set( 0.32, CH.shoulder, 0); armR.add(mkArm(true));
  upper.add(armL, armR);

  // ---- third-person gun, parented to the right arm ----
  const gun = partMesh(B => {
    B.box([-0.060, -0.060, -0.38], [0.060, 0.060, 0.115], cS);
    B.box([-0.038, -0.038, -0.40], [0.038, 0.038, 0.090], cD);
    B.box([-0.038, -0.030, -0.54], [0.038, 0.036, -0.36], cS);
    B.box([-0.022, -0.012, -0.555], [0.022, 0.020, -0.38], cT);
    B.box([-0.048, -0.17, -0.11], [0.048, -0.035, 0.035], ink);
    B.box([-0.027, -0.145, -0.095], [0.027, -0.050, 0.018], cT);
    B.box([-0.045, 0.045, -0.21], [0.045, 0.078, 0.025], cT);
    B.box([-0.050, -0.03, 0.095], [0.050, 0.065, 0.275], cS);
    B.box([-0.030, -0.012, 0.105], [0.030, 0.043, 0.245], cD);
  }, 0.90);
  gun.position.set(0, -CH.armLen + 0.02, -0.10);
  gun.rotation.x = -Math.PI / 2;   // barrel down the arm and out of the mitt
  armR.add(gun);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.54);
  gun.add(muzzle);

  const shards = [];
  for (let i = 0; i < 4; i++) {
    const shard = partMesh(B => {
      const w = 0.055 + (i & 1) * 0.018;
      B.box([-w, -0.075, -w], [w, 0.075, w], ink);
      B.box([-w + 0.018, -0.045, -w - 0.016],
            [w - 0.018, 0.045, w - 0.008], (i & 1) ? cT : cB);
    }, 0.85);
    shard.position.set(0, 0.98, 0);
    shard.visible = false;
    root.add(shard);
    shards.push(shard);
  }

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const inks = [];
  root.traverse(o => { if (o.isLineSegments) inks.push(o); });

  return {
    root, hips, upper, torso, headPiv, gearPiv, legL, legR, armL, armR,
    gun, muzzle, shards, inks, variant
  };
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
  rg.addColorStop(0.00, 'rgba(58,43,74,.66)');
  rg.addColorStop(0.55, 'rgba(58,43,74,.34)');
  rg.addColorStop(1.00, 'rgba(58,43,74,0)');
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
  g.lineWidth = 7; g.strokeStyle = '#3a2b4a'; g.lineJoin = 'round';
  g.strokeText(name, 128, 22); g.fillStyle = '#fffdf8'; g.fillText(name, 128, 22);
  const w = 190, x = (256 - w) / 2, y = 46, h = 15;
  g.fillStyle = '#3a2b4a';
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
  if (SOFTWARE_GPU) {
    const dx = ch.root.position.x - camera.position.x;
    const dz = ch.root.position.z - camera.position.z;
    const showInk = dx * dx + dz * dz < 324;
    for (let i = 0; i < ch.inks.length; i++) ch.inks[i].visible = showInk;
  }
  if (a._animHealth === undefined) a._animHealth = a.health;
  if (a.health < a._animHealth && a.alive) {
    a.flinch = 1;
    a.flinchSide = ((a.id * 17 + Math.round(a.health)) & 1) ? 1 : -1;
  }
  a._animHealth = a.health;

  if (!a.alive) {
    a.deathT += dt;
    const stagger = smoothstep(clamp(a.deathT / 0.11, 0, 1));
    const split = smoothstep(clamp((a.deathT - 0.10) / 0.42, 0, 1));
    const fall = smoothstep(clamp((a.deathT - 0.36) / 0.50, 0, 1));
    const burst = Math.sin(clamp(a.deathT / 0.30, 0, 1) * Math.PI);
    const drop = Math.max(0, a.deathT - 0.42);
    ch.root.rotation.x = -stagger * (1 - fall) * 0.42;
    ch.root.rotation.y = a.bodyYaw + a.deathDir * fall * 0.48;
    ch.root.rotation.z = a.deathDir * fall * 1.40;
    ch.root.position.y = a.pos.y - smoothstep(clamp((a.deathT - 0.72) / 0.95, 0, 1)) * 0.76;
    const sc = 1 - smoothstep(clamp((a.deathT - 1.28) / 0.52, 0, 1));
    ch.root.scale.set(Math.max(0.001, sc * (1 + burst * 0.36)),
                      Math.max(0.001, sc * (1 - burst * 0.48)),
                      Math.max(0.001, sc * (1 + burst * 0.36)));
    ch.upper.rotation.z = a.deathDir * stagger * (1 - fall) * 0.82;
    ch.upper.position.y = 0.16 * split;
    ch.torso.position.set(-a.deathDir * 0.10 * split, 0.12 * split - drop * drop * 0.20, 0);
    ch.headPiv.position.set(a.deathDir * 0.28 * split,
      CH.headC + 0.48 * split - drop * drop * 0.38, -0.10 * split);
    ch.legL.position.set(-CH.hipW - 0.28 * split,
      CH.legTop + 0.10 * split - drop * drop * 0.26, 0.12 * split);
    ch.legR.position.set(CH.hipW + 0.30 * split,
      CH.legTop + 0.18 * split - drop * drop * 0.32, -0.10 * split);
    ch.armL.position.set(-0.32 - 0.52 * split,
      CH.shoulder + 0.24 * split - drop * drop * 0.34, 0.18 * split);
    ch.armR.position.set(0.32 + 0.55 * split,
      CH.shoulder + 0.17 * split - drop * drop * 0.29, -0.20 * split);
    ch.legL.rotation.x = -0.62 - split * 1.05;
    ch.legR.rotation.x = 0.48 + split * 0.86;
    ch.legL.rotation.z = split * 0.90;
    ch.legR.rotation.z = -split * 0.82;
    ch.armL.rotation.set(0.98 + split * 1.10, 0, 1.10 + split * 1.22);
    ch.armR.rotation.set(0.82 - split * 0.76, 0, -1.18 - split * 1.16);
    ch.gearPiv.rotation.z = -a.deathDir * split * 1.05;
    for (let i = 0; i < ch.shards.length; i++) {
      const shard = ch.shards[i];
      const side = (i & 1) ? 1 : -1;
      const fore = (i & 2) ? 1 : -1;
      shard.visible = a.deathT > 0.09;
      shard.position.set(side * (0.18 + i * 0.055) * split,
        0.98 + (0.38 + (3 - i) * 0.075) * split - drop * drop * (0.46 + i * 0.05),
        fore * (0.16 + i * 0.035) * split);
      shard.rotation.set(side * split * (1.8 + i * 0.25),
        fore * split * (1.1 + i * 0.35), side * split * (2.2 - i * 0.18));
    }
    return;
  }

  ch.root.rotation.x = 0;
  ch.root.rotation.y = a.bodyYaw;
  ch.root.rotation.z = 0;
  ch.root.position.y = a.pos.y;
  ch.torso.position.set(0, 0, 0);
  ch.headPiv.position.set(0, CH.headC, 0);
  ch.legL.position.set(-CH.hipW, CH.legTop, 0);
  ch.legR.position.set(CH.hipW, CH.legTop, 0);
  ch.armL.position.set(-0.32, CH.shoulder, 0);
  ch.armR.position.set(0.32, CH.shoulder, 0);
  for (let i = 0; i < ch.shards.length; i++) ch.shards[i].visible = false;
  if (a.spawnT > 0) {
    a.spawnT = Math.max(0, a.spawnT - dt);
    const u = 1 - a.spawnT / 0.45;
    const s = u < 1 ? 1 + Math.sin(u * Math.PI) * 0.28 * (1 - u) : 1;
    ch.root.scale.set(s * (2 - s), Math.pow(smoothstep(u), 0.6) * s, s * (2 - s));
  } else ch.root.scale.set(1, 1, 1);

  const moveYaw = moving ? Math.atan2(a.vel.x, a.vel.z) + Math.PI : a.bodyYaw;
  const faceYaw = a.aimYaw + Math.PI;
  const bodyTarget = moving && !a.aiming ? moveYaw : faceYaw;
  a.bodyYaw = approachAngle(a.bodyYaw, bodyTarget, dt * (moving ? 9 : 4.5));
  ch.root.rotation.y = a.bodyYaw;

  const lead = angDelta(a.bodyYaw, faceYaw);
  ch.upper.rotation.y = damp(ch.upper.rotation.y, clamp(lead, -1.20, 1.20) * 0.78, 13, dt);
  ch.headPiv.rotation.y = damp(ch.headPiv.rotation.y, clamp(lead, -1.35, 1.35) * 0.46, 15, dt);
  ch.headPiv.rotation.x = damp(ch.headPiv.rotation.x, clamp(a.aimPitch, -0.78, 0.78), 14, dt);

  const invSpd = spd > 0.001 ? 1 / spd : 0;
  const localFwd = (-Math.sin(a.bodyYaw) * a.vel.x - Math.cos(a.bodyYaw) * a.vel.z) * invSpd;
  const localStrafe = (Math.cos(a.bodyYaw) * a.vel.x - Math.sin(a.bodyYaw) * a.vel.z) * invSpd;
  const stride = clamp(spd / 5.8, 0, 1.42);
  a.sprintBlend = damp(a.sprintBlend || 0, clamp((spd - 5.8) / 2.2, 0, 1), 8, dt);
  const gaitRate = 2.0 + spd * lerp(1.7, 2.05, a.sprintBlend);
  a.gait += dt * gaitRate;
  const sw = Math.sin(a.gait) * stride;
  const sw2 = Math.cos(a.gait * 2) * stride;
  if (a._animGround === undefined) a._animGround = a.onGround;
  if (!a.onGround && a._animGround && a.vel.y > 0) a.jumpT = 0.16;
  a.jumpT = Math.max(0, (a.jumpT || 0) - dt);
  if (!a.onGround) a._animFallV = Math.min(a._animFallV || 0, a.vel.y);
  if (a.onGround && !a._animGround) {
    a.landImpact = clamp((-(a._animFallV || 0) - 2.5) / 11, 0.12, 1);
    a.landT = 0.42;
    a._animFallV = 0;
  }
  a._animGround = a.onGround;
  a.landT = Math.max(0, (a.landT || 0) - dt);
  const landU = a.landT > 0 ? 1 - a.landT / 0.42 : 1;
  const landCrush = landU < 0.36 ? Math.sin(landU / 0.36 * Math.PI) * (a.landImpact || 0) : 0;
  const landRebound = landU >= 0.28 && landU < 0.78
    ? Math.sin((landU - 0.28) / 0.50 * Math.PI) * (a.landImpact || 0) : 0;
  const land = landCrush - landRebound * 0.34;
  const jumpU = a.jumpT > 0 ? 1 - a.jumpT / 0.16 : 1;
  const jumpSquash = a.jumpT > 0 && jumpU < 0.44
    ? Math.sin(jumpU / 0.44 * Math.PI) : 0;
  const jumpStretch = a.jumpT > 0 && jumpU >= 0.30
    ? Math.sin((jumpU - 0.30) / 0.70 * Math.PI) : 0;

  if (a.onGround) {
    const walk = lerp(1.12, 1.48, a.sprintBlend);
    ch.legL.rotation.x = damp(ch.legL.rotation.x, sw * walk * localFwd - landCrush * 0.40 + landRebound * 0.20, 22, dt);
    ch.legR.rotation.x = damp(ch.legR.rotation.x, -sw * walk * localFwd - landCrush * 0.40 + landRebound * 0.20, 22, dt);
    ch.legL.rotation.z = damp(ch.legL.rotation.z,
      -sw * 0.68 * localStrafe - landCrush * 0.34 + landRebound * 0.12, 20, dt);
    ch.legR.rotation.z = damp(ch.legR.rotation.z,
      sw * 0.68 * localStrafe + landCrush * 0.34 - landRebound * 0.12, 20, dt);
    ch.hips.position.y = damp(ch.hips.position.y,
      Math.abs(sw2) * lerp(0.045, 0.080, a.sprintBlend) - stride * 0.035 - land * 0.31, 18, dt);
  } else {
    const rise = clamp(a.vel.y / JUMP_V, -1, 1);
    ch.legL.rotation.x = damp(ch.legL.rotation.x, rise > 0 ? -0.94 : 0.36, 11, dt);
    ch.legR.rotation.x = damp(ch.legR.rotation.x, rise > 0 ? 0.70 : -0.34, 11, dt);
    ch.legL.rotation.z = damp(ch.legL.rotation.z, rise > 0 ? -0.20 : -0.44, 10, dt);
    ch.legR.rotation.z = damp(ch.legR.rotation.z, rise > 0 ? 0.20 : 0.44, 10, dt);
    ch.hips.position.y = damp(ch.hips.position.y,
      (rise > 0 ? -0.085 : 0.045) - jumpSquash * 0.13 + jumpStretch * 0.09, 12, dt);
  }
  ch.hips.scale.set(1 + jumpSquash * 0.16 - jumpStretch * 0.08 + landCrush * 0.13,
    1 - jumpSquash * 0.22 + jumpStretch * 0.14 - landCrush * 0.20 + landRebound * 0.07,
    1 + jumpSquash * 0.16 - jumpStretch * 0.08 + landCrush * 0.13);

  /* The rig faces local -Z: after bodyYaw, forward is (-sin yaw, -cos yaw)
     and right is (+cos yaw, -sin yaw). Shoulder +X swings an arm forward;
     past +PI/2 tips it upward. Keep the movement, aim, reload, air, and flinch
     signs below paired to those conventions or opposite limbs invert. */
  const aimUp = a.aiming ? 1 : 0;
  a.aimBlend = damp(a.aimBlend, aimUp, 10, dt);
  const rest = sw * 0.88 * localFwd + sw2 * 0.34 * localStrafe;
  const restL = -sw * 0.88 * localFwd - sw2 * 0.34 * localStrafe;
  const fireX = 1.42 + clamp(a.aimPitch, -0.7, 0.7);
  const reloadU = a.reloadT > 0 ? 1 - a.reloadT / WBY[a.weapon].reload : 0;
  const reloadPose = a.reloadT > 0 ? Math.sin(reloadU * Math.PI) : 0;
  const airReach = a.onGround ? 0 : clamp(-a.vel.y / 13, 0, 1);
  ch.armR.rotation.x = damp(ch.armR.rotation.x,
    lerp(rest, fireX, a.aimBlend) + a.recoil * 0.90 - reloadPose * 0.48 +
      airReach * 0.46 - jumpSquash * 0.58 + landRebound * 0.28, 18, dt);
  ch.armL.rotation.x = damp(ch.armL.rotation.x,
    lerp(restL, fireX - 0.12, a.aimBlend) + a.recoil * 0.62 - reloadPose * 0.90 +
      airReach * 0.60 - jumpSquash * 0.72 + landRebound * 0.34, 18, dt);
  ch.armR.rotation.z = damp(ch.armR.rotation.z,
    lerp(0.10, -0.38, a.aimBlend) - reloadPose * 0.36 - jumpSquash * 0.38, 16, dt);
  ch.armL.rotation.z = damp(ch.armL.rotation.z,
    lerp(-0.10, 0.58, a.aimBlend) + reloadPose * 0.68 + jumpSquash * 0.38, 16, dt);
  ch.armL.rotation.y = damp(ch.armL.rotation.y, lerp(0, 0.55, a.aimBlend), 14, dt);
  ch.armR.rotation.y = damp(ch.armR.rotation.y, reloadPose * -0.20, 14, dt);

  a.recoil = Math.max(0, a.recoil - dt * 6.5);
  a.flinch = Math.max(0, a.flinch - dt * 3.2);
  const flinchSide = a.flinchSide || 1;
  ch.upper.rotation.x = damp(ch.upper.rotation.x,
    clamp(a.aimPitch, -0.8, 0.8) * 0.38 + a.recoil * 0.30 + a.flinch * 0.48, 16, dt);
  ch.upper.rotation.z = damp(ch.upper.rotation.z,
    -localStrafe * stride * 0.20 - a.flinch * flinchSide * 0.72, 15, dt);
  ch.torso.rotation.y = damp(ch.torso.rotation.y, -sw * localFwd * 0.18, 16, dt);
  ch.hips.rotation.x = damp(ch.hips.rotation.x,
    stride * 0.15 + landCrush * 0.48 - landRebound * 0.18 - jumpSquash * 0.26, 16, dt);
  ch.hips.rotation.z = damp(ch.hips.rotation.z, -localStrafe * stride * 0.14, 16, dt);
  ch.hips.position.x = damp(ch.hips.position.x, a.flinch * flinchSide * 0.14 - localStrafe * stride * 0.035, 16, dt);
  ch.hips.position.z = damp(ch.hips.position.z, a.flinch * 0.12, 16, dt);
  const idle = moving ? 0 : 1;
  ch.upper.position.y = Math.sin(t * 1.9 + a.id) * 0.016 * idle;
  ch.upper.position.x = Math.sin(t * 0.63 + a.id * 1.7) * 0.026 * idle;
  ch.upper.position.z = -a.flinch * 0.14;
  ch.gearPiv.rotation.x = damp(ch.gearPiv.rotation.x,
    -sw * localFwd * 0.18 + a.recoil * 0.34 + landCrush * 0.46 - landRebound * 0.26, 9, dt);
  ch.gearPiv.rotation.z = damp(ch.gearPiv.rotation.z,
    -sw2 * localStrafe * 0.22 + a.flinch * flinchSide * 0.72, 8, dt);
}
