/* =====================================================================
   PASTEL NUKETOWN — kill-confirmed donuts
   ===================================================================== */

const DONUT_MAX = 24;
const DONUT_LIFETIME = 12.0;
const DONUT_LIFT = 0.35;
const DONUT_PICKUP_RADIUS = 1.1;
const DONUT_PICKUP_HEIGHT = 2.0;

/* One shared geometry and a fixed mesh pool keep a busy match from allocating
   a new GPU object for every death. The pool is deliberately separate from the
   gameplay list, so collection and eviction never leave a mesh behind. */
const DONUT_RENDER = {
  geometry: null, material: null, meshes: [], used: [], slots: new Map(), ready: false
};

/* ---- the look ------------------------------------------------------------
   The pickup is the donut emoji: a fat dough ring with a small hole, a thick
   pink glaze poured over the top that drips unevenly past the outer edge, and
   multicoloured sprinkles.

   All three are baked into ONE flat-shaded, vertex-coloured buffer, so a donut
   is still a single Mesh sharing one geometry and one material with the other
   23 in the pool. Sprinkles as their own meshes would have put 24 x 38 extra
   nodes in the scene graph for something that never moves relative to the
   dough; baked, they cost triangles in a buffer that is uploaded once. */
const DONUT_RING = 0.335;     // ring centre to the middle of the dough tube
const DONUT_TUBE = 0.155;     // fat dough: outer radius 0.49, hole radius 0.18
const DONUT_SQUASH = 0.76;    // a donut sits flatter than a circular-section torus
const DONUT_ICE = 0.034;      // how far the glaze stands off the dough
const DONUT_GLAZE_IN = Math.PI - 0.28;  // icing stops short of the hole's lip
const DONUT_SEG_U = 26;       // segments around the ring
const DONUT_SEG_V = 12;       // segments around the dough tube
const DONUT_SEG_ICE = 8;      // segments across the glaze band
const DONUT_SPRINKLES = 38;
const DONUT_TILT = 0.36;      // lean, so the glazed face reads from eye height

/* The glaze edge has to meet itself after a full turn around the ring, so the
   drip is harmonics of u rather than noise. Amplitudes sum to 1: range [0,1].
   The band it drives runs from just above the outer equator down to a proper
   run-off, which is what leaves a tan stripe of bare dough showing under the
   icing — without it the pickup is a pink pillow, not a donut. */
function donutDrip(u) {
  return 0.5 + 0.5 * (0.55 * Math.sin(3 * u + 0.9) +
                      0.30 * Math.sin(5 * u + 2.3) +
                      0.15 * Math.sin(8 * u + 4.1));
}

/* One sprinkle: a box lying on the glaze, oriented by the surface frame
   (L along its length, W across, N out of the glaze). L x W = N, which is the
   winding GeoBuilder needs for every face to end up pointing outwards. */
function donutSprinkle(gb, c, L, W, N, hl, hw, hn, col) {
  const p = (a, b, d) => [
    c[0] + L[0] * a * hl + W[0] * b * hw + N[0] * d * hn,
    c[1] + L[1] * a * hl + W[1] * b * hw + N[1] * d * hn,
    c[2] + L[2] * a * hl + W[2] * b * hw + N[2] * d * hn
  ];
  gb.quad(p(-1, -1,  1), p( 1, -1,  1), p( 1,  1,  1), p(-1,  1,  1), col, true);
  gb.quad(p( 1, -1, -1), p(-1, -1, -1), p(-1,  1, -1), p( 1,  1, -1), col, true);
  gb.quad(p( 1, -1, -1), p( 1,  1, -1), p( 1,  1,  1), p( 1, -1,  1), col, true);
  gb.quad(p(-1, -1, -1), p(-1, -1,  1), p(-1,  1,  1), p(-1,  1, -1), col, true);
  gb.quad(p(-1,  1, -1), p(-1,  1,  1), p( 1,  1,  1), p( 1,  1, -1), col, true);
  gb.quad(p(-1, -1, -1), p( 1, -1, -1), p( 1, -1,  1), p(-1, -1,  1), col, true);
}

/* Accumulates dough + glaze + sprinkles into one GeoBuilder. Colours are
   picked from small pre-built arrays rather than blended at build time, so
   nothing here needs a live THREE.Color to do arithmetic. */
function buildDonutGeo() {
  const gb = new GeoBuilder();
  const R = DONUT_RING, r = DONUT_TUBE, k = DONUT_SQUASH;
  /* golden, tan, toasted — the dough reads warm against the pastel ground */
  const DOUGH = [C(0xd9a066), C(0xe8b479), C(0xf3c894)];
  /* deep at the drip, lightest across the top, shaded again inside the hole */
  const GLAZE = [C(0xf279b4), C(0xff8fc4), C(0xff9dcc), C(0xffb6db),
                 C(0xffa4d0), C(0xf98cc0)];
  const GLAZE_RIM = C(0xef6faa);
  const SPRINKLE = [FX_MINT, FX_LILAC, FX_SUGAR, FX_BUBBLE,
                    C(PAL.houseA), C(0xffc4a6)];

  /* Squashed torus: u goes around the ring, v around the tube.
     v = 0 outer equator, +PI/2 top, PI the hole's lip, -PI/2 underside.
     `off` pushes a point out along the surface normal, which is how the glaze
     is built — a fatter tube would have hung over the hole and closed it up. */
  const nrm = (u, v) => {
    const nx = k * Math.cos(v) * Math.cos(u), ny = Math.sin(v);
    const nz = k * Math.cos(v) * Math.sin(u);
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
  const at = (u, v, off) => {
    const s = R + r * Math.cos(v), n = nrm(u, v);
    return [s * Math.cos(u) + n[0] * off, k * r * Math.sin(v) + n[1] * off,
            s * Math.sin(u) + n[2] * off];
  };
  /* Scalloped, and deliberately peaked: raising the wobble to a power keeps the
     icing sitting on the upper flank for most of the way round and lets it run
     right down the side in a few places. A uniform edge enrobes the whole ring
     and loses the tan band that says "dough" at a glance. */
  const edgeV = u => 0.14 - 0.88 * Math.pow(donutDrip(u), 1.8);
  /* full thickness across the top, thinning to a lip where it meets the hole */
  const thick = t => DONUT_ICE * (0.30 + 0.70 * Math.min(1, (1 - t) / 0.20));

  for (let i = 0; i < DONUT_SEG_U; i++) {
    const u0 = i / DONUT_SEG_U * TAU, u1 = (i + 1) / DONUT_SEG_U * TAU;

    /* dough: the whole tube, so the ring is solid under the glaze */
    for (let j = 0; j < DONUT_SEG_V; j++) {
      const v0 = j / DONUT_SEG_V * TAU, v1 = (j + 1) / DONUT_SEG_V * TAU;
      const lift = Math.sin((v0 + v1) * 0.5);
      const col = DOUGH[lift < -0.4 ? 0 : (lift < 0.35 ? 1 : 2)];
      gb.quad(at(u0, v0, 0), at(u0, v1, 0), at(u1, v1, 0), at(u1, v0, 0), col, true);
    }

    /* glaze: a shell from the drip edge, over the top, down to the hole */
    const e0 = edgeV(u0), e1 = edgeV(u1);
    for (let j = 0; j < DONUT_SEG_ICE; j++) {
      const t0 = j / DONUT_SEG_ICE, t1 = (j + 1) / DONUT_SEG_ICE;
      const col = GLAZE[clamp(Math.floor((t0 + t1) * 0.5 * GLAZE.length), 0, GLAZE.length - 1)];
      gb.quad(at(u0, lerp(e0, DONUT_GLAZE_IN, t0), thick(t0)),
              at(u0, lerp(e0, DONUT_GLAZE_IN, t1), thick(t1)),
              at(u1, lerp(e1, DONUT_GLAZE_IN, t1), thick(t1)),
              at(u1, lerp(e1, DONUT_GLAZE_IN, t0), thick(t0)), col, true);
    }

    /* the rims are what makes the icing a thick layer instead of a decal */
    gb.quad(at(u0, e0, thick(0)), at(u1, e1, thick(0)),
            at(u1, e1, 0), at(u0, e0, 0), GLAZE_RIM, true);
    gb.quad(at(u0, DONUT_GLAZE_IN, 0), at(u1, DONUT_GLAZE_IN, 0),
            at(u1, DONUT_GLAZE_IN, thick(1)), at(u0, DONUT_GLAZE_IN, thick(1)),
            GLAZE_RIM, true);
  }

  /* Sprinkles spread by the golden angle so they never line up with the ring
     segments, and sit in a band that reaches the outer flank — a player
     looking at the donut from across the street sees them side-on. */
  const srng = mulberry32(0x5B12C7);
  const GOLD = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < DONUT_SPRINKLES; i++) {
    const u = (i * GOLD) % TAU;
    const lo = edgeV(u) + 0.12, hi = DONUT_GLAZE_IN - 0.25;
    const v = lo + (hi - lo) * srng();
    const n = nrm(u, v);
    const p = at(u, v, thick((v - edgeV(u)) / (DONUT_GLAZE_IN - edgeV(u))));
    const t1 = [-Math.sin(u), 0, Math.cos(u)];
    const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2],
                n[0] * t1[1] - n[1] * t1[0]];
    const a = srng() * TAU, ca = Math.cos(a), sa = Math.sin(a);
    const L = [ca * t1[0] + sa * t2[0], ca * t1[1] + sa * t2[1], ca * t1[2] + sa * t2[2]];
    const W = [n[1] * L[2] - n[2] * L[1], n[2] * L[0] - n[0] * L[2],
               n[0] * L[1] - n[1] * L[0]];
    const hn = 0.019;
    const c = [p[0] + n[0] * hn * 0.4, p[1] + n[1] * hn * 0.4, p[2] + n[2] * hn * 0.4];
    donutSprinkle(gb, c, L, W, n, 0.05, hn, hn, SPRINKLE[i % SPRINKLE.length]);
  }
  return gb;
}

function resetDonuts() {
  for (const donut of G.donuts) hideDonutVisual(donut);
  G.donuts.length = 0;
  G.nextDonutId = 1;
  if (!G.donutStats) G.donutStats = {};
  G.donutStats.spawned = 0;
  G.donutStats.confirmed = 0;
  G.donutStats.stolen = 0;
  G.donutStats.denied = 0;
  G.donutStats.expired = 0;
  G.donutStats.evicted = 0;
}

function ensureDonutPool() {
  if (DONUT_RENDER.ready || typeof scene === 'undefined' || !scene) return;
  try {
    /* GeoBuilder.mesh() hands back the vertex-coloured toon material the rest
       of the town uses, with the Lambert fallback intact. Its mesh becomes the
       first pool slot; the other 23 share its geometry and material. */
    const proto = buildDonutGeo().mesh({ emissive: 0xfff4df });
    DONUT_RENDER.geometry = proto.geometry;
    DONUT_RENDER.material = proto.material;
    /* a little glow so the pickup still reads pink in a doorway's shadow */
    DONUT_RENDER.material.emissiveIntensity = 0.2;
    for (let i = 0; i < DONUT_MAX; i++) {
      const mesh = i === 0 ? proto
        : new THREE.Mesh(DONUT_RENDER.geometry, DONUT_RENDER.material);
      mesh.visible = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      DONUT_RENDER.meshes.push(mesh);
      DONUT_RENDER.used.push(false);
    }
    DONUT_RENDER.ready = true;
  } catch (e) {
    /* A headless or partially booted renderer should not stop the simulation. */
    DONUT_RENDER.geometry = null;
    DONUT_RENDER.material = null;
    DONUT_RENDER.meshes.length = 0;
    DONUT_RENDER.used.length = 0;
  }
}

function hideDonutVisual(donut) {
  if (!donut) return;
  const slot = DONUT_RENDER.slots.get(donut.id);
  if (slot === undefined) return;
  const mesh = DONUT_RENDER.meshes[slot];
  if (mesh) mesh.visible = false;
  DONUT_RENDER.used[slot] = false;
  DONUT_RENDER.slots.delete(donut.id);
}

function showDonutVisual(donut) {
  ensureDonutPool();
  if (!DONUT_RENDER.ready) return;
  let slot = -1;
  for (let i = 0; i < DONUT_RENDER.used.length; i++) {
    if (!DONUT_RENDER.used[i]) { slot = i; break; }
  }
  if (slot < 0) return;
  const mesh = DONUT_RENDER.meshes[slot];
  DONUT_RENDER.used[slot] = true;
  DONUT_RENDER.slots.set(donut.id, slot);
  mesh.visible = true;
  mesh.position.set(donut.x, donut.y, donut.z);
  mesh.rotation.set(0, 0, DONUT_TILT);
}

function removeDonut(index) {
  const donut = G.donuts[index];
  if (!donut) return null;
  hideDonutVisual(donut);
  G.donuts.splice(index, 1);
  return donut;
}

function donutGroundY(x, y, z) {
  const ox = Number.isFinite(x) ? x : 0;
  const oy = Number.isFinite(y) ? y + 0.05 : 0.05;
  const oz = Number.isFinite(z) ? z : 0;
  const hit = raycastMap(ox, oy, oz, 0, -1, 0, 64);
  if (hit && Number.isFinite(hit.py)) return hit.py + DONUT_LIFT;
  /* The ground plane is the safest fallback for an off-map death: it keeps
     the pickup visible and prevents a missed ray from creating an unreachable
     floating entity. */
  return DONUT_LIFT;
}

function spawnDonut(owner, killer) {
  if (!owner || G.mode !== 'kc' ||
      (typeof netIsGuest === 'function' && netIsGuest())) return null;
  if (G.donuts.length >= DONUT_MAX) {
    let oldest = 0;
    for (let i = 1; i < G.donuts.length; i++) {
      if (G.donuts[i].t > G.donuts[oldest].t) oldest = i;
    }
    removeDonut(oldest);
    G.donutStats.evicted++;
  }

  const donut = {
    id: G.nextDonutId++,
    owner: owner.id,
    killer: killer ? killer.id : null,
    ownerNetId: owner.netId || null,
    killerNetId: killer ? (killer.netId || null) : null,
    x: Number.isFinite(owner.pos.x) ? owner.pos.x : 0,
    y: donutGroundY(owner.pos.x, owner.pos.y, owner.pos.z),
    z: Number.isFinite(owner.pos.z) ? owner.pos.z : 0,
    t: 0
  };
  G.donuts.push(donut);
  G.donutStats.spawned++;
  showDonutVisual(donut);
  return donut;
}

function donutActor(id) {
  return G.actors.find(actor => actor.id === id) || null;
}

function donutOutcome(donut, collector) {
  if (collector.id === donut.owner) return 'DENIED';
  return collector.id === donut.killer ? 'CONFIRMED' : 'STOLEN';
}

function renderDonutOutcome(donut, collector, owner, killer, outcome) {
  if (typeof addKillFeed === 'function') addKillFeed(collector, owner, outcome);
  const x = donut.x, y = donut.y + 0.45, z = donut.z;
  if (collector.isPlayer) {
    if (typeof addFloater === 'function') {
      const color = outcome === 'CONFIRMED' ? '#b8f2d8' :
        (outcome === 'STOLEN' ? '#ff9dcc' : '#d8baff');
      addFloater(outcome, x, y, z, color, true);
    }
    if (outcome === 'CONFIRMED') SFX.kill();
    else SFX.ui();
  } else if (killer && killer.isPlayer && outcome === 'STOLEN') {
    if (typeof addFloater === 'function') addFloater('STOLEN', x, y, z, '#ff9dcc', true);
    SFX.ui();
  }
}

function reportDonutOutcome(donut, collector, outcome) {
  const owner = donutActor(donut.owner) || collector;
  const killer = donutActor(donut.killer);
  if (outcome === 'CONFIRMED' || outcome === 'STOLEN') collector.confirms++;
  if (outcome === 'CONFIRMED') G.donutStats.confirmed++;
  else if (outcome === 'DENIED') G.donutStats.denied++;
  else if (outcome === 'STOLEN') G.donutStats.stolen++;
  if (typeof netOnAuthoritativeConfirm === 'function')
    netOnAuthoritativeConfirm(donut, collector, outcome);
  renderDonutOutcome(donut, collector, owner, killer, outcome);
}

function donutTouchesActor(donut, actor) {
  if (!actor || !actor.alive) return false;
  const horizontal = Math.hypot(actor.pos.x - donut.x, actor.pos.z - donut.z);
  const vertical = Math.abs(actor.pos.y - donut.y);
  return horizontal <= DONUT_PICKUP_RADIUS && vertical <= DONUT_PICKUP_HEIGHT;
}

function animateDonuts() {
  for (const donut of G.donuts) {
    const slot = DONUT_RENDER.slots.get(donut.id);
    const mesh = slot === undefined ? null : DONUT_RENDER.meshes[slot];
    if (!mesh) continue;
    mesh.position.set(donut.x, donut.y + Math.sin((G.time + donut.id) * 2.1) * 0.08, donut.z);
    /* Euler XYZ applies Z first, so the lean is baked into the donut's own
       frame and the Y spin walks it round the compass: the glazed face is
       shown to every corner of the map in turn instead of only to the north.
       The X term is a slow nod on top of that. */
    mesh.rotation.y = (G.time * 1.1 + donut.id * 0.7) % TAU;
    mesh.rotation.z = DONUT_TILT;
    mesh.rotation.x = Math.sin((G.time + donut.id) * 1.4) * 0.12;
  }
}

function updateDonuts(dt) {
  if (G.mode !== 'kc') return;
  if (typeof netIsGuest === 'function' && netIsGuest()) {
    /* The host may disagree because it has not received this movement yet.
       Removing only the local replica makes contact feel immediate without
       promising a score; a still-present donut returns in the next snapshot. */
    for (let i = G.donuts.length - 1; i >= 0; i--)
      if (donutTouchesActor(G.donuts[i], G.player)) removeDonut(i);
    animateDonuts();
    return;
  }
  for (let i = G.donuts.length - 1; i >= 0; i--) {
    const donut = G.donuts[i];
    donut.t += dt;
    if (donut.t >= DONUT_LIFETIME) {
      removeDonut(i);
      G.donutStats.expired++;
    }
  }

  for (let i = G.donuts.length - 1; i >= 0; i--) {
    const donut = G.donuts[i];
    let collector = null;
    for (const actor of G.actors) {
      if (donutTouchesActor(donut, actor)) {
        collector = actor;
        break;
      }
    }
    if (!collector) continue;
    const outcome = donutOutcome(donut, collector);
    removeDonut(i);
    reportDonutOutcome(donut, collector, outcome);
    refreshBoard();
    checkMatchWin();
    if (G.over) break;
  }

  animateDonuts();
}
