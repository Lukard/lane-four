/* Lane Four 3D scene: renderer, chase camera, runner, particles, popups, quality
   and context loss, built from a THREE namespace passed in. Placeholder: a later
   stage fills LaneFour.Scene3D. */
(function (root) {
  'use strict';
  if (!root.LaneFour) throw new Error('scene3d.js needs core.js loaded first');
  Object.assign(root.LaneFour, { Scene3D: {} });
})(typeof window !== 'undefined' ? window : globalThis);
