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

/* Explicit assignments keep the API stable even though the implementation
   lives in a classic script with shared top-level lexical bindings. */
globalThis.setActiveMap = setActiveMap;
globalThis.activeMapId = activeMapId;
