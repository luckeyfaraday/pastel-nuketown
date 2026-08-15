/* =====================================================================
   PASTEL NUKETOWN — SHARED MAP REGISTRY
   Browser: globalThis.NUKETOWN_MAPS
   Node:    require('./map-registry.js')
   ===================================================================== */
(function (root, factory) {
  const node = typeof module !== 'undefined' && module.exports;
  const nuketown = node ? require('./mapspec.js') : root.NUKETOWN_MAP;
  const terminal = node ? require('./terminal-mapspec.js') : root.TERMINAL_MAP;
  const api = factory(nuketown, terminal);
  if (node) module.exports = api;
  root.NUKETOWN_MAPS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nuketown, terminal) {
  'use strict';

  const DEFAULT_ID = 'nuketown';
  /* Insertion order IS the rotation order — see nextMapId(). */
  const maps = Object.freeze({ nuketown: nuketown, terminal: terminal });

  return Object.freeze({
    DEFAULT_ID: DEFAULT_ID,
    get: function (id) {
      return typeof id === 'string' && Object.prototype.hasOwnProperty.call(maps, id)
        ? maps[id]
        : null;
    },
    ids: function () { return Object.keys(maps); },
    /* Map selection is a rotation, not a pick: a match ends and the next map
       in the pool loads. Deriving it from the id rather than storing a
       cursor means a host that migrates mid-session cannot reset the
       rotation, and an unknown id still yields a playable map. */
    nextId: function (id) {
      const order = Object.keys(maps);
      const at = order.indexOf(id);
      return at === -1 ? DEFAULT_ID : order[(at + 1) % order.length];
    }
  });
});
