/* =====================================================================
   PASTEL NUKETOWN — NON-VISUAL NAVIGATION + BOT AI
   ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NUKETOWN_AI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const MOVING_STATES = new Set(['patrol', 'hunt', 'engage', 'reposition', 'retreat']);
  const SKILLS = {
    easy: {
      reaction: 0.62, turn: 2.35, error: 0.145, minError: 0.035,
      settle: 2.8, lead: 0.07, cone: 0.075, burstMin: 0.16,
      burstMax: 0.42, pauseMin: 0.30, pauseMax: 0.72, preferred: 10.0
    },
    normal: {
      reaction: 0.34, turn: 4.25, error: 0.080, minError: 0.018,
      settle: 1.8, lead: 0.14, cone: 0.060, burstMin: 0.30,
      burstMax: 0.72, pauseMin: 0.17, pauseMax: 0.43, preferred: 11.5
    },
    hard: {
      reaction: 0.15, turn: 7.1, error: 0.038, minError: 0.007,
      settle: 1.05, lead: 0.23, cone: 0.045, burstMin: 0.48,
      burstMax: 1.05, pauseMin: 0.08, pauseMax: 0.24, preferred: 13.0
    }
  };

  function finite(n, fallback) {
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
  }

  function angleWrap(a) {
    a = finite(a, 0) % TAU;
    if (a > Math.PI) a -= TAU;
    if (a < -Math.PI) a += TAU;
    return a;
  }

  function angleDelta(to, from) {
    return angleWrap(to - from);
  }

  function slewAngle(from, to, maxStep) {
    const d = angleDelta(to, from);
    return angleWrap(from + clamp(d, -maxStep, maxStep));
  }

  function dist2D(a, b) {
    const dx = finite(a.x, 0) - finite(b.x, 0);
    const dz = finite(a.z, 0) - finite(b.z, 0);
    return Math.hypot(dx, dz);
  }

  function distSq3(a, b) {
    const dx = finite(a.x, 0) - finite(b.x, 0);
    const dy = finite(a.y, 0) - finite(b.y, 0);
    const dz = finite(a.z, 0) - finite(b.z, 0);
    return dx * dx + dy * dy + dz * dz;
  }

  function hashSeed(value) {
    let x = (Number(value) || 0) | 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return (x >>> 0) || 0x6d2b79f5;
  }

  function makeRng(seed) {
    let x = hashSeed(seed);
    return function seededRandom() {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 4294967296;
    };
  }

  function cylinderIntersectsBox(x, z, radius, y0, y1, solid) {
    if (solid.max[1] <= y0 + 0.015 || solid.min[1] >= y1 - 0.015) return false;
    const cx = clamp(x, solid.min[0], solid.max[0]);
    const cz = clamp(z, solid.min[2], solid.max[2]);
    const dx = x - cx;
    const dz = z - cz;
    return dx * dx + dz * dz < radius * radius - 1e-8;
  }

  function buildNav(map) {
    if (!map || !map.bounds || !Array.isArray(map.levels) ||
        !Array.isArray(map.solids) || !map.actor) {
      throw new TypeError('buildNav requires a valid Nuketown map spec');
    }

    const cellSize = 0.85;
    const bounds = map.bounds;
    const width = Math.max(1, Math.floor((bounds.maxX - bounds.minX) / cellSize));
    const height = Math.max(1, Math.floor((bounds.maxZ - bounds.minZ) / cellSize));
    const stepX = (bounds.maxX - bounds.minX) / width;
    const stepZ = (bounds.maxZ - bounds.minZ) / height;
    const levelCount = map.levels.length;
    const grid = new Int32Array(width * height * levelCount);
    grid.fill(-1);
    const nodes = [];
    const radius = map.actor.radius;
    const actorHeight = map.actor.height;

    function index(level, gx, gz) {
      return level * width * height + gz * width + gx;
    }

    function worldX(gx) {
      return bounds.minX + (gx + 0.5) * stepX;
    }

    function worldZ(gz) {
      return bounds.minZ + (gz + 0.5) * stepZ;
    }

    function supported(x, z, levelIndex) {
      if (levelIndex === 0) return true;
      const y = map.levels[levelIndex];
      for (let i = 0; i < map.platforms.length; i++) {
        const p = map.platforms[i];
        if (Math.abs(p.y - y) > 0.08) continue;
        if (x >= p.min[0] - 0.01 && x <= p.max[0] + 0.01 &&
            z >= p.min[1] - 0.01 && z <= p.max[1] + 0.01) return true;
      }
      return false;
    }

    function clearAt(x, z, levelIndex) {
      const y = map.levels[levelIndex];
      for (let i = 0; i < map.solids.length; i++) {
        if (cylinderIntersectsBox(x, z, radius, y, y + actorHeight, map.solids[i])) {
          return false;
        }
      }
      return true;
    }

    function walkableAt(x, z, levelIndex) {
      return x >= bounds.minX + radius && x <= bounds.maxX - radius &&
        z >= bounds.minZ + radius && z <= bounds.maxZ - radius &&
        supported(x, z, levelIndex) && clearAt(x, z, levelIndex);
    }

    function coverAt(x, z, levelIndex) {
      const y = map.levels[levelIndex];
      let score = 0;
      for (let i = 0; i < map.solids.length; i++) {
        const solid = map.solids[i];
        if (solid.max[1] < y + 0.62 || solid.min[1] > y + map.actor.eye) continue;
        const cx = clamp(x, solid.min[0], solid.max[0]);
        const cz = clamp(z, solid.min[2], solid.max[2]);
        const distance = Math.hypot(x - cx, z - cz);
        if (distance <= radius + 0.04 || distance >= 2.7) continue;
        score = Math.max(score, 1 - distance / 2.7);
      }
      return score;
    }

    for (let level = 0; level < levelCount; level++) {
      for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
          const x = worldX(gx);
          const z = worldZ(gz);
          if (!walkableAt(x, z, level)) continue;
          const id = nodes.length;
          grid[index(level, gx, gz)] = id;
          nodes.push({
            id: id, x: x, y: map.levels[level], z: z,
            level: level, gx: gx, gz: gz, cover: coverAt(x, z, level), edges: []
          });
        }
      }
    }

    function edgeExists(from, to) {
      const edges = nodes[from].edges;
      for (let i = 0; i < edges.length; i++) {
        if (edges[i].to === to) return true;
      }
      return false;
    }

    function addEdge(from, to, type) {
      if (from < 0 || to < 0 || from === to || edgeExists(from, to)) return;
      const a = nodes[from];
      const b = nodes[to];
      nodes[from].edges.push({
        to: to,
        type: type || 'walk',
        cost: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
      });
    }

    const neighborDirs = [
      [-1, 0], [1, 0], [0, -1], [0, 1],
      [-1, -1], [1, -1], [-1, 1], [1, 1]
    ];
    for (let level = 0; level < levelCount; level++) {
      for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
          const from = grid[index(level, gx, gz)];
          if (from < 0) continue;
          for (let d = 0; d < neighborDirs.length; d++) {
            const dx = neighborDirs[d][0];
            const dz = neighborDirs[d][1];
            const nx = gx + dx;
            const nz = gz + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
            const to = grid[index(level, nx, nz)];
            if (to < 0) continue;
            if (dx && dz) {
              if (grid[index(level, gx + dx, gz)] < 0 ||
                  grid[index(level, gx, gz + dz)] < 0) continue;
            }
            addEdge(from, to, 'walk');
          }
        }
      }
    }

    function nearestOnLevel(x, z, level, maxRadiusCells) {
      const rawX = Math.floor((x - bounds.minX) / stepX);
      const rawZ = Math.floor((z - bounds.minZ) / stepZ);
      let best = -1;
      let bestD = Infinity;
      const limit = maxRadiusCells == null ? Math.max(width, height) : maxRadiusCells;
      for (let r = 0; r <= limit; r++) {
        const minX = Math.max(0, rawX - r);
        const maxX = Math.min(width - 1, rawX + r);
        const minZ = Math.max(0, rawZ - r);
        const maxZ = Math.min(height - 1, rawZ + r);
        for (let gz = minZ; gz <= maxZ; gz++) {
          for (let gx = minX; gx <= maxX; gx++) {
            if (r > 0 && gx !== minX && gx !== maxX && gz !== minZ && gz !== maxZ) continue;
            const id = grid[index(level, gx, gz)];
            if (id < 0) continue;
            const n = nodes[id];
            const dd = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
            if (dd < bestD) {
              bestD = dd;
              best = id;
            }
          }
        }
        if (best >= 0 && r >= 2) break;
      }
      return best;
    }

    for (let i = 0; i < map.links.length; i++) {
      const link = map.links[i];
      let aLevel = 0;
      let bLevel = 0;
      for (let l = 1; l < levelCount; l++) {
        if (Math.abs(map.levels[l] - link.a[1]) < Math.abs(map.levels[aLevel] - link.a[1])) aLevel = l;
        if (Math.abs(map.levels[l] - link.b[1]) < Math.abs(map.levels[bLevel] - link.b[1])) bLevel = l;
      }
      const dx = link.b[0] - link.a[0];
      const dz = link.b[2] - link.a[2];
      const length = Math.max(0.001, Math.hypot(dx, dz));
      const px = -dz / length;
      const pz = dx / length;
      const laneOffset = Math.max(0, Math.min(finite(link.w, cellSize) * 0.3, cellSize * 0.62));
      const offsets = laneOffset > cellSize * 0.35 ? [-laneOffset, 0, laneOffset] : [0];
      for (let lane = 0; lane < offsets.length; lane++) {
        const offset = offsets[lane];
        const a = nearestOnLevel(link.a[0] + px * offset, link.a[2] + pz * offset, aLevel, 8);
        const b = nearestOnLevel(link.b[0] + px * offset, link.b[2] + pz * offset, bLevel, 8);
        addEdge(a, b, 'stair');
        addEdge(b, a, 'stair');
      }
    }

    let dropEdgeCount = 0;
    for (let level = 1; level < levelCount; level++) {
      let belowLevel = -1;
      let belowFall = Infinity;
      for (let l = 0; l < level; l++) {
        const fall = map.levels[level] - map.levels[l];
        if (fall > 0 && fall <= 4.0 && fall < belowFall) {
          belowFall = fall;
          belowLevel = l;
        }
      }
      if (belowLevel < 0) continue;
      const cardinal = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (let gz = 0; gz < height; gz++) {
        for (let gx = 0; gx < width; gx++) {
          const from = grid[index(level, gx, gz)];
          if (from < 0) continue;
          for (let d = 0; d < cardinal.length; d++) {
            const nx = gx + cardinal[d][0];
            const nz = gz + cardinal[d][1];
            if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
            if (grid[index(level, nx, nz)] >= 0) continue;
            const airX = worldX(nx);
            const airZ = worldZ(nz);
            if (!clearAt(airX, airZ, level)) continue;
            let to = grid[index(belowLevel, nx, nz)];
            if (to < 0) to = nearestOnLevel(airX, airZ, belowLevel, 2);
            if (to < 0) continue;
            if (!edgeExists(from, to)) {
              addEdge(from, to, 'drop');
              dropEdgeCount++;
            }
          }
        }
      }
    }

    function lineWalkable(a, b) {
      if (!a || !b || a.level !== b.level) return false;
      const distance = Math.hypot(b.x - a.x, b.z - a.z);
      const samples = Math.max(1, Math.ceil(distance / (cellSize * 0.32)));
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        if (!walkableAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, a.level)) {
          return false;
        }
      }
      return true;
    }

    function nearest(x, y, z) {
      x = finite(x, 0);
      y = finite(y, 0);
      z = finite(z, 0);
      let preferred = 0;
      for (let l = 1; l < levelCount; l++) {
        if (Math.abs(map.levels[l] - y) < Math.abs(map.levels[preferred] - y)) preferred = l;
      }
      let id = nearestOnLevel(x, z, preferred, 10);
      if (id >= 0) return id;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const dd = (n.x - x) * (n.x - x) + (n.y - y) * (n.y - y) +
          (n.z - z) * (n.z - z);
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      return best;
    }

    function heuristic(a, b) {
      return Math.hypot(a.x - b.x, a.z - b.z);
    }

    function findEdge(from, to) {
      const edges = nodes[from].edges;
      for (let i = 0; i < edges.length; i++) {
        if (edges[i].to === to) return edges[i];
      }
      return null;
    }

    function waypoint(id, via) {
      const n = nodes[id];
      return { x: n.x, y: n.y, z: n.z, level: n.level, nodeId: id, via: via || null };
    }

    function smoothPath(ids) {
      if (ids.length === 0) return [];
      if (ids.length === 1) return [waypoint(ids[0], null)];
      const result = [waypoint(ids[0], null)];
      let i = 0;
      while (i < ids.length - 1) {
        const immediate = findEdge(ids[i], ids[i + 1]);
        if (!immediate || immediate.type !== 'walk') {
          result.push(waypoint(ids[i + 1], immediate ? immediate.type : 'walk'));
          i++;
          continue;
        }
        let furthest = i + 1;
        for (let j = i + 2; j < ids.length; j++) {
          let ordinary = true;
          for (let k = i; k < j; k++) {
            const edge = findEdge(ids[k], ids[k + 1]);
            if (!edge || edge.type !== 'walk') {
              ordinary = false;
              break;
            }
          }
          if (!ordinary || nodes[ids[j]].level !== nodes[ids[i]].level ||
              !lineWalkable(nodes[ids[i]], nodes[ids[j]])) break;
          furthest = j;
        }
        result.push(waypoint(ids[furthest], 'walk'));
        i = furthest;
      }
      return result;
    }

    function findPath(start, goal, maxExpansions) {
      const startId = typeof start === 'number' ? start :
        nearest(start && start.x, start && start.y, start && start.z);
      const goalId = typeof goal === 'number' ? goal :
        nearest(goal && goal.x, goal && goal.y, goal && goal.z);
      if (startId < 0 || goalId < 0 || !nodes[startId] || !nodes[goalId]) return [];
      if (startId === goalId) return [waypoint(startId, null)];

      const cap = clamp(Math.floor(finite(maxExpansions, 850)), 32, 2400);
      const count = nodes.length;
      const g = new Float64Array(count);
      const parent = new Int32Array(count);
      const closed = new Uint8Array(count);
      g.fill(Infinity);
      parent.fill(-1);
      g[startId] = 0;
      const heapIds = [];
      const heapF = [];

      function heapPush(id, f) {
        let i = heapIds.length;
        heapIds.push(id);
        heapF.push(f);
        while (i > 0) {
          const p = (i - 1) >> 1;
          if (heapF[p] <= f) break;
          heapIds[i] = heapIds[p];
          heapF[i] = heapF[p];
          i = p;
        }
        heapIds[i] = id;
        heapF[i] = f;
      }

      function heapPop() {
        const id = heapIds[0];
        const lastId = heapIds.pop();
        const lastF = heapF.pop();
        if (heapIds.length > 0) {
          let i = 0;
          while (true) {
            let child = i * 2 + 1;
            if (child >= heapIds.length) break;
            if (child + 1 < heapIds.length && heapF[child + 1] < heapF[child]) child++;
            if (heapF[child] >= lastF) break;
            heapIds[i] = heapIds[child];
            heapF[i] = heapF[child];
            i = child;
          }
          heapIds[i] = lastId;
          heapF[i] = lastF;
        }
        return id;
      }

      heapPush(startId, heuristic(nodes[startId], nodes[goalId]));
      let best = startId;
      let bestH = heuristic(nodes[startId], nodes[goalId]);
      let expansions = 0;
      while (heapIds.length && expansions < cap) {
        const current = heapPop();
        if (closed[current]) continue;
        closed[current] = 1;
        expansions++;
        const h = heuristic(nodes[current], nodes[goalId]);
        if (h < bestH || (h === bestH && g[current] < g[best])) {
          bestH = h;
          best = current;
        }
        if (current === goalId) {
          best = current;
          break;
        }
        const edges = nodes[current].edges;
        for (let i = 0; i < edges.length; i++) {
          const edge = edges[i];
          if (closed[edge.to]) continue;
          const tentative = g[current] + edge.cost;
          if (tentative + 1e-9 >= g[edge.to]) continue;
          g[edge.to] = tentative;
          parent[edge.to] = current;
          heapPush(edge.to, tentative + heuristic(nodes[edge.to], nodes[goalId]));
        }
      }

      const ids = [];
      let cursor = best;
      let guard = count + 1;
      while (cursor >= 0 && guard-- > 0) {
        ids.push(cursor);
        if (cursor === startId) break;
        cursor = parent[cursor];
      }
      if (ids[ids.length - 1] !== startId) return [waypoint(startId, null)];
      ids.reverse();
      return smoothPath(ids);
    }

    function isSegmentTraversable(a, b) {
      if (!a || !b) return false;
      if (a.level === b.level) return lineWalkable(a, b);
      const from = typeof a.nodeId === 'number' ? a.nodeId : nearest(a.x, a.y, a.z);
      const to = typeof b.nodeId === 'number' ? b.nodeId : nearest(b.x, b.y, b.z);
      return !!findEdge(from, to);
    }

    const nav = {
      cellSize: cellSize,
      width: width,
      height: height,
      levels: map.levels.slice(),
      bounds: bounds,
      actor: {
        radius: map.actor.radius,
        height: map.actor.height,
        eye: map.actor.eye,
        step: map.actor.step
      },
      nodes: nodes,
      grid: grid,
      dropEdgeCount: dropEdgeCount,
      nearest: nearest,
      findPath: findPath,
      lineWalkable: lineWalkable,
      isSegmentTraversable: isSegmentTraversable,
      nodeAt: function nodeAt(level, gx, gz) {
        if (level < 0 || level >= levelCount || gx < 0 || gx >= width || gz < 0 || gz >= height) return -1;
        return grid[index(level, gx, gz)];
      }
    };
    return nav;
  }

  function createBrain(options) {
    options = options || {};
    const id = options.id == null ? 0 : options.id;
    const skillName = SKILLS[options.skill] ? options.skill : 'normal';
    const random = makeRng((Number(options.seed) || 1) ^ Math.imul(Number(id) || 0, 0x9e3779b1));
    return {
      id: id,
      skill: skillName,
      state: 'spawn',
      stateSince: 0,
      targetId: null,
      targetSeenAt: -Infinity,
      acquiredAt: -Infinity,
      lastKnown: null,
      aimYaw: 0,
      aimPitch: 0,
      initializedAim: false,
      path: [],
      pathIndex: 0,
      goal: null,
      goalKind: null,
      nextTargetEval: (hashSeed(id) % 12) * 0.01,
      targetScan: 0,
      nextDecision: 0,
      visibility: new Map(),
      strafeSign: random() < 0.5 ? -1 : 1,
      nextStrafe: 0,
      burstUntil: 0,
      pauseUntil: 0,
      progressPos: null,
      progressAt: 0,
      wasTryingMove: false,
      stuckAttempts: 0,
      escapeUntil: 0,
      escapeAngle: random() * TAU,
      patrolCount: 0,
      stateChanges: 0,
      phase: random() * TAU,
      phase2: random() * TAU,
      rand: random
    };
  }

  function setState(brain, state, now) {
    if (brain.state === state) return;
    brain.state = state;
    brain.stateSince = now;
    brain.stateChanges++;
  }

  function actorEyeY(nav, actor) {
    return finite(actor.pos && actor.pos.y, 0) + (nav.actor ? nav.actor.eye : 1.62);
  }

  function safeCanSee(view, a, b) {
    if (typeof view.canSee !== 'function') return false;
    try {
      return !!view.canSee(
        finite(a.x, 0), finite(a.y, 0), finite(a.z, 0),
        finite(b.x, 0), finite(b.y, 0), finite(b.z, 0)
      );
    } catch (_) {
      return false;
    }
  }

  function cachedVisibility(brain, view, actor, now, forceFresh) {
    const cached = brain.visibility.get(actor.id);
    const ttl = 0.12 + ((hashSeed(brain.id) & 31) / 1000);
    if (!forceFresh && cached && now - cached.at < ttl) return cached.visible;
    const nav = view.nav;
    const self = view.self;
    const from = {
      x: finite(self.pos && self.pos.x, 0),
      y: actorEyeY(nav, self),
      z: finite(self.pos && self.pos.z, 0)
    };
    const to = {
      x: finite(actor.pos && actor.pos.x, 0),
      y: actorEyeY(nav, actor),
      z: finite(actor.pos && actor.pos.z, 0)
    };
    const visible = safeCanSee(view, from, to);
    brain.visibility.set(actor.id, { visible: visible, at: now });
    return visible;
  }

  function livingActors(view) {
    return Array.isArray(view.actors) ? view.actors : [];
  }

  function findActor(view, id) {
    const actors = livingActors(view);
    for (let i = 0; i < actors.length; i++) {
      if (actors[i] && actors[i].id === id && actors[i].alive !== false &&
          finite(actors[i].health, 1) > 0 && actors[i].pos) return actors[i];
    }
    return null;
  }

  function evaluateTarget(brain, view, now) {
    const actors = livingActors(view);
    const selfPos = view.self.pos || { x: 0, y: 0, z: 0 };
    const candidates = [];
    for (let i = 0; i < actors.length; i++) {
      const actor = actors[i];
      if (!actor || actor.id === view.self.id || actor.alive === false ||
          finite(actor.health, 1) <= 0 || !actor.pos) continue;
      candidates.push({ actor: actor, d2: distSq3(selfPos, actor.pos) });
    }
    candidates.sort(function byDistance(a, b) { return a.d2 - b.d2; });

    const current = findActor(view, brain.targetId);
    let currentVisible = false;
    let currentD2 = Infinity;
    if (current) {
      currentD2 = distSq3(selfPos, current.pos);
      currentVisible = cachedVisibility(brain, view, current, now, false);
      if (currentVisible) {
        brain.targetSeenAt = now;
        brain.lastKnown = {
          x: finite(current.pos.x, 0), y: finite(current.pos.y, 0), z: finite(current.pos.z, 0)
        };
      }
    }

    let best = currentVisible ? current : null;
    let bestD2 = currentVisible ? currentD2 : Infinity;
    const checks = Math.min(candidates.length, 4);
    for (let i = 0; i < checks; i++) {
      const candidateIndex = (brain.targetScan + i) % Math.max(1, candidates.length);
      const actor = candidates[candidateIndex].actor;
      if (current && actor.id === current.id) continue;
      if (!cachedVisibility(brain, view, actor, now, false)) continue;
      const d2 = candidates[candidateIndex].d2;
      if (!best || d2 < bestD2 * 0.58) {
        best = actor;
        bestD2 = d2;
      }
    }
    if (candidates.length) brain.targetScan = (brain.targetScan + checks) % candidates.length;

    if (best && best.id !== brain.targetId) {
      brain.targetId = best.id;
      brain.acquiredAt = now;
      brain.targetSeenAt = now;
      brain.lastKnown = {
        x: finite(best.pos.x, 0), y: finite(best.pos.y, 0), z: finite(best.pos.z, 0)
      };
      brain.burstUntil = 0;
      brain.pauseUntil = 0;
    } else if (!best && (!current || now - brain.targetSeenAt > 3.6)) {
      brain.targetId = null;
    }
  }

  function chooseNodeGoal(brain, nav, selfPos, kind, threatPos) {
    if (!nav || !nav.nodes || nav.nodes.length === 0) return null;
    const currentId = nav.nearest(selfPos.x, selfPos.y, selfPos.z);
    const current = nav.nodes[currentId] || nav.nodes[0];
    let best = null;
    let bestScore = -Infinity;
    const count = nav.nodes.length;
    const samples = Math.min(56, count);
    const wantUpper = kind === 'patrol' &&
      ((brain.patrolCount + (hashSeed(brain.id) & 1)) % 3 === 1);
    for (let i = 0; i < samples; i++) {
      const idx = Math.floor(brain.rand() * count);
      const n = nav.nodes[idx];
      if (!n) continue;
      if (kind === 'reposition' && current.level === 0 && n.level === 0) continue;
      const travel = Math.hypot(n.x - current.x, n.z - current.z);
      if (travel < 5.0) continue;
      let score = travel * 0.18 + brain.rand() * 2.0;
      if (kind === 'patrol') {
        if (wantUpper === (n.level > 0)) score += 12;
        if (travel > 12 && travel < 31) score += 5;
      } else if (threatPos) {
        const threatDistance = Math.hypot(n.x - threatPos.x, n.z - threatPos.z);
        const curThreat = Math.hypot(current.x - threatPos.x, current.z - threatPos.z);
        const awayX = current.x - threatPos.x;
        const awayZ = current.z - threatPos.z;
        const candidateX = n.x - current.x;
        const candidateZ = n.z - current.z;
        const directional = (awayX * candidateX + awayZ * candidateZ) /
          Math.max(1, Math.hypot(awayX, awayZ) * Math.hypot(candidateX, candidateZ));
        score += threatDistance * (kind === 'retreat' ? 2.4 : 0.7) +
          directional * (kind === 'retreat' ? 10 : 3);
        score += finite(n.cover, 0) * (kind === 'retreat' ? 10 : 7);
        if (kind === 'reposition' && threatDistance > 7 && threatDistance < 18) score += 7;
        if (n.level !== current.level) {
          score += kind === 'retreat' ? 25 - travel * 0.65 : 32 - travel * 0.9;
        }
        if (threatDistance < curThreat - 2) score -= 12;
      }
      if (score > bestScore) {
        bestScore = score;
        best = { x: n.x, y: n.y, z: n.z, nodeId: n.id };
      }
    }
    if (!best) {
      const n = nav.nodes[Math.floor(brain.rand() * count)] || current;
      best = { x: n.x, y: n.y, z: n.z, nodeId: n.id };
    }
    return best;
  }

  function setGoal(brain, goal, kind) {
    brain.goal = goal;
    brain.goalKind = kind;
    brain.path = [];
    brain.pathIndex = 0;
  }

  function ensurePath(brain, view, goal) {
    const nav = view.nav;
    if (!nav || typeof nav.findPath !== 'function' || !goal) return;
    const selfPos = view.self.pos || { x: 0, y: 0, z: 0 };
    const movedGoal = !brain.goal || dist2D(brain.goal, goal) > 2.5 ||
      Math.abs(finite(brain.goal.y, 0) - finite(goal.y, 0)) > 1.5;
    if (movedGoal) {
      brain.goal = { x: goal.x, y: goal.y, z: goal.z, nodeId: goal.nodeId };
      brain.path = [];
      brain.pathIndex = 0;
    }
    if (brain.path.length && brain.pathIndex < brain.path.length) return;
    brain.path = nav.findPath(selfPos, goal, 900);
    brain.pathIndex = 0;
    while (brain.pathIndex < brain.path.length &&
      dist2D(selfPos, brain.path[brain.pathIndex]) < 0.65 &&
      Math.abs(finite(selfPos.y, 0) - brain.path[brain.pathIndex].y) < 1.0) {
      brain.pathIndex++;
    }
  }

  function followPath(brain, view) {
    const pos = view.self.pos || { x: 0, y: 0, z: 0 };
    while (brain.pathIndex < brain.path.length) {
      const waypoint = brain.path[brain.pathIndex];
      const horizontal = dist2D(pos, waypoint);
      const vertical = Math.abs(finite(pos.y, 0) - finite(waypoint.y, 0));
      if (horizontal < 0.52 && (vertical < 0.85 || waypoint.via === 'stair' || waypoint.via === 'drop')) {
        brain.pathIndex++;
      } else {
        break;
      }
    }
    if (brain.pathIndex >= brain.path.length) return { x: 0, z: 0, jump: false };
    const wp = brain.path[brain.pathIndex];
    const dx = wp.x - finite(pos.x, 0);
    const dz = wp.z - finite(pos.z, 0);
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return { x: 0, z: 0, jump: false };
    return {
      x: dx / len,
      z: dz / len,
      jump: wp.via === 'drop' || (wp.via === 'stair' && wp.y > finite(pos.y, 0) + 0.6)
    };
  }

  function updateUnstuck(brain, view, now) {
    const pos = view.self.pos || { x: 0, y: 0, z: 0 };
    if (!brain.progressPos) {
      brain.progressPos = { x: finite(pos.x, 0), z: finite(pos.z, 0) };
      brain.progressAt = now;
      return;
    }
    if (!brain.wasTryingMove) {
      brain.progressPos.x = finite(pos.x, 0);
      brain.progressPos.z = finite(pos.z, 0);
      brain.progressAt = now;
      return;
    }
    if (now - brain.progressAt < 1.2) return;
    const moved = Math.hypot(
      finite(pos.x, 0) - brain.progressPos.x,
      finite(pos.z, 0) - brain.progressPos.z
    );
    if (moved < 0.35) {
      brain.stuckAttempts++;
      brain.path = [];
      brain.pathIndex = 0;
      brain.escapeUntil = now + 0.7;
      brain.escapeAngle = angleWrap(brain.escapeAngle + 1.9 + brain.rand() * 1.5);
      if (brain.stuckAttempts >= 2) {
        brain.goal = null;
        brain.goalKind = null;
        brain.lastKnown = null;
        brain.nextDecision = 0;
        brain.stuckAttempts = 0;
      }
    } else {
      brain.stuckAttempts = 0;
    }
    brain.progressPos.x = finite(pos.x, 0);
    brain.progressPos.z = finite(pos.z, 0);
    brain.progressAt = now;
  }

  function updateAim(brain, view, target, visible, now, dt) {
    const nav = view.nav || { actor: { eye: 1.62 } };
    const self = view.self;
    const skill = SKILLS[brain.skill];
    if (!brain.initializedAim) {
      brain.aimYaw = finite(self.yaw, 0);
      brain.aimPitch = finite(self.pitch, 0);
      brain.initializedAim = true;
    }
    let desiredYaw = brain.aimYaw;
    let desiredPitch = brain.aimPitch;
    if (target && target.pos && now - brain.acquiredAt >= skill.reaction) {
      const tracked = Math.max(0, now - brain.acquiredAt - skill.reaction);
      const lead = skill.lead;
      const tx = finite(target.pos.x, 0) + finite(target.vel && target.vel.x, 0) * lead;
      const ty = actorEyeY(nav, target) + finite(target.vel && target.vel.y, 0) * lead;
      const tz = finite(target.pos.z, 0) + finite(target.vel && target.vel.z, 0) * lead;
      const sx = finite(self.pos && self.pos.x, 0);
      const sy = actorEyeY(nav, self);
      const sz = finite(self.pos && self.pos.z, 0);
      const dx = tx - sx;
      const dy = ty - sy;
      const dz = tz - sz;
      const horizontal = Math.max(0.001, Math.hypot(dx, dz));
      const shrink = Math.exp(-tracked / skill.settle);
      const error = skill.minError + skill.error * shrink;
      const wanderYaw = Math.sin(now * 1.73 + brain.phase) * error +
        Math.sin(now * 0.57 + brain.phase2) * error * 0.35;
      const wanderPitch = Math.sin(now * 1.31 + brain.phase2) * error * 0.58;
      desiredYaw = Math.atan2(dz, dx) + wanderYaw;
      desiredPitch = Math.atan2(dy, horizontal) + wanderPitch;
    } else if (!target || !visible) {
      desiredYaw = angleWrap(finite(self.yaw, brain.aimYaw) +
        Math.sin(now * 0.45 + brain.phase) * 0.18);
      desiredPitch = clamp(finite(self.pitch, brain.aimPitch) * 0.8, -0.45, 0.45);
    }
    const maxStep = skill.turn * dt;
    brain.aimYaw = slewAngle(brain.aimYaw, desiredYaw, maxStep);
    brain.aimPitch += clamp(desiredPitch - brain.aimPitch, -maxStep, maxStep);
    brain.aimPitch = clamp(finite(brain.aimPitch, 0), -1.5, 1.5);
  }

  function aimErrorToTarget(brain, view, target) {
    if (!target || !target.pos) return Infinity;
    const nav = view.nav || { actor: { eye: 1.62 } };
    const sx = finite(view.self.pos && view.self.pos.x, 0);
    const sy = actorEyeY(nav, view.self);
    const sz = finite(view.self.pos && view.self.pos.z, 0);
    const dx = finite(target.pos.x, 0) - sx;
    const dy = actorEyeY(nav, target) - sy;
    const dz = finite(target.pos.z, 0) - sz;
    const yaw = Math.atan2(dz, dx);
    const pitch = Math.atan2(dy, Math.max(0.001, Math.hypot(dx, dz)));
    return Math.hypot(angleDelta(yaw, brain.aimYaw), pitch - brain.aimPitch);
  }

  function burstAllowsFire(brain, now) {
    const skill = SKILLS[brain.skill];
    if (now < brain.pauseUntil) return false;
    if (now >= brain.burstUntil) {
      brain.burstUntil = now + skill.burstMin + brain.rand() * (skill.burstMax - skill.burstMin);
      brain.pauseUntil = brain.burstUntil + skill.pauseMin +
        brain.rand() * (skill.pauseMax - skill.pauseMin);
    }
    return now < brain.burstUntil;
  }

  function normalizedIntent(intent, brain) {
    return {
      moveX: clamp(finite(intent.moveX, 0), -1, 1),
      moveZ: clamp(finite(intent.moveZ, 0), -1, 1),
      jump: !!intent.jump,
      aimYaw: angleWrap(finite(intent.aimYaw, brain.aimYaw || 0)),
      aimPitch: clamp(finite(intent.aimPitch, brain.aimPitch || 0), -1.5, 1.5),
      fire: !!intent.fire,
      reload: !!intent.reload,
      targetId: intent.targetId == null ? null : intent.targetId,
      state: typeof intent.state === 'string' ? intent.state : 'patrol'
    };
  }

  function think(brain, view, dt) {
    if (!brain || !view || !view.self) {
      const fallbackBrain = brain || { aimYaw: 0, aimPitch: 0 };
      return normalizedIntent({
        moveX: 0, moveZ: 0, jump: false, aimYaw: 0, aimPitch: 0,
        fire: false, reload: false, targetId: null, state: 'spawn'
      }, fallbackBrain);
    }
    dt = clamp(finite(dt, 1 / 60), 0.001, 0.25);
    const now = finite(view.time, 0);
    const nav = view.nav;
    const self = view.self.pos ? view.self : Object.assign({}, view.self, {
      pos: { x: 0, y: 0, z: 0 }
    });

    updateUnstuck(brain, view, now);

    if (brain.nextTargetEval <= now) {
      evaluateTarget(brain, view, now);
      brain.nextTargetEval = now + 0.13 + ((hashSeed(brain.id) & 15) / 500);
    } else if (brain.targetId != null && !findActor(view, brain.targetId) &&
      now - brain.targetSeenAt > 3.6) {
      brain.targetId = null;
    }

    const target = findActor(view, brain.targetId);
    let visible = false;
    if (target) {
      visible = cachedVisibility(brain, view, target, now, false);
      if (visible) {
        brain.targetSeenAt = now;
        brain.lastKnown = {
          x: finite(target.pos.x, 0), y: finite(target.pos.y, 0), z: finite(target.pos.z, 0)
        };
      }
    }

    const healthRatio = finite(self.maxHealth, 100) > 0 ?
      finite(self.health, 0) / finite(self.maxHealth, 100) : 0;
    const ammo = Math.max(0, finite(self.ammo, 0));
    const magSize = Math.max(1, finite(self.magSize, 1));
    const reserve = Math.max(0, finite(self.reserve, 0));
    const inContact = !!target && (visible || now - brain.targetSeenAt < 1.0);
    let reload = false;

    if (brain.state === 'spawn' && now - brain.stateSince > 0.18) {
      setState(brain, 'patrol', now);
    }
    if (self.reloading) {
      setState(brain, 'reload', now);
    } else if (ammo <= 0 && reserve > 0) {
      reload = true;
      setState(brain, 'reload', now);
    } else if (!inContact && reserve > 0 && ammo < magSize * 0.48) {
      reload = true;
      setState(brain, 'reload', now);
    } else if (target && healthRatio < 0.25) {
      setState(brain, 'retreat', now);
    } else if (brain.state === 'reposition' && brain.goal &&
      dist2D(self.pos, brain.goal) >= 1.0 && now - brain.stateSince < 12.0) {
      // Commit long enough to actually reach cover or change floors instead of
      // oscillating back to engage as the range changes by a few centimetres.
    } else if (target && visible) {
      const range = dist2D(self.pos, target.pos);
      if (healthRatio < 0.62 || range < SKILLS[brain.skill].preferred * 0.45) {
        setState(brain, 'reposition', now);
      } else {
        setState(brain, 'engage', now);
      }
    } else if (target && brain.lastKnown && now - brain.targetSeenAt <= 3.6) {
      setState(brain, 'hunt', now);
    } else if (brain.state === 'reload' && !self.reloading && !reload) {
      setState(brain, 'patrol', now);
    } else if (brain.state !== 'patrol' && brain.state !== 'spawn') {
      setState(brain, 'patrol', now);
    }

    let movement = { x: 0, z: 0, jump: false };
    const movingState = MOVING_STATES.has(brain.state);
    if (now < brain.escapeUntil) {
      movement.x = Math.cos(brain.escapeAngle);
      movement.z = Math.sin(brain.escapeAngle);
      movement.jump = true;
    } else if (brain.state === 'engage' && target) {
      if (now >= brain.nextStrafe) {
        if (brain.rand() < 0.7) brain.strafeSign *= -1;
        brain.nextStrafe = now + 0.65 + brain.rand() * 1.0;
      }
      const dx = finite(target.pos.x, 0) - finite(self.pos.x, 0);
      const dz = finite(target.pos.z, 0) - finite(self.pos.z, 0);
      const range = Math.max(0.001, Math.hypot(dx, dz));
      const ux = dx / range;
      const uz = dz / range;
      const radial = clamp((range - SKILLS[brain.skill].preferred) / 5.0, -0.62, 0.42);
      movement.x = -uz * brain.strafeSign * 0.92 + ux * radial;
      movement.z = ux * brain.strafeSign * 0.92 + uz * radial;
    } else if (brain.state === 'hunt' && brain.lastKnown) {
      const huntGoal = brain.lastKnown;
      ensurePath(brain, view, huntGoal);
      movement = followPath(brain, view);
      if (dist2D(self.pos, huntGoal) < 1.2) {
        brain.targetId = null;
        brain.lastKnown = null;
        setState(brain, 'patrol', now);
      }
    } else if ((brain.state === 'retreat' || brain.state === 'reposition') &&
      (target || brain.goal)) {
      if (target && (!brain.goal || brain.goalKind !== brain.state ||
          dist2D(self.pos, brain.goal) < 1.0)) {
        setGoal(brain, chooseNodeGoal(brain, nav, self.pos, brain.state, target.pos), brain.state);
        brain.nextDecision = now + (brain.state === 'retreat' ? 2.2 : 1.7);
      }
      ensurePath(brain, view, brain.goal);
      movement = followPath(brain, view);
    } else if (brain.state === 'patrol' || brain.state === 'spawn') {
      if (!brain.goal || brain.goalKind !== 'patrol' ||
          brain.pathIndex >= brain.path.length || dist2D(self.pos, brain.goal) < 1.0) {
        brain.patrolCount++;
        setGoal(brain, chooseNodeGoal(brain, nav, self.pos, 'patrol', null), 'patrol');
      }
      ensurePath(brain, view, brain.goal);
      movement = followPath(brain, view);
    }

    if (brain.state === 'reload' && target && visible) {
      const dx = finite(self.pos.x, 0) - finite(target.pos.x, 0);
      const dz = finite(self.pos.z, 0) - finite(target.pos.z, 0);
      const len = Math.max(0.001, Math.hypot(dx, dz));
      movement = { x: dx / len, z: dz / len, jump: false };
    }

    updateAim(brain, view, target, visible, now, dt);
    let fire = false;
    if (target && visible && ammo > 0 && !self.reloading &&
        now - brain.acquiredAt >= SKILLS[brain.skill].reaction &&
        aimErrorToTarget(brain, view, target) <= SKILLS[brain.skill].cone &&
        burstAllowsFire(brain, now)) {
      fire = true;
    }

    brain.wasTryingMove = movingState &&
      Math.hypot(finite(movement.x, 0), finite(movement.z, 0)) > 0.25;
    return normalizedIntent({
      moveX: movement.x,
      moveZ: movement.z,
      jump: movement.jump,
      aimYaw: brain.aimYaw,
      aimPitch: brain.aimPitch,
      fire: fire,
      reload: reload,
      targetId: target ? target.id : null,
      state: brain.state
    }, brain);
  }

  return {
    buildNav: buildNav,
    createBrain: createBrain,
    think: think
  };
});
