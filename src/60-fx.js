/* =====================================================================
   PASTEL NUKETOWN — FX (confetti, sparkles, tracers, floaters) + audio
   ===================================================================== */

const FX = {
  conf: null, spark: null, tracers: [], tracerI: 0, rings: [], shake: 0, shakeV: 0
};

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

/* 0 right at the lens, 1 beyond ~2.2m. Used by every point sprite. */
function nearFade(x, y, z) {
  const dx = x - camera.position.x, dy = y - camera.position.y, dz = z - camera.position.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  return smoothstep((d - 0.7) / 1.5);
}

function ParticleSys(max, tex, additive, size) {
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setDrawRange(0, 0);
  const m = new THREE.PointsMaterial({
    size: size, map: tex, vertexColors: true, transparent: true,
    depthWrite: false, sizeAttenuation: true, fog: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    opacity: 1, alphaTest: additive ? 0 : 0.12
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
  P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
  P.life[i] = life; P.maxLife[i] = life;
  P.r[i] = color.r; P.g[i] = color.g; P.b[i] = color.b;
}
function psUpdate(P, dt) {
  const a = P.pts.geometry.attributes, pos = a.position.array, col = a.color.array;
  let live = 0;
  for (let i = 0; i < P.n; i++) {
    if (P.life[i] <= 0) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; pos[i * 3 + 1] = -999; continue; }
    P.life[i] -= dt;
    P.vy[i] -= P.grav * dt;
    P.vx[i] *= Math.exp(-2.2 * dt); P.vz[i] *= Math.exp(-2.2 * dt);
    pos[i * 3] += P.vx[i] * dt; pos[i * 3 + 1] += P.vy[i] * dt; pos[i * 3 + 2] += P.vz[i] * dt;
    if (pos[i * 3 + 1] < 0.03) { pos[i * 3 + 1] = 0.03; P.vy[i] *= -0.32; P.vx[i] *= 0.6; P.vz[i] *= 0.6; }
    const f = clamp(P.life[i] / P.maxLife[i], 0, 1);
    let e = f > 0.7 ? 1 : f / 0.7;
    /* Near-camera fade, ADDITIVE ONLY. sizeAttenuation makes a 0.3m sprite
       cover a third of the screen at arm's length and additive ones then
       bleach the frame, so dim them toward black as they near the lens —
       black is invisible under additive blending.
       Never do this to a normal-blended system: there black is opaque, and
       the confetti turns into a swarm of dark squares. It is small and
       solid anyway, so up close it just reads as confetti flying past. */
    if (P.additive) e *= nearFade(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    col[i * 3] = P.r[i] * e; col[i * 3 + 1] = P.g[i] * e; col[i * 3 + 2] = P.b[i] * e;
    live = i + 1;
  }
  a.position.needsUpdate = true; a.color.needsUpdate = true;
  P.pts.geometry.setDrawRange(0, P.n);
}

function initFX() {
  FX.conf  = ParticleSys(SOFTWARE_GPU ? 340 : 900, squareTex(), false, 0.16);
  FX.spark = ParticleSys(SOFTWARE_GPU ? 200 : 520, softTex(),  true,  0.30);

  // tracer pool: thin additive boxes stretched along the shot
  const tg = new THREE.BoxGeometry(0.035, 0.035, 1);
  tg.translate(0, 0, -0.5);
  for (let i = 0; i < 34; i++) {
    const m = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({
      color: C(0xfff0c0), transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false
    }));
    m.visible = false; m.frustumCulled = false;
    scene.add(m);
    FX.tracers.push({ mesh: m, t: 0 });
  }
  // impact shock rings
  const rg = new THREE.RingGeometry(0.22, 0.34, 18);
  for (let i = 0; i < 12; i++) {
    const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({
      color: C(0xffffff), transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false
    }));
    m.visible = false; scene.add(m);
    FX.rings.push({ mesh: m, t: 0, dur: 0.3 });
  }
}

const CONFETTI = [0xffb7c5, 0xa8dcf0, 0xb8f2d8, 0xd4c5f9, 0xffefa8, 0xffd3b6, 0xffffff];

function fxTracer(x0, y0, z0, x1, y1, z1, color) {
  const t = FX.tracers[FX.tracerI++ % FX.tracers.length];
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.05) return;
  t.mesh.position.set(x1, y1, z1);
  t.mesh.lookAt(x0, y0, z0);
  t.mesh.scale.set(1, 1, len);
  t.mesh.material.color.copy(color || C(0xfff0c0));
  t.mesh.material.opacity = 0.95;
  t.mesh.visible = true;
  t.t = 0.085;
}
function fxRing(x, y, z, nx, ny, nz, color, scale) {
  for (const r of FX.rings) {
    if (r.t > 0) continue;
    r.mesh.position.set(x + nx * 0.02, y + ny * 0.02, z + nz * 0.02);
    r.mesh.lookAt(x + nx, y + ny, z + nz);
    r.mesh.scale.setScalar(scale || 1);
    r.mesh.material.color.copy(color || C(0xfff8f0));
    r.mesh.material.opacity = 0.9;
    r.mesh.visible = true; r.t = r.dur = 0.28;
    r.s0 = scale || 1;
    return;
  }
}
function fxImpact(x, y, z, nx, ny, nz, kind) {
  const n = kind === 'actor' ? 14 : 8;
  for (let i = 0; i < n; i++) {
    const sx = nx + rand(-0.9, 0.9), sy = ny + rand(-0.2, 1.3), sz = nz + rand(-0.9, 0.9);
    const s = rand(1.6, 5.2);
    psEmit(FX.conf, x, y, z, sx * s, sy * s, sz * s, rand(0.5, 1.2),
           C(kind === 'actor' ? pick(CONFETTI) : 0xf0e6f2));
  }
  for (let i = 0; i < 5; i++)
    psEmit(FX.spark, x, y, z, nx * rand(1, 4) + rand(-1.5, 1.5), ny * rand(1, 3) + rand(0, 2), nz * rand(1, 4) + rand(-1.5, 1.5),
           rand(0.16, 0.36), C(0xfff2cc));
  fxRing(x, y, z, nx, ny, nz, C(kind === 'actor' ? 0xffd0e0 : 0xffffff), kind === 'actor' ? 1.1 : 0.7);
}
function fxKillBurst(x, y, z, color) {
  for (let i = 0; i < 46; i++) {
    const a = rand(0, TAU), p = rand(-0.6, 1.25), s = rand(2.5, 8);
    psEmit(FX.conf, x, y + rand(0.4, 1.5), z,
           Math.cos(a) * Math.cos(p) * s, Math.sin(p) * s + 3.5, Math.sin(a) * Math.cos(p) * s,
           rand(1.0, 2.0), C(pick(CONFETTI)));
  }
  for (let i = 0; i < 20; i++) {
    const a = rand(0, TAU), s = rand(1.5, 5);
    psEmit(FX.spark, x, y + rand(0.6, 1.4), z, Math.cos(a) * s, rand(1, 5), Math.sin(a) * s,
           rand(0.35, 0.8), C(0xffffff));
  }
  fxRing(x, y + 0.9, z, 0, 1, 0, color || C(0xffe0ec), 2.2);
}
function fxSpawnPuff(x, y, z, color) {
  for (let i = 0; i < 22; i++) {
    const a = rand(0, TAU), s = rand(1.2, 3.4);
    psEmit(FX.spark, x + Math.cos(a) * 0.4, y + rand(0.1, 1.7), z + Math.sin(a) * 0.4,
           Math.cos(a) * s, rand(0.5, 2.5), Math.sin(a) * s, rand(0.3, 0.7), color || C(0xffffff));
  }
}
function fxShake(amount) { FX.shakeV += amount; }

function updateFX(dt) {
  psUpdate(FX.conf, dt);
  psUpdate(FX.spark, dt);
  for (const t of FX.tracers) {
    if (t.t <= 0) continue;
    t.t -= dt;
    t.mesh.material.opacity = clamp(t.t / 0.085, 0, 1) * 0.95;
    if (t.t <= 0) t.mesh.visible = false;
  }
  for (const r of FX.rings) {
    if (r.t <= 0) continue;
    r.t -= dt;
    const u = 1 - r.t / r.dur;
    r.mesh.scale.setScalar((r.s0 || 1) * (1 + u * 2.6));
    r.mesh.material.opacity = (1 - u) * 0.85;
    if (r.t <= 0) r.mesh.visible = false;
  }
  FX.shakeV *= Math.exp(-9 * dt);
  FX.shake = FX.shakeV;
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
  floaters.push({ el, x, y, z, t: 0, dur: big ? 1.5 : 1.0, rise: big ? 1.5 : 1.0, dx: rand(-16, 16) });
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
