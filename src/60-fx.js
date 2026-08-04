/* =====================================================================
   PASTEL NUKETOWN — FX (confetti, sparkles, tracers, floaters) + audio
   ===================================================================== */

const FX = {
  conf: null, spark: null,
  bubbleMesh: null, bubbles: [], bubbleI: 0,
  mallowMesh: null, mallows: [], mallowI: 0,
  dartMesh: null, darts: [], dartI: 0,
  dropletMesh: null, droplets: [], dropletI: 0,
  sugarMesh: null, sugar: [], sugarI: 0,
  shardMesh: null, shards: [], shardI: 0,
  ringMesh: null, rings: [], ringI: 0,
  impacts: [], impactI: 0,
  activeWeapon: 'smg', impactDelay: 0.02,
  /* The effect the shot being drawn right now is wearing, and the colour its
     owner is drawn in — set by fxTracer and read by fxImpact, exactly the way
     activeWeapon and impactDelay already bridge that gap. Both are copied
     onto the queued impact record, so a shotgun with nine pellets in flight
     does not lose them to the next shot. */
  activeEffect: null,
  shake: 0, shakeV: 0,
  muzzleLights: [], muzzleI: 0
};
const MUZZLE_LIFE = 0.12;
const fxRng = mulberry32(0xFACADE);
const fxRand = (a, b) => a + (b - a) * fxRng();
const fxPick = arr => arr[Math.floor(fxRng() * arr.length) % arr.length];
const FX_DARK = C(0x3a2b4a);
const FX_WHITE = C(0xffffff);
const FX_BUBBLE = C(0x8eeeff);
const FX_PINK = C(0xff9dcc);
const FX_MINT = C(0xa8f1d4);
const FX_LILAC = C(0xd8baff);
const FX_SUGAR = C(0xfff4df);
const FX_GLASS = C(0x9fe8ff);
const _fxColorA = C(0xffffff);
const _fxColorB = C(0xffffff);
/* The shooter's colour for the shot in flight. Held here rather than kept as
   a reference to the caller's Color so nothing downstream can be surprised by
   it changing under them. */
const _fxOwner = C(0xffffff);
/* The default muzzle flash. An effect may move this hue; it may not move the
   intensity or the range, which is why both are literals at their one use. */
const FX_MUZZLE = C(0xffd38c);
const _fxMatrix = new THREE.Matrix4();
const _fxPosition = new THREE.Vector3();
const _fxScale = new THREE.Vector3();
const _fxDirection = new THREE.Vector3();
const _fxAxis = new THREE.Vector3();
const _fxUp = new THREE.Vector3(0, 1, 0);
const _fxForward = new THREE.Vector3(0, 0, 1);
const _fxQuat = new THREE.Quaternion();
const _fxSpinQuat = new THREE.Quaternion();
const _fxEuler = new THREE.Euler();
const LOLLI_SHARDS = [0x9fe8ff, 0xff8fc8, 0xfff1a6, 0xd4b7ff];

function fxMixSurface(out, hex, tint, amount, gain) {
  out.setHex(hex || 0xffffff).convertSRGBToLinear();
  out.r = lerp(out.r, tint.r, amount) * gain;
  out.g = lerp(out.g, tint.g, amount) * gain;
  out.b = lerp(out.b, tint.b, amount) * gain;
  return out;
}
function fxSetMaterialColor(material, color) {
  material.color.setRGB(color.r, color.g, color.b);
}

function fxSetInstance(mesh, index, x, y, z, quat, sx, sy, sz) {
  _fxPosition.set(x, y, z);
  _fxScale.set(sx, sy, sz);
  _fxMatrix.compose(_fxPosition, quat, _fxScale);
  mesh.setMatrixAt(index, _fxMatrix);
  mesh.userData.matrixDirty = true;
}
function fxHideInstance(mesh, index) {
  _fxMatrix.makeScale(0, 0, 0);
  mesh.setMatrixAt(index, _fxMatrix);
  mesh.userData.matrixDirty = true;
}
function fxSetInstanceColor(mesh, index, color) {
  const a = mesh.instanceColor.array, p = index * 3;
  a[p] = color.r; a[p + 1] = color.g; a[p + 2] = color.b;
  mesh.userData.colorDirty = true;
}
function fxFlushInstance(mesh) {
  if (!mesh) return;
  if (mesh.userData.matrixDirty) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.matrixDirty = false;
  }
  if (mesh.instanceColor && mesh.userData.colorDirty) {
    mesh.instanceColor.needsUpdate = true;
    mesh.userData.colorDirty = false;
  }
}
function fxMakeInstanced(geometry, material, count, colors) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.userData.matrixDirty = false;
  mesh.userData.colorDirty = false;
  if (colors) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  _fxMatrix.makeScale(0, 0, 0);
  for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _fxMatrix);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

const FX_BUBBLE_VERTEX = `
  attribute float fxPhase;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vPhase;
  void main() {
    vec4 instancedPosition = instanceMatrix * vec4(position, 1.0);
    vec4 worldPosition = modelMatrix * instancedPosition;
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vPhase = fxPhase;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;
const FX_BUBBLE_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying float vPhase;
  void main() {
    vec3 n = normalize(vWorldNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float rim = pow(1.0 - abs(dot(n, viewDir)), 1.55);
    float band = vPhase + rim * 12.0 + dot(vWorldPosition, vec3(0.19, 0.31, 0.13));
    vec3 pink = vec3(1.0, 0.35, 0.68);
    vec3 mint = vec3(0.28, 1.0, 0.70);
    vec3 lilac = vec3(0.62, 0.42, 1.0);
    float wp = 0.38 + 0.34 * sin(band);
    float wm = 0.38 + 0.34 * sin(band + 2.094);
    float wl = 0.38 + 0.34 * sin(band + 4.188);
    vec3 iri = (pink * wp + mint * wm + lilac * wl) / (wp + wm + wl);
    vec3 highlightDir = normalize(vec3(-0.48, 0.72, 0.50));
    float highlight = pow(max(dot(n, highlightDir), 0.0), 42.0);
    float pin = pow(max(dot(n, normalize(highlightDir + viewDir * 0.45)), 0.0), 95.0);
    vec3 color = iri * (0.30 + rim * 1.18) + vec3(1.0) * (highlight * 0.68 + pin);
    float alpha = 0.055 + rim * 0.57 + highlight * 0.20 + pin * 0.35;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.84));
  }
`;
const FX_CANDY_VERTEX = `
  attribute float fxPhase;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vLocalPosition;
  varying float vPhase;
  void main() {
    vec4 instancedPosition = instanceMatrix * vec4(position, 1.0);
    vec4 worldPosition = modelMatrix * instancedPosition;
    vWorldPosition = worldPosition.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
    vLocalPosition = position;
    vPhase = fxPhase;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;
const FX_CANDY_FRAGMENT = `
  precision highp float;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vLocalPosition;
  varying float vPhase;
  void main() {
    vec3 n = normalize(vWorldNormal);
    if (!gl_FrontFacing) n = -n;
    vec3 viewDir = normalize(cameraPosition - vWorldPosition);
    float disc = 1.0 - smoothstep(-0.015, 0.055, vLocalPosition.y);
    float radial = length(vLocalPosition.xz);
    float rim = smoothstep(0.12, 0.235, radial) * disc;
    float fresnel = pow(1.0 - abs(dot(n, viewDir)), 2.0);
    vec3 glass = mix(vec3(0.98, 0.30, 0.60), vec3(0.35, 0.90, 1.0),
      0.5 + 0.5 * sin(vPhase + radial * 18.0));
    glass = mix(glass * 1.25, vec3(0.24, 0.08, 0.34), rim * 0.62);
    float glint = pow(max(dot(n, normalize(vec3(-0.42, 0.76, 0.49))), 0.0), 32.0);
    vec3 stick = vec3(1.0, 0.89, 0.66) * (0.76 + 0.24 * max(n.y, 0.0));
    vec3 color = mix(stick, glass + fresnel * 0.45 + glint, disc);
    float alpha = mix(1.0, 0.72 + fresnel * 0.20, disc);
    gl_FragColor = vec4(color, alpha);
  }
`;
const FX_IMPACT_VERTEX = `
  varying vec3 vInstanceColor;
  void main() {
    vInstanceColor = instanceColor;
    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;
const FX_IMPACT_FRAGMENT = `
  precision highp float;
  uniform float fxGain;
  uniform float fxOpacity;
  varying vec3 vInstanceColor;
  void main() {
    gl_FragColor = vec4(vInstanceColor * fxGain, fxOpacity);
  }
`;
function fxImpactMaterial(gain, opacity, side) {
  return new THREE.ShaderMaterial({
    vertexShader: FX_IMPACT_VERTEX,
    fragmentShader: FX_IMPACT_FRAGMENT,
    uniforms: {
      fxGain: { value: gain },
      fxOpacity: { value: opacity }
    },
    transparent: true,
    depthWrite: false,
    side: side || THREE.FrontSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false
  });
}

/* Confetti shape. Squares read as "default particle demo"; a four-point
   candy star belongs to the same world as BUBBLEGUN and LOLLIPOP. */
function squareTex() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  g.translate(16, 16);
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU - Math.PI / 2;
    const r = i % 2 ? 5.5 : 15;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  g.beginPath(); g.arc(0, 0, 4.5, 0, TAU); g.fill();
  return new THREE.CanvasTexture(cv);
}
function softTex() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const g = cv.getContext('2d');
  const rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.4, 'rgba(255,255,255,.55)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(cv);
}

/* 0 right at the lens, 1 beyond 1.2m. Used by every point sprite.

   This used to reach out to 2.2m, because it was the only thing standing
   between the player and a sprite that had grown to fill the frame. It is
   not any more: FX_SPRITE_MAX_H below caps how wide a sprite can ever get,
   so this only has to stop something being drawn *on* the lens, and it can
   be tight enough to leave a muzzle flash a metre down the barrel at full
   strength. */
function nearFade(x, y, z) {
  const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return smoothstep((d - 0.45) / 0.75);
}

/* =====================================================================
   POINT SPRITES

   Our own shader rather than PointsMaterial, for two reasons — and the
   first cut of the shot effects walked into both of them at once.

   IT FADES ON ALPHA, NOT ON BRIGHTNESS. PointsMaterial has no per-particle
   opacity, so the only dimmer available was the vertex colour, and
   multiplying a colour toward zero is a fade only where the blend is
   additive. On the normal-blended pool it is a darkening: the butter
   0xfff1a6 at 55% brightness is 0x8c845b, which is mud. Every confetti
   flake spent the back 70% of its life sliding down to brown, and that —
   not the palette, which was pastel all along — is what put muddy tan
   stars on screen. Alpha fades to nothing under either blend, so both
   pools now use it, and the near-lens fade above can apply to both instead
   of only to the additive one.

   IT CANNOT GROW PAST FX_SPRITE_MAX_H. gl_PointSize goes as 1/distance
   with nothing to stop it: the 0.16m confetti sprite is 12px across a wall
   six metres off and 1200px across if it spawns six centimetres from the
   eye, which is where a muzzle puff spawns. The clamp is a hard ceiling
   measured in viewport heights, and it binds on the default kill confetti
   exactly as it binds on a bought effect.
   ===================================================================== */

/* No sprite, bought or default, may be wider than a twelfth of the
   viewport height — 75px on a 900px-tall view, half the width of the
   default hit-ring. Both pools reach it at 0.9m from the lens, which is
   also the closest an effect is allowed to draw (FX_EFFECT_CLEAR). */
const FX_SPRITE_MAX_H = 1 / 12;
/* The default hit-ring, which is the yardstick every effect is measured
   against below. RingGeometry(FX_RING_INNER, 1) scaled to FX_HIT_RING and
   grown by FX_RING_GROW: a thin white annulus that peaks a little over a
   metre in radius and is gone in 0.18s. */
const FX_RING_INNER = 0.88;
const FX_RING_GROW = 2.9;
const FX_HIT_RING = 0.26;
/* World size of one sprite in each pool: the number that, times half the
   viewport height and divided by the distance, is its width in pixels. */
const FX_CONF_SIZE = 0.16;
const FX_SPARK_SIZE = 0.30;

const FX_POINT_VERTEX = `
  attribute vec3 fxColor;
  attribute float fxAlpha;
  uniform float fxSize;
  uniform float fxScale;
  uniform float fxMaxPx;
  varying vec3 vFxColor;
  varying float vFxAlpha;
  void main() {
    vFxColor = fxColor;
    vFxAlpha = fxAlpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = min(fxSize * fxScale / max(-mv.z, 0.05), fxMaxPx);
    gl_Position = projectionMatrix * mv;
  }
`;
const FX_POINT_FRAGMENT = `
  precision highp float;
  uniform sampler2D fxMap;
  varying vec3 vFxColor;
  varying float vFxAlpha;
  void main() {
    float a = texture2D(fxMap, gl_PointCoord).a * vFxAlpha;
    if (a < 0.02) discard;
    gl_FragColor = vec4(vFxColor, a);
  }
`;

function ParticleSys(max, tex, additive, size) {
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  const alpha = new Float32Array(max);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('fxColor', new THREE.BufferAttribute(col, 3));
  g.setAttribute('fxAlpha', new THREE.BufferAttribute(alpha, 1));
  g.setDrawRange(0, 0);
  const m = new THREE.ShaderMaterial({
    vertexShader: FX_POINT_VERTEX, fragmentShader: FX_POINT_FRAGMENT,
    uniforms: {
      fxMap: { value: tex },
      fxSize: { value: size },
      /* Half the drawing buffer height and the clamp in the same units.
         psUpdate refreshes them, so a resize costs nothing here. */
      fxScale: { value: 360 },
      fxMaxPx: { value: 720 * FX_SPRITE_MAX_H }
    },
    transparent: true, depthWrite: false, toneMapped: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  scene.add(pts);
  return {
    pts, max, n: 0, additive: !!additive,
    vx: new Float32Array(max), vy: new Float32Array(max), vz: new Float32Array(max),
    life: new Float32Array(max), maxLife: new Float32Array(max),
    r: new Float32Array(max), g: new Float32Array(max), b: new Float32Array(max),
    grav: additive ? 0.6 : 15
  };
}
function psEmit(P, x, y, z, vx, vy, vz, life, color) {
  let i = P.n;
  if (i >= P.max) {                       // recycle the oldest slot
    i = 0; let best = 1e9;
    for (let k = 0; k < P.max; k++) if (P.life[k] < best) { best = P.life[k]; i = k; }
  } else P.n++;
  const a = P.pts.geometry.attributes;
  a.position.array[i * 3] = x; a.position.array[i * 3 + 1] = y; a.position.array[i * 3 + 2] = z;
  a.fxAlpha.array[i] = 0;
  P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
  P.life[i] = life; P.maxLife[i] = life;
  P.r[i] = color.r; P.g[i] = color.g; P.b[i] = color.b;
}
/* The clamp and the perspective term both live in drawing-buffer pixels,
   so they are re-read from the canvas rather than cached: a phone rotating
   changes both. No renderer means the headless harness, where nothing is
   drawn and the uniforms are inert. */
function psViewport(P) {
  const h = renderer && renderer.domElement ? renderer.domElement.height : 0;
  if (!h) return;
  const u = P.pts.material.uniforms;
  u.fxScale.value = h * 0.5;
  u.fxMaxPx.value = h * FX_SPRITE_MAX_H;
}
function psUpdate(P, dt) {
  const a = P.pts.geometry.attributes, pos = a.position.array, col = a.fxColor.array;
  const alpha = a.fxAlpha.array;
  psViewport(P);
  let live = 0;
  for (let i = 0; i < P.n; i++) {
    if (P.life[i] <= 0) { alpha[i] = 0; pos[i * 3 + 1] = -999; continue; }
    P.life[i] -= dt;
    P.vy[i] -= P.grav * dt;
    P.vx[i] *= Math.exp(-2.2 * dt); P.vz[i] *= Math.exp(-2.2 * dt);
    pos[i * 3] += P.vx[i] * dt; pos[i * 3 + 1] += P.vy[i] * dt; pos[i * 3 + 2] += P.vz[i] * dt;
    if (pos[i * 3 + 1] < 0.03) { pos[i * 3 + 1] = 0.03; P.vy[i] *= -0.32; P.vx[i] *= 0.6; P.vz[i] *= 0.6; }
    const f = clamp(P.life[i] / P.maxLife[i], 0, 1);
    let e = f > 0.7 ? 1 : f / 0.7;
    /* Both fades ride the alpha channel now, which is why both pools can
       have both of them. The old code faded by multiplying the colour
       toward black — a fade under additive blending and a slide into mud
       under normal blending — so the near-lens fade had to be withheld
       from the confetti to keep it from turning into dark squares. Neither
       compromise survives: the colour written below is the colour that was
       asked for, at every age and every distance. */
    e *= nearFade(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    alpha[i] = e;
    col[i * 3] = P.r[i]; col[i * 3 + 1] = P.g[i]; col[i * 3 + 2] = P.b[i];
    live = i + 1;
  }
  a.position.needsUpdate = true;
  a.fxColor.needsUpdate = true;
  a.fxAlpha.needsUpdate = true;
  P.pts.geometry.setDrawRange(0, P.n);
}

function fxWarmGeometryCache() {
  const warmScene = new THREE.Scene();
  const warmCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 4);
  const warmMeshMaterial = new THREE.MeshBasicMaterial({ color: FX_WHITE });
  const warmLineMaterial = new THREE.LineBasicMaterial({ color: FX_WHITE });
  const warmPointsMaterial = new THREE.PointsMaterial({ color: FX_WHITE, size: 1 });
  warmCamera.position.z = 2;
  const addGeometry = root => root.traverse(obj => {
    if (!obj.geometry || !obj.material) return;
    let warm;
    if (obj.isInstancedMesh) {
      warm = new THREE.InstancedMesh(obj.geometry, warmMeshMaterial, 1);
      _fxMatrix.identity();
      warm.setMatrixAt(0, _fxMatrix);
      warm.instanceMatrix.needsUpdate = true;
    } else if (obj.isPoints) warm = new THREE.Points(obj.geometry, warmPointsMaterial);
    else if (obj.isLineSegments) warm = new THREE.LineSegments(obj.geometry, warmLineMaterial);
    else if (obj.isLine) warm = new THREE.Line(obj.geometry, warmLineMaterial);
    else warm = new THREE.Mesh(obj.geometry, warmMeshMaterial);
    warm.frustumCulled = false;
    warm.scale.setScalar(0.001);
    warmScene.add(warm);
  });
  addGeometry(scene);
  addGeometry(vmScene);
  const target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: true, stencilBuffer: false
  });
  const priorTarget = renderer.getRenderTarget();
  const priorAutoClear = renderer.autoClear;
  renderer.setRenderTarget(target);
  renderer.autoClear = true;
  renderer.render(warmScene, warmCamera);
  renderer.setRenderTarget(priorTarget);
  renderer.autoClear = priorAutoClear;
  target.dispose();
  warmMeshMaterial.dispose();
  warmLineMaterial.dispose();
  warmPointsMaterial.dispose();
}

function initFX() {
  FX.conf  = ParticleSys(SOFTWARE_GPU ? 340 : 900, squareTex(), false, FX_CONF_SIZE);
  FX.spark = ParticleSys(SOFTWARE_GPU ? 200 : 520, softTex(),  true,  FX_SPARK_SIZE);

  const bubbleCount = SOFTWARE_GPU ? 12 : 40;
  const bubbleGeo = new THREE.SphereGeometry(1, SOFTWARE_GPU ? 8 : 14, SOFTWARE_GPU ? 6 : 10);
  const bubblePhase = new THREE.InstancedBufferAttribute(new Float32Array(bubbleCount), 1);
  bubblePhase.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < bubbleCount; i++) bubblePhase.array[i] = (i * 2.399963) % TAU;
  bubbleGeo.setAttribute('fxPhase', bubblePhase);
  FX.bubbleMesh = fxMakeInstanced(bubbleGeo, new THREE.ShaderMaterial({
    vertexShader: FX_BUBBLE_VERTEX, fragmentShader: FX_BUBBLE_FRAGMENT,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.NormalBlending, toneMapped: false
  }), bubbleCount, false);
  FX.bubbleMesh.renderOrder = 5;
  for (let i = 0; i < bubbleCount; i++) {
    FX.bubbles.push({
      t: -1, dur: 0, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0,
      wx: 0, wy: 0, wz: 0, rise: 0, wobble: 0, phase: 0, size: 0
    });
  }

  const mallowCount = SOFTWARE_GPU ? 20 : 48;
  const mallowProfile = [
    new THREE.Vector2(0, -0.39), new THREE.Vector2(0.065, -0.386),
    new THREE.Vector2(0.14, -0.35),
    new THREE.Vector2(0.205, -0.30), new THREE.Vector2(0.23, -0.18),
    new THREE.Vector2(0.23, 0.18), new THREE.Vector2(0.205, 0.30),
    new THREE.Vector2(0.14, 0.35), new THREE.Vector2(0.065, 0.386),
    new THREE.Vector2(0, 0.39)
  ];
  const mallowGeo = new THREE.LatheGeometry(mallowProfile, SOFTWARE_GPU ? 8 : 14);
  const mallowPos = mallowGeo.attributes.position.array;
  const mallowColor = new Float32Array(mallowPos.length);
  for (let i = 0; i < mallowPos.length / 3; i++) {
    const dust = 0.89 + 0.11 * (0.5 + 0.5 * Math.sin(i * 12.9898));
    mallowColor[i * 3] = FX_SUGAR.r * dust;
    mallowColor[i * 3 + 1] = FX_SUGAR.g * dust;
    mallowColor[i * 3 + 2] = FX_SUGAR.b * dust;
  }
  mallowGeo.setAttribute('color', new THREE.BufferAttribute(mallowColor, 3));
  FX.mallowMesh = fxMakeInstanced(mallowGeo, new THREE.MeshLambertMaterial({
    color: FX_WHITE, vertexColors: true,
    emissive: C(0xc19478), emissiveIntensity: 0.46
  }), mallowCount, false);
  for (let i = 0; i < mallowCount; i++) {
    FX.mallows.push({
      mode: 0, t: -1, dur: 0, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0,
      x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, surface: 0xffffff,
      arc: 0, rate: 0, phase: 0, axisX: 1, axisZ: 0, dusted: false,
      base: new THREE.Quaternion()
    });
  }

  const dartCount = SOFTWARE_GPU ? 6 : 16;
  const dartProfile = [
    new THREE.Vector2(0.0, 0.64), new THREE.Vector2(0.018, 0.625),
    new THREE.Vector2(0.035, 0.59), new THREE.Vector2(0.035, -0.015),
    new THREE.Vector2(0.10, -0.035), new THREE.Vector2(0.205, -0.065),
    new THREE.Vector2(0.24, -0.105), new THREE.Vector2(0.24, -0.145),
    new THREE.Vector2(0.205, -0.185), new THREE.Vector2(0.10, -0.215),
    new THREE.Vector2(0.0, -0.23)
  ];
  const dartGeo = new THREE.LatheGeometry(dartProfile, SOFTWARE_GPU ? 10 : 18);
  const dartPhase = new THREE.InstancedBufferAttribute(new Float32Array(dartCount), 1);
  dartPhase.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < dartCount; i++) dartPhase.array[i] = (i * 1.618034) % TAU;
  dartGeo.setAttribute('fxPhase', dartPhase);
  FX.dartMesh = fxMakeInstanced(dartGeo, new THREE.ShaderMaterial({
    vertexShader: FX_CANDY_VERTEX, fragmentShader: FX_CANDY_FRAGMENT,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    toneMapped: false
  }), dartCount, false);
  FX.dartMesh.renderOrder = 4;
  for (let i = 0; i < dartCount; i++) {
    FX.darts.push({
      t: -1, dur: 0, sx: 0, sy: 0, sz: 0, ex: 0, ey: 0, ez: 0,
      spin: 0, phase: 0, base: new THREE.Quaternion()
    });
  }

  const dropletCount = SOFTWARE_GPU ? 36 : 96;
  FX.dropletMesh = fxMakeInstanced(
    new THREE.SphereGeometry(1, SOFTWARE_GPU ? 5 : 7, SOFTWARE_GPU ? 3 : 5),
    fxImpactMaterial(1.40, 0.76), dropletCount, true);
  const dropletPalette = [FX_PINK, FX_MINT, FX_LILAC, FX_WHITE];
  for (let i = 0; i < dropletCount; i++) {
    fxSetInstanceColor(FX.dropletMesh, i, dropletPalette[i % dropletPalette.length]);
    FX.droplets.push({
      t: -1, dur: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0
    });
  }

  const sugarCount = SOFTWARE_GPU ? 36 : 96;
  FX.sugarMesh = fxMakeInstanced(
    new THREE.SphereGeometry(1, SOFTWARE_GPU ? 4 : 6, SOFTWARE_GPU ? 3 : 4),
    fxImpactMaterial(0.80, 0.20), sugarCount, true);
  for (let i = 0; i < sugarCount; i++) {
    fxSetInstanceColor(FX.sugarMesh, i, FX_SUGAR);
    FX.sugar.push({
      t: -1, dur: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, size: 0
    });
  }

  const shardCount = SOFTWARE_GPU ? 24 : 64;
  FX.shardMesh = fxMakeInstanced(
    new THREE.ConeGeometry(0.075, 0.32, 3, 1, false),
    fxImpactMaterial(1.35, 0.72, THREE.DoubleSide), shardCount, true);
  for (let i = 0; i < shardCount; i++) {
    fxSetInstanceColor(FX.shardMesh, i, C(LOLLI_SHARDS[i % LOLLI_SHARDS.length]));
    FX.shards.push({
      t: -1, dur: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      rx: 0, ry: 0, rz: 0, sx: 0, sy: 0, sz: 0, size: 0
    });
  }

  const ringCount = SOFTWARE_GPU ? 10 : 24;
  FX.ringMesh = fxMakeInstanced(
    new THREE.RingGeometry(FX_RING_INNER, 1, SOFTWARE_GPU ? 14 : 24),
    fxImpactMaterial(1.20, 0.48, THREE.DoubleSide), ringCount, true);
  FX.ringMesh.material.polygonOffset = true;
  FX.ringMesh.material.polygonOffsetFactor = -3;
  for (let i = 0; i < ringCount; i++) {
    fxSetInstanceColor(FX.ringMesh, i, FX_WHITE);
    FX.rings.push({
      t: -1, dur: 0, x: 0, y: 0, z: 0, s0: 0, grow: 0,
      quat: new THREE.Quaternion()
    });
  }

  const impactCount = SOFTWARE_GPU ? 40 : 96;
  for (let i = 0; i < impactCount; i++) {
    FX.impacts.push({
      t: -1, weapon: 'smg', x: 0, y: 0, z: 0,
      nx: 0, ny: 1, nz: 0, kind: 'map', surface: 0xffffff,
      effect: null, tintR: 1, tintG: 1, tintB: 1
    });
  }

  if (!SOFTWARE_GPU) {
    for (let i = 0; i < 3; i++) {
      const pl = new THREE.PointLight(FX_MUZZLE, 0, 8.5, 2);
      pl.visible = false;
      scene.add(pl);
      FX.muzzleLights.push({ light: pl, t: 0 });
    }
  }

  fxFlushInstance(FX.dropletMesh);
  fxFlushInstance(FX.sugarMesh);
  fxFlushInstance(FX.shardMesh);
  fxFlushInstance(FX.ringMesh);
}

const CONFETTI = [0xffb7c5, 0xa8dcf0, 0xb8f2d8, 0xd4c5f9, 0xffefa8, 0xffd3b6, 0xffffff];

/* =====================================================================
   SHOT EFFECTS — the third cosmetic

   One purchase themes a player's whole shooting signature: the wake a shot
   leaves behind it, the colour of the muzzle flash, and the flourish on the
   impact, as one identity. Unlike a viewmodel, every one of those three is
   seen by the other eight people in the room, which is the point.

   Nothing below is a second particle system. Every effect emits into the
   pools above — FX.conf, FX.spark, FX.sugar, FX.rings — which are fixed in
   size, recycle their oldest slot and allocate nothing per shot. An effect
   is a table of numbers naming which of them to use and how.

   Four rules run through it, and each is a way this can turn into a
   gameplay change wearing a cosmetic's clothes.

   THE OWNER STAYS READABLE. A remote player's shot is drawn in their jersey
   trim -- 70-game.js and 75-network.js both pass that colour in -- and in a
   nine-player match that colour is how you tell who is shooting at you. So
   the effect owns the SHAPE, the MOTION and the hue family of its wake, and
   the owner owns its TINT: every particle is the effect's colour mixed half
   way to the shooter's (FX_TRIM_MIX). A blue jersey's Starfall is a cool
   ice-gold and a pink one's is warm coral-gold, they are still told apart at
   a glance, and both are still obviously Starfall and not Bubble Trail. The
   colour argument used to be handed to fxTracer and dropped on the floor,
   because the projectile meshes carry their own shaders; the wake is what
   finally puts it on screen.

   NO EXTRA INFORMATION. The wake lies along the segment the default
   projectile already flies, from the same muzzle to the same endpoint, and
   every particle dies inside the flight time it decorates. It tells a
   watcher nothing the default did not already tell them -- not where the
   shooter is, not where the shot landed, not a fraction of a second sooner.

   NO EXTRA SCREEN, AND IT IS MEASURED. An effect that blankets your own
   view while you fire is a bought disadvantage; one that blankets an
   opponent's view when your shots land near them is a bought advantage.
   Neither is acceptable, so the budget is not "small and few" but a number:
   EVERY EFFECT COVERS NO MORE OF THE SCREEN THAN THE DEFAULT HIT DOES.
   Effects are told apart by shape, colour, motion and decay -- never by
   size, because size is the one axis that is also a gameplay change.

   The yardstick, and the arithmetic behind the numbers on each effect
   below. A 1600x900 viewport, the camera's 74-degree vertical field, a
   wall six metres off -- 99.5 pixels to the metre. A point sprite of world
   size s is s * 450 / 6 pixels wide there, so the 0.16m confetti sprite is
   12px and the 0.30m soft sprite 22.5px. Areas are the whole sprite quad,
   which is deliberately pessimistic: the star texture inks 23% of its quad
   and the soft blob about 40%.

     DEFAULT (a BUBBLEGUN pellet on a wall)   7900 px^2
       hit-ring, peak radius 1.01m, annulus   7200
       nine droplets                           690

     fx-starfall    17 sprites x 144          2450 px^2   0.31x default
     fx-confettipop 20 sprites x 144          2880 px^2   0.36x default
     fx-bubbletrail 11 sprites x 506 + bloom  5800 px^2   0.73x default

   Both distances and both sizes scale as 1/d, so those ratios hold at
   every range -- with one exception, which is where the first cut of this
   went wrong. A point sprite six centimetres from the eye is 1200px across
   and the default draws nothing there at all. Three things close that:
   FX_SPRITE_MAX_H clamps any sprite to a twelfth of the viewport height,
   FX_EFFECT_STANDOFF starts the wake and the flash a metre down the
   barrel, and FX_EFFECT_CLEAR forbids an effect particle inside 0.9m of
   the lens outright. effects.test.js checks all of it.

   And no effect touches the muzzle light's intensity or range -- only its
   hue -- nor draws a ring: an expanding ring is the default impact's own
   silhouette, and it is both the largest thing on the frame and the one
   shape a bought effect has no business echoing.

   NO EXTRA COST. Counts are per shot, halve under SOFTWARE_GPU, and are
   bounded whatever the range: a 90m rifle shot lays down the same five
   particles a 6m one does. Nine players on automatics is roughly 110 shots
   a second; that is five particles of each into pools of 900 and 520 that
   were already sized for kill confetti.
   ===================================================================== */

/* Half. Far enough that the effect keeps a recognisable colour of its own,
   not so far that two jerseys wearing the same effect converge. */
const FX_TRIM_MIX = 0.5;

/* How far down the shot the wake and the flash begin.

   A shot starts at the shooter's eye, so for the one player whose eye the
   camera is at, a muzzle particle spawned 6cm along it is a particle on the
   lens: 1200 pixels of it, six at a time, every time they pull the trigger.
   FX_SPRITE_MAX_H stops it filling the frame and nearFade stops it being
   opaque, but neither makes it a good idea — the default draws nothing in
   the first metre of a shot, and a metre down the barrel is also where a
   muzzle flash looks like it comes from. */
const FX_EFFECT_STANDOFF = 1.1;
/* And the floor under it. Whatever the geometry -- a shot fired into a wall
   you are standing against, somebody firing point blank into your face --
   nothing an effect draws is allowed inside this radius of the lens. It is
   also where both pools hit the sprite clamp, so this is the distance at
   which every number in the budget above stops being able to grow. */
const FX_EFFECT_CLEAR = 0.9;

function fxAwayFromLens(x, y, z) {
  const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z;
  return dx * dx + dy * dy + dz * dz > FX_EFFECT_CLEAR * FX_EFFECT_CLEAR;
}

/* Every colour below is one of the seven the town is already painted in
   (CONFETTI above, which is the same list the kill burst and the store
   cards use) or a shade of one of them. Nothing is mixed to order and
   nothing arrives from another game: an imported hue is what sank two
   rounds of weapon skins, and the tan star was that same failure by a
   different route -- 0xfff1a6 is a house butter, it was the fade that
   dragged it to 0x8c845b. Three hue families, one each, far enough apart
   to name across a road: LILAC, RAINBOW, MINT. */
const SHOT_EFFECTS = {
  /* STARFALL — a comet's tail. Candy stars are flung along the shot, hang
     for an instant and sag, so the wake keeps a soft downward curve after
     the shot itself has landed. Amethyst: the one cool violet in the town,
     worn by nothing else, and a sagging line of it is a shape no other
     effect makes. 17 sprites, 2450 px^2 at the reference frame — 0.31x the
     default hit, and no ring. */
  'fx-starfall': {
    name: 'Starfall',
    muzzleTint: C(0xd8ccff),
    colors: [0xd4c5f9, 0xc3b0f2, 0xece4ff],
    wake:   { sys: 'conf', count: 5, jitter: 0.045, sway: 0.5, rise: [1.4, 2.9], life: [0.26, 0.40] },
    muzzle: { count: 4, out: [0.6, 1.6], sway: 1.0, rise: [1.2, 2.4], life: [0.22, 0.34] },
    burst:  { sys: 'conf', count: 8, push: [1.6, 3.6], lift: [1.4, 3.0], life: [0.34, 0.52] }
  },
  /* CONFETTI POP — a party popper on the end of the barrel. A wide, fast,
     tumbling scatter in the town's whole party palette, thin along the shot
     and loud at both ends: a fistful out of the muzzle, and a real pop where
     it lands. The one that falls fastest, and the only rainbow — being all
     seven at once is the identity, which is why it can share a texture with
     Starfall and still never be mistaken for it. 20 sprites, 2880 px^2,
     0.36x the default hit. */
  'fx-confettipop': {
    name: 'Confetti Pop',
    muzzleTint: C(0xffb7c5),
    colors: CONFETTI,
    wake:   { sys: 'conf', count: 4, jitter: 0.10, sway: 1.5, rise: [0.4, 2.0], life: [0.22, 0.34] },
    muzzle: { count: 6, out: [1.2, 2.8], sway: 1.8, rise: [1.0, 2.6], life: [0.26, 0.40] },
    burst:  { sys: 'conf', count: 10, push: [2.6, 5.4], lift: [2.0, 4.2], life: [0.40, 0.62] }
  },
  /* BUBBLE TRAIL — the only one that goes UP. Soap lights drift off the shot
     line and rise instead of falling, and the hit ends in a cluster of
     bubbles swelling and going soft. House mint and house sky. Direction
     alone tells it from the other two at any distance, in any light, at
     speed. Its sprite is the big soft blob rather than the star, so it runs
     the fewest of them: 11 sprites and four bloom grains, 5800 px^2 counted
     as solid quads, 0.73x the default hit — and nearer 0.3x once the blob's
     40% ink coverage is allowed for. */
  'fx-bubbletrail': {
    name: 'Bubble Trail',
    muzzleTint: C(0xbdf0e2),
    colors: [0xb8f2d8, 0xa8dcf0, 0xd8f6ff],
    wake:   { sys: 'spark', count: 4, jitter: 0.05, sway: 0.30, rise: [0.5, 1.2], life: [0.30, 0.44] },
    muzzle: { count: 3, out: [0.4, 1.2], sway: 0.6, rise: [0.8, 1.8], life: [0.30, 0.44] },
    burst:  { sys: 'spark', count: 4, push: [1.2, 2.8], lift: [1.0, 2.4], life: [0.34, 0.50],
              bloom: 4 }
  }
};

/* Forgiving in the same way every other cosmetic lookup here is: a newer
   relay's id, a damaged preference or nothing at all all mean the default
   wake rather than a failed render. */
function fxEffectFor(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(SHOT_EFFECTS, id)
    ? SHOT_EFFECTS[id]
    : null;
}

function fxEffectSystem(name) {
  return name === 'spark' ? FX.spark : FX.conf;
}

/* One particle's colour: the effect's, mixed half way to whoever fired. */
function fxEffectTint(out, hex, owner) {
  return fxMixSurface(out, hex, owner || FX_WHITE, owner ? FX_TRIM_MIX : 0, 1);
}

function fxEffectCount(n) {
  return SOFTWARE_GPU ? Math.max(1, n >> 1) : n;
}

/* The wake, laid along the segment the shot already flies. Spaced evenly
   over the whole line so it reads as a path rather than a puff at one end,
   and counted per shot rather than per metre so range costs nothing. */
function fxEffectWake(effect, len, x0, y0, z0, x1, y1, z1) {
  const w = effect.wake;
  const sys = fxEffectSystem(w.sys);
  const count = fxEffectCount(w.count);
  /* Never the first metre, and never more than the near half of a shot so
     short that the standoff would swallow all of it. */
  const from = Math.min(0.5, FX_EFFECT_STANDOFF / len);
  for (let i = 0; i < count; i++) {
    const u = from + (1 - from) * (i + fxRand(0.15, 0.85)) / count;
    const x = lerp(x0, x1, u) + fxRand(-w.jitter, w.jitter);
    const y = lerp(y0, y1, u) + fxRand(-w.jitter, w.jitter);
    const z = lerp(z0, z1, u) + fxRand(-w.jitter, w.jitter);
    if (!fxAwayFromLens(x, y, z)) continue;
    fxEffectTint(_fxColorA, fxPick(effect.colors), _fxOwner);
    psEmit(sys, x, y, z,
      fxRand(-w.sway, w.sway),
      fxRand(w.rise[0], w.rise[1]),
      fxRand(-w.sway, w.sway),
      fxRand(w.life[0], w.life[1]), _fxColorA);
  }
}

/* The flash. `ux,uy,uz` is the way the shot went, so the puff leaves the
   barrel rather than sitting on it. */
function fxEffectMuzzlePuff(effect, x, y, z, ux, uy, uz) {
  const m = effect.muzzle;
  const sys = fxEffectSystem(effect.wake.sys);
  const count = fxEffectCount(m.count);
  const bx = x + ux * FX_EFFECT_STANDOFF;
  const by = y + uy * FX_EFFECT_STANDOFF;
  const bz = z + uz * FX_EFFECT_STANDOFF;
  if (!fxAwayFromLens(bx, by, bz)) return;
  for (let i = 0; i < count; i++) {
    const push = fxRand(m.out[0], m.out[1]);
    fxEffectTint(_fxColorA, fxPick(effect.colors), _fxOwner);
    psEmit(sys, bx, by, bz,
      ux * push + fxRand(-m.sway, m.sway),
      uy * push + fxRand(m.rise[0], m.rise[1]),
      uz * push + fxRand(-m.sway, m.sway),
      fxRand(m.life[0], m.life[1]), _fxColorA);
  }
}

/* Bubble Trail's landing: the same swelling, softening grains a marshmallow
   leaves on a wall, in the effect's colour rather than the surface's. Same
   pool, same update loop, same budget — only the tint and the count differ. */
function fxEffectBloom(effect, q, count) {
  for (let i = 0; i < fxEffectCount(count); i++) {
    const index = FX.sugarI++ % FX.sugar.length;
    const d = FX.sugar[index];
    const a = fxRand(0, TAU), side = fxRand(0.2, 1.0);
    d.x = q.x + q.nx * 0.04; d.y = q.y + q.ny * 0.04; d.z = q.z + q.nz * 0.04;
    d.vx = q.nx * fxRand(0.2, 0.8) + Math.cos(a) * side;
    d.vy = q.ny * fxRand(0.2, 0.8) + fxRand(0.3, 1.0);
    d.vz = q.nz * fxRand(0.2, 0.8) + Math.sin(a) * side;
    d.size = fxRand(0.030, 0.058);
    d.t = 0; d.dur = fxRand(0.40, 0.58);
    fxEffectTint(_fxColorA, fxPick(effect.colors), _fxColorB);
    fxSetInstanceColor(FX.sugarMesh, index, _fxColorA);
    _fxQuat.identity();
    fxSetInstance(FX.sugarMesh, index, d.x, d.y, d.z, _fxQuat, d.size, d.size, d.size);
  }
}

/* The flourish on a hit. It is added to the weapon's own impact and never
   replaces it: what a shot did — a bubble splash, a mallow stuck to a wall,
   a lollipop shattering — is the weapon's identity and the feedback everyone
   reads a hit from, so an effect garnishes it and stays smaller than it. */
function fxEffectBurst(effect, q) {
  const b = effect.burst;
  const sys = fxEffectSystem(b.sys);
  /* A shot into the wall you are standing against lands on the lens. The
     weapon's own impact is allowed there because it is the feedback the
     player is owed; a bought flourish on top of it is not. */
  if (!fxAwayFromLens(q.x, q.y, q.z)) return;
  /* The owner's colour travelled with the impact rather than in a module
     global: nine pellets are queued at once, and the next shot must not be
     able to repaint the ones still waiting. */
  _fxColorB.r = q.tintR; _fxColorB.g = q.tintG; _fxColorB.b = q.tintB;
  /* No ring here. The expanding ring is the default impact's own
     silhouette and the biggest single thing on the frame; an effect that
     added a second one would both double the area and copy the shape it is
     supposed to be distinguishable from. */
  if (b.bloom) fxEffectBloom(effect, q, b.bloom);
  const count = fxEffectCount(b.count);
  for (let i = 0; i < count; i++) {
    const a = fxRand(0, TAU), side = fxRand(b.push[0], b.push[1]);
    fxEffectTint(_fxColorA, fxPick(effect.colors), _fxColorB);
    psEmit(sys, q.x + q.nx * 0.04, q.y + q.ny * 0.04, q.z + q.nz * 0.04,
      q.nx * side + Math.cos(a) * side * 0.6,
      q.ny * side + fxRand(b.lift[0], b.lift[1]),
      q.nz * side + Math.sin(a) * side * 0.6,
      fxRand(b.life[0], b.life[1]), _fxColorA);
  }
}

function fxWeaponAt(x, y, z) {
  let weapon = G.player && WBY[G.player.weapon] ? G.player.weapon : 'smg';
  let best = 1e9;
  for (let i = 0; i < G.actors.length; i++) {
    const a = G.actors[i];
    if (!a || !a.alive || !WBY[a.weapon]) continue;
    const dx = x - a.pos.x, dy = y - (a.pos.y + 1.25), dz = z - a.pos.z;
    const d2 = dx * dx + dz * dz + dy * dy * 0.35;
    if (d2 < best) { best = d2; weapon = a.weapon; }
  }
  return weapon;
}
function fxLaunchBubble(x0, y0, z0, x1, y1, z1, dur) {
  const index = FX.bubbleI++ % FX.bubbles.length;
  const b = FX.bubbles[index];
  const dx = x1 - x0, dz = z1 - z0;
  const h = Math.hypot(dx, dz) || 1;
  b.sx = x0; b.sy = y0; b.sz = z0;
  b.ex = x1; b.ey = y1; b.ez = z1;
  b.wx = dz / h; b.wz = -dx / h;
  b.wobble = fxRand(0.045, 0.115);
  b.rise = fxRand(0.035, 0.10);
  b.size = fxRand(0.145, 0.185);
  b.phase = fxRand(0, TAU);
  b.t = 0; b.dur = dur;
  _fxQuat.identity();
  fxSetInstance(FX.bubbleMesh, index, x0, y0, z0, _fxQuat, b.size, b.size, b.size);
}
function fxLaunchMallow(x0, y0, z0, x1, y1, z1, dur) {
  const index = FX.mallowI++ % FX.mallows.length;
  const p = FX.mallows[index];
  p.mode = 1;
  p.sx = x0; p.sy = y0; p.sz = z0;
  p.ex = x1; p.ey = y1; p.ez = z1;
  p.arc = fxRand(0.07, 0.15);
  p.rate = fxRand(12, 20) * (fxRng() < 0.5 ? -1 : 1);
  p.phase = fxRand(0, TAU);
  const axisAngle = fxRand(0, TAU);
  p.axisX = Math.cos(axisAngle);
  p.axisZ = Math.sin(axisAngle);
  _fxDirection.set(x1 - x0, y1 - y0, z1 - z0).normalize();
  p.base.setFromUnitVectors(_fxUp, _fxDirection);
  p.t = 0; p.dur = dur; p.dusted = false;
  _fxAxis.set(p.axisX, 0, p.axisZ);
  _fxSpinQuat.setFromAxisAngle(_fxAxis, p.phase);
  _fxQuat.copy(p.base).multiply(_fxSpinQuat);
  fxSetInstance(FX.mallowMesh, index, x0, y0, z0, _fxQuat, 0.62, 0.62, 0.62);
}
function fxLaunchDart(x0, y0, z0, x1, y1, z1, dur) {
  const index = FX.dartI++ % FX.darts.length;
  const d = FX.darts[index];
  d.sx = x0; d.sy = y0; d.sz = z0;
  d.ex = x1; d.ey = y1; d.ez = z1;
  d.spin = fxRand(38, 56) * (fxRng() < 0.5 ? -1 : 1);
  d.phase = fxRand(0, TAU);
  _fxDirection.set(x1 - x0, y1 - y0, z1 - z0).normalize();
  d.base.setFromUnitVectors(_fxUp, _fxDirection);
  d.t = 0; d.dur = dur;
  _fxSpinQuat.setFromAxisAngle(_fxUp, d.phase);
  _fxQuat.copy(d.base).multiply(_fxSpinQuat);
  fxSetInstance(FX.dartMesh, index, x0, y0, z0, _fxQuat, 0.68, 0.68, 0.68);
}
function fxTracer(x0, y0, z0, x1, y1, z1, color, effectId) {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  const weapon = fxWeaponAt(x0, y0, z0);
  const projectile = WBY[weapon].projectile || 'bubble';
  const dur = projectile === 'mallow'
    ? clamp(len / 125, 0.08, 0.30)
    : (projectile === 'dart' ? clamp(len / 720, 0.045, 0.20) : clamp(len / 320, 0.055, 0.30));
  FX.activeWeapon = weapon;
  FX.impactDelay = dur;
  /* Whoever fired, in whatever colour the caller draws them: the weapon's own
     tracer tint for the player, the jersey trim for everybody else. */
  _fxOwner.r = color ? color.r : 1;
  _fxOwner.g = color ? color.g : 1;
  _fxOwner.b = color ? color.b : 1;
  const effect = fxEffectFor(effectId);
  FX.activeEffect = effect;
  if (len < 0.05) return;
  if (effect) {
    const inv = 1 / len;
    fxEffectWake(effect, len, x0, y0, z0, x1, y1, z1);
    fxEffectMuzzlePuff(effect, x0, y0, z0, dx * inv, dy * inv, dz * inv);
  }

  if (projectile === 'mallow') {
    const inv = 1 / len;
    const ux = dx * inv, uy = dy * inv, uz = dz * inv;
    const h = Math.hypot(ux, uz) || 1;
    const bx = uz / h, bz = -ux / h;
    const cx = uy * bz, cy = h, cz = -uy * bx;
    for (let i = 0; i < 3; i++) {
      const a = fxRand(0, TAU), r = i ? fxRand(0.08, 0.24) : fxRand(0.02, 0.08);
      const ox = (bx * Math.cos(a) + cx * Math.sin(a)) * r;
      const oy = cy * Math.sin(a) * r;
      const oz = (bz * Math.cos(a) + cz * Math.sin(a)) * r;
      fxLaunchMallow(x0, y0, z0, x1 + ox, y1 + oy, z1 + oz, dur * fxRand(0.94, 1.04));
    }
  } else if (projectile === 'dart') {
    fxLaunchDart(x0, y0, z0, x1, y1, z1, dur);
  } else {
    fxLaunchBubble(x0, y0, z0, x1, y1, z1, dur);
  }
}
function fxRing(x, y, z, nx, ny, nz, color, scale) {
  const index = FX.ringI++ % FX.rings.length;
  const r = FX.rings[index];
  r.x = x + nx * 0.025; r.y = y + ny * 0.025; r.z = z + nz * 0.025;
  r.quat.setFromUnitVectors(_fxForward, _fxDirection.set(nx, ny, nz).normalize());
  r.s0 = scale || 1;
  r.grow = r.s0 > 1 ? 1.8 : FX_RING_GROW;
  r.t = 0;
  r.dur = r.s0 > 1 ? 0.28 : 0.18;
  fxSetInstanceColor(FX.ringMesh, index, color || FX_WHITE);
  fxSetInstance(FX.ringMesh, index, r.x, r.y, r.z, r.quat, r.s0, r.s0, r.s0);
}
/* An effect may move the flash's hue and nothing else. Intensity and range
   stay where they are for every player wearing anything, because a brighter
   or longer-reaching flash is a player who is easier to find in a dark
   corner — a bought disadvantage is still a bought change to the match. */
function fxMuzzle(x, y, z, effectId) {
  if (!FX.muzzleLights.length) return;
  const effect = fxEffectFor(effectId);
  const ml = FX.muzzleLights[FX.muzzleI++ % FX.muzzleLights.length];
  ml.light.position.set(x, y, z);
  ml.light.color.copy(effect ? effect.muzzleTint : FX_MUZZLE);
  ml.light.intensity = 4.2;
  ml.light.visible = true;
  ml.t = MUZZLE_LIFE;
}
function fxSurfaceColor(x, y, z, kind) {
  if (kind === 'actor') return 0xffb7d2;
  if (Math.abs(x) > 29 || Math.abs(z) > 19) return PAL.perimeter;
  if (x > -27.5 && x < -16 && Math.abs(z) < 2.8 && y < 3.3) return PAL.bus;
  if (x > 16.5 && x < 25.5 && Math.abs(z) < 2.6 && y < 2.6) return PAL.truck;
  if (y < 0.34) {
    if (Math.abs(z) < 4.2) return PAL.road;
    if (Math.abs(z) < 5.7) return PAL.walk;
    return 0xd8ecc8;
  }
  return z < -5.4 ? PAL.houseA : (z > 5.4 ? PAL.houseB : PAL.cream);
}
function fxDropletBurst(q) {
  const count = SOFTWARE_GPU ? 6 : (q.kind === 'actor' ? 11 : 9);
  let tx, ty, tz;
  if (Math.abs(q.ny) < 0.88) {
    const inv = 1 / (Math.hypot(q.nx, q.nz) || 1);
    tx = q.nz * inv; ty = 0; tz = -q.nx * inv;
  } else {
    tx = 1; ty = 0; tz = 0;
  }
  const bx = q.ny * tz - q.nz * ty;
  const by = q.nz * tx - q.nx * tz;
  const bz = q.nx * ty - q.ny * tx;
  for (let i = 0; i < count; i++) {
    const index = FX.dropletI++ % FX.droplets.length;
    const d = FX.droplets[index];
    const a = (i + fxRand(-0.12, 0.12)) / count * TAU;
    const ca = Math.cos(a), sa = Math.sin(a);
    const speed = fxRand(2.8, 5.2);
    d.x = q.x + q.nx * 0.035; d.y = q.y + q.ny * 0.035; d.z = q.z + q.nz * 0.035;
    d.vx = (tx * ca + bx * sa) * speed + q.nx * fxRand(0.35, 1.1);
    d.vy = (ty * ca + by * sa) * speed + q.ny * fxRand(0.35, 1.1);
    d.vz = (tz * ca + bz * sa) * speed + q.nz * fxRand(0.35, 1.1);
    d.size = fxRand(0.034, 0.060);
    d.t = 0; d.dur = fxRand(0.32, 0.46);
    _fxDirection.set(d.vx, d.vy, d.vz).normalize();
    _fxQuat.setFromUnitVectors(_fxUp, _fxDirection);
    fxSetInstance(FX.dropletMesh, index, d.x, d.y, d.z, _fxQuat,
      d.size * 0.72, d.size * 1.55, d.size * 0.72);
  }
}
function fxSugarBurst(x, y, z, nx, ny, nz, surface) {
  fxMixSurface(_fxColorA, surface, FX_SUGAR, 0.72, 1.08);
  const count = SOFTWARE_GPU ? 5 : 9;
  for (let i = 0; i < count; i++) {
    const index = FX.sugarI++ % FX.sugar.length;
    const d = FX.sugar[index];
    const a = fxRand(0, TAU);
    const side = fxRand(0.2, 1.15);
    d.x = x + nx * 0.035; d.y = y + ny * 0.035; d.z = z + nz * 0.035;
    d.vx = nx * fxRand(0.15, 0.75) + Math.cos(a) * side;
    d.vy = ny * fxRand(0.15, 0.75) + fxRand(0.25, 1.05);
    d.vz = nz * fxRand(0.15, 0.75) + Math.sin(a) * side;
    d.size = fxRand(0.035, 0.072);
    d.t = 0; d.dur = fxRand(0.48, 0.70);
    fxSetInstanceColor(FX.sugarMesh, index, _fxColorA);
    _fxQuat.identity();
    fxSetInstance(FX.sugarMesh, index, d.x, d.y, d.z, _fxQuat,
      d.size, d.size, d.size);
  }
}
function fxStickMallow(q) {
  const index = FX.mallowI++ % FX.mallows.length;
  const p = FX.mallows[index];
  p.mode = 2; p.t = 0; p.dur = 0.58; p.dusted = false;
  p.x = q.x + q.nx * 0.035; p.y = q.y + q.ny * 0.035; p.z = q.z + q.nz * 0.035;
  p.nx = q.nx; p.ny = q.ny; p.nz = q.nz; p.surface = q.surface;
  p.base.setFromUnitVectors(_fxUp, _fxDirection.set(q.nx, q.ny, q.nz).normalize());
  fxSetInstance(FX.mallowMesh, index, p.x, p.y, p.z, p.base, 0.76, 0.32, 0.76);
}
function fxShardBurst(q) {
  const count = SOFTWARE_GPU ? 5 : (q.kind === 'actor' ? 12 : 9);
  let tx, ty, tz;
  if (Math.abs(q.ny) < 0.88) {
    const inv = 1 / (Math.hypot(q.nx, q.nz) || 1);
    tx = q.nz * inv; ty = 0; tz = -q.nx * inv;
  } else {
    tx = 1; ty = 0; tz = 0;
  }
  const bx = q.ny * tz - q.nz * ty;
  const by = q.nz * tx - q.nx * tz;
  const bz = q.nx * ty - q.ny * tx;
  for (let i = 0; i < count; i++) {
    const index = FX.shardI++ % FX.shards.length;
    const s = FX.shards[index];
    const a = (i + fxRand(-0.16, 0.16)) / count * TAU;
    const ca = Math.cos(a), sa = Math.sin(a), push = fxRand(4.2, 8.2);
    s.x = q.x + q.nx * 0.045; s.y = q.y + q.ny * 0.045; s.z = q.z + q.nz * 0.045;
    s.vx = (tx * ca + bx * sa) * push + q.nx * fxRand(1.1, 2.7);
    s.vy = (ty * ca + by * sa) * push + q.ny * fxRand(1.1, 2.7) + fxRand(0.3, 1.8);
    s.vz = (tz * ca + bz * sa) * push + q.nz * fxRand(1.1, 2.7);
    s.rx = fxRand(0, TAU); s.ry = fxRand(0, TAU); s.rz = fxRand(0, TAU);
    s.sx = fxRand(-24, 24); s.sy = fxRand(-24, 24); s.sz = fxRand(-24, 24);
    s.size = fxRand(0.42, 0.78);
    s.t = 0; s.dur = fxRand(0.26, 0.42);
    _fxQuat.setFromEuler(_fxEuler.set(s.rx, s.ry, s.rz));
    fxSetInstance(FX.shardMesh, index, s.x, s.y, s.z, _fxQuat,
      s.size, s.size, s.size);
  }
}
function fxBubbleImpact(q) {
  fxMixSurface(_fxColorA, q.surface, FX_BUBBLE, 0.55, 1.35);
  fxRing(q.x, q.y, q.z, q.nx, q.ny, q.nz, _fxColorA, FX_HIT_RING);
  fxDropletBurst(q);
}
function fxMallowImpact(q) {
  fxStickMallow(q);
}
function fxDartImpact(q) {
  fxMixSurface(_fxColorA, q.surface, FX_GLASS, 0.46, 1.55);
  fxShardBurst(q);
  const sparkCount = SOFTWARE_GPU ? 2 : 5;
  for (let i = 0; i < sparkCount; i++) {
    const push = fxRand(2.5, 7.0);
    psEmit(FX.spark, q.x, q.y, q.z,
      q.nx * push + fxRand(-2.0, 2.0),
      q.ny * push + fxRand(0.5, 3.0),
      q.nz * push + fxRand(-2.0, 2.0),
      fxRand(0.12, 0.28), _fxColorA);
  }
}
function fxDoImpact(q) {
  const w = WBY[q.weapon] || WBY.smg;
  if (w.projectile === 'mallow') fxMallowImpact(q);
  else if (w.projectile === 'dart') fxDartImpact(q);
  else fxBubbleImpact(q);
  if (q.effect) fxEffectBurst(q.effect, q);
}
function fxImpact(x, y, z, nx, ny, nz, kind, surfColor) {
  if (!FX.impacts.length) return;
  const q = FX.impacts[FX.impactI++ % FX.impacts.length];
  q.weapon = FX.activeWeapon;
  q.effect = FX.activeEffect;
  q.tintR = _fxOwner.r; q.tintG = _fxOwner.g; q.tintB = _fxOwner.b;
  q.x = x; q.y = y; q.z = z;
  q.nx = nx; q.ny = ny; q.nz = nz;
  q.kind = kind;
  q.surface = typeof surfColor === 'number'
    ? surfColor
    : (surfColor && typeof surfColor.getHex === 'function' ? surfColor.getHex() : fxSurfaceColor(x, y, z, kind));
  q.t = Math.max(0.012, FX.impactDelay);
}
function fxKillBurst(x, y, z, color) {
  for (let i = 0; i < 46; i++) {
    const a = fxRand(0, TAU), p = fxRand(-0.6, 1.25), s = fxRand(2.5, 8);
    psEmit(FX.conf, x, y + fxRand(0.4, 1.5), z,
           Math.cos(a) * Math.cos(p) * s, Math.sin(p) * s + 3.5, Math.sin(a) * Math.cos(p) * s,
           fxRand(1.0, 2.0), C(fxPick(CONFETTI)));
  }
  for (let i = 0; i < 20; i++) {
    const a = fxRand(0, TAU), s = fxRand(1.5, 5);
    psEmit(FX.spark, x, y + fxRand(0.6, 1.4), z, Math.cos(a) * s, fxRand(1, 5), Math.sin(a) * s,
           fxRand(0.35, 0.8), C(0xffffff));
  }
  fxRing(x, y + 0.9, z, 0, 1, 0, color || C(0xffe0ec), 2.2);
}
function fxSpawnPuff(x, y, z, color) {
  for (let i = 0; i < 22; i++) {
    const a = fxRand(0, TAU), s = fxRand(1.2, 3.4);
    psEmit(FX.spark, x + Math.cos(a) * 0.4, y + fxRand(0.1, 1.7), z + Math.sin(a) * 0.4,
           Math.cos(a) * s, fxRand(0.5, 2.5), Math.sin(a) * s, fxRand(0.3, 0.7), color || C(0xffffff));
  }
}
function fxShake(amount) { FX.shakeV += amount; }

function updateFX(dt) {
  psUpdate(FX.conf, dt);
  psUpdate(FX.spark, dt);

  for (let i = 0; i < FX.bubbles.length; i++) {
    const b = FX.bubbles[i];
    if (b.t < 0) continue;
    b.t += dt;
    const u = b.t / b.dur;
    if (u >= 1) {
      b.t = -1;
      fxHideInstance(FX.bubbleMesh, i);
      continue;
    }
    const arc = Math.sin(u * Math.PI);
    const phase = b.phase + u * TAU * 2.35;
    const wander = Math.sin(phase) * b.wobble * arc;
    const x = lerp(b.sx, b.ex, u) + b.wx * wander;
    const y = lerp(b.sy, b.ey, u) + arc * b.rise +
      Math.cos(phase * 0.79) * b.wobble * 0.34 * arc;
    const z = lerp(b.sz, b.ez, u) + b.wz * wander;
    const sx = b.size * (1 + Math.sin(phase * 1.11) * 0.12);
    const sy = b.size * (1 + Math.sin(phase * 1.07 + 2.094) * 0.095);
    const sz = b.size * (1 + Math.sin(phase * 0.97 + 4.188) * 0.11);
    _fxQuat.identity();
    fxSetInstance(FX.bubbleMesh, i, x, y, z, _fxQuat, sx, sy, sz);
  }

  for (let i = 0; i < FX.mallows.length; i++) {
    const p = FX.mallows[i];
    if (p.mode === 0 || p.t < 0) continue;
    p.t += dt;
    const u = p.t / p.dur;
    if (u >= 1) {
      p.mode = 0; p.t = -1;
      fxHideInstance(FX.mallowMesh, i);
      continue;
    }
    if (p.mode === 1) {
      const arc = Math.sin(u * Math.PI);
      const x = lerp(p.sx, p.ex, u);
      const y = lerp(p.sy, p.ey, u) + arc * p.arc;
      const z = lerp(p.sz, p.ez, u);
      _fxAxis.set(p.axisX, 0, p.axisZ);
      _fxSpinQuat.setFromAxisAngle(_fxAxis, p.phase + p.t * p.rate);
      _fxQuat.copy(p.base).multiply(_fxSpinQuat);
      const breathe = 0.62 * (1 + Math.sin(p.phase + p.t * 8) * 0.025);
      fxSetInstance(FX.mallowMesh, i, x, y, z, _fxQuat,
        breathe, breathe, breathe);
    } else {
      const release = smoothstep((u - 0.40) / 0.60);
      const settle = smoothstep(u / 0.12);
      const fade = 1 - smoothstep((u - 0.72) / 0.28);
      const bulge = lerp(0.76, 0.86, settle) * fade;
      const squash = lerp(0.34, 0.27, settle) * fade;
      if (!p.dusted && u >= 0.42) {
        p.dusted = true;
        fxSugarBurst(p.x, p.y, p.z, p.nx, p.ny, p.nz, p.surface);
      }
      fxSetInstance(FX.mallowMesh, i, p.x, p.y - release * 0.26, p.z,
        p.base, bulge, squash, bulge);
    }
  }

  for (let i = 0; i < FX.darts.length; i++) {
    const d = FX.darts[i];
    if (d.t < 0) continue;
    d.t += dt;
    const u = d.t / d.dur;
    if (u >= 1) {
      d.t = -1;
      fxHideInstance(FX.dartMesh, i);
      continue;
    }
    _fxSpinQuat.setFromAxisAngle(_fxUp, d.phase + d.t * d.spin);
    _fxQuat.copy(d.base).multiply(_fxSpinQuat);
    fxSetInstance(FX.dartMesh, i,
      lerp(d.sx, d.ex, u), lerp(d.sy, d.ey, u), lerp(d.sz, d.ez, u),
      _fxQuat, 0.68, 0.68, 0.68);
  }

  for (let i = 0; i < FX.impacts.length; i++) {
    const q = FX.impacts[i];
    if (q.t < 0) continue;
    q.t -= dt;
    if (q.t <= 0) { q.t = -1; fxDoImpact(q); }
  }

  for (let i = 0; i < FX.droplets.length; i++) {
    const d = FX.droplets[i];
    if (d.t < 0) continue;
    d.t += dt;
    const u = d.t / d.dur;
    if (u >= 1) {
      d.t = -1;
      fxHideInstance(FX.dropletMesh, i);
      continue;
    }
    d.vy -= 6.2 * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    const fade = 1 - smoothstep((u - 0.66) / 0.34);
    const size = d.size * fade;
    _fxDirection.set(d.vx, d.vy, d.vz).normalize();
    _fxQuat.setFromUnitVectors(_fxUp, _fxDirection);
    fxSetInstance(FX.dropletMesh, i, d.x, d.y, d.z, _fxQuat,
      size * 0.72, size * 1.55, size * 0.72);
  }

  for (let i = 0; i < FX.sugar.length; i++) {
    const d = FX.sugar[i];
    if (d.t < 0) continue;
    d.t += dt;
    const u = d.t / d.dur;
    if (u >= 1) {
      d.t = -1;
      fxHideInstance(FX.sugarMesh, i);
      continue;
    }
    d.vx *= Math.exp(-2.8 * dt); d.vz *= Math.exp(-2.8 * dt);
    d.vy += 0.18 * dt;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    const bloom = 1 + smoothstep(u / 0.42) * 2.2;
    const fade = 1 - smoothstep((u - 0.54) / 0.46);
    const size = d.size * bloom * fade;
    _fxQuat.identity();
    fxSetInstance(FX.sugarMesh, i, d.x, d.y, d.z, _fxQuat, size, size, size);
  }

  for (let i = 0; i < FX.rings.length; i++) {
    const r = FX.rings[i];
    if (r.t < 0) continue;
    r.t += dt;
    const u = r.t / r.dur;
    if (u >= 1) {
      r.t = -1;
      fxHideInstance(FX.ringMesh, i);
      continue;
    }
    const size = r.s0 * (1 + smoothstep(u) * r.grow);
    fxSetInstance(FX.ringMesh, i, r.x, r.y, r.z, r.quat, size, size, size);
  }

  for (let i = 0; i < FX.shards.length; i++) {
    const s = FX.shards[i];
    if (s.t < 0) continue;
    s.t += dt;
    const u = s.t / s.dur;
    if (u >= 1) {
      s.t = -1;
      fxHideInstance(FX.shardMesh, i);
      continue;
    }
    s.vy -= 7.2 * dt;
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    s.rx += s.sx * dt; s.ry += s.sy * dt; s.rz += s.sz * dt;
    const fade = 1 - smoothstep((u - 0.62) / 0.38);
    _fxQuat.setFromEuler(_fxEuler.set(s.rx, s.ry, s.rz));
    fxSetInstance(FX.shardMesh, i, s.x, s.y, s.z, _fxQuat,
      s.size * fade, s.size * fade, s.size * fade);
  }

  for (let i = 0; i < FX.muzzleLights.length; i++) {
    const ml = FX.muzzleLights[i];
    if (ml.t <= 0) continue;
    ml.t -= dt;
    ml.light.intensity = 4.2 * smoothstep(clamp(ml.t / MUZZLE_LIFE, 0, 1));
    if (ml.t <= 0) ml.light.visible = false;
  }
  FX.shakeV *= Math.exp(-9 * dt);
  FX.shake = FX.shakeV;

  fxFlushInstance(FX.bubbleMesh);
  fxFlushInstance(FX.mallowMesh);
  fxFlushInstance(FX.dartMesh);
  fxFlushInstance(FX.dropletMesh);
  fxFlushInstance(FX.sugarMesh);
  fxFlushInstance(FX.shardMesh);
  fxFlushInstance(FX.ringMesh);
}

/* =====================================================================
   THE EFFECT IN THE DISPLAY CASE

   A character and a gun can be handed to the store as a model, because
   that is what they are. An effect is motion, and the pools it draws from
   live in the world scene and are driven by somebody pulling a trigger —
   neither of which the store has. So it previews as its own small loop:
   one shot crossing the case, laying its wake, and popping at the far
   end, over and over, in the same colours, the same directions and the
   same lifetimes the real thing uses.

   It is deliberately a handful of plain meshes rather than a second copy
   of the emitters above. Nothing here runs during a match; it exists only
   while the panel is open, and 82-store.js stops it the moment it closes.

   `null` is the default look and previews as a bare shot with no wake,
   which is what makes the case's default-versus-selection comparison mean
   something for this cosmetic too.
   ===================================================================== */
const FX_PREVIEW = {
  span: 0.95,        // how far the shot crosses, in metres
  arc: 0.10,         // the sag on its path, so it is not a ruled line
  wake: 14,          // motes laid along it
  pop: 8,            // and thrown out of the far end
  fade: 0.55,        // how long a mote lives, in loop-seconds
  cycle: 1.7,        // and how long the whole loop takes
  size: 0.030
};

function fxPreviewPath(out, u) {
  out.set(
    (u - 0.5) * FX_PREVIEW.span,
    0.34 - Math.sin(u * Math.PI) * FX_PREVIEW.arc,
    0
  );
  return out;
}

/* Every way this can fail — a THREE too small to build meshes with, an id
   from a newer relay, a throw out of a constructor — comes back as null,
   which the case already knows how to say out loud. */
function buildEffectPreview(effectId) {
  if (typeof THREE !== 'object' || !THREE ||
      typeof THREE.Group !== 'function' || typeof THREE.Mesh !== 'function' ||
      typeof THREE.SphereGeometry !== 'function' ||
      typeof THREE.MeshBasicMaterial !== 'function') return null;
  const effect = fxEffectFor(effectId);
  if (effectId && !effect) return null;

  let root;
  try {
    root = new THREE.Group();
    const geo = new THREE.SphereGeometry(1, 8, 6);
    const colors = effect ? effect.colors : [0xfff4df];
    /* Down for the two that fall, up for the one that rises: the preview
       has to be able to show that, because it is the single thing that
       tells Bubble Trail from the other two across a map. */
    const drift = effect && effect.wake.rise[1] > 0 && effect.wake.sys === 'spark'
      ? 0.30 : -0.42;
    const motes = [];
    const total = effect ? FX_PREVIEW.wake + FX_PREVIEW.pop : FX_PREVIEW.pop;
    for (let i = 0; i < total; i++) {
      const wake = effect && i < FX_PREVIEW.wake;
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: C(colors[i % colors.length]),
        transparent: true, depthWrite: false, toneMapped: false
      }));
      mesh.scale.setScalar(FX_PREVIEW.size);
      root.add(mesh);
      motes.push({
        mesh: mesh,
        /* Wake motes are born as the shot passes them; pop motes are all
           born when it lands, and leave along their own spoke. */
        born: wake ? (i + 0.5) / FX_PREVIEW.wake : 1,
        u: wake ? (i + 0.5) / FX_PREVIEW.wake : 1,
        ox: wake ? (fxRng() - 0.5) * 0.09 : Math.cos(i * 2.399963) * 0.30,
        oy: wake ? (fxRng() - 0.5) * 0.06 : Math.sin(i * 2.399963) * 0.30 + 0.10,
        oz: wake ? (fxRng() - 0.5) * 0.09 : 0,
        drift: wake ? drift : drift * 0.5
      });
    }

    const head = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: C(0xfff8f0), transparent: true, depthWrite: false, toneMapped: false
    }));
    head.scale.setScalar(FX_PREVIEW.size * 1.9);
    root.add(head);

    let t = 0;
    /* 82-store.js drives this once a frame while the panel is up, and a node
       that has one is a node it leaves alone rather than turning on a
       turntable: a wake seen edge-on is nothing at all. */
    root.userData.pnTick = function (dt) {
      t = (t + dt / FX_PREVIEW.cycle) % 1;
      /* The shot crosses in the first 62% of the loop; the rest is the pop
         at the end of it fading out. */
      const flight = 0.62 * FX_PREVIEW.cycle;
      const now = t * FX_PREVIEW.cycle;
      fxPreviewPath(head.position, Math.min(1, now / flight));
      head.visible = now < flight;
      for (let i = 0; i < motes.length; i++) {
        const m = motes[i];
        const age = now - m.born * flight;
        if (age < 0 || age > FX_PREVIEW.fade) { m.mesh.visible = false; continue; }
        const k = age / FX_PREVIEW.fade;
        m.mesh.visible = true;
        fxPreviewPath(m.mesh.position, m.u);
        m.mesh.position.x += m.ox * k;
        m.mesh.position.y += m.oy * k + m.drift * age * age;
        m.mesh.position.z += m.oz * k;
        m.mesh.material.opacity = 1 - k;
        m.mesh.scale.setScalar(FX_PREVIEW.size * (1 - k * 0.4));
      }
    };
    /* Wound forward to a frame worth looking at, because the card pictures
       are a single still off this same node and the first frame of the loop
       is an empty case. */
    root.userData.pnTick(FX_PREVIEW.cycle * 0.35);
  } catch (e) {
    return null;
  }
  return root;
}

/* =====================================================================
   DOM FLOATERS (damage numbers, pickups)
   ===================================================================== */
const floaters = [];
const floatLayer = document.getElementById('floaters');
const _pv = new THREE.Vector3();
function addFloater(text, x, y, z, color, big) {
  if (floaters.length > 26) { const f = floaters.shift(); f.el.remove(); }
  const el = document.createElement('div');
  el.className = 'float';
  el.textContent = text;
  if (color) el.style.color = color;
  if (big) el.style.fontSize = '30px';
  floatLayer.appendChild(el);
  floaters.push({ el, x, y, z, t: 0, dur: big ? 1.5 : 1.0, rise: big ? 1.5 : 1.0, dx: fxRand(-16, 16) });
}
function updateFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.t += dt;
    if (f.t >= f.dur) { f.el.remove(); floaters.splice(i, 1); continue; }
    const u = f.t / f.dur;
    _pv.set(f.x, f.y + u * f.rise, f.z).project(camera);
    if (_pv.z > 1) { f.el.style.opacity = '0'; continue; }
    const sx = (_pv.x * 0.5 + 0.5) * innerWidth + f.dx * u;
    const sy = (-_pv.y * 0.5 + 0.5) * innerHeight;
    f.el.style.left = sx + 'px';
    f.el.style.top = sy + 'px';
    f.el.style.opacity = String(1 - smoothstep(clamp((u - 0.55) / 0.45, 0, 1)));
    f.el.style.transform = 'translate(-50%,-50%) scale(' + (1 + Math.sin(Math.min(u * 4, Math.PI * 0.5)) * 0.28) + ')';
  }
}

/* =====================================================================
   AUDIO — everything synthesised, no assets
   ===================================================================== */
const SFX = {
  ctx: null, master: null, ok: false,
  init() {
    if (this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.32;
      this.master.connect(this.ctx.destination);
      this.noiseBuf = this.makeNoise();
      this.ok = true;
    } catch (e) { this.ok = false; }
  },
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },
  makeNoise() {
    const n = this.ctx.sampleRate * 0.5;
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },
  /* pan/attenuate by distance from the listener */
  place(node, x, y, z) {
    if (!x && x !== 0) { node.connect(this.master); return; }
    const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z;
    const d = Math.hypot(dx, dy, dz);
    const g = this.ctx.createGain();
    g.gain.value = clamp(1 - d / 62, 0.02, 1) * clamp(1 / (1 + d * 0.09), 0.05, 1);
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) {
      const f = new THREE.Vector3(); camera.getWorldDirection(f);
      const rx = f.z, rz = -f.x;                  // camera-right on the XZ plane
      p.pan.value = clamp((dx * rx + dz * rz) / Math.max(d, 0.5), -1, 1) * 0.85;
      node.connect(p); p.connect(g);
    } else node.connect(g);
    g.connect(this.master);
  },
  noise(dur, freq, q, gain, x, y, z, type) {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true;
    const f = c.createBiquadFilter(); f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    s.connect(f); f.connect(g);
    this.place(g, x, y, z);
    s.start(t); s.stop(t + dur + 0.02);
  },
  tone(f0, f1, dur, gain, type, x, y, z, delay) {
    if (!this.ok) return;
    const c = this.ctx, t = c.currentTime + (delay || 0);
    const o = c.createOscillator(); o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    this.place(g, x, y, z);
    o.start(t); o.stop(t + dur + 0.02);
  },
  shoot(id, x, y, z) {
    if (id === 'shotgun') { this.noise(0.30, 780, 0.7, 0.55, x, y, z); this.tone(220, 48, 0.26, 0.30, 'square', x, y, z); }
    else if (id === 'rifle') { this.noise(0.20, 1500, 1.5, 0.36, x, y, z); this.tone(700, 130, 0.16, 0.20, 'sawtooth', x, y, z); }
    else { this.noise(0.09, 2100, 2.2, 0.26, x, y, z); this.tone(880, 300, 0.07, 0.15, 'square', x, y, z); }
  },
  hit(head) { this.tone(head ? 1500 : 900, head ? 2300 : 1250, 0.075, head ? 0.30 : 0.20, 'sine'); },
  hurt() { this.noise(0.20, 320, 0.8, 0.36, null); this.tone(180, 70, 0.20, 0.22, 'triangle'); },
  kill() { [0, 0.07, 0.14].forEach((d, i) => this.tone([660, 880, 1320][i], [660, 880, 1320][i], 0.16, 0.19, 'sine', null, 0, 0, d)); },
  die() { this.tone(420, 90, 0.6, 0.28, 'triangle'); this.noise(0.5, 260, 0.6, 0.28, null); },
  reload(x, y, z) { this.noise(0.05, 1500, 3, 0.24, x, y, z, 'bandpass'); },
  reloadDone(x, y, z) { this.noise(0.07, 900, 3, 0.30, x, y, z, 'bandpass'); this.tone(340, 200, 0.07, 0.14, 'square', x, y, z); },
  step(x, y, z) { this.noise(0.055, 200 + Math.random() * 90, 1.1, 0.13, x, y, z, 'lowpass'); },
  spawn() { this.tone(300, 900, 0.20, 0.20, 'sine'); this.tone(600, 1500, 0.22, 0.10, 'sine', null, 0, 0, 0.05); },
  swap() { this.noise(0.05, 1200, 2.5, 0.16, null); },
  empty() { this.noise(0.035, 2600, 4, 0.14, null); },
  ui() { this.tone(520, 900, 0.09, 0.18, 'sine'); },
  win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.4, 0.2, 'sine', null, 0, 0, i * 0.12)); }
};
