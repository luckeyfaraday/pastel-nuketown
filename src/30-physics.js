/* =====================================================================
   PASTEL NUKETOWN — physics: cylinder-vs-AABB movement + hitscan
   The map is only ~110 boxes, so brute force with an early reject beats
   a broadphase we'd have to debug. Measured well under a millisecond.
   ===================================================================== */

const SOLIDS = MAP.solids;
const ACT = MAP.actor;               // {radius, height, eye, step}
const GRAVITY = 26.0;
const JUMP_V  = 8.4;

/* ---------- AABB overlap for an actor cylinder treated as a box ---- */
function boxOverlap(s, x, y, z, r, h) {
  return x + r > s.min[0] && x - r < s.max[0] &&
         y + h > s.min[1] && y     < s.max[1] &&
         z + r > s.min[2] && z - r < s.max[2];
}

/* Resolve one horizontal axis by pushing the actor back out of anything
   it ended up inside. Returns true if it hit something. */
function resolveAxis(p, axis, r, h) {
  let hit = false;
  const i = axis === 'x' ? 0 : 2;
  for (let k = 0; k < SOLIDS.length; k++) {
    const s = SOLIDS[k];
    if (!boxOverlap(s, p.x, p.y, p.z, r, h)) continue;
    hit = true;
    const c = i === 0 ? p.x : p.z;
    const dPos = s.max[i] + r - c;      // push toward +axis
    const dNeg = c - (s.min[i] - r);    // push toward -axis
    const v = dPos < dNeg ? s.max[i] + r : s.min[i] - r;
    if (i === 0) p.x = v; else p.z = v;
  }
  return hit;
}

/* Move an actor. `p` is feet position (mutated), `v` is velocity (mutated).
   Returns {onGround, hitWall, landed}. */
function moveActor(p, v, dt, opts) {
  opts = opts || {};
  const r = opts.radius || ACT.radius, h = opts.height || ACT.height;
  const step = opts.step === undefined ? ACT.step : opts.step;
  const startY = p.y;

  /* ---- vertical ---- */
  v.y -= GRAVITY * dt;
  if (v.y < -55) v.y = -55;
  p.y += v.y * dt;

  let onGround = false;
  if (p.y <= 0) { p.y = 0; if (v.y < 0) v.y = 0; onGround = true; }

  for (let k = 0; k < SOLIDS.length; k++) {
    const s = SOLIDS[k];
    if (!boxOverlap(s, p.x, p.y, p.z, r, h)) continue;
    const feetToTop = s.max[1] - p.y;
    const headToBot = (p.y + h) - s.min[1];
    if (v.y <= 0 && feetToTop <= headToBot) {          // landed on top
      p.y = s.max[1]; v.y = 0; onGround = true;
    } else if (v.y > 0) {                              // bonked the ceiling
      p.y = s.min[1] - h; v.y = 0;
    }
  }

  /* ---- horizontal, one axis at a time so we slide along walls ---- */
  const dx = v.x * dt, dz = v.z * dt;
  const preX = p.x, preZ = p.z, preY = p.y;

  p.x += dx; const hx = resolveAxis(p, 'x', r, h);
  p.z += dz; const hz = resolveAxis(p, 'z', r, h);
  let hitWall = hx || hz;

  /* ---- step-up: retry the same move from step-height and drop back --
     Without this, bots and the player snag on curbs, porch steps and the
     bottom stair, which reads as "the AI is stuck". */
  if (hitWall && onGround && step > 0) {
    const wantX = preX + dx, wantZ = preZ + dz;
    const gotSq = (p.x - preX) * (p.x - preX) + (p.z - preZ) * (p.z - preZ);
    const wantSq = dx * dx + dz * dz;
    if (gotSq < wantSq * 0.92) {
      const t = { x: preX, y: preY + step, z: preZ };
      let blocked = false;
      for (let k = 0; k < SOLIDS.length; k++)
        if (boxOverlap(SOLIDS[k], t.x, t.y, t.z, r, h)) { blocked = true; break; }
      if (!blocked) {
        t.x = wantX; resolveAxis(t, 'x', r, h);
        t.z = wantZ; resolveAxis(t, 'z', r, h);
        const gotSq2 = (t.x - preX) * (t.x - preX) + (t.z - preZ) * (t.z - preZ);
        if (gotSq2 > gotSq + 1e-4) {
          // drop back down onto whatever we stepped onto
          let landY = 0;
          for (let k = 0; k < SOLIDS.length; k++) {
            const s = SOLIDS[k];
            if (t.x + r <= s.min[0] || t.x - r >= s.max[0]) continue;
            if (t.z + r <= s.min[2] || t.z - r >= s.max[2]) continue;
            if (s.max[1] <= t.y + 0.02 && s.max[1] > landY) landY = s.max[1];
          }
          if (landY <= preY + step + 0.02) {
            p.x = t.x; p.z = t.z; p.y = Math.max(landY, preY);
            hitWall = false;
          }
        }
      }
    }
  }

  // keep everyone inside the fence no matter what
  const B = MAP.bounds;
  p.x = clamp(p.x, B.minX + r, B.maxX - r);
  p.z = clamp(p.z, B.minZ + r, B.maxZ - r);

  return { onGround, hitWall, landed: onGround && startY - p.y > 0.06 };
}

/* =====================================================================
   RAYCAST against the static map
   ===================================================================== */
const _rc = { hit: false, dist: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0 };
function rayBox(ox, oy, oz, dx, dy, dz, s, maxT) {
  // slab test; returns entry t or -1
  let t0 = 0, t1 = maxT, axis = -1, sign = 1;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < s.min[i] || o[i] > s.max[i]) return -1; continue; }
    const inv = 1 / d[i];
    let a = (s.min[i] - o[i]) * inv, b = (s.max[i] - o[i]) * inv, sg = -1;
    if (a > b) { const tmp = a; a = b; b = tmp; sg = 1; }
    if (a > t0) { t0 = a; axis = i; sign = sg; }
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  _rc.nx = _rc.ny = _rc.nz = 0;
  if (axis === 0) _rc.nx = sign; else if (axis === 1) _rc.ny = sign; else if (axis === 2) _rc.nz = sign;
  return t0;
}
function raycastMap(ox, oy, oz, dx, dy, dz, maxT) {
  let best = maxT, bn = [0, 1, 0], found = false;
  for (let k = 0; k < SOLIDS.length; k++) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, SOLIDS[k], best);
    if (t >= 0 && t < best) { best = t; found = true; bn = [_rc.nx, _rc.ny, _rc.nz]; }
  }
  // ground plane
  if (dy < -1e-9) {
    const t = -oy / dy;
    if (t >= 0 && t < best) { best = t; found = true; bn = [0, 1, 0]; }
  }
  if (!found) return null;
  return { dist: best, nx: bn[0], ny: bn[1], nz: bn[2],
           px: ox + dx * best, py: oy + dy * best, pz: oz + dz * best };
}
function canSee(ax, ay, az, bx, by, bz) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-4) return true;
  dx /= d; dy /= d; dz /= d;
  const h = raycastMap(ax, ay, az, dx, dy, dz, d - 0.05);
  return !h;
}

/* Hitboxes. These MUST track the character proportions in 50-actors.js
   (CH.headC / CH.torsoTop) or bullets pass through visible heads. */
const HIT = { headY: 1.60, headR: 0.30, bodyTop: 1.42, bodyR: 0.36, footY: 0.06 };

/* ---- ray vs actor: cylinder body + sphere head (headshots!) ---- */
function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, y0, y1, r, maxT) {
  const px = ox - cx, pz = oz - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) return -1;
  const b = 2 * (px * dx + pz * dz);
  const c = px * px + pz * pz - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
    if (t < 0 || t > maxT) continue;
    const y = oy + dy * t;
    if (y >= y0 && y <= y1) return t;
  }
  return -1;
}
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r, maxT) {
  const px = ox - cx, py = oy - cy, pz = oz - cz;
  const b = 2 * (px * dx + py * dy + pz * dz);
  const c = px * px + py * py + pz * pz - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  for (const t of [(-b - sq) / 2, (-b + sq) / 2]) if (t >= 0 && t <= maxT) return t;
  return -1;
}

/* Full hitscan: nearest of (map, any living actor). `ignore` is an id. */
function hitscan(ox, oy, oz, dx, dy, dz, maxT, actors, ignoreId) {
  const m = raycastMap(ox, oy, oz, dx, dy, dz, maxT);
  let best = m ? m.dist : maxT;
  let res = m ? { kind: 'map', dist: m.dist, px: m.px, py: m.py, pz: m.pz, nx: m.nx, ny: m.ny, nz: m.nz } : null;

  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    if (!a.alive || a.id === ignoreId) continue;
    const hy = a.pos.y + HIT.headY;                // head centre
    const th = raySphere(ox, oy, oz, dx, dy, dz, a.pos.x, hy, a.pos.z, HIT.headR, best);
    if (th >= 0 && th < best) {
      best = th;
      res = { kind: 'actor', actor: a, head: true, dist: th,
              px: ox + dx * th, py: oy + dy * th, pz: oz + dz * th, nx: -dx, ny: -dy, nz: -dz };
      continue;
    }
    const tb = rayCylinder(ox, oy, oz, dx, dy, dz, a.pos.x, a.pos.z,
                           a.pos.y + HIT.footY, a.pos.y + HIT.bodyTop, HIT.bodyR, best);
    if (tb >= 0 && tb < best) {
      best = tb;
      res = { kind: 'actor', actor: a, head: false, dist: tb,
              px: ox + dx * tb, py: oy + dy * tb, pz: oz + dz * tb, nx: -dx, ny: -dy, nz: -dz };
    }
  }

  // mannequins are shootable decoration — they stop bullets and spin
  for (let i = 0; i < WORLD.mannequins.length; i++) {
    const m2 = WORLD.mannequins[i];
    const t = rayCylinder(ox, oy, oz, dx, dy, dz, m2.position.x, m2.position.z,
                          m2.position.y + 0.7, m2.position.y + 2.05, 0.3, best);
    if (t >= 0 && t < best) {
      best = t;
      res = { kind: 'mannequin', obj: m2, dist: t,
              px: ox + dx * t, py: oy + dy * t, pz: oz + dz * t, nx: -dx, ny: -dy, nz: -dz };
    }
  }
  return res;
}

/* ---- spawn picking: farthest spawn from the nearest living threat ---- */
function pickSpawn(actors, selfId) {
  let bestPt = MAP.spawns[0], bestScore = -1e9;
  for (const sp of MAP.spawns) {
    let near = 1e9;
    for (const a of actors) {
      if (!a.alive || a.id === selfId) continue;
      const d = Math.hypot(a.pos.x - sp.x, a.pos.z - sp.z);
      if (d < near) near = d;
    }
    const score = Math.min(near, 40) + rng() * 6;
    if (score > bestScore) { bestScore = score; bestPt = sp; }
  }
  return bestPt;
}
