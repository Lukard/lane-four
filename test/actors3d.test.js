'use strict';
// LaneFour.Actors3D without a GPU: three's objects, a fake DOM for the popups, and the instance
// matrices read back. The pixel checks (sizes on screen, colours) live in the browser harness.
// Skips when three is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/core.js');
require('../src/geom.js');
require('../src/assets3d.js');
require('../src/actors3d.js');
const LF = globalThis.LaneFour;
const G = LF.Geom;

const threeP = import('three').catch(() => null);
const near = (a, b, eps = 1e-5) => Math.abs(a - b) <= eps;

// A DOM element that counts style and hidden writes.
const makeEl = () => {
  const el = { className: '', parentNode: null, writes: 0, _h: false, _t: '' };
  el.style = new Proxy({}, { set: (t, k, v) => { el.writes++; t[k] = v; return true; } }); // every assignment counts, changed or not
  Object.defineProperty(el, 'textContent', { get: () => el._t, set: (v) => { el.writes++; el._t = v; } });
  Object.defineProperty(el, 'hidden', { get: () => el._h, set: (v) => { el.writes++; el._h = v; } });
  return el;
};
globalThis.document = { createElement: () => makeEl() };
const makeLayer = () => ({
  children: [],
  appendChild(n) { n.parentNode = this; this.children.push(n); },
  removeChild(n) { this.children.splice(this.children.indexOf(n), 1); n.parentNode = null; },
});

const withActors = (fn, opts = {}) => async (t) => {
  const THREE = await threeP;
  if (!THREE) return t.skip('three is not installed (npm install)');
  const disposed = { geometry: 0, material: 0 };
  const patch = [[THREE.BufferGeometry, 'geometry'], [THREE.Material, 'material']].map(([C, k]) => {
    const orig = C.prototype.dispose;
    C.prototype.dispose = function () { disposed[k]++; return orig.call(this); };
    return () => { C.prototype.dispose = orig; };
  });
  try {
    const layer = makeLayer();
    const glowTexture = new THREE.Texture();
    const actors = LF.Actors3D.create(THREE, { glowTexture, popLayer: layer, tier: opts.tier || 0 });
    const race = new LF.Race(400);
    race.x = 20;
    const camera = new THREE.PerspectiveCamera(52, 390 / 844, 0.3, 120);
    camera.rotation.order = 'YXZ';
    const sol = G.solveRig(G.RIGS.portrait, 0);
    camera.position.set(race.x - sol.back, sol.height, 0);
    camera.rotation.set(-sol.pitch, -Math.PI / 2, 0);
    camera.updateMatrixWorld();
    actors.setView(52, 390, 844, true);
    const av = { phase: 0.3, target: 0, crouch: 0, air: 0, stumble: 0, gait: 0.6, charged: false, t: 1 };
    const f = { race, av, phase: 'running', particles: [], popups: [], dt: 0.016, reduceMotion: false, camera };
    const meshes = actors.root.children;
    const bones = meshes.find((m) => m.isInstancedMesh && m.count === 11);
    const joints = meshes.find((m) => m.isInstancedMesh && m.count === 13);
    const points = meshes.find((m) => m.isPoints);
    const shadow = meshes.find((m) => m.isMesh && !m.isInstancedMesh && !m.material.map);
    const glow = meshes.find((m) => m.isMesh && !m.isInstancedMesh && m.material.map);
    await fn({ THREE, actors, layer, race, camera, av, f, bones, joints, points, shadow, glow, disposed });
  } finally {
    patch.forEach((undo) => undo());
  }
};

const pos = (m, i) => { const a = m.instanceMatrix.array; return [a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14]]; };
const col = (m, i) => Array.from(m.instanceColor.array.slice(i * 3, i * 3 + 3));
const len = (m, i, c) => { const a = m.instanceMatrix.array, o = i * 16 + c * 4; return Math.hypot(a[o], a[o + 1], a[o + 2]); };

test('runner: 11 bones and 13 joints, never culled, joints at the pose in world metres', withActors(({ actors, race, av, f, bones, joints }) => {
  assert.equal(bones.count, 11);
  assert.equal(joints.count, 13);
  assert.equal(bones.frustumCulled, false);
  assert.equal(joints.frustumCulled, false);
  assert.equal(bones.geometry.parameters.radialSegments, 6);
  assert.deepEqual([joints.geometry.parameters.widthSegments, joints.geometry.parameters.heightSegments], [8, 6]);
  actors.update(f);
  const p = G.runnerPose({ ...av }, false);
  const want = (q, z) => [race.x + q.x, race.y + q.y, z];
  const eq = (a, b) => a.every((v, i) => near(v, b[i], 1e-4));
  assert.ok(eq(pos(joints, 12), want(p.head, 0)), 'head');
  assert.ok(eq(pos(joints, 0), want(p.hip, 0)) && eq(pos(joints, 1), want(p.shoulder, 0)), 'hip and shoulder on the torso axis');
  for (let i = 0; i < 2; i++) {
    const z = i ? -0.10 : 0.10, za = i ? -0.21 : 0.21;
    assert.ok(eq(pos(joints, 2 + i), want(p.legs[i].knee, z)), 'knee ' + i);
    assert.ok(eq(pos(joints, 4 + i), want(p.legs[i].ankle, z)), 'ankle ' + i);
    assert.ok(eq(pos(joints, 6 + i), want(p.legs[i].toe, z)), 'toe ' + i);
    assert.ok(eq(pos(joints, 8 + i), want(p.arms[i].elbow, za)), 'elbow ' + i);
    assert.ok(eq(pos(joints, 10 + i), want(p.arms[i].wrist, za)), 'wrist ' + i);
  }
}));

test('runner: segment lengths and radii match the pose and the spec', withActors(({ actors, f, bones }) => {
  actors.update(f);
  const L = [0.46, 0.46, 0.46, 0.46, 0.15, 0.15, 0.29, 0.29, 0.27, 0.27, 0.55]; // thigh x2, shin x2, foot x2, upper arm x2, forearm x2, torso
  L.forEach((l, i) => assert.ok(near(len(bones, i, 1), l, 1e-5), 'bone ' + i + ' length ' + len(bones, i, 1)));
  const R = [[0.055, 0.055], [0.055, 0.055], [0.055, 0.055], [0.055, 0.055], [0.04, 0.04], [0.04, 0.04], [0.048, 0.048], [0.048, 0.048], [0.048, 0.048], [0.048, 0.048], [0.11, 0.18]];
  R.forEach(([rx, rz], i) => { assert.ok(near(len(bones, i, 0), rx, 1e-6) && near(len(bones, i, 2), rz, 1e-6), 'bone ' + i + ' radius'); });
}));

test('runner: index 0 limbs and head #fbf8ef, index 1 #c9c4b6, torso amber', withActors(({ THREE, actors, f, bones, joints }) => {
  actors.update(f);
  const c = (hex) => { const k = new THREE.Color(hex); return [k.r, k.g, k.b]; };
  const eq = (a, b) => a.every((v, i) => near(v, b[i], 2e-3));
  for (const i of [0, 2, 4, 6, 8]) assert.ok(eq(col(bones, i), c('#fbf8ef')), 'near bone ' + i);
  for (const i of [1, 3, 5, 7, 9]) assert.ok(eq(col(bones, i), c('#c9c4b6')), 'far bone ' + i);
  assert.ok(eq(col(bones, 10), c('#ffb22e')));
  assert.ok(eq(col(joints, 12), c('#fbf8ef')));
  for (const i of [2, 4, 6, 8, 10]) assert.ok(eq(col(joints, i), c('#fbf8ef')) && eq(col(joints, i + 1), c('#c9c4b6')), 'joint pair ' + i);
}));

test('runner: the trail leg lifts by 0.12 * air above air 0.5, in 3D only, and S.av is never written', withActors(({ actors, race, av, f }) => {
  Object.freeze(av); // any write throws in strict mode
  const ref = (air) => G.runnerPose({ gait: av.gait, phase: av.phase, crouch: av.crouch, air, stumble: av.stumble, t: av.t }, false);
  for (const air of [0.4, 0.5, 0.51, 0.8, 1]) {
    f.av = Object.freeze({ ...av, air });
    actors.update(f);
    const lift = air > 0.5 ? 0.12 * air : 0, r = ref(air), p = actors.pose;
    assert.ok(near(p.legs[1].knee.y - r.legs[1].knee.y, lift) && near(p.legs[1].ankle.y - r.legs[1].ankle.y, lift) && near(p.legs[1].toe.y - r.legs[1].toe.y, lift), 'trail leg at air ' + air);
    assert.ok(near(p.legs[0].knee.y, r.legs[0].knee.y) && near(p.legs[0].toe.y, r.legs[0].toe.y), 'lead leg untouched at air ' + air);
    assert.equal(race.y, 0);
  }
}));

test('runner: while paused the gait eases to a stand and back on resume, and a snap takes the live value', withActors(({ actors, f }) => {
  f.av = Object.freeze({ phase: 0.3, target: 0, crouch: 0, air: 0, stumble: 0, gait: 0.9, charged: false, t: 1 });
  actors.update(f);
  assert.equal(actors.a3.gait, 0.9, 'running: the live gait');
  f.phase = 'paused';
  actors.update(f);
  assert.ok(actors.a3.gait < 0.9 && actors.a3.gait > 0.8, 'the first paused frame eases a little: ' + actors.a3.gait);
  for (let i = 0; i < 180; i++) actors.update(f);
  assert.ok(actors.a3.gait < 0.01, 'a stand after 3 s');
  f.phase = 'running';
  actors.update(f);
  assert.ok(actors.a3.gait < 0.9, 'resume eases up rather than popping');
  for (let i = 0; i < 120; i++) actors.update(f);
  assert.equal(actors.a3.gait, 0.9, 'back to the live value exactly');
  f.phase = 'paused';
  for (let i = 0; i < 180; i++) actors.update(f);
  actors.snap();
  actors.update(f);
  assert.ok(near(actors.a3.gait, 0.9 * Math.exp(-0.016 / 0.3), 1e-9), 'a snap restarts the ease from the live gait');
}));

test('shadow and charge glow follow the spec numbers', withActors(({ THREE, actors, race, av, f, shadow, glow }) => {
  actors.update(f);
  assert.ok(near(shadow.position.x - race.x, 0.06) && near(shadow.position.y, 0.012));
  assert.ok(near(shadow.scale.x, 0.42) && near(shadow.scale.z, 0.30) && shadow.scale.y === 1);
  assert.equal(shadow.geometry.parameters.segments, 16);
  assert.ok(shadow.material.transparent && !shadow.material.depthWrite && near(shadow.material.opacity, 0.3) && shadow.material.color.getHex() === 0);
  race.y = 1.1;
  actors.update(f);
  assert.ok(near(shadow.scale.x, 0.42 * 0.5), 'k = 1 - y / 2.2');
  race.y = 3;
  actors.update(f);
  assert.ok(near(shadow.scale.x, 0.42 * 0.35), 'floor 0.35');
  race.y = 0;
  assert.equal(glow.visible, false);
  f.av = { ...av, charged: true, air: 0.2 };
  actors.update(f);
  assert.equal(glow.visible, true);
  assert.ok(near(glow.position.x - (race.x + actors.pose.hip.x), 0.15) && near(glow.position.y, race.y + actors.pose.hip.y) && glow.position.z === 0);
  assert.equal(glow.geometry.parameters.width, 1.8);
  assert.equal(glow.material.color.getHexString(), '57d98f');
  assert.ok(near(glow.material.opacity, 0.45) && glow.material.blending === THREE.AdditiveBlending && !glow.material.depthWrite && glow.material.fog === false);
  f.av = { ...av, charged: true, air: 0.9 };
  actors.update(f);
  assert.equal(glow.visible, false, 'hidden once airborne');
}));

const P = (o) => ({ x: 22, h: 0.5, z: 0, vx: 0, vh: 0, life: 0.5, max: 1, col: '226, 120, 92', size: 0.035, ...o });

test('particles: position (x, h, -z), linear colour from the sRGB string, alpha life / max, per-point size', withActors(({ THREE, actors, f, points }) => {
  f.particles = [P({ x: 23, h: 1, z: 0.3 }), P({ x: 24, h: 1.5, z: -0.2, life: 0.9, max: 0.9, col: '255, 178, 46', size: 0.05 })];
  actors.update(f);
  const g = points.geometry, p = g.attributes.position.array, c = g.attributes.color.array, s = g.attributes.psize.array;
  assert.equal(g.drawRange.count, 2);
  assert.ok(near(p[0], 23) && near(p[1], 1) && near(p[2], -0.3) && near(p[5], 0.2));
  const lin = (r, gg, b) => { const k = new THREE.Color().setRGB(r / 255, gg / 255, b / 255, THREE.SRGBColorSpace); return [k.r, k.g, k.b]; };
  assert.ok(lin(226, 120, 92).every((v, i) => near(v, c[i], 1e-6)) && lin(255, 178, 46).every((v, i) => near(v, c[4 + i], 1e-6)));
  assert.ok(near(c[3], 0.5) && near(c[7], 1));
  assert.ok(near(s[0], 0.035) && near(s[1], 0.05));
  assert.equal(points.frustumCulled, false);
  assert.ok(points.material.transparent && !points.material.depthWrite && points.material.vertexColors);
  actors.setView(41, 844, 390, false);
  assert.ok(near(points.material.size, 1 / Math.tan((41 * Math.PI) / 360)), 'size = 1 / tan(vfov / 2)');
}));

test('particles: bursts (z 0, size >= 0.05) fan out sideways with age; dust and fresh bursts do not', withActors(({ actors, f, points }) => {
  f.particles = [P({ vx: 1.3, life: 0.4, max: 0.9, size: 0.05 }), P({ vx: 1.3, life: 0.9, max: 0.9, size: 0.05 }), P({ vx: 1.3, life: 0.4, max: 0.9, size: 0.035 })];
  actors.update(f);
  const p = points.geometry.attributes.position.array;
  assert.ok(Math.abs(p[2]) > 0.05 && Math.abs(p[2]) <= 1.6 * 0.5 + 1e-9, 'an aged burst particle is off the centre line');
  assert.equal(p[5], 0);
  assert.equal(p[8], 0);
}));

test('particles: capacity follows the tier, the newest are kept, none at T3', async (t) => {
  for (const [tier, cap] of [[0, 256], [1, 256], [2, 128], [3, 0]]) {
    await withActors(({ actors, f, points }) => {
      f.particles = [];
      for (let i = 0; i < 300; i++) f.particles.push(P({ x: 30 + i * 0.01 }));
      actors.update(f);
      assert.equal(points.geometry.drawRange.count, cap, 'T' + tier);
      assert.equal(points.visible, cap > 0);
      if (cap) assert.ok(near(points.geometry.attributes.position.array[0], 30 + (300 - cap) * 0.01, 1e-3), 'newest kept');
    }, { tier })(t);
  }
});

test('popups: six pooled nodes, text and colour on change only, clamped and stacked, none written when idle', withActors(({ actors, layer, race, f, camera }) => {
  assert.equal(layer.children.length, 6);
  assert.ok(layer.children.every((n) => n.className === 'pop3d' && n.hidden));
  const Q = (text, color, life, max = 1.1) => ({ text, x: 0, h: 0, color, life, max });
  f.popups = [Q('Clear', '#57d98f', 0.3), Q('Star', '#ffb22e', 0.9)];
  actors.update(f);
  const [a, b, c] = layer.children;
  assert.deepEqual([a.hidden, b.hidden, c.hidden], [false, false, true]);
  assert.equal(a.textContent, 'Clear');
  assert.equal(b.style.color, '#ffb22e');
  assert.equal(a.style.opacity, String(Math.round(Math.min(1, 1.6 * 0.3 / 1.1) * 50) / 50));
  assert.equal(b.style.opacity, '1');
  const m = /^translate\(-50%,-50%\) translate3d\(([-\d.]+)px,([-\d.]+)px,0\)$/.exec(a.style.transform);
  assert.ok(m && +m[1] > 0 && +m[1] < 390 && +m[2] > 0 && +m[2] < 844, a.style.transform);
  const proj = (y) => (0.5 - new (require('three').Vector3)(race.x + 2, y, 0).project(camera).y * 0.5) * 844;
  const ys01 = layer.children.slice(0, 2).map((n) => +/translate3d\([-\d.]+px,([-\d.]+)px/.exec(n.style.transform)[1]);
  assert.ok(Math.abs(ys01[0] - proj(1.9 + 0.8 * 0.6)) < 0.06 && Math.abs(ys01[1] - proj(1.9 + 0.2 * 0.6 + 0.55)) < 0.06, 'anchored 2 m ahead and 1.9 m above the runner, rising 0.6 m/s, slot i another 0.55 m up: ' + ys01);
  const before = layer.children.map((n) => n.writes);
  for (let i = 0; i < 5; i++) actors.update(f);
  assert.deepEqual(layer.children.map((n) => n.writes), before, 'nothing written while nothing changes');
  f.popups = [];
  for (let i = 0; i < 9; i++) f.popups.push(Q('P' + i, '#fff', 1));
  actors.update(f);
  assert.equal(layer.children.length, 6, 'no node is ever added');
  assert.equal(layer.children.filter((n) => !n.hidden).length, 6, 'the first six show');
  race.y = 2.4;
  f.popups = [Q('A', '#fff', 1), Q('B', '#fff', 1), Q('C', '#fff', 1)];
  actors.update(f);
  const ys = layer.children.slice(0, 3).map((n) => +/translate3d\([-\d.]+px,([-\d.]+)px/.exec(n.style.transform)[1]);
  const line = Math.min(40, Math.max(20, 0.052 * 390)) * 1.05;
  assert.ok(Math.min(...ys) >= 0.22 * 844 - 0.1, 'never above the HUD line (22% in portrait): ' + ys);
  assert.ok(ys[0] - ys[1] >= line - 0.2 && ys[1] - ys[2] >= line - 0.2, 'stacked a line apart even when clamped: ' + ys);
  actors.setView(41, 844, 390, false);
  actors.update(f);
  const ys2 = layer.children.slice(0, 3).map((n) => +/translate3d\([-\d.]+px,([-\d.]+)px/.exec(n.style.transform)[1]);
  assert.ok(Math.min(...ys2) >= 0.15 * 390 - 0.1 && Math.min(...ys2) < 0.22 * 390, 'landscape clamps at 15%: ' + ys2);
  f.popups = [];
  actors.update(f);
  assert.ok(layer.children.every((n) => n.hidden));
}));

test('dispose removes the popup nodes and frees every geometry and material', withActors(({ actors, layer, disposed }) => {
  actors.dispose();
  assert.equal(layer.children.length, 0);
  assert.equal(disposed.geometry, 5, 'bone, joint, shadow, glow and points geometries');
  assert.ok(disposed.material >= 4, 'materials disposed: ' + disposed.material);
  assert.equal(actors.root.parent, null);
  actors.dispose(); // idempotent
}));

test('create refuses missing inputs', async (t) => {
  const THREE = await threeP;
  if (!THREE) return t.skip('three is not installed (npm install)');
  assert.throws(() => LF.Actors3D.create(THREE, { popLayer: makeLayer() }), /glowTexture/);
  assert.throws(() => LF.Actors3D.create(THREE, { glowTexture: new THREE.Texture() }), /popLayer/);
});
