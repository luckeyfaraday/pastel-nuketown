/* =====================================================================
   PASTEL NUKETOWN — world: the map made visible
   Everything static lands in ONE vertex-coloured mesh + ONE line mesh,
   so the whole town is two draw calls.
   ===================================================================== */

const WORLD = { group: null, mannequins: [], props: [], sky: null, contacts: null };
const STREET_MOTION = {
  wires: null, wireBase: null,
  flags: null, flagBase: null, flagPhase: null
};

/* ---- small geometry helpers layered on GeoBuilder ---- */
function ngonPrism(B, axis, c0, c1, cu, cv, r, sides, color, rot) {
  // extrude an n-gon along `axis` ('x'|'y'|'z') from c0 to c1, centred (cu,cv)
  const pts = [];
  rot = rot || 0;
  for (let i = 0; i < sides; i++) {
    const a = rot + i / sides * TAU;
    pts.push([cu + Math.cos(a) * r, cv + Math.sin(a) * r]);
  }
  const P = (t, u, v) => axis === 'y' ? [u, t, v] : (axis === 'x' ? [t, u, v] : [u, v, t]);
  for (let i = 0; i < sides; i++) {
    const p = pts[i], q = pts[(i + 1) % sides];
    B.quad(P(c0, p[0], p[1]), P(c0, q[0], q[1]), P(c1, q[0], q[1]), P(c1, p[0], p[1]), color, true);
    B.edge(P(c0, p[0], p[1]), P(c0, q[0], q[1]));
    B.edge(P(c1, p[0], p[1]), P(c1, q[0], q[1]));
  }
  for (let i = 1; i < sides - 1; i++) {
    B.tri(P(c1, pts[0][0], pts[0][1]), P(c1, pts[i][0], pts[i][1]), P(c1, pts[i + 1][0], pts[i + 1][1]), color, true);
    B.tri(P(c0, pts[0][0], pts[0][1]), P(c0, pts[i + 1][0], pts[i + 1][1]), P(c0, pts[i][0], pts[i][1]), color, true);
  }
}
/* =====================================================================
   CURVE HELPERS
   Everything here was a rectangle. A cartoon style can be low-poly, but it
   needs a few memorable contours or it reads as economical rather than
   intentional — so these buy silhouettes on the hero props only. Triangles
   are free in this renderer (it is fill-rate bound), and collision keeps
   using the untouched AABBs from mapspec.
   ===================================================================== */

/* An annular arc swept along one axis: wheel arches, awning scallops,
   arched door heads. `axis` is the extrusion direction. */
function arcBand(B, axis, t0, t1, cu, cv, rIn, rOut, a0, a1, segs, color, noEdge) {
  const P = (t, u, v) => axis === 'y' ? [u, t, v] : (axis === 'x' ? [t, u, v] : [u, v, t]);
  /* The (t,u,v) -> (x,y,z) mapping has opposite handedness for the 'x' sweep
     than for 'y'/'z', so the same vertex order yields inward normals there
     and the band renders black. Reversing the sweep flips every quad back. */
  if (axis === 'x') { const tmp = t0; t0 = t1; t1 = tmp; }
  for (let i = 0; i < segs; i++) {
    const s0 = a0 + (a1 - a0) * (i / segs), s1 = a0 + (a1 - a0) * ((i + 1) / segs);
    const c0 = Math.cos(s0), n0 = Math.sin(s0), c1 = Math.cos(s1), n1 = Math.sin(s1);
    const oA = [cu + c0 * rOut, cv + n0 * rOut], oB = [cu + c1 * rOut, cv + n1 * rOut];
    const iA = [cu + c0 * rIn,  cv + n0 * rIn],  iB = [cu + c1 * rIn,  cv + n1 * rIn];
    // outer rim
    B.quad(P(t0, oA[0], oA[1]), P(t0, oB[0], oB[1]), P(t1, oB[0], oB[1]), P(t1, oA[0], oA[1]), color, true);
    // the two flat faces
    B.quad(P(t1, oA[0], oA[1]), P(t1, oB[0], oB[1]), P(t1, iB[0], iB[1]), P(t1, iA[0], iA[1]), color, true);
    B.quad(P(t0, iA[0], iA[1]), P(t0, iB[0], iB[1]), P(t0, oB[0], oB[1]), P(t0, oA[0], oA[1]), color, true);
    /* Rim ink-lines outline the arc's END CAPS. On a fender that reads as
       the fender; on a swept body panel it reads as a floating ring, so
       callers that blend into a surface pass noEdge. */
    if (!noEdge) {
      B.edge(P(t0, oA[0], oA[1]), P(t0, oB[0], oB[1]));
      B.edge(P(t1, oA[0], oA[1]), P(t1, oB[0], oB[1]));
    }
  }
}

/* A squat dome — bulbous caps on fence posts and gate piers. */
function domeY(B, cx, cy, cz, r, h, segs, rings, color) {
  for (let j = 0; j < rings; j++) {
    const p0 = (j / rings) * (Math.PI / 2), p1 = ((j + 1) / rings) * (Math.PI / 2);
    const r0 = Math.cos(p0) * r, r1 = Math.cos(p1) * r;
    const y0 = cy + Math.sin(p0) * h, y1 = cy + Math.sin(p1) * h;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * TAU, a1 = ((i + 1) / segs) * TAU;
      const A = [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0];
      const Bp = [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0];
      const Cp = [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1];
      const D = [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1];
      if (r1 < 1e-4) B.tri(A, Bp, Cp, color, true);
      else B.quad(A, Bp, Cp, D, color, true);
    }
  }
}

/* A chamfered box: two interpenetrating boxes, one inset horizontally and
   one vertically. Cheaper than real bevel geometry and the notched
   silhouette reads the same at this scale. */
function bevelBox(B, min, max, color, c, opt) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  B.box([x0 + c, y0, z0 + c], [x1 - c, y1, z1 - c], color, opt);
  B.box([x0, y0 + c, z0], [x1, y1 - c, z1], color, opt);
}

/* A row of half-discs hanging off an edge — awning/canopy scallops. */
function scallopEdge(B, axis, t0, t1, along0, along1, y, r, color) {
  const n = Math.max(2, Math.round(Math.abs(along1 - along0) / (r * 2)));
  for (let i = 0; i < n; i++) {
    const cu = along0 + (along1 - along0) * ((i + 0.5) / n);
    if (axis === 'z') arcBand(B, 'z', t0, t1, cu, y, 0, r, Math.PI, TAU, 6, color);
    else              arcBand(B, 'x', t0, t1, y, cu, 0, r, Math.PI, TAU, 6, color);
  }
}

/* gable roof: a triangular prism ridged along X */
function gable(B, x0, x1, z0, z1, yBase, yPeak, color, eave) {
  eave = eave || 0.55;
  const a0 = z0 - eave, a1 = z1 + eave, b0 = x0 - eave, b1 = x1 + eave;
  const zm = (a0 + a1) / 2;
  const L = [b0, yBase, a0], R = [b1, yBase, a0], L2 = [b0, yBase, a1], R2 = [b1, yBase, a1];
  const PL = [b0, yPeak, zm], PR = [b1, yPeak, zm];
  /* Winding matters: GeoBuilder takes the face normal from (b-a)x(d-a), so
     these must be ordered outward or the roof ends up lit from underneath. */
  B.quad(PL, PR, R, L, color);            // -Z slope
  B.quad(PR, PL, L2, R2, color);          // +Z slope
  B.tri(L, L2, PL, color);                // gable ends
  B.tri(R2, R, PR, color);
  B.quad(L, R, R2, L2, color, true);      // underside
}
/* a chunky window: recessed pane + proud frame, punched on a wall face */
function windowPanel(B, o) {
  const t = 0.09, f = 0.14;                       // proud depth, frame width
  const { axis, at, dir, u0, u1, v0, v1 } = o;    // u = horizontal, v = vertical
  const frame = C(PAL.cream), glass = C(PAL.glass);
  const mk = (a0, a1, b0, b1, d0, d1, col) => {
    if (axis === 'z') B.box([a0, b0, d0], [a1, b1, d1], col);
    else B.box([d0, b0, a0], [d1, b1, a1], col);
  };
  const d0 = dir > 0 ? at : at - t, d1 = dir > 0 ? at + t : at;
  mk(u0 - f, u1 + f, v0 - f, v0, d0, d1, frame);        // sill
  mk(u0 - f, u1 + f, v1, v1 + f, d0, d1, frame);        // head
  mk(u0 - f, u0, v0, v1, d0, d1, frame);                // jambs
  mk(u1, u1 + f, v0, v1, d0, d1, frame);
  const g0 = dir > 0 ? at + 0.02 : at - 0.06, g1 = dir > 0 ? at + 0.06 : at - 0.02;
  mk(u0, u1, v0, v1, g0, g1, glass);                    // pane
  mk(u0, u1, (v0 + v1) / 2 - 0.04, (v0 + v1) / 2 + 0.04, d0, d1, frame);  // mullion
}

/* ---------------------------------------------------------------- */
function buildWorld() {
  const B = new GeoBuilder();
  const grp = new THREE.Group();

  /* ================= GROUND ================= */
  const sand = C(PAL.sand), sandD = C(PAL.sandDeep);
  // far enough that its edge is always past fog-far, so the horizon is clean
  B.box([-600, -1.2, -600], [600, -0.03, 600], sandD, { top: sand, noEdge: true });

  // the town pad — a paler concrete apron so the play space reads apart
  B.box([-31.5, -0.03, -21.5], [31.5, 0.0, 21.5], C(0xf1e6d5), { top: C(0xf3ead9), noEdge: true });

  // lawns (pale sage) in the four yard quadrants
  const lawn = C(0xd8ecc8), lawn2 = C(0xcfe7bd);
  const lawns = [[-18.5, -12.5, 8.5, -5.3], [-30, -12.5, -18.5, -5.3], [8.5, -12.5, 30, -5.3]];
  for (const [x0, z0, x1, z1] of lawns) {
    B.box([x0, 0.0, z0], [x1, 0.035, z1], lawn2, { top: lawn, noEdge: true });
    B.box([-x1, 0.0, -z1], [-x0, 0.035, -z0], lawn2, { top: lawn, noEdge: true });
  }

  // street + curbs + markings
  B.box([-31.5, 0.0, -4], [31.5, 0.045, 4], C(PAL.road), { top: C(PAL.road), noEdge: true });
  for (const s of [-1, 1]) {
    B.box([-31.5, 0.0, s > 0 ? 4 : -5.5], [31.5, 0.16, s > 0 ? 5.5 : -4], C(0xdcd5e8), { top: C(PAL.walk), noEdge: true });
  }
  for (let x = -29; x < 30; x += 4.6)
    B.box([x, 0.046, -0.18], [x + 2.4, 0.055, 0.18], C(PAL.roadLine), { noEdge: true });
  // driveways in front of each house
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? -6.4 : -2.6, x1 = s > 0 ? 2.6 : 6.4;
    const z0 = s > 0 ? -5.5 : 4, z1 = s > 0 ? -4 : 5.5;
    B.box([x0, 0.0, s > 0 ? -5.4 : 5.4], [x1, 0.05, s > 0 ? -4.9 : 5.9], C(0xe9e0f0), { noEdge: true });
    B.box([x0, 0.0, z0 - (s > 0 ? 0 : 0)], [x1, 0.17, z1], C(0xe9e0f0), { noEdge: true });
  }

  /* ================= SOLIDS FROM THE MAP SPEC ================= */
  for (const s of MAP.solids) {
    const [x0, y0, z0] = s.min, [x1, y1, z1] = s.max;
    const A = s.house === 'A';
    switch (s.mat) {
      case 'house':
        B.box(s.min, s.max, C(A ? PAL.houseA : PAL.houseB),
              { top: Cx(A ? PAL.houseA : PAL.houseB, 1.04) }); break;
      case 'trim':
        B.box(s.min, s.max, C(A ? PAL.houseAtrim : PAL.houseBtrim)); break;
      case 'slab':
        B.box(s.min, s.max, C(PAL.slab), { top: C(0xfdf3ea) }); break;
      case 'stair':
        B.box(s.min, s.max, C(PAL.stair), { top: C(0xfaece0) }); break;
      case 'roof':
        B.box(s.min, s.max, C(A ? PAL.roofA : PAL.roofB)); break;
      case 'post': {
        B.box(s.min, s.max, C(PAL.post));
        const pcx = (x0 + x1) / 2, pcz = (z0 + z1) / 2, pr = Math.max(x1 - x0, z1 - z0) * 0.62;
        domeY(B, pcx, y1, pcz, pr, pr * 0.75, 8, 3, C(PAL.cream));      // finial
        B.box([x0 - 0.06, y0, z0 - 0.06], [x1 + 0.06, y0 + 0.22, z1 + 0.06], C(PAL.cream));
        break;
      }
      case 'rail':  B.box(s.min, s.max, C(PAL.rail)); break;
      case 'perimeter': {
        B.box(s.min, s.max, C(PAL.perimeter), { top: C(0xe9e2f2) });
        /* You end up nose-to-nose with these constantly, and a bare 60m slab
           is the least magical surface in the map. Break it into precast
           panels with a coping cap and a colour band — geometry is free
           here, the renderer is fill-rate bound, not triangle bound. */
        const alongX = (x1 - x0) > (z1 - z0);
        const len = alongX ? x1 - x0 : z1 - z0;
        const n = Math.max(2, Math.round(len / 3.6));
        const inset = 0.055;
        for (let i = 0; i < n; i++) {
          const t0 = (i + 0.035) / n, t1 = (i + 0.965) / n;
          // recessed panel face, proud of the wall on both sides
          const band = [{ y0: 0.42, y1: 3.95, c: Cx(PAL.perimeter, 1.04) }];
          for (const b of band) {
            if (alongX) B.box([lerp(x0, x1, t0), b.y0, z0 - inset], [lerp(x0, x1, t1), b.y1, z1 + inset], b.c, { noEdge: true });
            else        B.box([x0 - inset, b.y0, lerp(z0, z1, t0)], [x1 + inset, b.y1, lerp(z0, z1, t1)], b.c, { noEdge: true });
          }
          // a pastel painted square on every third panel, alternating hue
          if (i % 3 === 1) {
            const hue = [0xffc9d6, 0xc8f2dc, 0xffe9a8, 0xd4c5f9][i % 4];
            const m0 = (i + 0.34) / n, m1 = (i + 0.66) / n;
            if (alongX) B.box([lerp(x0, x1, m0), 1.05, z0 - inset - 0.03], [lerp(x0, x1, m1), 1.95, z1 + inset + 0.03], C(hue), { noEdge: true });
            else        B.box([x0 - inset - 0.03, 1.05, lerp(z0, z1, m0)], [x1 + inset + 0.03, 1.95, lerp(z0, z1, m1)], C(hue), { noEdge: true });
          }
        }
        // coping cap along the top so the silhouette isn't a bare edge
        B.box([x0 - 0.12, y1, z0 - 0.12], [x1 + 0.12, y1 + 0.18, z1 + 0.12], C(0xfff6ec));
        // skirting shadow band at the base grounds it
        B.box([x0 - 0.04, 0, z0 - 0.04], [x1 + 0.04, 0.34, z1 + 0.04], Cx(PAL.perimeter, 0.93), { noEdge: true });
        break;
      }
      case 'crate':
        bevelBox(B, s.min, s.max, C(PAL.crate), 0.11, { top: C(PAL.crateTop) });
        // strapping so crates read as crates
        B.box([x0 - 0.03, y0 + (y1 - y0) * 0.42, z0 - 0.03], [x1 + 0.03, y0 + (y1 - y0) * 0.58, z1 + 0.03],
              C(0xffbf9a), { noEdge: true });
        break;
      case 'picket': {
        // draw individual pickets along the long axis; collision stays the box
        const alongX = (x1 - x0) > (z1 - z0);
        const len = alongX ? x1 - x0 : z1 - z0;
        const n = Math.max(2, Math.round(len / 0.42));
        const col = C(PAL.picket);
        for (let i = 0; i < n; i++) {
          const t0 = (i + 0.14) / n, t1 = (i + 0.72) / n;
          const h = y1 - 0.06 + (i % 2 ? 0.02 : 0);
          if (alongX) {
            const a = lerp(x0, x1, t0), b = lerp(x0, x1, t1);
            B.box([a, y0, z0], [b, h, z1], col);
            domeY(B, (a + b) / 2, h, (z0 + z1) / 2, (b - a) * 0.5, (b - a) * 0.55, 5, 1, col);
          } else {
            const a = lerp(z0, z1, t0), b = lerp(z0, z1, t1);
            B.box([x0, y0, a], [x1, h, b], col);
            domeY(B, (x0 + x1) / 2, h, (a + b) / 2, (b - a) * 0.5, (b - a) * 0.55, 5, 1, col);
          }
        }
        // two rails
        for (const yy of [0.32, 0.82])
          B.box([x0, yy, z0 + 0.02], [x1, yy + 0.09, z1 - 0.02], Cx(PAL.picket, 0.94), { noEdge: true });
        break;
      }
      case 'bus': case 'truck': break;   // bespoke meshes below
      default: B.box(s.min, s.max, C(0xe8e0f0));
    }
  }

  /* ================= HOUSE DRESSING ================= */
  for (const s of [1, -1]) {
    const A = s > 0, hc = A ? PAL.roofA : PAL.roofB;
    const mx = (v) => s > 0 ? v : -v;
    const F = MAP.consts;

    // pitched roof over the flat roof slab
    if (s > 0) gable(B, -12, 4, -18, -7, F.ROOF, F.ROOF + 2.6, C(hc));
    else       gable(B, -4, 12, 7, 18, F.ROOF, F.ROOF + 2.6, C(hc));

    // chimney
    const chx = s > 0 ? [-9.8, -8.4] : [8.4, 9.8];
    const chz = s > 0 ? [-15.6, -14.2] : [14.2, 15.6];
    B.box([chx[0], F.ROOF, chz[0]], [chx[1], F.ROOF + 3.4, chz[1]], C(A ? 0xffc9d6 : 0xc8f2dc));
    B.box([chx[0] - 0.12, F.ROOF + 3.4, chz[0] - 0.12], [chx[1] + 0.12, F.ROOF + 3.7, chz[1] + 0.12], C(PAL.cream));

    // ---- windows (mirrored coordinates handled by sign) ----
    const zf = mx(-7) + (s > 0 ? -0.3 : 0.3);      // outer face of front wall
    const dirF = s > 0 ? -1 : 1;
    const W = (o) => windowPanel(B, o);
    const ux = (a, b) => s > 0 ? [a, b] : [-b, -a];

    // front, ground
    let p = ux(-10.6, -8.6); W({ axis: 'z', at: zf, dir: dirF, u0: p[0], u1: p[1], v0: 1.15, v1: 2.35 });
    p = ux(0.6, 2.6);       W({ axis: 'z', at: zf, dir: dirF, u0: p[0], u1: p[1], v0: 1.15, v1: 2.35 });
    // front, upper
    p = ux(-11.4, -9.6);    W({ axis: 'z', at: zf, dir: dirF, u0: p[0], u1: p[1], v0: 4.35, v1: 5.6 });
    p = ux(1.4, 3.4);       W({ axis: 'z', at: zf, dir: dirF, u0: p[0], u1: p[1], v0: 4.35, v1: 5.6 });
    // back wall
    const zb = mx(-18) + (s > 0 ? 0 : 0), dirB = s > 0 ? -1 : 1;
    const zbo = s > 0 ? -18 : 18;
    p = ux(-10.2, -8.2);    W({ axis: 'z', at: zbo, dir: -dirF, u0: p[0], u1: p[1], v0: 1.15, v1: 2.35 });
    p = ux(1.6, 3.4);       W({ axis: 'z', at: zbo, dir: -dirF, u0: p[0], u1: p[1], v0: 1.15, v1: 2.35 });
    // east wall (x = 4 for A)
    const xe = s > 0 ? 4 : -4, dirE = s > 0 ? 1 : -1;
    let q = ux(-16.2, -14.4); W({ axis: 'x', at: xe, dir: dirE, u0: q[0], u1: q[1], v0: 1.15, v1: 2.35 });
    q = ux(-11.2, -9.4);      W({ axis: 'x', at: xe, dir: dirE, u0: q[0], u1: q[1], v0: 1.15, v1: 2.35 });
    q = ux(-16.2, -14.4);     W({ axis: 'x', at: xe, dir: dirE, u0: q[0], u1: q[1], v0: 4.35, v1: 5.6 });
    // west wall (x = -12 for A)
    const xw = s > 0 ? -12 : 12, dirW = s > 0 ? -1 : 1;
    q = ux(-17.2, -15.4);     W({ axis: 'x', at: xw, dir: dirW, u0: q[0], u1: q[1], v0: 1.15, v1: 2.35 });
    q = ux(-17.2, -15.6);     W({ axis: 'x', at: xw, dir: dirW, u0: q[0], u1: q[1], v0: 4.35, v1: 5.6 });

    // front door surround + threshold mat
    const dx = ux(-5.72, -3.28);
    B.box([dx[0], 0, zf - (s > 0 ? 0.1 : 0)], [dx[1], 2.42, zf + (s > 0 ? 0 : 0.1)], C(A ? PAL.houseAtrim : PAL.houseBtrim));
    const dm = ux(-5.5, -3.5);
    B.box([dm[0], 0.045, mx(-5.4)], [dm[1], 0.09, mx(-4.9)], C(A ? 0xffb0c4 : 0x9fd8c4), { noEdge: true });

    // porch ceiling lamp + house number plaque
    const lx = ux(-4.9, -4.1);
    B.box([lx[0], 2.72, mx(-6.2)], [lx[1], 2.98, mx(-5.8)], C(0xfff3c4));

    // gutter line under the eaves
    const gx = s > 0 ? [-12.5, 4.5] : [-4.5, 12.5];
    for (const zz of (s > 0 ? [-18.5, -6.9] : [6.9, 18.5]))
      B.box([gx[0], F.ROOF - 0.22, zz - 0.12], [gx[1], F.ROOF, zz + 0.12], C(PAL.cream), { noEdge: true });
  }

  /* ================= BUS (west end) ================= */
  {
    const x0 = -27, x1 = -16.5, z0 = -2.4, z1 = 2.4;
    const body = C(PAL.bus), trim = C(PAL.busTrim), glass = C(PAL.glass);
    B.box([x0, 0.62, z0], [x1, 2.55, z1], body, { top: Cx(PAL.bus, 1.05) });
    B.box([x0 + 0.15, 2.55, z0 + 0.15], [x1 - 0.15, 2.88, z1 - 0.15], Cx(PAL.bus, 1.06));   // roof cap
    // snub nose with a rounded top-front edge (noEdge: it blends into the body)
    B.box([x0 - 0.34, 0.62, z0 + 0.2], [x0 + 0.35, 1.95, z1 - 0.2], Cx(PAL.bus, 0.97));
    arcBand(B, 'z', z0 + 0.2, z1 - 0.2, x0 + 0.05, 1.95, 0, 0.39, Math.PI * 0.5, Math.PI, 7,
            Cx(PAL.bus, 0.97), true);
    B.box([x0 - 0.34, 1.95, z0 + 0.2], [x0 + 0.05, 2.34, z1 - 0.2], Cx(PAL.bus, 0.99), { skip: { nx: 1 } });
    // window strip both sides
    for (const zz of [z0, z1 - 0.12]) {
      for (let i = 0; i < 6; i++) {
        const a = x0 + 0.9 + i * 1.55;
        B.box([a, 1.5, zz - 0.06], [a + 1.2, 2.32, zz + 0.18], glass);
      }
    }
    B.box([x0, 1.32, z0 - 0.06], [x1, 1.5, z1 + 0.06], trim, { noEdge: true });     // belt line
    B.box([x0 - 0.1, 0.5, z0 - 0.08], [x1 + 0.1, 0.72, z1 + 0.08], trim);          // skirt
    B.box([x1 - 0.1, 0.9, z0 + 0.3], [x1 + 0.22, 2.3, z1 - 0.3], glass);           // rear window
    // wheels, each under an arched fender
    for (const wx of [x0 + 1.7, x1 - 1.9]) {
      for (const wz of [z0 + 0.15, z1 - 0.15]) {
        ngonPrism(B, 'z', wz - 0.28, wz + 0.28, wx, 0.62, 0.62, 10, C(PAL.tyre), 0.31);
        ngonPrism(B, 'z', wz - 0.30, wz + 0.30, wx, 0.62, 0.26, 8, C(0xf7efe6), 0.39);   // hub
        const zo = wz > 0 ? 0.02 : -0.32;
        arcBand(B, 'z', wz - 0.30 + zo, wz + 0.30 + zo, wx, 0.62, 0.74, 0.94, 0.15, Math.PI - 0.15, 9,
                Cx(PAL.bus, 0.92));
      }
    }
    // candy-stripe bumper along the nose
    for (let i = 0; i < 9; i++) {
      const za = lerp(z0 + 0.1, z1 - 0.1, i / 9), zb = lerp(z0 + 0.1, z1 - 0.1, (i + 1) / 9);
      B.box([x0 - 0.42, 0.50, za], [x0 - 0.20, 0.86, zb], C(i % 2 ? 0xffb7c5 : 0xfff8f0));
    }
    // roof hatch + lights
    B.box([-23.4, 2.88, -0.6], [-22.2, 3.0, 0.6], C(0xffd0d8));
    for (const zz of [z0 + 0.5, z1 - 0.5]) B.box([x0 - 0.3, 1.5, zz - 0.18], [x0 - 0.18, 1.85, zz + 0.18], C(0xfff3c4));
  }

  /* ================= PICKUP TRUCK (east end) ================= */
  {
    const x0 = 17, x1 = 25, z0 = -2.1, z1 = 2.1;
    const body = C(PAL.truck), glass = C(PAL.glass);
    B.box([x0, 0.55, z0], [x1, 1.35, z1], body, { top: Cx(PAL.truck, 1.05) });           // chassis
    B.box([x0 + 0.4, 1.35, z0], [x0 + 3.5, 2.35, z1], Cx(PAL.truck, 1.03));              // cab
    B.box([x0 + 0.62, 1.6, z0 - 0.07], [x0 + 3.3, 2.18, z1 + 0.07], glass);              // cab glass
    B.box([x0 + 3.6, 1.35, z0], [x1 - 0.2, 1.62, z0 + 0.22], Cx(PAL.truck, 0.96));       // bed walls
    B.box([x0 + 3.6, 1.35, z1 - 0.22], [x1 - 0.2, 1.62, z1], Cx(PAL.truck, 0.96));
    B.box([x1 - 0.2, 1.35, z0], [x1, 1.62, z1], Cx(PAL.truck, 0.96));
    B.box([x0 + 3.55, 1.3, z0 + 0.2], [x1 - 0.2, 1.4, z1 - 0.2], C(0xffc9c0), { noEdge: true });
    for (let i = 0; i < 7; i++) {                                                        // striped bumper
      const za = lerp(z0 - 0.05, z1 + 0.05, i / 7), zb = lerp(z0 - 0.05, z1 + 0.05, (i + 1) / 7);
      B.box([x0 - 0.24, 0.72, za], [x0, 1.15, zb], C(i % 2 ? 0xffe9a8 : 0xfff8f0));
    }
    for (const wx of [x0 + 1.5, x1 - 1.5]) {
      for (const wz of [z0 + 0.1, z1 - 0.1]) {
        ngonPrism(B, 'z', wz - 0.26, wz + 0.26, wx, 0.55, 0.55, 10, C(PAL.tyre), 0.31);
        ngonPrism(B, 'z', wz - 0.28, wz + 0.28, wx, 0.55, 0.23, 8, C(0xf7efe6), 0.39);   // hub
        const zo = wz > 0 ? 0.02 : -0.30;
        arcBand(B, 'z', wz - 0.28 + zo, wz + 0.28 + zo, wx, 0.55, 0.66, 0.86, 0.12, Math.PI - 0.12, 9,
                Cx(PAL.truck, 0.93));                                                     // swept fender
      }
    }
    // rounded cab roof: a shallow dome struck from well below the roofline
    // so the arc actually spans the cab width instead of nubbing the centre
    {
      const rr = 2.75, cy = 2.35 - 2.60, half = Math.asin(Math.min(1, (z1 - z0) / 2 / rr));
      arcBand(B, 'x', x0 + 0.4, x0 + 3.5, cy, 0, rr - 0.16, rr, -half, half, 10,
              Cx(PAL.truck, 1.06), true);
    }
    for (const zz of [z0 + 0.45, z1 - 0.45]) B.box([x0 - 0.24, 1.15, zz - 0.2], [x0 - 0.1, 1.45, zz + 0.2], C(0xfff3c4));
  }

  /* ================= POWER POLES + WIRES ================= */
  const poleTops = [];
  for (const px of [-24, -8, 8, 24]) {
    const pz = px % 16 === 0 ? -6.6 : 6.6;
    ngonPrism(B, 'y', 0, 7.6, px, pz, 0.19, 6, C(PAL.wood));
    B.box([px - 1.5, 6.9, pz - 0.12], [px + 1.5, 7.1, pz + 0.12], C(PAL.wood));
    B.box([px - 1.2, 7.1, pz - 0.1], [px - 1.0, 7.3, pz + 0.1], C(0xdfeef7));
    B.box([px + 1.0, 7.1, pz - 0.1], [px + 1.2, 7.3, pz + 0.1], C(0xdfeef7));
    poleTops.push([px, 7.2, pz]);
  }

  /* ================= DESERT DRESSING ================= */
  // cacti + rocks + dry bushes outside the walls
  for (let i = 0; i < 46; i++) {
    const a = rand(0, TAU), r = rand(36, 120);
    const x = Math.cos(a) * r, z = Math.sin(a) * r * 0.8;
    if (Math.abs(x) < 34 && Math.abs(z) < 24) continue;
    const kind = rng();
    if (kind < 0.34) {                              // cactus
      const h = rand(1.8, 4.2), g = C(0xbfe3c4);
      ngonPrism(B, 'y', 0, h, x, z, rand(0.24, 0.4), 7, g);
      if (rng() < 0.7) {
        const s2 = rng() < 0.5 ? -1 : 1, ay = h * rand(0.42, 0.6);
        B.box([x + (s2 > 0 ? 0.2 : -1.1), ay, z - 0.2], [x + (s2 > 0 ? 1.1 : -0.2), ay + 0.4, z + 0.2], g);
        ngonPrism(B, 'y', ay, ay + rand(0.7, 1.4), x + s2 * 0.95, z, 0.24, 6, g);
      }
    } else if (kind < 0.7) {                        // rock
      const s2 = rand(0.5, 1.7);
      ngonPrism(B, 'y', 0, s2 * rand(0.5, 0.9), x, z, s2, 6, C(rng() < 0.5 ? 0xe4dced : 0xefe2d2), rand(0, 1));
    } else {                                        // stylised tree
      const th = rand(2.4, 4.0);
      ngonPrism(B, 'y', 0, th, x, z, 0.3, 6, C(PAL.wood));
      const lc = C(rng() < 0.5 ? PAL.leaf : PAL.leaf2);
      ngonPrism(B, 'y', th, th + 1.5, x, z, rand(1.5, 2.3), 7, lc, rand(0, 1));
      ngonPrism(B, 'y', th + 1.3, th + 2.5, x, z, rand(1.0, 1.6), 7, lc, rand(0, 1));
    }
  }

  /* ================= THE NUKE TOWER (the reason it's called Nuketown) */
  {
    const tx = -6, tz = -74, h = 34;
    const steel = C(0xe3d9ee);
    for (const [ox, oz] of [[-2.4, -2.4], [2.4, -2.4], [2.4, 2.4], [-2.4, 2.4]]) {
      // legs taper inward as they rise
      const b = [tx + ox, 0, tz + oz], t = [tx + ox * 0.28, h, tz + oz * 0.28];
      const w = 0.32;
      B.quad([b[0] - w, b[1], b[2] - w], [b[0] + w, b[1], b[2] - w], [t[0] + w * .6, t[1], t[2] - w * .6], [t[0] - w * .6, t[1], t[2] - w * .6], steel);
      B.quad([b[0] + w, b[1], b[2] + w], [b[0] - w, b[1], b[2] + w], [t[0] - w * .6, t[1], t[2] + w * .6], [t[0] + w * .6, t[1], t[2] + w * .6], steel);
    }
    for (let i = 1; i < 7; i++) {                    // cross bracing
      const y = h * i / 7, sp = lerp(2.4, 0.7, i / 7);
      B.box([tx - sp, y, tz - sp], [tx + sp, y + 0.24, tz + sp], steel, { noEdge: true });
    }
    B.box([tx - 1.5, h, tz - 1.5], [tx + 1.5, h + 0.5, tz + 1.5], steel);
    ngonPrism(B, 'y', h + 0.5, h + 2.6, tx, tz, 1.15, 10, C(0xffd3b6));   // the device
    ngonPrism(B, 'y', h + 2.6, h + 3.4, tx, tz, 0.75, 10, C(0xff9aa2));
    B.box([tx - 0.1, h + 3.4, tz - 0.1], [tx + 0.1, h + 5.2, tz + 0.1], C(0xff9aa2));
    B.box([tx - 0.35, h + 4.6, tz - 0.35], [tx + 0.35, h + 4.9, tz + 0.35], C(0xfff3c4));
  }

  /* ---- roadside sign: WELCOME TO NUKETOWN ---- */
  {
    const sx = 28.5, sz = -8.5;
    ngonPrism(B, 'y', 0, 3.2, sx - 1.6, sz, 0.16, 6, C(PAL.wood));
    ngonPrism(B, 'y', 0, 3.2, sx + 1.6, sz, 0.16, 6, C(PAL.wood));
    B.box([sx - 2.1, 1.9, sz - 0.14], [sx + 2.1, 3.5, sz + 0.14], C(0xfff3c4), { top: C(0xfff8dc) });
    B.box([sx - 1.85, 2.1, sz - 0.2], [sx + 1.85, 3.3, sz - 0.14], C(0xffb7c5));
  }

  /* ================= INTERIORS =================
     Both houses were bare boxes inside, which is where the map stopped
     feeling like a place. None of this collides — it is dressing, drawn
     into the same merged mesh, so it costs nothing on a fill-rate-bound
     renderer. Mirrored through the origin like everything else. */
  for (const s of [1, -1]) {
    const A = s > 0;
    const m = (x, z) => s > 0 ? [x, z] : [-x, -z];     // mirror a point
    const box = (x0, y0, z0, x1, y1, z1, col, opt) => {
      const [ax, az] = m(x0, z0), [bx, bz] = m(x1, z1);
      B.box([Math.min(ax, bx), y0, Math.min(az, bz)],
            [Math.max(ax, bx), y1, Math.max(az, bz)], col, opt);
    };
    const wood = C(PAL.wood), rugA = C(A ? 0xffd3e2 : 0xcfeadf), rugB = C(A ? 0xffe9a8 : 0xbfe3f5);
    const cream = C(PAL.cream);

    // --- ground floor: rug, couch, coffee table, sideboard, wall art ---
    box(-10.6, 0.01, -16.4, -5.4, 0.03, -12.6, rugA, { top: rugA, noEdge: true });
    box(-10.2, 0.035, -16.0, -5.8, 0.05, -13.0, rugB, { top: rugB, noEdge: true });
    box(-10.9, 0.0, -16.9, -9.5, 0.62, -13.2, C(A ? 0xffb7c5 : 0xa8dcf0));          // couch base
    box(-11.0, 0.62, -16.9, -10.4, 1.28, -13.2, C(A ? 0xff9aa2 : 0x8fd0e8));        // couch back
    box(-8.6, 0.0, -15.4, -7.0, 0.42, -14.0, wood, { top: C(0xf3dfc4) });           // coffee table
    box(-8.2, 0.42, -15.0, -7.6, 0.60, -14.6, C(0xfff3c4), { noEdge: true });       // a vase on it
    box(-5.6, 0.0, -17.6, -3.2, 1.05, -17.2, wood, { top: C(0xf3dfc4) });           // sideboard
    box(-5.2, 1.05, -17.5, -4.8, 1.42, -17.3, C(0xffb7c5), { noEdge: true });       // lamp
    for (let i = 0; i < 3; i++)                                                      // framed pictures
      box(-9.4 + i * 1.5, 1.6, -17.78, -8.6 + i * 1.5, 2.4, -17.72,
          C([0xffefa8, 0xd4c5f9, 0xb8f2d8][i]));
    // kitchen counter along the east wall
    box(1.2, 0.0, -16.8, 3.4, 0.92, -13.6, cream, { top: C(0xf7efe6) });
    box(1.3, 0.92, -16.7, 3.3, 0.98, -13.7, C(A ? 0xffc9d6 : 0xc8f2dc), { noEdge: true });
    box(1.6, 1.9, -17.7, 3.4, 2.6, -17.6, cream);                                    // wall cupboard

    // --- upper floor: bed, rug, dresser, poster ---
    const F1 = MAP.consts.F1;
    box(-10.8, F1 + 0.01, -16.6, -6.6, F1 + 0.03, -13.4, rugB, { top: rugB, noEdge: true });
    box(-11.0, F1, -16.9, -8.6, F1 + 0.52, -14.2, cream, { top: C(0xfdf3ea) });      // bed base
    box(-11.0, F1 + 0.52, -16.9, -8.6, F1 + 0.74, -14.4,
        C(A ? 0xffd3e2 : 0xbfe3f5), { top: C(A ? 0xffe3ec : 0xd4eefb) });            // duvet
    box(-11.0, F1 + 0.74, -16.9, -9.9, F1 + 0.96, -16.2, cream);                     // pillow
    box(-6.2, F1, -17.6, -4.2, F1 + 0.95, -17.1, wood, { top: C(0xf3dfc4) });        // dresser
    box(-5.9, F1 + 0.95, -17.5, -5.3, F1 + 1.22, -17.2, C(0xb8f2d8), { noEdge: true });
    box(-2.8, F1 + 1.5, -17.78, -1.0, F1 + 2.5, -17.72, C(A ? 0xffb7c5 : 0xa8dcf0)); // poster
  }

  B.bakeAO();
  /* Chunk along the street axis so looking one way culls the other end.
     The ground slab lands in the middle chunk; its bounding sphere is huge,
     so that chunk intentionally resists culling because it is always seen. */
  const CUTS = [-16, -5, 5, 16];
  const meshes = B.meshChunks(CUTS);
  const lineSets = B.lineChunks(CUTS, 0.42);
  for (const m of meshes) grp.add(m);
  for (const l of lineSets) grp.add(l);
  scene.add(grp);
  WORLD.group = grp;
  WORLD.staticMesh = meshes[0];
  WORLD.chunks = meshes;

  buildMannequins();
  WORLD.sky = buildSky();
  buildContactShadows();
  buildStreetMotion(poleTops);
  buildDustMotes();
  buildMagic();
  return grp;
}

function buildContactShadows() {
  const specs = [];
  const mats = ['crate', 'bus', 'truck', 'post', 'picket'];
  for (const s of MAP.solids) {
    if (mats.indexOf(s.mat) < 0) continue;
    const x0 = s.min[0], z0 = s.min[2], x1 = s.max[0], z1 = s.max[2];
    const x = (x0 + x1) * 0.5, z = (z0 + z1) * 0.5;
    const pad = s.mat === 'post' ? 2.4 : (s.mat === 'picket' ? 1.18 : 1.32);
    specs.push([x, z, Math.max(0.9, (x1 - x0) * pad), Math.max(0.9, (z1 - z0) * pad)]);
  }
  specs.push([-4.5, -5.55, 3.8, 1.35], [4.5, 5.55, 3.8, 1.35]);

  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const cx = cv.getContext('2d');
  const rg = cx.createRadialGradient(32, 32, 3, 32, 32, 31);
  rg.addColorStop(0, 'rgba(255,255,255,.95)');
  rg.addColorStop(0.54, 'rgba(255,255,255,.62)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = rg; cx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const mat = new THREE.MeshBasicMaterial({
    map: tex, color: C(0x695979), transparent: true, opacity: 0.31,
    depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -1
  });
  const shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, specs.length);
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI * 0.5);
  const p = new THREE.Vector3(), s = new THREE.Vector3(), m = new THREE.Matrix4();
  for (let i = 0; i < specs.length; i++) {
    const v = specs[i];
    const az = Math.abs(v[1]);
    const y = az < 4.05 ? 0.058 : (az < 5.55 ? 0.176 : 0.049);
    p.set(v[0], y, v[1]); s.set(v[2], v[3], 1);
    m.compose(p, q, s);
    shadows.setMatrixAt(i, m);
  }
  shadows.instanceMatrix.needsUpdate = true;
  shadows.frustumCulled = false;
  shadows.renderOrder = 2;
  scene.add(shadows);
  WORLD.contacts = shadows;
}

function buildStreetMotion(poles) {
  const wirePos = [];
  const addWire = (x0, y0, z0, x1, y1, z1, segs, sag) => {
    for (let i = 0; i < segs; i++) {
      const a = i / segs, b = (i + 1) / segs;
      const ay = lerp(y0, y1, a) - Math.sin(a * Math.PI) * sag;
      const by = lerp(y0, y1, b) - Math.sin(b * Math.PI) * sag;
      wirePos.push(lerp(x0, x1, a), ay, lerp(z0, z1, a),
                   lerp(x0, x1, b), by, lerp(z0, z1, b));
    }
  };
  for (let p = 0; p < poles.length - 1; p++) {
    for (const zOff of [-0.62, 0, 0.62])
      addWire(poles[p][0], 7.24, poles[p][2] + zOff,
              poles[p + 1][0], 7.24, poles[p + 1][2] + zOff, 10, 0.48);
  }
  for (const x of [-8, 8])
    addWire(x, 6.15, -6.25, x, 6.15, 6.25, 12, 0.58);

  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wirePos), 3));
  const wires = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({
    color: C(0x564965), transparent: true, opacity: 0.72, fog: true
  }));
  wires.frustumCulled = false;
  scene.add(wires);
  STREET_MOTION.wires = wires;
  STREET_MOTION.wireBase = wg.attributes.position.array.slice(0);

  const flagPos = [], flagCol = [], flagPhase = [];
  const hues = [0xff8fa8, 0xffd36e, 0x78d8c0, 0x87bfe6, 0xb89bea, 0xffae87];
  for (const x of [-8, 8]) {
    const n = 12;
    for (let i = 0; i < n; i++) {
      const z0 = lerp(-5.9, 5.9, (i + 0.08) / n);
      const z1 = lerp(-5.9, 5.9, (i + 0.92) / n);
      const zm = (z0 + z1) * 0.5;
      const y = 6.15 - Math.sin((i + 0.5) / n * Math.PI) * 0.58;
      flagPos.push(x, y, z0, x, y, z1, x, y - 0.86, zm);
      const c = C(hues[(i + (x > 0 ? 2 : 0)) % hues.length]);
      for (let j = 0; j < 3; j++) {
        flagCol.push(c.r, c.g, c.b);
        flagPhase.push(i * 0.51 + j * 0.16 + (x > 0 ? 1.7 : 0));
      }
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flagPos), 3));
  fg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(flagCol), 3));
  const flags = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: true
  }));
  flags.frustumCulled = false;
  flags.castShadow = !SOFTWARE_GPU;
  scene.add(flags);
  STREET_MOTION.flags = flags;
  STREET_MOTION.flagBase = fg.attributes.position.array.slice(0);
  STREET_MOTION.flagPhase = new Float32Array(flagPhase);
}

function updateStreetMotion(t) {
  if (WORLD.sky) {
    WORLD.sky.nearClouds.rotation.y = t * 0.0042;
    WORLD.sky.farClouds.rotation.y = -t * 0.0018;
  }
  if (STREET_MOTION.wires) {
    const a = STREET_MOTION.wires.geometry.attributes.position;
    const p = a.array, b = STREET_MOTION.wireBase;
    for (let i = 0; i < p.length; i += 3) {
      p[i] = b[i];
      p[i + 1] = b[i + 1] + Math.sin(t * 0.85 + b[i] * 0.08 + b[i + 2] * 0.17) * 0.045;
      p[i + 2] = b[i + 2] + Math.sin(t * 0.62 + b[i] * 0.11) * 0.028;
    }
    a.needsUpdate = true;
  }
  if (STREET_MOTION.flags) {
    const a = STREET_MOTION.flags.geometry.attributes.position;
    const p = a.array, b = STREET_MOTION.flagBase, ph = STREET_MOTION.flagPhase;
    for (let i = 0; i < ph.length; i++) {
      const k = i * 3, flap = i % 3 === 2 ? 1 : 0.22;
      p[k] = b[k] + Math.sin(t * 1.9 + ph[i]) * 0.12 * flap;
      p[k + 1] = b[k + 1] + Math.sin(t * 1.25 + ph[i] * 0.7) * 0.045 * flap;
      p[k + 2] = b[k + 2] + Math.cos(t * 1.7 + ph[i]) * 0.08 * flap;
    }
    a.needsUpdate = true;
  }
}

/* =====================================================================
   MANNEQUINS — Nuketown's signature. Separate objects so they spin and
   topple when you shoot them.
   ===================================================================== */
/* Mannequins are Nuketown's signature prop, but in a free-for-all a pastel
   humanoid the same size and colour family as a bot is a false target you
   waste bullets on. So they get deliberately de-humanised: ONE cool ivory
   material (never a jersey colour), visible joint seams, a turned display
   base, and arms tucked flat to the body so the silhouette can never be
   mistaken for someone holding a gun. */
const MANNEQUIN_IVORY = 0xf3ece6;
function mannequinGeo() {
  const B = new GeoBuilder();
  const c = C(MANNEQUIN_IVORY), c2 = Cx(MANNEQUIN_IVORY, 0.94), seam = Cx(MANNEQUIN_IVORY, 0.80);
  ngonPrism(B, 'y', 0.0, 0.09, 0, 0, 0.36, 12, seam);        // turned display base
  ngonPrism(B, 'y', 0.09, 0.16, 0, 0, 0.30, 12, c2);
  B.box([-0.07, 0.16, -0.07], [0.07, 0.78, 0.07], c2);       // stand pole
  B.box([-0.21, 0.78, -0.13], [0.21, 1.30, 0.13], c);        // hips
  B.box([-0.225, 1.30, -0.145], [0.225, 1.36, 0.145], seam); // waist seam
  B.box([-0.26, 1.36, -0.15], [0.26, 1.60, 0.15], c);        // chest
  B.box([-0.27, 1.60, -0.16], [0.27, 1.65, 0.16], seam);     // shoulder seam
  B.box([-0.075, 1.65, -0.075], [0.075, 1.76, 0.075], c2);   // neck
  ngonPrism(B, 'y', 1.76, 2.04, 0, 0, 0.155, 10, c);         // featureless head
  // arms flat against the torso, hanging down — never a gun pose
  for (const s of [-1, 1]) {
    const x0 = s * 0.20, x1 = s * 0.325;
    B.box([Math.min(x0, x1), 0.94, -0.085], [Math.max(x0, x1), 1.58, 0.085], c2);
  }
  const m = B.mesh(); const l = B.lines(0.55);
  const g = new THREE.Group(); g.add(m); if (l) g.add(l);
  return g;
}
/* =====================================================================
   LOCALISED MAGIC
   The global dust motes are pleasant but evenly spread, which makes them
   read as weather rather than as authored magic — constant sparkle becomes
   wallpaper. These emitters instead pool magic at specific landmarks, so
   the effect identifies a PLACE: fireflies under the porch lamps, candy
   floss off the chimneys, bubbles from the vehicle exhausts, petals
   circling the two spawn ends.

   All motion is analytic — position is a pure function of (site, phase,
   time) — so there is no per-frame simulation state to update, just a
   buffer write. Everything is additive and deliberately faint: fading a
   vertex colour toward black is invisible under additive blending, but
   would turn a normal-blended sprite into a dark square (see psUpdate).
   ===================================================================== */
const MAGIC = { groups: [], sites: [] };

function magicPoints(n, tex, size, opacity) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const m = new THREE.PointsMaterial({
    size: size, map: tex, vertexColors: true, transparent: true, opacity: opacity,
    depthWrite: false, sizeAttenuation: true, fog: true,
    blending: THREE.AdditiveBlending
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  scene.add(p);
  return { pts: p, n: n, items: [] };
}

function buildMagic() {
  const soft = SOFTWARE_GPU;
  const F = MAP.consts;
  const tex = MOTE_TEX || null;

  /* emitter sites, mirrored through the origin like the rest of the map */
  const sites = [];
  for (const s of [1, -1]) {
    sites.push({ k: 'firefly', x: s * -4.5,  y: 2.62,        z: s * -6.0, c: 0xffe9a0 });
    sites.push({ k: 'puff',    x: s * -9.1,  y: F.ROOF + 3.8, z: s * -14.9, c: s > 0 ? 0xffd6e6 : 0xd7e6ff });
  }
  sites.push({ k: 'bubble', x: -16.7, y: 0.55, z:  1.5, c: 0xd8f2ff });   // bus exhaust
  sites.push({ k: 'bubble', x:  25.2, y: 0.60, z: -1.4, c: 0xffe0ee });   // truck exhaust
  sites.push({ k: 'petal',  x: -27.5, y: 0.0,  z:  0.0, c: 0xffc9dc });   // west spawn end
  sites.push({ k: 'petal',  x:  27.5, y: 0.0,  z:  0.0, c: 0xc9e8ff });   // east spawn end
  for (const st of sites) st.lin = C(st.c);   // convert once, not per particle per frame
  MAGIC.sites = sites;

  const per = { firefly: soft ? 10 : 22, puff: soft ? 8 : 16,
                bubble: soft ? 7 : 14,  petal: soft ? 8 : 18 };
  const specs = [
    { key: 'warm',   kinds: ['firefly', 'petal'], size: 0.055, opacity: 1.0 },
    { key: 'bubble', kinds: ['bubble'],           size: 0.13, opacity: 0.85 },
    { key: 'puff',   kinds: ['puff'],             size: 0.95, opacity: 0.50 }
  ];
  for (const sp of specs) {
    const items = [];
    for (const site of sites) {
      if (sp.kinds.indexOf(site.k) < 0) continue;
      for (let i = 0; i < per[site.k]; i++)
        items.push({ site: site, ph: (i + 0.5) / per[site.k], j: rand(0, TAU) });
    }
    if (!items.length) continue;
    const grp = magicPoints(items.length, tex, sp.size, sp.opacity);
    grp.items = items;
    MAGIC.groups.push(grp);
  }
}

const _frac = v => v - Math.floor(v);
function updateMagic(t) {
  for (const grp of MAGIC.groups) {
    const pos = grp.pts.geometry.attributes.position.array;
    const col = grp.pts.geometry.attributes.color.array;
    for (let i = 0; i < grp.items.length; i++) {
      const it = grp.items[i], s = it.site, ph = it.ph;
      let x, y, z, e;
      if (s.k === 'firefly') {
        // lazy spiral under the porch lamp, twinkling out of phase
        const a = t * 0.55 + ph * TAU, r = 0.40 + 0.30 * Math.sin(t * 0.9 + it.j);
        x = s.x + Math.cos(a) * r;
        z = s.z + Math.sin(a) * r;
        y = s.y - 0.55 + 0.40 * Math.sin(t * 1.3 + it.j * 2.1);
        e = 0.30 + 0.70 * (0.5 + 0.5 * Math.sin(t * 3.1 + it.j * 3.7));
      } else if (s.k === 'puff') {
        // candy floss leaving the chimney, expanding and blowing downwind
        const u = _frac(t * 0.13 + ph);
        const spread = 0.16 + u * 0.85;
        x = s.x + Math.cos(it.j) * spread + u * 1.5;
        z = s.z + Math.sin(it.j) * spread + u * 0.5;
        y = s.y + u * 3.2;
        e = Math.sin(u * Math.PI) * 0.85;
      } else if (s.k === 'bubble') {
        // bubbles wobbling up out of an exhaust pipe
        const u = _frac(t * 0.20 + ph);
        x = s.x + Math.sin(t * 1.7 + it.j) * 0.20 + u * 0.35;
        z = s.z + Math.cos(t * 1.3 + it.j) * 0.20;
        y = s.y + u * 2.1;
        e = (1 - u) * (0.55 + 0.45 * Math.sin(t * 2.2 + it.j));
      } else {                                    // petal
        const a = t * 0.30 + ph * TAU, r = 1.5 + 0.6 * Math.sin(it.j);
        x = s.x + Math.cos(a) * r;
        z = s.z + Math.sin(a) * r;
        y = 0.35 + 0.85 * (0.5 + 0.5 * Math.sin(t * 0.8 + it.j));
        e = 0.75;
      }
      e *= nearFade(x, y, z);
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      const c = s.lin;
      col[i * 3] = c.r * e; col[i * 3 + 1] = c.g * e; col[i * 3 + 2] = c.b * e;
    }
    grp.pts.geometry.attributes.position.needsUpdate = true;
    grp.pts.geometry.attributes.color.needsUpdate = true;
  }
}

function buildMannequins() {
  const spots = [
    [-8.5, -5.9, 0.3], [1.2, -5.9, -0.6], [-14.5, -8.5, 1.2], [6.2, -9.4, 2.4],
    [-19.5, 2.0, 1.9], [-2.5, 1.4, 0.8], [10.5, -3.2, 3.6]
  ];
  let i = 0;
  for (const [x, z, yaw] of spots) {
    for (const s of [1, -1]) {
      const g = mannequinGeo();
      g.position.set(s * x, 0, s * z);
      g.rotation.y = yaw + (s < 0 ? Math.PI : 0);
      g.userData = { spin: 0, lean: 0, base: g.rotation.y, hp: 3 };
      scene.add(g);
      WORLD.mannequins.push(g);
      i++;
    }
  }
}

/* =====================================================================
   FLOATING DUST MOTES — the cheap trick that makes a scene feel magical
   ===================================================================== */
let MOTES = null, MOTE_TEX = null;
function buildDustMotes() {
  const N = SOFTWARE_GPU ? 80 : 360;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), ph = new Float32Array(N);
  const tints = [0xfff3c4, 0xffd9e6, 0xd8ecff, 0xe0d0ff, 0xffffff];
  for (let i = 0; i < N; i++) {
    pos[i * 3] = rand(-34, 34); pos[i * 3 + 1] = rand(0.3, 15); pos[i * 3 + 2] = rand(-24, 24);
    const c = C(tints[i % tints.length]);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    ph[i] = rand(0, TAU);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const cv = document.createElement('canvas'); cv.width = cv.height = 32;
  const cx = cv.getContext('2d');
  const rg = cx.createRadialGradient(16, 16, 0, 16, 16, 16);
  rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.35, 'rgba(255,255,255,.7)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = rg; cx.fillRect(0, 0, 32, 32);
  MOTE_TEX = new THREE.CanvasTexture(cv);
  const tex = MOTE_TEX;

  const mat = new THREE.PointsMaterial({
    size: 0.2, map: tex, vertexColors: true, transparent: true, opacity: 0.8,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false
  });
  MOTES = new THREE.Points(g, mat);
  MOTES.frustumCulled = false;
  MOTES.userData = { ph, base: pos.slice(0), tint: col.slice(0) };
  scene.add(MOTES);
}
function updateMotes(t) {
  updateStreetMotion(t);
  if (!MOTES) return;
  const p = MOTES.geometry.attributes.position, base = MOTES.userData.base, ph = MOTES.userData.ph;
  const c = MOTES.geometry.attributes.color, tint = MOTES.userData.tint;
  const n = ph.length;
  for (let i = 0; i < n; i++) {
    const a = ph[i];
    const x = base[i * 3] + Math.sin(t * 0.22 + a) * 1.5;
    const y = base[i * 3 + 1] + Math.sin(t * 0.34 + a * 2.1) * 0.7;
    const z = base[i * 3 + 2] + Math.cos(t * 0.19 + a * 1.4) * 1.5;
    p.array[i * 3] = x; p.array[i * 3 + 1] = y; p.array[i * 3 + 2] = z;
    // motes drift through the camera constantly; without this they bloom
    const e = nearFade(x, y, z);
    c.array[i * 3] = tint[i * 3] * e;
    c.array[i * 3 + 1] = tint[i * 3 + 1] * e;
    c.array[i * 3 + 2] = tint[i * 3 + 2] * e;
  }
  p.needsUpdate = true; c.needsUpdate = true;
}
