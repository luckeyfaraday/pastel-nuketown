/* =====================================================================
   PASTEL NUKETOWN — SHARED MAP REGISTRY
   Browser: globalThis.NUKETOWN_MAPS
   Node:    require('./map-registry.js')
   ===================================================================== */
(function (root, factory) {
  const nuketown = typeof module !== 'undefined' && module.exports
    ? require('./mapspec.js')
    : root.NUKETOWN_MAP;
  const api = factory(nuketown);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NUKETOWN_MAPS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nuketown) {
  'use strict';

  const DEFAULT_ID = 'nuketown';
  const maps = Object.freeze({ nuketown: nuketown });

  return Object.freeze({
    DEFAULT_ID: DEFAULT_ID,
    get: function (id) {
      return typeof id === 'string' && Object.prototype.hasOwnProperty.call(maps, id)
        ? maps[id]
        : null;
    },
    ids: function () { return Object.keys(maps); }
  });
});
