/* =====================================================================
   PASTEL NUKETOWN — kill-confirmed donuts
   ===================================================================== */

const DONUT_MAX = 24;
const DONUT_LIFETIME = 12.0;
const DONUT_LIFT = 0.35;
const DONUT_PICKUP_RADIUS = 1.1;
const DONUT_PICKUP_HEIGHT = 2.0;

/* One shared torus and a fixed mesh pool keep a busy match from allocating a
   new GPU object for every death. The pool is deliberately separate from the
   gameplay list, so collection and eviction never leave a mesh behind. */
const DONUT_RENDER = {
  geometry: null, material: null, meshes: [], used: [], slots: new Map(), ready: false
};

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
    DONUT_RENDER.geometry = new THREE.TorusGeometry(0.34, 0.11, 10, 20);
    DONUT_RENDER.material = new THREE.MeshLambertMaterial({
      color: C(0xff9dcc), emissive: C(0xfff4df), emissiveIntensity: 0.28
    });
    for (let i = 0; i < DONUT_MAX; i++) {
      const mesh = new THREE.Mesh(DONUT_RENDER.geometry, DONUT_RENDER.material);
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
  mesh.rotation.set(0, 0, 0);
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
    mesh.rotation.y = (G.time * 0.75 + donut.id * 0.7) % TAU;
    mesh.rotation.z = Math.sin((G.time + donut.id) * 1.4) * 0.12;
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
