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
   trick for a pastel look. Shadows land around 62% brightness instead of
   0%, so nothing ever goes muddy. Falls back to Lambert if this build of
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
  GRAD = makeGradientMap(4, 0.70);
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
/* axis-aligned box; `tint` darkens sides slightly so faces read apart even
   when the light is flat */
GeoBuilder.prototype.box = function (min, max, color, opt) {
  opt = opt || {};
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const top = opt.top || color, sideC = opt.side || color, botC = opt.bottom || color;
  const ne = opt.noEdge;
  const skip = opt.skip || {};
  if (!skip.py) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], top, ne);
  if (!skip.ny) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], botC, ne);
  if (!skip.pz) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], sideC, ne);
  if (!skip.nz) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], sideC, ne);
  if (!skip.px) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], sideC, ne);
  if (!skip.nx) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], sideC, ne);
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
let EDGE_COL = C(0x6b5f80);

/* =====================================================================
   RENDERER / SCENE
   ===================================================================== */
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

let renderer, scene, camera, sunLight;
let SOFTWARE_GPU = false;

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

  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: !SOFTWARE_GPU,          // MSAA is ~4x the fill cost in SwiftShader
    powerPreference: 'high-performance'
  });
  renderer.setSize(innerWidth, innerHeight);
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
  scene.fog = new THREE.Fog(C(0xd7dcf2), 95, 250);

  camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.06, 400);
  camera.rotation.order = 'YXZ';

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);   // RES.scale is kept by setPixelRatio
  });
}

function initLights() {
  /* Two constraints pull against each other here:
       exterior total must stay near ~1.35 (no tone mapping in r128, so more
       than that clips the pale pastels to flat white), while interiors are
       lit by the hemisphere and fill ALONE and go muddy below ~0.8.
     Hence a hemisphere-heavy split: 0.68 + 0.15 indoors, +0.52 sun outdoors. */
  const hemi = new THREE.HemisphereLight(C(0xdcefff), C(0xffe0bd), 0.68);
  hemi.position.set(0, 40, 0);
  scene.add(hemi);

  sunLight = new THREE.DirectionalLight(C(0xfff4d9), 0.52);
  sunLight.position.set(-34, 46, 26);
  sunLight.castShadow = !SOFTWARE_GPU;
  const S = 2048;
  sunLight.shadow.mapSize.set(S, S);
  const c = sunLight.shadow.camera;
  c.left = -46; c.right = 46; c.top = 42; c.bottom = -42; c.near = 1; c.far = 130;
  c.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0012;
  sunLight.shadow.normalBias = 0.035;
  scene.add(sunLight);
  scene.add(sunLight.target);
  sunLight.target.position.set(0, 0, 0);

  // cool bounce from the opposite side keeps shadowed faces pastel, not grey
  const fill = new THREE.DirectionalLight(C(0xcfd9ff), 0.15);
  fill.position.set(30, 18, -26);
  scene.add(fill);
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
  // two-stage vertical ramp: horizon glow -> mid -> zenith
  vec3 col = mix(cLow, cMid, smoothstep(0.42, 0.56, h));
  col = mix(col, cHigh, smoothstep(0.55, 0.92, h));
  // warm band hugging the horizon
  col += cLow * 0.35 * pow(1.0 - abs(vDir.y), 14.0);
  // soft sun
  float d = max(dot(normalize(vDir), sunDir), 0.0);
  col += cSun * pow(d, 220.0) * 1.5;
  col += cSun * pow(d, 12.0) * 0.16;
  gl_FragColor = vec4(col, 1.0);
}`;

function buildSky() {
  const sunDir = sunLight.position.clone().normalize();
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS,
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      cLow:  { value: C(0xffdfd0) },   // peach horizon
      cMid:  { value: C(0xd9e4fb) },   // powder blue
      cHigh: { value: C(0xbcd0f7) },   // deeper blue zenith
      cSun:  { value: C(0xfff3d0) },
      sunDir: { value: sunDir }
    }
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(260, 24, 16), mat);
  /* Draw the sky AFTER the town, not before. depthWrite is off, so the
     depth test then rejects every pixel the buildings already cover —
     otherwise this full-screen custom shader runs once for the whole
     viewport and is immediately painted over. Worth ~25% of the frame
     under software rendering. */
  sky.frustumCulled = false; sky.renderOrder = 100;
  scene.add(sky);

  // ---- puffy clouds: clusters of soft billboards ----
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const cx = cv.getContext('2d');
  const g = cx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,.95)');
  g.addColorStop(0.5, 'rgba(255,255,255,.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = g; cx.fillRect(0, 0, 128, 128);
  const cloudTex = new THREE.CanvasTexture(cv);

  const cloudMat = new THREE.SpriteMaterial({
    map: cloudTex, transparent: true, opacity: 0.85, depthWrite: false, fog: false,
    color: C(0xfffdfa)
  });
  const clouds = new THREE.Group(); clouds.renderOrder = -90;
  for (let i = 0; i < 16; i++) {
    const a = rand(0, TAU), r = rand(110, 210), y = rand(38, 84);
    const cluster = new THREE.Group();
    cluster.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    const n = randi(3, 6), s = rand(20, 40);
    for (let j = 0; j < n; j++) {
      const sp = new THREE.Sprite(cloudMat);
      sp.position.set(rand(-s, s), rand(-s * 0.16, s * 0.16), rand(-s * 0.3, s * 0.3));
      const ss = rand(s * 0.75, s * 1.5);
      sp.scale.set(ss, ss * rand(0.5, 0.72), 1);
      cluster.add(sp);
    }
    clouds.add(cluster);
  }
  scene.add(clouds);
  return { sky, clouds };
}
