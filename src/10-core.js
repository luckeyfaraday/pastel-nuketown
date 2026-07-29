/* =====================================================================
   PASTEL NUKETOWN — core: palette, math, geometry builder, sky, lights
   ===================================================================== */
'use strict';

const MAP = globalThis.NUKETOWN_MAP;
const AI  = globalThis.NUKETOWN_AI;

const QS = new URLSearchParams(location.search);
const AUTOSTART = QS.has('autostart');

/* ---------- fatal error surface (a blank pastel screen tells us nothing) */
function fatal(msg) {
  const el = document.getElementById('fatal');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = 'ERROR\n\n' + msg;
  const l = document.getElementById('loading'); if (l) l.classList.add('off');
}
window.addEventListener('error', e => fatal((e.message || 'error') + '\n' + (e.filename || '') + ':' + (e.lineno || '')));

/* ---------- math ---------- */
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp  = (a, b, t) => a + (b - a) * t;
const smoothstep = t => (t = clamp(t, 0, 1), t * t * (3 - 2 * t));
const TAU = Math.PI * 2;
function angDelta(a, b) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
function approachAngle(cur, tgt, maxStep) { const d = angDelta(cur, tgt); return cur + clamp(d, -maxStep, maxStep); }
// exponential smoothing that is correct for a variable timestep
const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

/* deterministic PRNG so a replayed match looks the same */
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xC0FFEE);
const rand  = (a, b) => a + (b - a) * rng();
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick  = arr => arr[Math.floor(rng() * arr.length) % arr.length];

/* ---------- colour ---------- *
   Renderer output is sRGB, but r128 does no automatic colour management,
   so every authored hex must be converted to linear exactly once. C() is
   the single door — never hand a raw hex to a material or vertex colour. */
const _ctmp = new THREE.Color();
function C(hex) { return new THREE.Color(hex).convertSRGBToLinear(); }
function Cx(hex, mulR, mulG, mulB) {
  const c = C(hex);
  c.r *= mulR; c.g *= (mulG === undefined ? mulR : mulG); c.b *= (mulB === undefined ? mulR : mulB);
  return c;
}

const PAL = {
  ink:      0x4a3f5c,
  cream:    0xfff8f0,
  sand:     0xf6e2c0,
  sandDeep: 0xecd0a6,
  road:     0xcdc6dd,
  roadLine: 0xfff3c4,
  walk:     0xe6dff0,

  houseA:   0xffe9a8,   // butter yellow house  (north)
  houseAtrim:0xffc9d6,
  roofA:    0xff9aa2,   // coral roof
  houseB:   0xbfe3f5,   // sky-blue house       (south)
  houseBtrim:0xc8f2dc,
  roofB:    0xb6bef0,   // periwinkle roof

  slab:     0xf3e7dd,
  stair:    0xf0dfd2,
  post:     0xfff6ec,
  rail:     0xfff6ec,
  picket:   0xfffaf3,
  crate:    0xffd3b6,
  crateTop: 0xffe3cc,
  perimeter:0xdcd3e8,
  bus:      0xffe08a,
  busTrim:  0xffffff,
  truck:    0xff9ab0,
  glass:    0xd8f2ff,
  tyre:     0x8b7f9e,
  metal:    0xd7cfe4,
  mannequin:0xf5dff0,
  wood:     0xe8c9a8,
  leaf:     0xc9edd6,
  leaf2:    0xffd6e8
};

/* bot jersey colours — all pastel, all clearly separable at distance */
const BOT_COLORS = [
  { body: 0xffb7c5, trim: 0xff8fa8, name: 'Bubblegum' },
  { body: 0xa8dcf0, trim: 0x7cc6e6, name: 'Sky' },
  { body: 0xb8f2d8, trim: 0x86e0bb, name: 'Sherbet' },
  { body: 0xd4c5f9, trim: 0xb49ff0, name: 'Lilac' },
  { body: 0xffefa8, trim: 0xf7dc78, name: 'Butter' },
  { body: 0xffd3b6, trim: 0xffb894, name: 'Peach' },
  { body: 0xc9f0f7, trim: 0x99dee9, name: 'Frost' },
  { body: 0xf7c5e0, trim: 0xe89ec9, name: 'Taffy' },
  { body: 0xdff2b8, trim: 0xbfe08a, name: 'Pistachio' }
];
const PLAYER_COLOR = { body: 0xfff8f0, trim: 0xffc9d6, name: 'You' };

/* ---------------------------------------------------------------------
   YAW CONVENTIONS — these differ on purpose, so convert at the border.

     ENGINE yaw : 0 = +Z, forward = (sin y, cos y)
                  used by movement, bullets, the camera rig, the characters.
     CONTRACT yaw: 0 = +X, forward = (cos y, sin y)
                  declared by mapspec.js (spawn yaws) and therefore what
                  bots.js emits and expects.

   The two are a reflection of each other, so a single involution converts
   in both directions. Every crossing point calls this: respawnActor (spawn
   yaws in) and stepBot (bot aim out and back).
   --------------------------------------------------------------------- */
const yawFlip = y => Math.PI * 0.5 - y;

/* =====================================================================
   TOON MATERIAL
   Cel shading with a *lifted* shadow floor — the single most important
   trick for a pastel look. Shadows retain a hard 55% luminance floor instead
   of falling to black. Falls back to Lambert if this build of
   three has no working MeshToonMaterial.
   ===================================================================== */
let TOON_OK = true;
function makeGradientMap(steps, floorV) {
  const d = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) d[i] = Math.round(255 * lerp(floorV, 1.0, i / (steps - 1)));
  const t = new THREE.DataTexture(d, steps, 1, THREE.LuminanceFormat);
  t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
let GRAD = null;
try {
  if (typeof THREE.MeshToonMaterial !== 'function') throw new Error('no MeshToonMaterial');
  GRAD = makeGradientMap(5, 0.55);
} catch (e) { TOON_OK = false; }

function toonMat(opts) {
  opts = opts || {};
  const base = {
    color: opts.color !== undefined ? C(opts.color) : C(0xffffff),
    vertexColors: !!opts.vertexColors,
    transparent: !!opts.transparent,
    opacity: opts.opacity === undefined ? 1 : opts.opacity,
    side: opts.side || THREE.FrontSide,
    emissive: opts.emissive !== undefined ? C(opts.emissive) : C(0x000000)
  };
  if (opts.map) base.map = opts.map;
  if (TOON_OK) { base.gradientMap = GRAD; return new THREE.MeshToonMaterial(base); }
  return new THREE.MeshLambertMaterial(base);
}

/* =====================================================================
   GEOMETRY BUILDER
   Accumulates flat-shaded quads with per-vertex colour into ONE buffer,
   plus a parallel line buffer of the "inked" edges. The whole 110-box
   map then draws in two calls, which keeps it fast even under software
   rendering.
   ===================================================================== */
function GeoBuilder() {
  this.pos = []; this.nrm = []; this.col = [];
  this.epos = []; this.ecol = [];
}
GeoBuilder.prototype.quad = function (a, b, c, d, color, noEdge) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  const P = this.pos, N = this.nrm, K = this.col;
  const tri = (p, q, r) => {
    P.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]);
    for (let i = 0; i < 3; i++) { N.push(nx, ny, nz); K.push(color.r, color.g, color.b); }
  };
  tri(a, b, c); tri(a, c, d);
  if (!noEdge) { this.edge(a, b); this.edge(b, c); this.edge(c, d); this.edge(d, a); }
};
GeoBuilder.prototype.edge = function (a, b, col) {
  const c = col || EDGE_COL;
  this.epos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  this.ecol.push(c.r, c.g, c.b, c.r, c.g, c.b);
};
GeoBuilder.prototype.tri = function (a, b, c, color, noEdge) {
  this.quad(a, b, c, c, color, true);
  if (!noEdge) { this.edge(a, b); this.edge(b, c); this.edge(c, a); }
};
function faceTint(c, r, g, b) {
  return { r: c.r * r, g: c.g * (g === undefined ? r : g), b: c.b * (b === undefined ? r : b) };
}
function shadowFace(c, coolV, lift) {
  const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  const sat = 1.04 + coolV * 0.20;
  const r = Math.max(0, lum + (c.r - lum) * sat);
  const g = Math.max(0, lum + (c.g - lum) * sat);
  const b = Math.max(0, lum + (c.b - lum) * sat);
  return {
    r: r * lift * (1 - coolV * 0.75),
    g: g * lift * (1 + coolV * 0.18),
    b: b * lift * (1 + coolV * 1.80)
  };
}
/* Face tints reinforce the warm +X/-Z key even when shadow maps are off.
   Indirect-only faces lift material exposure, not the light floor, so their
   colour stays candy-rich without flattening the key split. */
GeoBuilder.prototype.box = function (min, max, color, opt) {
  opt = opt || {};
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const top = opt.top || color, sideC = opt.side || color, botC = opt.bottom || color;
  const px = faceTint(sideC, 1.045, 1.03, 1.0);
  const nz = faceTint(sideC, 1.02, 1.0, 0.975);
  const pz = shadowFace(sideC, 0.08, 1.54);
  const nx = shadowFace(sideC, 0.15, 1.43);
  const ne = opt.noEdge;
  const skip = opt.skip || {};
  if (!skip.py) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top, ne);
  if (!skip.ny) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], botC, ne);
  if (!skip.pz) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], pz, ne);
  if (!skip.nz) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], nz, ne);
  if (!skip.px) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], px, ne);
  if (!skip.nx) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], nx, ne);
};
GeoBuilder.prototype.mesh = function (matOpts) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(this.nrm, 3));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(this.col, 3));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, toonMat(Object.assign({ vertexColors: true }, matOpts || {})));
  m.castShadow = true; m.receiveShadow = true;
  return m;
};
/* Split the accumulated triangles into spatial chunks along X.
   One merged mesh means one bounding sphere covering the whole town, so
   frustum culling can never reject anything — every triangle is transformed
   every frame no matter which way you face. That is invisible on a GPU and
   expensive on a software rasteriser. Chunking costs a few extra draw calls
   and lets half the map drop out when you look down the street.
   Triangles spanning a boundary go to the chunk holding their centroid;
   the chunk's real bounds are computed from its own vertices, so nothing
   is ever wrongly culled. */
GeoBuilder.prototype.meshChunks = function (cuts, matOpts) {
  const n = cuts.length + 1;
  const buckets = [];
  for (let i = 0; i < n; i++) buckets.push({ pos: [], nrm: [], col: [] });
  const P = this.pos, N = this.nrm, K = this.col;
  for (let t = 0; t < P.length; t += 9) {
    const cx = (P[t] + P[t + 3] + P[t + 6]) / 3;
    let b = 0;
    while (b < cuts.length && cx >= cuts[b]) b++;
    const q = buckets[b];
    for (let k = 0; k < 9; k++) { q.pos.push(P[t + k]); q.nrm.push(N[t + k]); q.col.push(K[t + k]); }
  }
  const out = [];
  for (const q of buckets) {
    if (!q.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(q.pos, 3));
    g.setAttribute('normal',   new THREE.Float32BufferAttribute(q.nrm, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(q.col, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, toonMat(Object.assign({ vertexColors: true }, matOpts || {})));
    m.castShadow = true; m.receiveShadow = true;
    out.push(m);
  }
  return out;
};
/* Same partition for the ink lines. */
GeoBuilder.prototype.lineChunks = function (cuts, opacity) {
  if (!this.epos.length) return [];
  const n = cuts.length + 1;
  const buckets = [];
  for (let i = 0; i < n; i++) buckets.push({ pos: [], col: [] });
  const P = this.epos, K = this.ecol;
  for (let t = 0; t < P.length; t += 6) {
    const cx = (P[t] + P[t + 3]) / 2;
    let b = 0;
    while (b < cuts.length && cx >= cuts[b]) b++;
    const q = buckets[b];
    for (let k = 0; k < 6; k++) { q.pos.push(P[t + k]); q.col.push(K[t + k]); }
  }
  const out = [];
  for (const q of buckets) {
    if (!q.pos.length) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(q.pos, 3));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(q.col, 3));
    g.computeBoundingSphere();
    out.push(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true,
      opacity: opacity === undefined ? 0.5 : opacity, depthWrite: false
    })));
  }
  return out;
};
GeoBuilder.prototype.lines = function (opacity) {
  if (!this.epos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(this.epos, 3));
  g.setAttribute('color',    new THREE.Float32BufferAttribute(this.ecol, 3));
  g.computeBoundingSphere();
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true,
    opacity: opacity === undefined ? 0.5 : opacity, depthWrite: false
  });
  return new THREE.LineSegments(g, mat);
};
/* Baked vertex AO: ground-contact darkening + downward-face shading.
   Free at runtime, reads as grounded geometry under flat shading. */
GeoBuilder.prototype.bakeAO = function () {
  const P = this.pos, N = this.nrm, K = this.col;
  for (let i = 0; i < P.length; i += 3) {
    const y = P[i + 1], ny = N[i + 1];
    let ao = 1.0;
    if (ny < 0.7) ao *= 0.68 + 0.32 * smoothstep(y / 1.35);
    if (ny < -0.5) ao *= 0.78;
    else if (ny < 0.3) ao *= 0.92;
    const depth = 1 - ao;
    const lum = K[i] * 0.2126 + K[i + 1] * 0.7152 + K[i + 2] * 0.0722;
    const sat = 1 + depth * 0.55;
    K[i] = Math.max(0, lum + (K[i] - lum) * sat) * ao * (1 - depth * 0.08);
    K[i + 1] = Math.max(0, lum + (K[i + 1] - lum) * sat) * ao * (1 - depth * 0.02);
    K[i + 2] = Math.max(0, lum + (K[i + 2] - lum) * sat) * ao * (1 + depth * 0.12);
  }
  return this;
};
let EDGE_COL = C(0x6b5f80);

/* =====================================================================
   RENDERER / SCENE
   ===================================================================== */
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

let renderer, scene, camera, sunLight;
let SOFTWARE_GPU = false;

/* =====================================================================
   VIEWPORT SIZE
   The drawing surface follows the canvas element, never innerWidth /
   innerHeight. On a phone those two disagree exactly when it matters: a
   rotation (or the fullscreen a match start asks for) resizes the layout
   viewport, and the `resize` that follows can carry the pre-transition
   numbers. Everything else on screen is laid out by CSS and moves with the
   change; a canvas sized from the stale numbers keeps the inline width and
   height three.js writes and no longer covers the screen, leaving a band of
   page background — same #cfe8f5 as the sky, so it reads as a cut-off
   render — and putting the picture out of register with the crosshair.

   So the stylesheet owns the display size (that's setSize's third argument,
   which stops three.js from writing over it), the drawing buffer is measured
   off the element, and it's the element that gets watched: a ResizeObserver
   fires for every cause, including the ones that never reach `resize`. */
function viewW() { return Math.max(1, Math.round(canvas.clientWidth) || innerWidth); }
function viewH() { return Math.max(1, Math.round(canvas.clientHeight) || innerHeight); }

let viewW0 = 0, viewH0 = 0;
/* `force` is for a pixel-ratio change, where the CSS size is the same but the
   buffer behind it has to be reallocated anyway. */
function syncViewSize(force) {
  const w = viewW(), h = viewH();
  if (!force && w === viewW0 && h === viewH0) return;
  viewW0 = w; viewH0 = h;
  if (camera) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  if (vmCam) { vmCam.aspect = w / h; vmCam.updateProjectionMatrix(); }
  if (renderer) renderer.setSize(w, h, false);
  if (PostFX.active) PostFX.resize();
}

/* Several of these fire together for one rotation, and a couple fire while
   the layout is still settling, so coalesce into the next frame. */
function watchViewSize() {
  let queued = false;
  const sync = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; syncViewSize(); });
  };
  addEventListener('resize', sync);
  addEventListener('orientationchange', sync);
  document.addEventListener('fullscreenchange', sync);
  if (window.visualViewport) visualViewport.addEventListener('resize', sync);
  if (window.ResizeObserver) new ResizeObserver(sync).observe(canvas);
}

/* Which GPU are we on? This has to be answered BEFORE the real context is
   made, because `antialias` is baked in at creation and MSAA is the single
   most expensive thing you can ask a software rasteriser for. So probe with
   a throwaway context first. */
let GPU_NAME = '';
function detectSoftwareGPU() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    GPU_NAME = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return /swiftshader|llvmpipe|software|basic render/i.test(GPU_NAME);
  } catch (e) { return false; }
}

function initRenderer() {
  SOFTWARE_GPU = detectSoftwareGPU();

  /* The world renders offscreen: hardware gets MSAA on that target and
     MSAA-off paths get FXAA. Backbuffer MSAA would only multisample the
     fullscreen composite and duplicate the expensive allocation. */
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: false,
    powerPreference: 'high-performance'
  });
  renderer.setSize(viewW(), viewH(), false);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.setClearColor(C(0xcfe8f5), 1);

  if (SOFTWARE_GPU) {
    /* Fill rate is the whole budget here. Render at ~0.6x and let the
       browser upscale — flat cel colours survive that far better than a
       detailed render would — and drop shadow mapping entirely, which
       costs a second full geometry pass plus PCF taps per lit pixel. */
    renderer.setPixelRatio(0.5);
    renderer.shadowMap.enabled = false;
  } else {
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(C(0xe5cedf), 30, 118);

  camera = new THREE.PerspectiveCamera(74, viewW() / viewH(), 0.06, 400);
  camera.rotation.order = 'YXZ';

  syncViewSize(true);        // RES.scale is kept by setPixelRatio
  watchViewSize();
}

function initLights() {
  /* Pale surfaces still clip if total exterior light climbs much past 1.45,
     while interiors need about 0.65 without the sun. A lower cool ambient
     floor plus a stronger raking key gives both without bleaching the trim. */
  const hemi = new THREE.HemisphereLight(C(0xc8ddff), C(0xf2c7be), 0.55);
  hemi.position.set(0, 40, 0);
  scene.add(hemi);

  sunLight = new THREE.DirectionalLight(C(0xffd8a8), 0.78);
  sunLight.position.set(48, 34, -44);
  sunLight.castShadow = !SOFTWARE_GPU;
  const S = 2048;
  sunLight.shadow.mapSize.set(S, S);
  const c = sunLight.shadow.camera;
  c.left = -42; c.right = 42; c.top = 34; c.bottom = -34; c.near = 4; c.far = 140;
  c.updateProjectionMatrix();
  sunLight.shadow.bias = -0.00055;
  sunLight.shadow.normalBias = 0.028;
  scene.add(sunLight);
  scene.add(sunLight.target);
  sunLight.target.position.set(0, 1.5, 0);

  const fill = new THREE.DirectionalLight(C(0xb7c9ff), 0.12);
  fill.position.set(-34, 22, 30);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(C(0xd9efff), 0.10);
  rim.position.set(-8, 50, 38);
  scene.add(rim);

  if (!SOFTWARE_GPU) {
    for (const s of [-1, 1]) {
      const room = new THREE.PointLight(C(0xffc58f), 0.56, 11, 2);
      room.position.set(-s * 5.0, 2.45, -s * 13.6);
      scene.add(room);
    }
  }

  PostFX.init();
}

/* =====================================================================
   SKY — gradient dome + soft sun bloom disc, drawn behind everything
   ===================================================================== */
const SKY_VS = `
varying vec3 vDir;
void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const SKY_FS = `
varying vec3 vDir;
uniform vec3 cLow, cMid, cHigh, cSun;
uniform vec3 sunDir;
void main(){
  float h = clamp(vDir.y*0.5+0.5, 0.0, 1.0);
  vec3 col = mix(cLow, cMid, smoothstep(0.43, 0.61, h));
  col = mix(col, cHigh, smoothstep(0.60, 0.96, h));
  col += cLow * 0.24 * pow(1.0 - abs(vDir.y), 18.0);
  float d = max(dot(normalize(vDir), sunDir), 0.0);
  float disc = smoothstep(0.9985, 0.9994, d);
  col += cSun * disc * 1.65;
  col += cSun * pow(d, 30.0) * 0.34;
  col += cSun * pow(d, 7.0) * 0.055;
  gl_FragColor = vec4(col, 1.0);
}`;

function buildSky() {
  const sunDir = sunLight.position.clone().normalize();
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      cLow:  { value: C(0xf6bfc9) },
      cMid:  { value: C(0xb9d4f5) },
      cHigh: { value: C(0x879edc) },
      cSun:  { value: C(0xffd897) },
      sunDir: { value: sunDir }
    }
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(260, 24, 16), mat);
  /* Draw after town geometry so the depth test rejects covered pixels; drawing
     this full-screen shader first wastes a complete fill on software GPUs. */
  sky.frustumCulled = false; sky.renderOrder = 100;
  scene.add(sky);

  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const cx = cv.getContext('2d');
  const g = cx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,.95)');
  g.addColorStop(0.5, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = g; cx.fillRect(0, 0, 128, 128);
  const cloudTex = new THREE.CanvasTexture(cv);

  const cloudLayer = (count, near) => {
    const cloudMat = new THREE.SpriteMaterial({
      map: cloudTex, transparent: true, opacity: near ? 0.78 : 0.48,
      depthWrite: false, fog: false, color: C(near ? 0xfff5ee : 0xe7ecff)
    });
    const clouds = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      const r = near ? rand(92, 154) : rand(162, 232);
      const y = near ? rand(30, 58) : rand(58, 104);
      const cluster = new THREE.Group();
      cluster.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
      const n = near ? randi(3, 6) : randi(2, 5);
      const s = near ? rand(17, 31) : rand(25, 43);
      for (let j = 0; j < n; j++) {
        const sp = new THREE.Sprite(cloudMat);
        sp.position.set(rand(-s, s), rand(-s * 0.13, s * 0.13), rand(-s * 0.26, s * 0.26));
        const ss = rand(s * 0.8, s * 1.48);
        sp.scale.set(ss, ss * rand(0.42, 0.64), 1);
        cluster.add(sp);
      }
      clouds.add(cluster);
    }
    scene.add(clouds);
    return clouds;
  };
  const farClouds = cloudLayer(13, false);
  const nearClouds = cloudLayer(11, true);
  return { sky, nearClouds, farClouds, cloudTex };
}

/* =====================================================================
   POST-PROCESSING — hand-rolled chain, no EffectComposer dependency.
   Scene renders to a WebGLRenderTarget; a fullscreen triangle composites
   bloom + colour grade + vignette + chromatic aberration + FXAA.
   On SOFTWARE_GPU the bloom pass is skipped entirely and the half-resolution
   scene receives the cheap grade + vignette + FXAA composite.
   ===================================================================== */
const POST_VS = `
varying vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BLOOM_FS = `
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform vec2 uDirection;
uniform float uThreshold;
uniform float uExtract;
vec3 sampleBloom(vec2 uv){
  vec3 s = texture2D(tSrc, uv).rgb;
  if(uExtract < 0.5) return s;
  float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
  return s * smoothstep(uThreshold, uThreshold + 0.18, lum);
}
void main(){
  vec2 stepUv = uTexel * uDirection * 2.0;
  vec3 c = sampleBloom(vUv) * 0.227027;
  c += sampleBloom(vUv + stepUv) * 0.1945946;
  c += sampleBloom(vUv - stepUv) * 0.1945946;
  c += sampleBloom(vUv + stepUv * 2.0) * 0.1216216;
  c += sampleBloom(vUv - stepUv * 2.0) * 0.1216216;
  c += sampleBloom(vUv + stepUv * 3.0) * 0.0540540;
  c += sampleBloom(vUv - stepUv * 3.0) * 0.0540540;
  c += sampleBloom(vUv + stepUv * 4.0) * 0.0162162;
  c += sampleBloom(vUv - stepUv * 4.0) * 0.0162162;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `
varying vec2 vUv;
uniform sampler2D tScene;
#ifdef USE_BLOOM
uniform sampler2D tBloom;
uniform float uBloomStr;
#endif
#ifdef USE_FXAA
uniform vec2 uTexel;
#endif

vec3 grade(vec3 c){
  vec3 bounded = clamp(c, 0.0, 1.0);
  c = mix(c, bounded * bounded * (3.0 - 2.0 * bounded), 0.18);
  c = c * (1.0 + c * 0.035) / (1.0 + c * 0.105);
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 warm = vec3(1.035, 1.008, 0.970);
  vec3 cool = vec3(0.960, 0.985, 1.045);
  c *= mix(cool, warm, smoothstep(0.28, 0.76, lum));
  lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(lum), c, 1.065);
  return c;
}

#ifdef USE_FXAA
vec3 fxaa(sampler2D tex, vec2 uv, vec2 tx){
  vec3 nw = texture2D(tex, uv + vec2(-tx.x, -tx.y)).rgb;
  vec3 ne = texture2D(tex, uv + vec2( tx.x, -tx.y)).rgb;
  vec3 sw = texture2D(tex, uv + vec2(-tx.x,  tx.y)).rgb;
  vec3 se = texture2D(tex, uv + vec2( tx.x,  tx.y)).rgb;
  vec3 m  = texture2D(tex, uv).rgb;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lnw = dot(nw, luma), lne = dot(ne, luma);
  float lsw = dot(sw, luma), lse = dot(se, luma);
  float lm  = dot(m, luma);
  float mn = min(lm, min(min(lnw, lne), min(lsw, lse)));
  float mx = max(lm, max(max(lnw, lne), max(lsw, lse)));
  float range = mx - mn;
  if(range < max(0.0312, mx * 0.125)) return m;
  vec2 dir;
  dir.x = -((lnw + lne) - (lsw + lse));
  dir.y =  ((lnw + lsw) - (lne + lse));
  float rcp = 1.0 / (abs(dir.x) + abs(dir.y) + 1e-6);
  dir = clamp(dir * rcp, -4.0, 4.0) * tx;
  vec3 a = 0.5 * (
    texture2D(tex, uv + dir * (1.0/3.0 - 0.5)).rgb +
    texture2D(tex, uv + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (
    texture2D(tex, uv + dir * -0.5).rgb +
    texture2D(tex, uv + dir *  0.5).rgb);
  float lb = dot(b, luma);
  return (lb < mn || lb > mx) ? a : b;
}
#endif

void main(){
  vec2 uv = vUv;
  vec2 center = uv - 0.5;
  float r2 = dot(center, center);

  #ifdef USE_FXAA
    vec3 col = fxaa(tScene, uv, uTexel);
  #else
    vec3 col = texture2D(tScene, uv).rgb;
  #endif

  vec2 caOff = center * r2 * 0.0032;
  float caMask = smoothstep(0.16, 0.50, r2);
  col.r = mix(col.r, texture2D(tScene, uv + caOff).r, caMask);
  col.b = mix(col.b, texture2D(tScene, uv - caOff).b, caMask);

  #ifdef USE_BLOOM
    vec3 bl = texture2D(tBloom, uv).rgb;
    col += bl * uBloomStr;
  #endif

  col = grade(col);

  float vig = 1.0 - smoothstep(0.16, 0.52, r2) * 0.105;
  col *= vig;

  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}`;

const PostFX = {
  active: false,
  rtScene: null, rtBloomA: null, rtBloomB: null,
  bloom: false, msaa: false, useFXAA: false,
  bloomMat: null, compMat: null,
  bloomScene: null, compScene: null,
  fsCam: null,
  w: 0, h: 0,

  init() {
    const pr = renderer.getPixelRatio();
    const w = Math.max(1, Math.round((canvas.clientWidth || innerWidth) * pr));
    const h = Math.max(1, Math.round((canvas.clientHeight || innerHeight) * pr));
    this.w = w; this.h = h;
    this.bloom = !SOFTWARE_GPU;
    this.msaa = !SOFTWARE_GPU && renderer.capabilities.isWebGL2 &&
      typeof THREE.WebGLMultisampleRenderTarget === 'function';
    this.useFXAA = !this.msaa;

    const opts = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                   format: THREE.RGBAFormat, encoding: THREE.LinearEncoding };
    const Target = this.msaa ? THREE.WebGLMultisampleRenderTarget : THREE.WebGLRenderTarget;
    this.rtScene = new Target(w, h, opts);
    if (this.msaa) this.rtScene.samples = 4;
    this.rtScene.depthBuffer = true;
    if (this.bloom) {
      this.rtBloomA = new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), opts);
      this.rtBloomB = new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), opts);
    }

    const geo = new THREE.BufferGeometry();
    const verts = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]);
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));

    if (this.bloom) {
      this.bloomMat = new THREE.ShaderMaterial({
        vertexShader: POST_VS, fragmentShader: BLOOM_FS,
        depthTest: false, depthWrite: false,
        uniforms: {
          tSrc: { value: null },
          uTexel: { value: new THREE.Vector2(1 / Math.max(1, w >> 1), 1 / Math.max(1, h >> 1)) },
          uDirection: { value: new THREE.Vector2(1, 0) },
          uThreshold: { value: 0.94 },
          uExtract: { value: 1 }
        }
      });
    }

    const defines = {};
    if (this.bloom) defines.USE_BLOOM = 1;
    if (this.useFXAA) defines.USE_FXAA = 1;
    const compUniforms = { tScene: { value: null } };
    if (this.bloom) {
      compUniforms.tBloom = { value: null };
      compUniforms.uBloomStr = { value: 0.32 };
    }
    if (this.useFXAA) compUniforms.uTexel = { value: new THREE.Vector2(1 / w, 1 / h) };
    this.compMat = new THREE.ShaderMaterial({
      vertexShader: POST_VS, fragmentShader: COMPOSITE_FS,
      depthTest: false, depthWrite: false,
      defines: defines,
      uniforms: compUniforms
    });

    if (this.bloom) this.bloomScene = new THREE.Scene();
    this.compScene = new THREE.Scene();
    this.fsCam = new THREE.Camera();

    if (this.bloom) {
      const bloomQuad = new THREE.Mesh(geo, this.bloomMat);
      bloomQuad.frustumCulled = false;
      this.bloomScene.add(bloomQuad);
    }

    const compQuad = new THREE.Mesh(geo, this.compMat);
    compQuad.frustumCulled = false;
    this.compScene.add(compQuad);

    this.active = true;
  },

  resize() {
    if (!this.active) return;
    const pr = renderer.getPixelRatio();
    const w = Math.max(1, Math.round((canvas.clientWidth || innerWidth) * pr));
    const h = Math.max(1, Math.round((canvas.clientHeight || innerHeight) * pr));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.rtScene.setSize(w, h);
    if (this.bloom) {
      const bw = Math.max(1, w >> 1), bh = Math.max(1, h >> 1);
      this.rtBloomA.setSize(bw, bh);
      this.rtBloomB.setSize(bw, bh);
      this.bloomMat.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    }
    if (this.useFXAA) this.compMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  },

  render() {
    this.resize();
    const r = renderer;

    r.setRenderTarget(this.rtScene);
    r.autoClear = true;
    r.render(scene, camera);

    if (this.bloom) {
      this.bloomMat.uniforms.tSrc.value = this.rtScene.texture;
      this.bloomMat.uniforms.uDirection.value.set(1, 0);
      this.bloomMat.uniforms.uExtract.value = 1;
      r.setRenderTarget(this.rtBloomA);
      r.render(this.bloomScene, this.fsCam);

      this.bloomMat.uniforms.tSrc.value = this.rtBloomA.texture;
      this.bloomMat.uniforms.uDirection.value.set(0, 1);
      this.bloomMat.uniforms.uExtract.value = 0;
      r.setRenderTarget(this.rtBloomB);
      r.render(this.bloomScene, this.fsCam);
      this.compMat.uniforms.tBloom.value = this.rtBloomB.texture;
    }

    this.compMat.uniforms.tScene.value = this.rtScene.texture;
    r.setRenderTarget(null);
    r.render(this.compScene, this.fsCam);
  }
};
