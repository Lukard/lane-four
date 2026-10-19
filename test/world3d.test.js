'use strict';
// LaneFour.World3D without a GPU: three's scene objects and a stub 2D canvas are enough to
// build the world, drive update() and check matrices, budgets, setRace and dispose.
// The pixel checks live in the browser harness. Skips when three is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/core.js');
require('../src/geom.js');
require('../src/assets3d.js');
require('../src/world3d.js');
const LF = globalThis.LaneFour;
const G = LF.Geom;

const threeP = import('three').catch(() => null);
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// A 2D context that accepts everything; measureText gives plausible numbers for the atlas.
const ctx2d = () => new Proxy({
  measureText: (t) => ({ width: t.length * 40, actualBoundingBoxAscent: 70, actualBoundingBoxDescent: 0 }),
  createRadialGradient: () => ({ addColorStop() {} }),
}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d() }) };

// Builds a world and hands the pieces to fn; counts every dispose() on the way.
const withWorld = (fn, opts = {}) => async (t) => {
  const THREE = await threeP;
  if (!THREE) return t.skip('three is not installed (npm install)');
  const disposed = { geometry: 0, material: 0, texture: 0 };
  const patch = [[THREE.BufferGeometry, 'geometry'], [THREE.Material, 'material'], [THREE.Texture, 'texture']].map(([C, k]) => {
    const orig = C.prototype.dispose;
    C.prototype.dispose = function () { disposed[k]++; return orig.call(this); };
    return () => { C.prototype.dispose = orig; };
  });
  try {
    const race = opts.race || new LF.Race(400);
    const camera = new THREE.PerspectiveCamera(50, 0.46, 0.3, 120);
    camera.position.set(race.x - 5.5, 3.6, 0);
    const world = LF.World3D.build(THREE, { race, tier: opts.tier || 0, anisotropy: 4 });
    const scene = new THREE.Scene();
    scene.add(world.root);
    const ctx = { race, t: 1, dt: 0.016, camera, reduceMotion: false, phase: 'running' };
    const refs = {};
    world.root.traverse((o) => {
      if (o.isInstancedMesh) {
        if (o.renderOrder === 3) refs.hurdle = o;
        else if (o.renderOrder === 4) refs.star = o;
        else if (o.renderOrder === 6) refs.starGlow = o;
        else if (o.renderOrder === 7) refs.flood = o;
        else if (o.renderOrder === 2) refs[o.instanceMatrix.count === 30 ? 'chevIdle' : 'chevAct'] = o;
      } else if (o.isMesh && o.material.alphaMap && o.renderOrder === 2) refs.squat = o;
      else if (o.isMesh && o.material.alphaMap) refs.numbers = o;
      else if (o.isMesh && o.material.map && o.material.map.image.height === 256 && o.material.map.image.width === 512 && !o.isInstancedMesh) refs.stands = o;
      else if (o.isPoints) refs.points = o;
    });
    await fn({ THREE, world, scene, ctx, race, camera, refs, disposed });
  } finally {
    patch.forEach((undo) => undo());
  }
};

const liveGeometries = (world) => { const s = new Set(); world.root.traverse((o) => { if (o.geometry) s.add(o.geometry); }); return s.size; };

test('budgets: draw calls, triangles, textures and texture memory', withWorld(({ world, ctx }) => {
  world.update(ctx);
  const s = world.stats();
  assert.ok(s.drawCalls >= 12 && s.drawCalls <= 60, 'calls ' + s.drawCalls);
  assert.ok(s.triangles < 60000, 'tris ' + s.triangles);
  assert.ok(s.textures <= 8 && s.textureMB < 4, s.textures + ' textures, ' + s.textureMB + ' MB');
  assert.equal(s.tier, 'T0');
}));

test('update(): far hurdles are scaled up, hit hurdles tip about their base, cleared ones stand', withWorld(({ world, ctx, race, refs }) => {
  race.x = 10;
  world.update(ctx);
  const a = refs.hurdle.instanceMatrix.array;
  for (const i of [0, 1, 2]) assert.ok(near(a[i * 16], G.farScale(race.hurdles[i].x - race.x)), 'farScale for hurdle ' + i);
  assert.deepEqual([a[12], a[28], a[44]], [45, 80, 115]);
  race.hurdles[0].state = 'hit';
  race.hurdles[0].fall = 1;
  race.hurdles[1].state = 'cleared';
  world.update(ctx);
  assert.ok(near(a[0], Math.cos(1.38)) && near(a[4], Math.sin(1.38)) && near(a[1], -Math.sin(1.38)), 'tipped 1.38 rad, forward');
  assert.ok(near(a[16], 1) && near(a[17], 0), 'a cleared hurdle stands at scale 1');
  race.hurdles[2].state = 'hit';
  race.hurdles[2].fall = 0.5;
  world.update(ctx);
  assert.ok(near(a[32], Math.cos(G.tipAngle(race.hurdles[2]))), 'mid-fall angle follows easeOutBack');
}));

test('update(): stars bob, spin and scale with distance, and vanish once the hurdle is done', withWorld(({ world, ctx, race, refs, camera }) => {
  race.x = 30;
  camera.position.set(race.x - 5.5, 3.6, 0);
  ctx.t = 2;
  world.update(ctx);
  const m = refs.star.instanceMatrix.array, h = race.hurdles[0];
  const y = 2.45 + Math.sin(3 * 2 + h.x) * 0.06;
  const sc = Math.min(2.2, Math.max(1, Math.hypot(h.x - camera.position.x, y - camera.position.y) / 14));
  assert.ok(near(m[0], sc, 1e-3) && near(m[13], y) && near(m[5], Math.cos(0.8 * 2) * sc, 1e-3), 'scale, height and spin');
  assert.ok(near(m[16], 2.2), 'capped at 2.2 far away');
  assert.deepEqual(Array.from(refs.starGlow.instanceMatrix.array.slice(0, 16)), Array.from(m.slice(0, 16)), 'glow shares the star matrix');
  race.hurdles[0].state = 'cleared';
  world.update(ctx);
  assert.deepEqual([m[0], m[5], m[10]], [0, 0, 0]);
  ctx.reduceMotion = true;
  race.hurdles[1].state = 'up';
  world.update(ctx);
  assert.ok(near(m[13 + 16], 2.45) && near(m[5 + 16], m[0 + 16]), 'reduced motion: no bob, no spin');
}));

test('update(): chevrons follow the next hurdle, pulse inside 4.4 m only, and rebuild only on change', withWorld(({ world, ctx, race, refs }) => {
  race.x = 10;
  world.update(ctx);
  assert.equal(refs.chevIdle.count, 27);
  assert.equal(refs.chevAct.count, 3);
  assert.deepEqual([0, 1, 2].map((k) => +refs.chevAct.instanceMatrix.array[k * 16 + 12].toFixed(2)), [41.4, 42.3, 43.2]);
  const v = refs.chevIdle.instanceMatrix.version;
  ctx.t = 1.1;
  world.update(ctx);
  assert.equal(refs.chevIdle.instanceMatrix.version, v, 'unchanged scene, unchanged instances');
  assert.equal(refs.chevAct.material.opacity, 0.6, 'steady while far');
  race.x = race.hurdles[0].x - 3;
  const seen = new Set();
  for (const t of [0, 0.05, 0.1, 0.15]) { ctx.t = t; world.update(ctx); seen.add(refs.chevAct.material.opacity.toFixed(3)); }
  assert.equal(seen.size, 4, 'pulsing');
  ctx.reduceMotion = true;
  world.update(ctx);
  assert.equal(refs.chevAct.material.opacity, 0.6, 'fixed under reduced motion');
  ctx.reduceMotion = false;
  race.x = race.hurdles[0].x;
  world.update(ctx);
  assert.equal(refs.chevAct.count, 3, 'a hurdle the runner stands on is still next');
  race.hurdles[0].state = 'cleared';
  world.update(ctx);
  assert.equal(refs.chevIdle.count, 24);
  assert.ok(near(refs.chevAct.instanceMatrix.array[12], race.hurdles[1].x - 3.6));
}));

test('update(): SQUAT shows for the first two hurdles only, and not once finished', withWorld(({ world, ctx, race, refs }) => {
  world.update(ctx);
  const range = () => [refs.squat.geometry.drawRange.start, refs.squat.geometry.drawRange.count, refs.squat.visible];
  assert.deepEqual(range(), [0, 12, true]);
  race.hurdles[0].state = 'cleared';
  world.update(ctx);
  assert.deepEqual(range(), [6, 6, true]);
  race.hurdles[1].state = 'cleared';
  world.update(ctx);
  assert.equal(refs.squat.visible, false);
  race.hurdles[1].state = 'up';
  world.update(ctx);
  assert.equal(refs.squat.visible, true);
  ctx.phase = 'finished';
  world.update(ctx);
  assert.equal(refs.squat.visible, false);
}));

test('cheer: star and finish flash to 1.35, clear to 1.21, decay with tau 0.5 s, x0.4 under reduced motion', withWorld(({ world, ctx, refs }) => {
  const col = () => refs.stands.material.color.r;
  world.update(ctx);
  assert.equal(col(), 1);
  world.cheer('star');
  ctx.dt = 0;
  world.update(ctx);
  assert.ok(near(col(), 1.35, 1e-6));
  ctx.dt = 0.5;
  world.update(ctx);
  assert.ok(near(col(), 1 + 0.35 * Math.exp(-1), 1e-6));
  world.cheer('clear');
  ctx.dt = 0;
  world.update(ctx);
  assert.ok(near(col(), 1 + 0.35 * Math.max(0.6, Math.exp(-1)), 1e-6) && col() > 1.2, 'clear never lowers a stronger flash, it raises a weaker one');
  for (let i = 0; i < 200; i++) { ctx.dt = 0.05; world.update(ctx); }
  assert.equal(col(), 1);
  world.cheer('hit');
  ctx.dt = 0;
  world.update(ctx);
  assert.equal(col(), 1, 'unknown kinds are ignored');
  ctx.reduceMotion = true;
  world.cheer('finish');
  world.update(ctx);
  assert.ok(near(col(), 1 + 0.35 * 0.4, 1e-6));
}));

test('setTier hides the stars and glows at T2, restores them at T0, and keeps the sky inside far', withWorld(({ world, refs }) => {
  const calls0 = world.stats().drawCalls;
  assert.equal(world.setTier(2).name, 'T2');
  assert.equal(refs.points.visible, false);
  assert.equal(refs.flood.visible, false);
  assert.equal(refs.starGlow.visible, false);
  assert.equal(world.stats().drawCalls, calls0 - 3);
  assert.ok(near(world.sky.children[0].scale.x * 100, 76.5), 'dome radius 0.85 * far 90');
  world.setTier(0);
  assert.equal(world.stats().drawCalls, calls0);
  assert.equal(world.sky.children[0].scale.x, 1);
}));

test('setRace swaps only distance geometry: nothing leaks, the old geometry is disposed, a new race object is picked up by update()', withWorld(({ world, ctx, refs, disposed }) => {
  world.update(ctx);
  const base = liveGeometries(world);
  const before = disposed.geometry;
  for (const d of [200, 400, 400, 200]) world.setRace(new LF.Race(d));
  assert.equal(liveGeometries(world), base, 'geometry count is flat');
  assert.equal(disposed.geometry - before, 4 * 9, 'nine swapped geometries per setRace, each disposed');
  assert.equal(disposed.texture, 0, 'textures live for the session');
  assert.equal(disposed.material, 0);
  const r200 = new LF.Race(200);
  ctx.race = r200;
  world.update(ctx);
  assert.equal(refs.hurdle.count, 5);
  assert.equal(refs.chevIdle.count, 12);
  const s = world.stats();
  assert.ok(s.triangles < 3000);
  assert.throws(() => world.setRace({ distance: 400, hurdles: new Array(25).fill({ x: 1, state: 'up' }) }), /at most 24/);
}));

test('dispose frees geometry, materials and textures and detaches the root', withWorld(({ world, scene, disposed }) => {
  const meshes = [];
  world.root.traverse((o) => { if (o.geometry) meshes.push(o); });
  world.dispose();
  assert.equal(world.root.parent, null);
  assert.equal(scene.children.length, 0);
  assert.ok(disposed.geometry >= meshes.length, 'every geometry');
  assert.ok(disposed.material >= 18, 'every material, ' + disposed.material);
  assert.equal(disposed.texture, 7);
}));

test('Z is mirrored once: lane 1 is on -Z, lane 8 on +Z, the infield stand rises on -Z and faces the track', withWorld(({ world, refs, THREE }) => {
  // numbers: quads alternate start/finish per lane, so quad 0 is lane 1 (Z -3.66) and quad 14 is lane 8 (Z +4.88)
  const p = refs.numbers.geometry.attributes.position, idx = refs.numbers.geometry.index.array;
  const centre = (q) => { let z = 0; for (let i = 0; i < 4; i++) z += p.getZ(q * 4 + i) / 4; return z; };
  assert.ok(near(centre(0), G.laneZ(1)) && near(centre(14), G.laneZ(8)), 'lane digits at laneZ(k): ' + centre(0) + ', ' + centre(14));
  assert.ok(centre(0) < 0 && centre(14) > 0);
  const a = new THREE.Vector3().fromBufferAttribute(p, idx[0]), b = new THREE.Vector3().fromBufferAttribute(p, idx[1]), c = new THREE.Vector3().fromBufferAttribute(p, idx[2]);
  assert.ok(b.clone().sub(a).cross(c.clone().sub(a)).y > 0, 'glyph quads face up');
  assert.ok(p.getZ(1) > p.getZ(0), 'texture u grows with +Z: text reads left to right from behind');
  // stands: two quads, the one at Z < 0 faces +Z (toward the track) and up, the other faces -Z and up
  const sp = refs.stands.geometry.attributes.position, si = refs.stands.geometry.index.array;
  for (const [q, side] of [[0, -1], [1, 1]]) {
    const v = (k) => new THREE.Vector3().fromBufferAttribute(sp, si[q * 6 + k]);
    const n = v(1).clone().sub(v(0)).cross(v(2).clone().sub(v(0)));
    assert.ok(Math.sign(sp.getZ(q * 4)) === side, 'quad ' + q + ' sits on side ' + side);
    assert.ok(n.y > 0 && n.z * side < 0, 'stand on side ' + side + ' faces up and toward the track: ' + n.toArray());
  }
}));

test('no material is shared between an InstancedMesh and a plain Mesh (three re-derives the program every frame it flips)', withWorld(({ world }) => {
  const kinds = new Map();
  world.root.traverse((o) => {
    if (!o.material || !(o.isMesh || o.isPoints)) return;
    const k = kinds.get(o.material) || new Set();
    k.add(o.isInstancedMesh ? 'instanced' : 'plain');
    kinds.set(o.material, k);
  });
  assert.ok(kinds.size >= 10);
  for (const [m, k] of kinds) assert.equal(k.size, 1, 'material ' + m.type + ' (color ' + m.color.getHexString() + ') is used by both');
}));

test('after the finish the LED board rolls up into the rail and the gantry lifts away as the camera nears it, and only then', withWorld(({ world, ctx, race, camera }) => {
  const is = (m) => m.isMesh && !m.isInstancedMesh;
  const led = world.root.children.find((m) => is(m) && m.material.map && m.geometry.attributes.position.count === 4 && m.geometry.attributes.position.getY(0) > 2);
  const gantry = world.root.children.find((m) => is(m) && m.material.vertexColors && !m.material.polygonOffset);
  assert.ok(led && gantry, 'found the LED board and the gantry');
  world.root.updateMatrixWorld();
  const at = (camX) => { camera.position.set(camX, 3.6, 0); world.update(ctx); return { sy: led.matrix.elements[5], ty: led.matrix.elements[13], led: led.visible, gy: gantry.matrix.elements[13], gantry: gantry.visible }; };
  const d = race.distance;
  race.x = d - 3;
  assert.deepEqual(at(d - 4), { sy: 1, ty: 0, led: true, gy: 0, gantry: true }, 'racing: always whole, however near');
  assert.deepEqual(at(d - 0.5), { sy: 1, ty: 0, led: true, gy: 0, gantry: true }, 'racing: even right under it');
  race.finished = true;
  race.finishTime = 63.2;
  race.x = d + 2;
  assert.deepEqual(at(d - 7.2), { sy: 1, ty: 0, led: true, gy: 0, gantry: true }, 'finished, but the camera is still far: whole');
  const half = at(d - 0.09 - 2.5 - 2.3);
  assert.ok(near(half.sy, 0.5) && near(half.ty, 1.5) && half.led && half.gy === 0 && half.gantry, 'half way: the board is squashed toward its top edge (y = 3.0), the gantry has not moved');
  assert.ok(near(led.matrix.elements[5] * 3.0 + led.matrix.elements[13], 3.0), 'the top edge stays on the rail');
  const near2 = at(d - 2.5 - 0.09);
  assert.ok(near(near2.sy, 0) && !near2.led && near2.gantry && near(near2.gy, 14 * (1 - (2.5 + 0.09 - 1) / 3), 1e-9), 'board rolled up and hidden, the gantry already lifting');
  const mid = at(d - 3.5);
  assert.ok(near(mid.sy, (3.5 - 0.09 - 2.5) / 4.6, 1e-9) && mid.led && near(mid.ty, 3 * (1 - mid.sy) + 14 * (1 - 2.5 / 3), 1e-9) && near(mid.gy, 14 * (1 - 2.5 / 3), 1e-9), 'the board is lifted with the gantry while it is still rolling up');
  world.root.updateMatrixWorld();
  assert.ok(near(gantry.matrixWorld.elements[13], mid.gy, 1e-9) && near(led.matrixWorld.elements[13], mid.ty, 1e-9), 'the world matrices follow');
  const rest = at(d - 1.5);
  assert.ok(near(rest.gy, 14 * (1 - 0.5 / 3), 1e-9) && rest.gantry && !rest.led, 'a camera resting 1.5 m short: the rail is lifted 11.7 m overhead');
  assert.deepEqual([at(d - 1).gantry, at(d - 1).led, at(d + 5).gantry, at(d + 5).led], [false, false, false, false], 'gone at 1 m and beyond');
  race.finished = false; // a restart on the same race object
  race.x = 0;
  assert.deepEqual(at(-6), { sy: 1, ty: 0, led: true, gy: 0, gantry: true }, 'whole again');
}));
