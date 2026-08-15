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
   ROTATION, AND THE PICK THAT OUTRANKS IT
   The default is a rotation: a match ends and the next map in the pool
   loads, so both maps actually get played without anyone deciding. A
   player who does want to decide pins one from the MAP card, and a pin
   wins — a setting that quietly moved after every match would not be a
   setting. ROTATE is one of the picker's choices rather than a separate
   switch, so releasing the pin is the same gesture as making it.

   The swap is DEFERRED rather than done in endMatch, because endMatch
   leaves you standing in the map reading the scoreboard — rebuilding the
   world underneath that is the one moment it must not happen. The flag is
   spent by whichever comes first: returning to the title (so the card
   shows what is next) or pressing REMATCH straight from the over screen.

   The pin is session state, like the match mode: neither is persisted, so
   a reload starts both of them fresh.
   ===================================================================== */
let MAP_ROTATE_PENDING = false;
let MAP_PINNED_ID = null;             // null = rotate

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

/* A map whose render hook throws rolls back inside setActiveMap, so a broken
   map costs the swap rather than the session. */
function applyMapId(id) {
  try { return setActiveMap(id) === true; } catch (error) { return false; }
}

/* Everything that can move the map as the title comes back up, in the one
   order that is correct: a pin always wins, and the rotation only fires when
   there is nothing pinned. One entry, so no caller can get that order wrong.

   A pin outlives a room — the relay's map was adopted over the top of it —
   so this is also where the choice comes back once the session is ours
   again. Until then nothing moves: rebuilding the world under a room is the
   failure the whole handshake exists to prevent. */
function applyPendingMapRotation() {
  const pending = MAP_ROTATE_PENDING;
  MAP_ROTATE_PENDING = false;
  if (!mapRotationIsOurs()) return false;
  if (MAP_PINNED_ID) return applyMapId(MAP_PINNED_ID);
  if (!pending || typeof MAPS.nextId !== 'function') return false;
  const next = MAPS.nextId(ACTIVE_MAP_ID);
  if (next === ACTIVE_MAP_ID) return false;
  return applyMapId(next);
}

function pinnedMapId() { return MAP_PINNED_ID; }

/* The picker's one way in. `null` releases the pin and hands the map back to
   the rotation from wherever it is standing. Swapping the world on the spot
   is safe from here and nowhere else: the picker only exists on the title
   screen, which is the same moment the deferred rotation waits for. */
function chooseMapId(id) {
  if (!mapRotationIsOurs()) return false;
  MAP_ROTATE_PENDING = false;
  if (id === null || id === undefined) { MAP_PINNED_ID = null; return true; }
  if (!MAPS.get(id)) return false;
  if (!applyMapId(id)) return false;
  MAP_PINNED_ID = id;
  return true;
}

/* Explicit assignments keep the API stable even though the implementation
   lives in a classic script with shared top-level lexical bindings. */
globalThis.setActiveMap = setActiveMap;
globalThis.activeMapId = activeMapId;
globalThis.chooseMapId = chooseMapId;
globalThis.pinnedMapId = pinnedMapId;
