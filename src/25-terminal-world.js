/* =====================================================================
   PASTEL NUKETOWN — TERMINAL: the map made visible
   Same deal as the Nuketown dressing in 20-world.js. Everything static
   lands in the shared GeoBuilder, collision keeps using the untouched
   AABBs from terminal-mapspec.js, and the curved things (fuselage, jet
   bridge, escalator handrails) are silhouette only.
   ===================================================================== */

/* Terminal's own palette. Nuketown is butter/coral/sky domestic; an airport
   wants cooler concrete with two hot accents doing all the signage work, or
   the whole map reads as one grey mass at distance. */
const TPAL = {
  tarmac:    0xd9d2e2,
  tarmacDeep:0xc9c1d6,
  paint:     0xfff3c4,
  paintRed:  0xffb0b8,
  hall:      0xf4eef8,
  hallTrim:  0xe4dcf0,
  mullion:   0xbfc9e8,
  pane:      0xd8f2ff,
  slab:      0xf3e7dd,
  counter:   0xffd9e6,
  steel:     0xd7cfe4,
  crateA:    0xfff2e0,
  crateB:    0xffc9d6,
  crateC:    0xc8f2dc,
  livery:    0xff9ab0,
  liveryB:   0x9fc4f5,
  hull:      0xfffaf3,
  scrub:     0xd8ecc8,
  sign:      0xffd6a8
};

function buildTerminalGeometry(ctx) {
  const B = ctx.builder, C = ctx.color, Cx = ctx.colorScale;
  const H = ctx.helpers;
  const MAPT = ctx.map;
  const F1 = MAPT.consts.F1;

  /* ================= GROUND =================
     Three slabs that TILE rather than overlap, and the outer one sits 35cm
     down. Nuketown gets away with a 3cm step between its ground and its pad
     because both are near-identical creams; here the scrub is green and the
     apron is lavender, so the same 3cm reads as violent z-fighting across
     the whole floor at eye level. Separate them properly and never let two
     ground planes share a footprint. */
  B.box([-600, -1.2, -600], [600, -0.35, 600], C(TPAL.scrub),
        { top: Cx(TPAL.scrub, 1.03), noEdge: true });
  // apron, from the frontage out to the fence
  B.box([-41, -0.35, -9], [41, 0.0, 27], C(TPAL.tarmacDeep),
        { top: C(TPAL.tarmac), noEdge: true });
  // terminal floor — its own surface, so the interior reads as indoors
  B.box([-41, -0.35, -27], [41, 0.0, -9], C(TPAL.tarmacDeep),
        { top: C(TPAL.hall), noEdge: true });
  // a terrazzo band down the middle of the hall, following the lane
  for (let x = -37; x < 30; x += 3.4)
    B.box([x, 0.001, -14.2], [x + 2.2, 0.005, -10.6], Cx(TPAL.hall, 0.97), { noEdge: true });

  /* Apron markings. These are the only thing telling you which way the map
     runs once you are out in the open, so they follow the lanes rather than
     decorating: the lead-in line points at the plane's nose gear. */
  for (let x = -38; x < 40; x += 5.2)                       // taxiway dashes
    B.box([x, 0.001, 23.4], [x + 2.8, 0.006, 23.9], C(TPAL.paint), { noEdge: true });
  B.box([-2.2, 0.001, 2.0], [-1.8, 0.006, 22.0], C(TPAL.paint), { noEdge: true });
  B.box([-6.0, 0.001, 1.6], [2.0, 0.006, 2.0], C(TPAL.paint), { noEdge: true });
  // stand box around the parked aircraft
  for (const [a, b] of [[[-13, 8.4], [27, 8.9]], [[-13, 15.1], [27, 15.6]]])
    B.box([a[0], 0.001, a[1]], [b[0], 0.006, b[1]], C(TPAL.paintRed), { noEdge: true });
  // service road hugging the frontage
  B.box([-40, 0.001, -7.4], [40, 0.006, -7.0], C(TPAL.paintRed), { noEdge: true });

  /* ================= SOLIDS FROM THE MAP SPEC ================= */
  for (const s of MAPT.solids) {
    const [x0, y0, z0] = s.min, [x1, y1, z1] = s.max;
    switch (s.mat) {
      case 'terminal':
        B.box(s.min, s.max, C(TPAL.hall), { top: Cx(TPAL.hall, 1.04) });
        break;

      /* Glass is faked. The renderer keeps the whole world in one opaque
         vertex-coloured mesh, and real transparency costs another draw call
         on a page that also has to run on a phone. A pale pane plus heavy
         mullions reads as glazing from every angle that matters, and the
         actual holes in the frontage are where the crossings are. */
      case 'glass': {
        B.box(s.min, s.max, C(TPAL.pane), { noEdge: true });
        const len = x1 - x0;
        const n = Math.max(2, Math.round(len / 2.6));
        for (let i = 0; i <= n; i++) {
          const mx = lerp(x0, x1, i / n);
          B.box([mx - 0.09, y0, z0 - 0.05], [mx + 0.09, y1, z1 + 0.05], C(TPAL.mullion));
        }
        for (const yy of [y0 + (y1 - y0) * 0.5, y1 - 0.16])
          B.box([x0, yy, z0 - 0.05], [x1, yy + 0.16, z1 + 0.05], C(TPAL.mullion));
        break;
      }

      case 'trim':
        B.box(s.min, s.max, C(TPAL.hallTrim));
        break;
      case 'slab':
        B.box(s.min, s.max, C(TPAL.slab), { top: C(0xfdf3ea) });
        break;
      case 'stair': {
        B.box(s.min, s.max, C(TPAL.slab), { top: C(0xfaece0) });
        // escalator comb plate — a warm band on each tread nose
        B.box([x0, y1 - 0.04, z0], [x1, y1, z0 + 0.12], C(TPAL.sign), { noEdge: true });
        break;
      }
      case 'rail':
        B.box(s.min, s.max, C(TPAL.steel));
        B.box([x0 - 0.05, y1 - 0.1, z0 - 0.05], [x1 + 0.05, y1, z1 + 0.05], C(0xfff6ec));
        break;
      case 'counter':
        H.bevelBox(B, s.min, s.max, C(TPAL.counter), 0.08, { top: C(0xfff1f6) });
        break;
      case 'metal':
        B.box(s.min, s.max, C(TPAL.steel));
        break;
      case 'roof':
        B.box(s.min, s.max, C(TPAL.hallTrim), { top: Cx(TPAL.hallTrim, 1.03) });
        break;

      /* Freight containers. Three colourways cycled by position so a stack
         reads as separate boxes rather than one tall slab — the stacks are
         climbable and the player needs to see the risers. */
      case 'container': {
        const tint = [TPAL.crateA, TPAL.crateB, TPAL.crateC][
          Math.abs(Math.round(x0 * 3 + z0 * 7)) % 3];
        const h = MAPT.consts.CONT;
        for (let y = y0; y < y1 - 0.01; y += h) {
          const yt = Math.min(y + h, y1);
          H.bevelBox(B, [x0, y, z0], [x1, yt, z1], C(tint), 0.09,
                     { top: Cx(tint, 1.05) });
          // corner castings + a strap, so the risers are legible from below
          B.box([x0 - 0.03, yt - 0.14, z0 - 0.03], [x1 + 0.03, yt, z1 + 0.03],
                C(TPAL.steel), { noEdge: true });
          B.box([lerp(x0, x1, 0.44), y, z0 - 0.04], [lerp(x0, x1, 0.56), yt, z1 + 0.04],
                Cx(tint, 0.9), { noEdge: true });
        }
        break;
      }

      case 'wing': case 'fuselage': case 'bridge':
        break;                                   // bespoke meshes below

      case 'perimeter': {
        B.box(s.min, s.max, C(TPAL.tarmacDeep), { top: C(0xe9e2f2) });
        // chain-link posts, so 80m of fence is not one bare slab
        const alongX = (x1 - x0) > (z1 - z0);
        const len = alongX ? x1 - x0 : z1 - z0;
        const n = Math.max(2, Math.round(len / 4.2));
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          if (alongX) B.box([lerp(x0, x1, t) - 0.11, 0, z0 - 0.06],
                            [lerp(x0, x1, t) + 0.11, y1 + 0.3, z1 + 0.06], C(TPAL.steel));
          else        B.box([x0 - 0.06, 0, lerp(z0, z1, t) - 0.11],
                            [x1 + 0.06, y1 + 0.3, lerp(z0, z1, t) + 0.11], C(TPAL.steel));
        }
        break;
      }

      default:
        B.box(s.min, s.max, C(TPAL.hallTrim));
    }
  }

  /* ================= THE PLANE =================
     Collision stays the plain AABBs in the spec; this is silhouette only.
     The fuselage is an 14-gon prism swept along X, which is the same trick
     the Nuketown bus uses for its roof curve. */
  const CZ = 12.0, CR = 2.2;                        // centreline z, radius
  const cy = 4.3;                                   // fuselage axis height
  /* Port and starboard are mirror images, so everything below is given as a
     pair of SIGNED offsets off the centreline and sorted on the way in. */
  const zbox = (x0, x1, y0, y1, oa, ob, color, opts) =>
    B.box([x0, y0, CZ + Math.min(oa, ob)], [x1, y1, CZ + Math.max(oa, ob)], color, opts);
  H.ngonPrism(B, 'x', -12, 24, cy, CZ, CR, 14, C(TPAL.hull), 0.22);
  // nose cone and tail cone, tapered by two shorter prisms
  H.ngonPrism(B, 'x', 24, 26.4, cy, CZ, CR * 0.62, 14, C(TPAL.hull), 0.22);
  H.ngonPrism(B, 'x', -14.2, -12, cy + 0.5, CZ, CR * 0.55, 14, C(TPAL.hull), 0.22);
  /* Cheatline: the one stripe that makes it read as an airliner. A SKIN on
     each flank, never one box across the section — the cabin is walkable at
     F1 and a full-width stripe lands as an opaque deck 0.9m above the floor
     the player is standing on. From inside, that stripe was the floor, and
     everything under it (your feet, pickups, the bottom half of every body)
     was hidden behind it. The outer edges are where they were, so nothing
     about the silhouette from outside changes. */
  for (const dir of [-1, 1]) {
    zbox(-13, 25, cy - 0.55, cy - 0.1, dir * (CR - 0.15), dir * (CR + 0.04),
         C(TPAL.livery), { noEdge: true });
    zbox(-13, 25, cy - 1.0, cy - 0.62, dir * (CR - 0.30), dir * (CR + 0.03),
         C(TPAL.liveryB), { noEdge: true });
  }
  // cabin windows
  for (let x = -8; x < 22; x += 1.9)
    for (const zz of [CZ - CR - 0.05, CZ + CR - 0.09])
      B.box([x, cy + 0.42, zz], [x + 0.62, cy + 0.86, zz + 0.14], C(TPAL.pane), { noEdge: true });
  // flight deck glass
  B.box([25.0, cy + 0.5, CZ - 1.25], [26.1, cy + 1.0, CZ + 1.25], C(TPAL.pane));

  // doors, drawn where the spec punched holes so the openings read as doors
  for (const [dx0, dx1, zz] of [[14, 18, CZ - CR], [4, 8, CZ - CR], [4, 8, CZ + CR - 0.1],
                                [-6, -3, CZ + CR - 0.1]])
    B.box([dx0 - 0.08, F1 - 0.05, zz - 0.06], [dx1 + 0.08, 5.5, zz + 0.16],
          C(TPAL.hallTrim));

  /* ---- cabin liner ----------------------------------------------------
     The hull above is a one-sided shell with no inner faces, and the spec's
     cabin boxes are collision-only — the 'fuselage' case up top draws
     nothing — so without this the cabin renders as open air: you stand on
     nothing at F1 and see the whole map straight through the aircraft,
     while everyone outside is looking at a solid plane. The cabin is a
     walkable platform with three exits and it is where the jet bridge
     lands, so it has to be an actual room.

     None of it can sit on the spec's AABB. That is 2.2 half-width at every
     height and the hull is a 14-gon of the same radius, so the hull is down
     to 1.84 by the time you reach the door headers and a wall out there
     punches straight through the curve. LZ comes off the camera instead:
     collision stops a player 0.38 short of the AABB, so an eye never gets
     past 1.52 off the centreline, and 1.75 keeps the wall clear of the view
     while staying inside the hull. */
  const LI = 1.70, LO = 1.78;                       // liner inner face, outer envelope
  const LCY = 5.35;                                 // ceiling underside
  /* Floor pan, plus a sill at each exit closing the strip out to whatever
     the door lands on — wing root, jet bridge deck, airstairs, all at
     |z - CZ| = 2.0. Stop there and not at the AABB: the wing tops are also
     at F1, and an overlap would be two coplanar faces fighting. */
  zbox(-6, 22, F1 - 0.06, F1, -1.9, 1.9, C(TPAL.slab), { top: C(0xfdf3ea) });
  for (const [dx0, dx1, dir] of [[4, 8, -1], [14, 18, -1], [4, 8, 1], [-6, -3, 1]])
    zbox(dx0, dx1, F1 - 0.06, F1, dir * 1.9, dir * 2.0, C(TPAL.slab), { top: C(0xfdf3ea) });
  /* Side walls carry the openings the spec punched, and the ceiling doubles
     as their header, so a gap reads as a door from the inside too. */
  for (const [dir, runs, doors] of [
    [-1, [[-6, 4], [8, 14], [18, 22]], [[4, 8], [14, 18]]],
    [1,  [[-3, 4], [8, 22]],           [[-6, -3], [4, 8]]]
  ]) {
    for (const [wx0, wx1] of runs)
      zbox(wx0, wx1, F1, LCY, dir * LI, dir * LO, C(TPAL.hall));
    // and the windows again on the inner face: the outer ones are set in the
    // hull, which is now behind this wall. Proud of it, or the two faces are
    // coplanar and fight.
    for (let x = -5.4; x < 21; x += 1.9)
      if (!doors.some(d => x + 0.62 > d[0] && x < d[1]))
        zbox(x, x + 0.62, cy + 0.42, cy + 0.86, dir * (LI - 0.02), dir * LI,
             C(TPAL.pane), { noEdge: true });
  }
  for (const bx of [-6, 21.9])                      // aft and forward bulkheads
    zbox(bx, bx + 0.1, F1, LCY, -LI, LI, C(TPAL.hallTrim));
  /* The ceiling runs out to the walls' outer face, or the seam between them
     is a slot you can see the sky through — the hull over it is culled from
     in here. LCY is as high as that full width fits: the 14-gon has closed
     to 1.78 by y = 5.5, and the crown is not a place to find that out. */
  zbox(-6, 22, LCY, LCY + 0.08, -LO, LO, C(TPAL.hall));

  /* wings, raked toward the tip. solid() indexes its eight corners by bit —
     bit0 = x, bit1 = y, bit2 = z — so the near-z plane must be 0..3 and the
     far-z plane 4..7 or the faces wind inward and the wing renders black.
     That means root and tip swap roles between the two sides. */
  for (const dir of [-1, 1]) {
    const zr = CZ + dir * (CR - 0.2), zt = CZ + dir * 8.6;
    const near = dir < 0 ? [zt, 4.6, 9.2] : [zr, 2, 10];
    const far  = dir < 0 ? [zr, 2, 10]    : [zt, 4.6, 9.2];
    const [nz, nx0, nx1] = near, [fz, fx0, fx1] = far;
    B.solid([[nx0, F1 - 0.28, nz], [nx1, F1 - 0.28, nz], [nx0, F1, nz], [nx1, F1, nz],
             [fx0, F1 - 0.28, fz], [fx1, F1 - 0.28, fz], [fx0, F1, fz], [fx1, F1, fz]],
            C(TPAL.hull));
    // engine nacelle slung under the wing
    H.ngonPrism(B, 'x', 3.4, 8.2, F1 - 1.35, CZ + dir * 5.0, 1.15, 10, C(TPAL.hull), 0.3);
    H.ngonPrism(B, 'x', 3.1, 3.6, F1 - 1.35, CZ + dir * 5.0, 1.22, 10, C(TPAL.livery), 0.3);
    // winglet
    B.box([8.9, F1, zt - 0.22], [9.9, F1 + 1.5, zt + 0.22], C(TPAL.livery));
  }
  // tailfin (swept, tapering) + stabilisers
  B.solid([[-13.6, 6.4, 11.7], [-10.2, 6.4, 11.7], [-12.4, 11.0, 11.85], [-10.4, 11.0, 11.85],
           [-13.6, 6.4, 12.3], [-10.2, 6.4, 12.3], [-12.4, 11.0, 12.15], [-10.4, 11.0, 12.15]],
          C(TPAL.livery));
  for (const dir of [-1, 1])
    B.box([-13.4, 6.1, CZ + dir * 0.9], [-10.6, 6.35, CZ + dir * 4.4], C(TPAL.hull));

  // gear: struts and paired wheels
  for (const gx of [-2.0, 18.0]) {
    B.box([gx - 0.22, 0.5, CZ - 0.22], [gx + 0.22, 2.4, CZ + 0.22], C(TPAL.steel));
    for (const dir of [-1, 1])
      H.ngonPrism(B, 'x', gx - 0.42, gx + 0.42, 0.52, CZ + dir * 0.62, 0.52, 10,
                  C(0x8b7f9e), 0.15);
  }

  /* ================= JET BRIDGE ================= */
  /* The deck first. The spec's 'bridge' boxes are collision-only like the
     plane's, so CROSSING 3 — the map's signature chokepoint — was a walkway
     you crossed on nothing but the ribs, with the hall floor 3.3m below you
     through the gap. It runs out to the fuselage rather than stopping at the
     spec's z = 9.8, so the step into the cabin lands on the plane's door
     sill instead of a slot. */
  B.box([14, F1 - 0.3, -9], [18, F1, CZ - 2.0], C(TPAL.slab), { top: C(0xfdf3ea) });
  // a ribbed tube on the deck the spec already made walkable
  for (let z = -8.6; z < 9.6; z += 1.5)
    H.arcBand(B, 'z', z, z + 0.36, 16.0, F1 + 0.05, 1.98, 2.16, 0, Math.PI, 10,
              C(TPAL.hallTrim), true);
  H.arcBand(B, 'z', -9, 9.8, 16.0, F1 + 0.05, 1.92, 2.02, 0, Math.PI, 12,
            C(TPAL.hall), true);
  /* The column itself is the spec's 'metal' solid, drawn with everything
     else up top; the second one that used to stand here shared both of its
     x planes and the pair fought all the way up. This is just the capital,
     tucked under the deck it carries so no face is coplanar with either. */
  B.box([15.0, F1 - 0.62, -2.4], [17.0, F1 - 0.25, -0.4], C(TPAL.hallTrim));

  /* ================= INTERIOR DRESSING ================= */
  // gate signage hanging off the mezzanine edge — the hall's only hot colour
  for (const [sx, w] of [[-20, 3.2], [-4, 3.2], [14, 3.2], [25, 2.6]])
    B.box([sx, F1 + 1.15, -15.4], [sx + w, F1 + 2.0, -15.15], C(TPAL.sign));
  // Burger Town's checkered floor, the one place the palette goes loud
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 8; j++)
      if ((i + j) % 2 === 0)
        B.box([-17.6 + i * 0.8, F1 + 0.005, -23.6 + j * 0.8],
              [-16.8 + i * 0.8, F1 + 0.02, -22.8 + j * 0.8], C(TPAL.counter), { noEdge: true });
  // baggage carts parked along the frontage, Terminal's answer to mannequins
  for (const [cx, cz] of [[-21, -11.5], [-3, -11.5], [9, -12.5], [21, -11.5], [-13, -12.5]]) {
    B.box([cx, 0.42, cz], [cx + 2.6, 1.05, cz + 1.3], C(TPAL.crateA), { top: C(0xfff8ee) });
    B.box([cx + 0.1, 0.28, cz + 0.1], [cx + 2.5, 0.44, cz + 1.2], C(TPAL.steel));
    for (const wx of [cx + 0.35, cx + 2.15])
      for (const wz of [cz + 0.22, cz + 1.05])
        H.ngonPrism(B, 'x', wx - 0.09, wx + 0.09, 0.26, wz, 0.26, 8, C(0x8b7f9e), 0.2);
    B.box([cx + 2.5, 0.44, cz + 0.5], [cx + 3.1, 1.25, cz + 0.8], C(TPAL.steel));  // tow bar
  }
}

function buildTerminalDecorations() {
  /* Same contract as Nuketown's: the sky is parented to WORLD.group so a
     map swap disposes it with everything else. A map that forgets this
     renders against an empty horizon. */
  WORLD.sky = buildSky(WORLD.group);
  buildDustMotes();
}
