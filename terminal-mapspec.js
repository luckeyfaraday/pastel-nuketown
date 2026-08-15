/* =====================================================================
   PASTEL NUKETOWN — TERMINAL MAP SPEC  (contract file; do not restructure)
   =====================================================================
   Same contract as mapspec.js. Consumed by the renderer, the physics
   engine and the bot navigation through the shared map registry.

   COORDINATES
     Y is up, meters. X is the terminal frontage (long axis), Z is depth:
     the building sits at -Z, the apron at +Z. Unlike Nuketown this map is
     NOT symmetric, which is fine — the match is free-for-all and
     pickSpawn() has no team logic to balance.

     x in [-40, 40]   long axis (frontage)
     z in [-26, 26]   short axis (interior -> apron)
     y = 0 ground, 3.3 everything upstairs

   THE ONE-LEVEL RULE
     Mezzanine, jet bridge, plane cabin floor and the top of a three-high
     freight stack ALL sit at y = 3.3. That keeps levels at two instead of
     three, which keeps the nav grid under 2x Nuketown rather than ~2.6x,
     and lets bots contest the plane and the container tops.

     The 1.1 container height is load-bearing twice over. bots.js
     supported() matches a platform to a level within 0.08m, so 3 x 1.1
     must land exactly on 3.3. And each riser has to clear the engine's
     jump apex of 1.357m or the stack is a wall — see CONT below.

   DATA
     solids    [{min:[x,y,z], max:[x,y,z], mat}]  block movement
     platforms [{min:[x,z], max:[x,z], y}]        walkable tops
     links     [{a:[x,y,z], b:[x,y,z], w}]        stairs (2-way)
     spawns    [{x,y,z,yaw}]
     bounds    {minX,maxX,minZ,maxZ}
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TERMINAL_MAP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const W = 0.3;       // wall thickness
  const H0 = 3.0;      // ground-floor ceiling
  const SLAB = 0.3;    // floor slab thickness
  const F1 = H0 + SLAB;   // 3.3 — the one upper level
  const H1 = 6.3;      // upper ceiling / building height
  const ROOF = 6.6;
  /* Freight container height. THREE stacked = F1 exactly, and each 1.1 step
     is under the engine's jump apex of JUMP_V^2/(2*GRAVITY) = 8.4^2/52 =
     1.357m. Step-up only assists while grounded, so it does not extend a
     jump: anything taller than ~1.35 is a wall, not a climb. An earlier
     draft used 1.65 and two stacks, which hit F1 on paper and was
     unclimbable in practice. */
  const CONT = 1.1;
  const CW = 2.4;      // container footprint

  // building envelope
  const BX0 = -38, BX1 = 30, BZ0 = -24, FZ = -9;
  // mezzanine occupies the back strip of the building
  const MZ = -15;

  const solids = [];
  const platforms = [];
  const links = [];
  const spawns = [];

  function box(x0, y0, z0, x1, y1, z1, mat) {
    solids.push({ min: [x0, y0, z0], max: [x1, y1, z1], mat: mat || 'wall' });
  }
  function plat(x0, z0, x1, z1, y) {
    platforms.push({ min: [x0, z0], max: [x1, z1], y: y });
  }
  function link(ax, ay, az, bx, by, bz, w) {
    links.push({ a: [ax, ay, az], b: [bx, by, bz], w: w || 1.6 });
  }

  /* A run of steps rising along +/-Z, the same shape mapspec.js uses for the
     house staircase. Escalators and airstairs are the only walkable climbs
     on this map; everything else upstairs is reached by jumping crates. */
  function steps(x0, x1, zBottom, zTop, yTop, mat) {
    const N = 9;
    for (let i = 0; i < N; i++) {
      const za = zBottom + (zTop - zBottom) * (i / N);
      const zb = zBottom + (zTop - zBottom) * ((i + 1) / N);
      box(x0, 0, Math.min(za, zb), x1, yTop * ((i + 1) / N), Math.max(za, zb), mat || 'stair');
    }
    /* The link's two nodes must land just BEYOND each end of the run, in the
       direction of travel — the bottom one out on the floor, the top one on
       the deck it arrives at. Offsetting both the same way puts the top node
       in mid-air and the nav graph silently loses the climb. */
    const cx = (x0 + x1) / 2;
    const dir = Math.sign(zTop - zBottom);
    link(cx, 0, zBottom - dir * 0.9, cx, yTop, zTop + dir * 0.9, 1.8);
  }

  /* =====================================================================
     TERMINAL BUILDING  x[-38,30]  z[-24,-9]
     ===================================================================== */
  // back wall + side walls, full height
  box(BX0, 0, BZ0, BX1, H1, BZ0 + W, 'terminal');
  box(BX0, 0, BZ0, BX0 + W, H1, FZ, 'terminal');
  box(BX1 - W, 0, BZ0, BX1, H1, FZ, 'terminal');

  /* ---- the frontage at z=-9: glass, with the map's crossings punched in it.
     Four ways to change lanes and no more — that is the whole map. */
  // Security front is solid masonry, not glass...
  box(-38, 0, FZ - W, -35, H1, FZ, 'terminal');
  // ...except the Kastovia office firing slit, y 1.2..2.2, onto the apron
  box(-35, 0, FZ - W, -32, 1.2, FZ, 'terminal');
  box(-35, 2.2, FZ - W, -32, H1, FZ, 'terminal');
  box(-32, 0, FZ - W, -31, H1, FZ, 'terminal');
  // CROSSING 1 — Security service door, x[-31,-29], header above
  box(-31, 2.4, FZ - W, -29, H1, FZ, 'terminal');
  box(-29, 0, FZ - W, -24, H1, FZ, 'terminal');
  // glass frontage, Shopping
  box(-24, 0, FZ - W, -10, H1, FZ, 'glass');
  // CROSSING 2 — shattered panel, x[-10,-6], the obvious push
  box(-10, 2.6, FZ - W, -6, H1, FZ, 'glass');
  // glass frontage, Shopping east + Lower Lounge
  box(-6, 0, FZ - W, 24, H1, FZ, 'glass');
  // CROSSING 4 — doorway to the maintenance shed, x[24,27]
  box(24, 2.4, FZ - W, 27, H1, FZ, 'glass');
  box(27, 0, FZ - W, BX1, H1, FZ, 'glass');

  /* ---- interior dividers. Security | Shopping | Lower Lounge ---- */
  // Security divider at x=-24, doorway z[-16,-14]
  box(-24, 0, BZ0, -24 + W, H0, -16, 'trim');
  box(-24, 0, -14, -24 + W, H0, FZ, 'trim');
  box(-24, 2.25, -16, -24 + W, H0, -14, 'trim');
  // Lower Lounge divider at x=+6, two doorways
  box(6, 0, BZ0, 6 + W, H0, -20, 'trim');
  box(6, 0, -18, 6 + W, H0, -13, 'trim');
  box(6, 0, -11, 6 + W, H0, FZ, 'trim');
  box(6, 2.25, -20, 6 + W, H0, -18, 'trim');
  box(6, 2.25, -13, 6 + W, H0, -11, 'trim');

  /* ---- Kastovia Airlines office, inside Security ---- */
  box(-36, 0, -15, -31, H0, -15 + W, 'trim');          // north wall
  box(-31 - W, 0, -15, -31, H0, -12.5, 'trim');        // east wall, upper part
  box(-31 - W, 0, -10.5, -31, H0, FZ, 'trim');         // east wall, lower part
  box(-31 - W, 2.25, -12.5, -31, H0, -10.5, 'trim');   // door header

  /* ---- Security: two scanner arches as waist cover ---- */
  for (const sx of [-35, -29]) {
    box(sx, 0, -21, sx + 0.45, 2.4, -18.6, 'metal');
    box(sx + 2.6, 0, -21, sx + 3.05, 2.4, -18.6, 'metal');
    box(sx, 2.4, -21, sx + 3.05, 2.9, -18.6, 'metal');
  }

  /* ---- Shopping: check-in counters, the room's spine of cover ---- */
  for (const [cx0, cx1] of [[-20, -15], [-13, -8], [-6, -2]])
    box(cx0, 0, -18, cx1, 1.15, -16, 'counter');

  /* ---- Lower Lounge: snack bar ---- */
  box(12, 0, -18, 20, 1.15, -16.5, 'counter');

  /* =====================================================================
     UPPER LEVEL — everything at F1
     ===================================================================== */
  // mezzanine slab along the back of the building
  box(-24, H0, BZ0, BX1, F1, MZ, 'slab');
  plat(-24, BZ0, BX1, MZ, F1);
  // catwalk spur out to the jet bridge mouth
  box(12, H0, MZ, 20, F1, FZ, 'slab');
  plat(12, MZ, 20, FZ, F1);
  // mezzanine edge railing, except where the escalators and catwalk land
  box(-24, F1, MZ - 0.14, -13, F1 + 1.0, MZ, 'rail');
  box(-10, F1, MZ - 0.14, 12, F1 + 1.0, MZ, 'rail');
  box(20, F1, MZ - 0.14, 22, F1 + 1.0, MZ, 'rail');
  box(26, F1, MZ - 0.14, BX1, F1 + 1.0, MZ, 'rail');
  // catwalk railings
  box(12, F1, MZ, 12.14, F1 + 1.0, FZ, 'rail');
  box(19.86, F1, MZ, 20, F1 + 1.0, FZ, 'rail');

  // escalators: Shopping (west) and Lower Lounge (east)
  steps(-13, -10, -10, MZ, F1);
  steps(22, 25, -10, MZ, F1);

  /* ---- Burger Town, on the mezzanine. The defensive perch. ---- */
  box(-18, F1, BZ0, -18 + W, H1, -17, 'trim');
  box(-8 - W, F1, BZ0, -8, H1, -17, 'trim');
  box(-18, F1, -17, -14, H1, -17 + W, 'trim');
  box(-10, F1, -17, -8, H1, -17 + W, 'trim');
  /* Counter and kitchen hug the west wall rather than crossing the room.
     Anything spanning the middle leaves a slot the 0.85m nav grid cannot
     resolve, and Burger Town silently becomes an island with a spawn in it —
     which is exactly what an earlier layout did. Keep x[-16,-8] clear. */
  box(-17.4, F1, -22, -16, F1 + 0.95, -18.5, 'counter');
  box(-17.4, F1, -23.6, -14, F1 + 1.9, -22.6, 'trim');   // kitchen line

  /* ---- Upper Lounge furniture ----------------------------------------
     Without this the mezzanine is 54m of empty slab: no cover, no sightline
     breaks, and whoever gets up here first holds the whole hall. Seating
     banks are crouch cover, the two kiosks are full cover that also cut the
     length of the deck into rooms. Keep the catwalk mouth (x 12..20) and
     both escalator landings clear. */
  for (const sx of [-6, 2, 22])
    box(sx, F1, -21, sx + 5, F1 + 0.95, -19.5, 'counter');
  for (const kx of [0, 24]) {
    box(kx, F1, BZ0 + W, kx + 4, F1 + 2.2, BZ0 + W + 2.0, 'trim');
    box(kx - 0.2, F1 + 2.2, BZ0 + W - 0.2, kx + 4.2, F1 + 2.5, BZ0 + W + 2.2, 'slab');
  }
  // planters break the run between Burger Town and the catwalk
  for (const px of [-7.2, 9.4])
    box(px, F1, -17.6, px + 1.4, F1 + 0.8, -16.2, 'trim');

  // building roof caps the interior
  box(BX0, H1, BZ0, BX1, ROOF, FZ, 'roof');

  /* =====================================================================
     THE PLANE  — parked on gear, belly at 2.1 so you can walk underneath
     ===================================================================== */
  const CZ0 = 9.8, CZ1 = 14.2;        // fuselage z extent
  const DH = 5.4;                     // door header height
  box(-12, 2.1, CZ0, -6, 6.5, CZ1, 'fuselage');            // tail section
  box(22, 2.1, CZ0, 26, 6.5, CZ1, 'fuselage');             // nose
  box(-6, 2.1, CZ0, 22, F1, CZ1, 'fuselage');              // belly under the cabin
  box(-6, 6.2, CZ0, 22, 6.5, CZ1, 'fuselage');             // cabin ceiling
  box(-6, F1, CZ0, -6 + W, 6.2, CZ1, 'fuselage');          // rear bulkhead
  box(22 - W, F1, CZ0, 22, 6.2, CZ1, 'fuselage');          // forward bulkhead
  plat(-6, CZ0, 22, CZ1, F1);                              // cabin floor

  /* Three exits, as on the real map. Each is a gap in a cabin wall with a
     header over it, so the opening reads as a door rather than a missing
     panel. Port side faces the terminal; starboard faces open apron. */
  // port wall — EXIT 2 over-wing at x[4,8], EXIT 1 forward at x[14,18]
  for (const [dx0, dx1] of [[-6, 4], [8, 14], [18, 22]])
    box(dx0, F1, CZ0, dx1, 6.5, CZ0 + W, 'fuselage');
  for (const [dx0, dx1] of [[4, 8], [14, 18]])
    box(dx0, DH, CZ0, dx1, 6.5, CZ0 + W, 'fuselage');
  /* starboard wall — EXIT 3 rear airstairs at x[-6,-3], plus a second
     over-wing door at x[4,8]. Without it the starboard wing is an island:
     nothing else on the upper level touches it. */
  for (const [dx0, dx1] of [[-3, 4], [8, 22]])
    box(dx0, F1, CZ1 - W, dx1, 6.5, CZ1, 'fuselage');
  for (const [dx0, dx1] of [[-6, -3], [4, 8]])
    box(dx0, DH, CZ1 - W, dx1, 6.5, CZ1, 'fuselage');

  // landing gear
  box(-2.6, 0, 11.4, -1.4, 2.1, 12.6, 'metal');
  box(17.4, 0, 11.4, 18.6, 2.1, 12.6, 'metal');
  // tailfin
  box(-14, 6.5, 11, -10, 11, 13, 'fuselage');

  // wings, walkable at F1 and flush with the fuselage
  box(2, F1 - 0.25, 4, 10, F1, CZ0, 'wing');
  plat(2, 4, 10, CZ0, F1);
  box(2, F1 - 0.25, CZ1, 10, F1, 20, 'wing');
  plat(2, CZ1, 10, 20, F1);

  // EXIT 3 — rear airstairs, starboard side, down to the apron
  steps(-6, -3, 18, 14, F1, 'stair');

  /* =====================================================================
     JET BRIDGE  — CROSSING 3, the signature chokepoint. Entirely upstairs
     and entirely exposed through the frontage glass on the way across.
     ===================================================================== */
  box(14, H0, FZ, 18, F1, CZ0, 'bridge');
  plat(14, FZ, 18, CZ0, F1);
  box(14, F1, FZ, 14 + W, 4.4, CZ0, 'bridge');
  box(18 - W, F1, FZ, 18, 4.4, CZ0, 'bridge');
  box(15.4, 0, -2, 16.6, H0, -0.8, 'metal');       // support column

  /* =====================================================================
     MAINTENANCE SHED  — CROSSING 4. Roof is a platform at F1.
     ===================================================================== */
  box(24, 0, -6, 24 + W, F1, 1, 'terminal');
  box(32 - W, 0, -6, 32, F1, 1, 'terminal');
  box(24, 0, -6, 26, F1, -6 + W, 'terminal');
  box(28, 0, -6, 32, F1, -6 + W, 'terminal');
  box(24, 0, 1 - W, 26, F1, 1, 'terminal');
  box(28, 0, 1 - W, 32, F1, 1, 'terminal');
  box(24, H0, -6, 32, F1, 1, 'slab');
  plat(24, -6, 32, 1, F1);

  /* =====================================================================
     FREIGHT CONTAINERS — the apron's only cover, and the reason it is not
     a shooting gallery. Stacked pairs top out at F1 and join the upper
     lane; singles are jump-up cover only, like Nuketown's crates.
     ===================================================================== */
  const containers = [
    // tail end of the apron
    [-30, 2, 3], [-27.4, 2, 2], [-24.8, 2, 1],     // a climb up to F1
    [-22, 16, 2], [-18, 4, 1], [-34, 12, 1], [-16, -1, 2],
    // mid apron — these two break the long sightline down the fuselage
    [-8, 6.5, 3], [-8, 3.9, 2], [-8, 1.3, 1],      // a climb up to F1
    [2, 21, 2], [10, 0, 2],
    // nose end
    [28, 6, 3], [30.6, 6, 2], [33.2, 6, 1],        // a climb up to F1
    [31, 16, 1], [24, 20, 2],
    // against the maintenance shed. The full stack butts onto the roof at
    // x=32, and the two below it are the climb — without them the roof and
    // the stack form an island that nothing on the map can reach.
    [32, -5.5, 3], [32, -2.9, 2], [32, -0.3, 1]
  ];
  for (const [x0, z0, stack] of containers) {
    const top = CONT * stack;
    box(x0, 0, z0, x0 + CW, top, z0 + CW, 'container');
    if (stack === 3) plat(x0, z0, x0 + CW, z0 + CW, top);
  }

  /* buildNav models drops but never jumps, so a stack a player can climb is
     still invisible to a bot. Each of the three freight climbs above gets an
     explicit link, or the container tops become a human-only lane. */
  link(-29, 0, 1.4, -28.8, F1, 3.2, 1.6);
  link(-6.9, 0, 0.7, -6.9, F1, 7.7, 1.6);
  link(34.4, 0, 7.2, 29.2, F1, 7.2, 1.6);
  link(33.2, 0, 0.9, 33.2, F1, -4.3, 1.6);   // up to the shed roof

  /* =====================================================================
     PERIMETER
     ===================================================================== */
  const B = { minX: -40, maxX: 40, minZ: -26, maxZ: 26 };
  const PH = 6.0;
  solids.push({ min: [B.minX - 0.6, 0, B.minZ - 0.6], max: [B.minX, PH, B.maxZ + 0.6], mat: 'perimeter' });
  solids.push({ min: [B.maxX, 0, B.minZ - 0.6], max: [B.maxX + 0.6, PH, B.maxZ + 0.6], mat: 'perimeter' });
  solids.push({ min: [B.minX, 0, B.minZ - 0.6], max: [B.maxX, PH, B.minZ], mat: 'perimeter' });
  solids.push({ min: [B.minX, 0, B.maxZ], max: [B.maxX, PH, B.maxZ + 0.6], mat: 'perimeter' });

  /* =====================================================================
     SPAWNS — spread so no cluster is more than ~12m from cover. yaw is
     radians, 0 = +X, and every point faces roughly toward map centre.
     ===================================================================== */
  const spawnPts = [
    // Security (west interior) — no mezzanine overhead, single height
    [-36, 0, -21, 0.3], [-27, 0, -13, 0.2], [-27, 0, -21, 0.4],
    // Lower Lounge (east interior)
    [12, 0, -21, 2.9], [20, 0, -12, 3.0], [28, 0, -20, 3.1],
    // Shopping, under the mezzanine
    [-20, 0, -21, 1.0], [2, 0, -20, 2.2],
    // upstairs: Burger Town and the east mezzanine
    [-11, F1, -20, 0.8], [26, F1, -19, 2.6],
    // apron, tail end
    [-34, 0, 6, 0.0], [-26, 0, 20, -0.4],
    // apron, nose end
    [36, 0, 14, 3.14], [30, 0, 22, -2.7]
  ];
  for (const [x, y, z, yaw] of spawnPts) spawns.push({ x: x, y: y, z: z, yaw: yaw });

  return {
    solids: solids,
    platforms: platforms,
    links: links,
    spawns: spawns,
    bounds: B,
    levels: [0, F1],
    consts: { W: W, H0: H0, SLAB: SLAB, F1: F1, H1: H1, ROOF: ROOF, CONT: CONT, CW: CW },
    actor: { radius: 0.38, height: 1.8, eye: 1.62, step: 0.55 },
    /* Renderer extension. The contract above stays renderer-free so this
       file is side-effect free under `require`; the drawing lives in
       src/25-terminal-world.js and is only ever reached from the browser
       build, where every part shares one global scope. */
    render: {
      chunkCuts: [-24, -8, 8, 24],
      buildGeometry: function (context) { buildTerminalGeometry(context); },
      buildDecorations: function () { buildTerminalDecorations(); }
    }
  };
});
