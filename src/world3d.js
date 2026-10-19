/* Lane Four 3D world: track, markings, stands, sky, hurdles, stars and the
   finish gantry, built from a THREE namespace passed in. Placeholder: a later
   stage fills LaneFour.World3D. */
(function (root) {
  'use strict';
  if (!root.LaneFour) throw new Error('world3d.js needs core.js loaded first');
  Object.assign(root.LaneFour, { World3D: {} });
})(typeof window !== 'undefined' ? window : globalThis);
