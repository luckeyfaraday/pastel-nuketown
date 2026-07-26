/* =====================================================================
   PASTEL NUKETOWN — SHARED MAP SPEC  (contract file; do not restructure)
   =====================================================================
   Consumed by BOTH:
     - index.html   (renderer + engine)   -> globalThis.NUKETOWN_MAP
     - bots.js      (nav + AI)            -> require('./mapspec.js')

   COORDINATES
     Y is up, meters. Street runs along X. Map is 180deg-rotationally
     symmetric about the origin (classic Nuketown): House A sits north
     (-Z), House B south (+Z); bus at the west end, truck at the east.

     x in [-30, 30]   long axis (street)
     z in [-20, 20]   short axis
     y = 0 ground, 3.3 = upper floor, 6.6 = roof top

   DATA
     solids    [{min:[x,y,z], max:[x,y,z], mat, house?}]  block movement
     platforms [{min:[x,z], max:[x,z], y}]                walkable tops
     links     [{a:[x,y,z], b:[x,y,z], w}]                stairs (2-way)
     spawns    [{x,y,z,yaw}]
     bounds    {minX,maxX,minZ,maxZ}
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NUKETOWN_MAP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const W = 0.3;      // wall thickness
  const H0 = 3.0;     // ground-floor ceiling height
  const SLAB = 0.3;   // floor slab thickness
  const F1 = H0 + SLAB;   // 3.3 upper floor level
  const H1 = 6.3;     // upper ceiling
  const ROOF = 6.6;

  const solids = [];
  const platforms = [];
  const links = [];
  const spawns = [];

  // --- emit helpers ---------------------------------------------------
  // s = +1 -> House A (north).  s = -1 -> House B (south), mirrored
  // through the origin, which is exactly Nuketown's rotational symmetry.
  function box(s, x0, y0, z0, x1, y1, z1, mat, house) {
    const ax = s > 0 ? x0 : -x1, bx = s > 0 ? x1 : -x0;
    const az = s > 0 ? z0 : -z1, bz = s > 0 ? z1 : -z0;
    solids.push({
      min: [ax, y0, az], max: [bx, y1, bz],
      mat: mat || 'wall', house: house || null
    });
  }
  function plat(s, x0, z0, x1, z1, y) {
    const ax = s > 0 ? x0 : -x1, bx = s > 0 ? x1 : -x0;
    const az = s > 0 ? z0 : -z1, bz = s > 0 ? z1 : -z0;
    platforms.push({ min: [ax, az], max: [bx, bz], y: y });
  }
  function link(s, ax, ay, az, bx, by, bz, w) {
    links.push({
      a: [s > 0 ? ax : -ax, ay, s > 0 ? az : -az],
      b: [s > 0 ? bx : -bx, by, s > 0 ? bz : -bz],
      w: w || 1.6
    });
  }

  /* =====================================================================
     HOUSE  (footprint x[-12,4]  z[-18,-7];  front wall faces the street)
     ===================================================================== */
  function buildHouse(s) {
    const hc = s > 0 ? 'A' : 'B';
    const X0 = -12, X1 = 4, ZB = -18, ZF = -7;   // back / front

    // ---- ground floor shell (y 0..H0) ----
    // front (street-facing) wall, door gap x[-5.5,-3.5]
    box(s, X0, 0, ZF - W, -5.5, H0, ZF, 'house', hc);
    box(s, -3.5, 0, ZF - W, X1, H0, ZF, 'house', hc);
    box(s, -5.5, 2.25, ZF - W, -3.5, H0, ZF, 'house', hc);   // door header
    // back wall, door gap x[-1.5,0.5]
    box(s, X0, 0, ZB, -1.5, H0, ZB + W, 'house', hc);
    box(s, 0.5, 0, ZB, X1, H0, ZB + W, 'house', hc);
    box(s, -1.5, 2.25, ZB, 0.5, H0, ZB + W, 'house', hc);
    // west wall, side opening z[-13.5,-11.5]
    box(s, X0, 0, ZB, X0 + W, H0, -13.5, 'house', hc);
    box(s, X0, 0, -11.5, X0 + W, H0, ZF, 'house', hc);
    box(s, X0, 2.25, -13.5, X0 + W, H0, -11.5, 'house', hc);
    // east wall solid
    box(s, X1 - W, 0, ZB, X1, H0, ZF, 'house', hc);
    // interior dividers
    box(s, -5.5, 0, ZB, -5.2, H0, -12.5, 'trim', hc);
    box(s, -5.5, 0, -12.8, -1.0, H0, -12.5, 'trim', hc);

    // ---- staircase: rises along -Z, bottom z=-12.5 -> top z=-16.2 ----
    const SX0 = 1.6, SX1 = 3.7, STEPS = 9;
    const sz0 = -12.5, sz1 = -16.2;
    for (let i = 0; i < STEPS; i++) {
      const za = sz0 + (sz1 - sz0) * (i / STEPS);
      const zb = sz0 + (sz1 - sz0) * ((i + 1) / STEPS);
      const top = F1 * ((i + 1) / STEPS);
      box(s, SX0, 0, Math.min(za, zb), SX1, top, Math.max(za, zb), 'stair', hc);
    }
    link(s, (SX0 + SX1) / 2, 0, -11.9, (SX0 + SX1) / 2, F1, -16.8, 1.8);

    // ---- upper floor slab (hole over the stairwell) ----
    box(s, X0, H0, ZB, SX0, F1, ZF, 'slab', hc);
    box(s, SX0, H0, ZB, X1, F1, sz1, 'slab', hc);
    box(s, SX0, H0, sz0, X1, F1, ZF, 'slab', hc);
    plat(s, X0, ZB, SX0, ZF, F1);
    plat(s, SX0, ZB, X1, sz1, F1);
    plat(s, SX0, sz0, X1, ZF, F1);

    // ---- upper floor shell (y F1..H1) ----
    // front wall, balcony doorway gap x[-9,-1]
    box(s, X0, F1, ZF - W, -9, H1, ZF, 'house', hc);
    box(s, -1, F1, ZF - W, X1, H1, ZF, 'house', hc);
    box(s, -9, F1 + 2.25, ZF - W, -1, H1, ZF, 'house', hc);
    // back wall with a drop-out window gap x[-6,-3] (jump down to alley)
    box(s, X0, F1, ZB, -6, H1, ZB + W, 'house', hc);
    box(s, -3, F1, ZB, X1, H1, ZB + W, 'house', hc);
    box(s, -6, F1 + 1.9, ZB, -3, H1, ZB + W, 'house', hc);
    // west wall, upper opening z[-14,-12]
    box(s, X0, F1, ZB, X0 + W, H1, -14, 'house', hc);
    box(s, X0, F1, -12, X0 + W, H1, ZF, 'house', hc);
    box(s, X0, F1 + 1.9, -14, X0 + W, H1, -12, 'house', hc);
    // east wall solid
    box(s, X1 - W, F1, ZB, X1, H1, ZF, 'house', hc);
    // upper divider
    box(s, -4.0, F1, ZB, -3.7, H1, -13.0, 'trim', hc);

    // ---- roof ----
    box(s, X0, H1, ZB, X1, ROOF, ZF, 'roof', hc);

    /* ---- porch + balcony ----------------------------------------------
       The porch roof IS the balcony floor: one slab at y H0..F1 hanging
       off the front wall, held by two posts. Walk out the upper doorway
       onto it. */
    const PZ0 = ZF, PZ1 = ZF + 1.7;      // porch depth toward the street
    box(s, -10, H0, PZ0, 2, F1, PZ1, 'slab', hc);
    plat(s, -10, PZ0, 2, PZ1, F1);
    box(s, -10, 0, PZ1 - 0.45, -9.55, H0, PZ1, 'post', hc);
    box(s, 1.55, 0, PZ1 - 0.45, 2, H0, PZ1, 'post', hc);
    // balcony railing (waist high, y F1..F1+1.0)
    box(s, -10, F1, PZ1 - 0.14, 2, F1 + 1.0, PZ1, 'rail', hc);
    box(s, -10, F1, PZ0, -9.86, F1 + 1.0, PZ1, 'rail', hc);
    box(s, 1.86, F1, PZ0, 2, F1 + 1.0, PZ1, 'rail', hc);
    // porch step
    box(s, -6.2, 0, PZ1, -2.8, 0.25, PZ1 + 0.7, 'trim', hc);

    // ---- front-yard picket fences (waist high, cover) ----
    box(s, -17.5, 0, PZ1 + 0.5, -10.5, 1.15, PZ1 + 0.68, 'picket', hc);
    box(s, 2.5, 0, PZ1 + 0.5, 8.5, 1.15, PZ1 + 0.68, 'picket', hc);
    box(s, -17.68, 0, -12.5, -17.5, 1.15, PZ1 + 0.68, 'picket', hc);
    box(s, 8.32, 0, -12.5, 8.5, 1.15, PZ1 + 0.68, 'picket', hc);
  }

  buildHouse(+1);   // House A — north
  buildHouse(-1);   // House B — south

  /* =====================================================================
     STREET FURNITURE / VEHICLES  (also 180deg symmetric)
     ===================================================================== */
  // school bus (west) / pickup truck (east)
  solids.push({ min: [-27, 0, -2.4], max: [-16.5, 3.0, 2.4], mat: 'bus' });
  solids.push({ min: [17, 0, -2.1], max: [25, 2.0, 2.1], mat: 'truck' });

  // crates & barriers for street cover — mirrored pairs
  const cover = [
    [-4.6, -2.6, -3.0, -1.0, 1.6],   // x0,z0,x1,z1,height
    [-14.5, 3.2, -12.9, 4.8, 1.5],
    [-9.0, -5.0, -7.6, -3.6, 1.2],
    [-20.5, -5.6, -19.1, -4.2, 1.5],
    [-15.5, -9.5, -14.1, -8.1, 1.2]
  ];
  for (const [x0, z0, x1, z1, h] of cover) {
    solids.push({ min: [x0, 0, z0], max: [x1, h, z1], mat: 'crate' });
    solids.push({ min: [-x1, 0, -z1], max: [-x0, h, -z0], mat: 'crate' });
  }

  /* =====================================================================
     PERIMETER
     ===================================================================== */
  const B = { minX: -30, maxX: 30, minZ: -20, maxZ: 20 };
  const PH = 4.5;
  solids.push({ min: [B.minX - 0.6, 0, B.minZ - 0.6], max: [B.minX, PH, B.maxZ + 0.6], mat: 'perimeter' });
  solids.push({ min: [B.maxX, 0, B.minZ - 0.6], max: [B.maxX + 0.6, PH, B.maxZ + 0.6], mat: 'perimeter' });
  solids.push({ min: [B.minX, 0, B.minZ - 0.6], max: [B.maxX, PH, B.minZ], mat: 'perimeter' });
  solids.push({ min: [B.minX, 0, B.maxZ], max: [B.maxX, PH, B.maxZ + 0.6], mat: 'perimeter' });

  /* =====================================================================
     SPAWNS  — two end clusters (classic Nuketown) + yard fillers.
     yaw: radians, 0 = +X. Spawns face roughly toward map centre.
     ===================================================================== */
  const spawnPts = [
    [-28.0, -9.0, 0.2], [-28.5, 6.0, -0.2], [-24.0, -14.5, 0.6],
    [-25.0, 13.5, -0.6], [-28.8, 0.0, 0.0], [-21.0, -16.5, 0.5],
    [-19.0, 9.0, -0.4]
  ];
  for (const [x, z, yaw] of spawnPts) {
    spawns.push({ x: x, y: 0, z: z, yaw: yaw });
    spawns.push({ x: -x, y: 0, z: -z, yaw: yaw + Math.PI });
  }

  return {
    solids: solids,
    platforms: platforms,
    links: links,
    spawns: spawns,
    bounds: B,
    levels: [0, F1],
    consts: { W: W, H0: H0, SLAB: SLAB, F1: F1, H1: H1, ROOF: ROOF },
    // canonical player/bot collision cylinder + eye height
    actor: { radius: 0.38, height: 1.8, eye: 1.62, step: 0.55 }
  };
});
