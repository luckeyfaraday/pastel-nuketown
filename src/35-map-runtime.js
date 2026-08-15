/* =====================================================================
   PASTEL NUKETOWN — active map lifecycle
   ===================================================================== */

function activeMapId() { return ACTIVE_MAP_ID; }

function setActiveMap(id) {
  const next = MAPS.get(id);
  if (!next) return false;
  if (id === ACTIVE_MAP_ID) return true;

  const previousMap = MAP;
  const previousId = ACTIVE_MAP_ID;
  const hadWorld = !!WORLD.group;

  MAP = next;
  ACTIVE_MAP_ID = id;
  bindPhysicsMap(next);

  if (!hadWorld) return true;

  disposeWorld();
  try {
    buildWorld();
    if (typeof initAI === 'function') initAI();
  } catch (error) {
    /* A registered map with a broken render hook is a developer error. Put
       the previous map back before surfacing it so callers never observe a
       half-applied world/physics pairing. */
    disposeWorld();
    MAP = previousMap;
    ACTIVE_MAP_ID = previousId;
    bindPhysicsMap(previousMap);
    buildWorld();
    if (typeof initAI === 'function') initAI();
    throw error;
  }
  return true;
}

/* =====================================================================
   ROTATION
   Map selection is a rotation, not a pick: a match ends and the next map
   in the pool loads. Nobody chooses, so both maps actually get played and
   the title screen keeps one card instead of a third control.

   The swap is DEFERRED rather than done in endMatch, because endMatch
   leaves you standing in the map reading the scoreboard — rebuilding the
   world underneath that is the one moment it must not happen. The flag is
   spent by whichever comes first: returning to the title (so the card
   shows what is next) or pressing REMATCH straight from the over screen.
   ===================================================================== */
let MAP_ROTATE_PENDING = false;

/* Only in solo. A room rotates as well, but the relay announces it and every
   page adopts it out of the round-start message — the relay is what decides a
   round has begun, so it is also what decides what the round is played on. A
   peer that rotated on its own instead would be playing different geometry
   from everyone else, which is the whole failure the handshake prevents. */
function mapRotationIsOurs() {
  return typeof NET !== 'object' || !NET || NET.mode === 'solo';
}

function queueMapRotation() {
  if (mapRotationIsOurs()) MAP_ROTATE_PENDING = true;
}

function applyPendingMapRotation() {
  if (!MAP_ROTATE_PENDING) return false;
  MAP_ROTATE_PENDING = false;
  if (!mapRotationIsOurs() || typeof MAPS.nextId !== 'function') return false;
  const next = MAPS.nextId(ACTIVE_MAP_ID);
  if (next === ACTIVE_MAP_ID) return false;
  /* A map whose render hook throws rolls back inside setActiveMap, so a
     broken map costs the rotation rather than the session. */
  try { return setActiveMap(next); } catch (error) { return false; }
}

/* Explicit assignments keep the API stable even though the implementation
   lives in a classic script with shared top-level lexical bindings. */
globalThis.setActiveMap = setActiveMap;
globalThis.activeMapId = activeMapId;
