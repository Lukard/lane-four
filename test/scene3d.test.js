'use strict';
// LaneFour.Scene3D without a GPU: the chase camera maths, the start-tier rule and the ways create()
// can fail. Everything that needs a WebGL context (frames, tiers, context loss, dispose) is in the
// browser harness. Skips the create() tests when three is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/core.js');
require('../src/geom.js');
require('../src/assets3d.js');
require('../src/world3d.js');
require('../src/actors3d.js');
require('../src/scene3d.js');
const LF = globalThis.LaneFour;
const G = LF.Geom;
const { ChaseCam, pickStartTier, tierKey } = LF.Scene3D;

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const av = (o) => ({ phase: 0, target: 0, crouch: 0, air: 0, stumble: 0, gait: 0, charged: false, t: 0, ...o });
const run = (over) => { const r = new LF.Race(400); r.x = 50; return Object.assign(r, over); };
const cam = (rig = 'portrait') => { const c = new ChaseCam(); c.setRig(G.RIGS[rig]); return c; };

test('camera: x is exactly r.x - back for every speed, and it never lags a hit', () => {
  const c = cam();
  const r = run({ v: 9.5 });
  for (let i = 0; i < 200; i++) c.update(1 / 60, r, av(), 'running', false, i === 0);
  assert.ok(c.s > 0.97);
  assert.ok(near(c.x, r.x - c.sol.back, 1e-12) && near(c.sol.back, 5.5 + 0.5 * c.s, 1e-12));
  r.v *= 0.35; // a hit drops v in one step; x follows r.x, only back eases
  r.x += 0.1;
  c.update(1 / 60, r, av(), 'running', false, false);
  assert.ok(near(c.x, r.x - c.sol.back, 1e-12));
});

test('camera: the speed zoom follows v / 9.5 with tau 0.6 s, frame-rate independent; paused and reduceMotion pull it to 0', () => {
  const run1 = (dt, secs) => { const c = cam(), r = run({ v: 9.5 }); c.update(dt, r, av(), 'running', false, true); c.s = 0; for (let t = 0; t < secs - 1e-9; t += dt) c.update(dt, r, av(), 'running', false, false); return c.s; };
  assert.ok(near(run1(1 / 60, 0.6), 1 - Math.exp(-1), 1e-6));
  assert.ok(near(run1(1 / 30, 0.6), run1(1 / 120, 0.6), 1e-6), 'frame-rate independent');
  const c = cam(), r = run({ v: 9.5 });
  c.update(0.016, r, av(), 'running', false, true);
  assert.equal(c.s, 1);
  for (let i = 0; i < 300; i++) c.update(1 / 60, r, av(), 'paused', false, false);
  assert.ok(c.s < 0.01, 'paused: vEff = 0');
  c.update(0.016, r, av(), 'running', true, false);
  assert.equal(c.s, 0, 'reduceMotion: s = 0');
  assert.ok(near(c.sol.back, 5.5) && near(c.sol.height, 3.6));
});

test('camera: height = rig + 0.15 s + 0.4 * smoothed runner y - 0.25 crouch, bob 0.02 * gait * cos(4 pi phase), floor 3.15', () => {
  const c = cam('standard'), r = run();
  c.update(0.016, r, av(), 'ready', false, true);
  assert.ok(near(c.y, 3.4));
  c.update(0.016, r, av({ crouch: 1 }), 'ready', false, true);
  assert.ok(near(c.y, 3.4 - 0.25), 'crouch dip');
  c.update(0.016, r, av({ crouch: 1 }), 'ready', false, true);
  c.update(0.016, r, av({ gait: 1, phase: 0 }), 'ready', false, true);
  assert.ok(near(c.y, 3.4 + 0.02), 'bob at phase 0');
  c.update(0.016, r, av({ gait: 1, phase: 0.25 }), 'ready', false, true);
  assert.ok(near(c.y, 3.4 - 0.02, 1e-12), 'bob at phase 0.25');
  c.update(0.016, r, av({ crouch: 1.0 }), 'ready', false, true);
  const low = cam('standard'); // standard height 3.4 - 0.25 is above the floor, so force it with a tall dip
  low.update(0.016, r, av({ crouch: 4 }), 'ready', false, true);
  assert.equal(low.y, 3.15, 'never below 3.15 (the finish board top is 3.0)');
  const hi = cam(), rj = run({ y: 1.5 });
  hi.update(0.016, rj, av(), 'running', false, true);
  assert.ok(near(hi.y, 3.6 + 0.4 * 1.5), 'a snap takes the runner height at once');
  rj.y = 0;
  for (let i = 0; i < 3; i++) hi.update(0.12 / 3, rj, av(), 'running', false, false);
  assert.ok(near(hi.yS, 1.5 * Math.exp(-1), 1e-9), 'y-follow tau 0.12 s');
  const rm = cam(), rr = run({ y: 1.5 });
  rm.update(0.016, rr, av(), 'running', true, true);
  rr.y = 0;
  rm.update(0.25, rr, av(), 'running', true, false);
  assert.ok(near(rm.yS, 1.5 * Math.exp(-1), 1e-9), 'reduceMotion keeps y-follow at tau 0.25 s');
});

test('camera: hit shake lasts 0.35 s, peaks at 0.10 m, decays quadratically at about 7 Hz and moves y and z only', () => {
  const c = cam(), r = run();
  c.update(0.016, r, av(), 'running', false, true);
  const base = c.y;
  c.hit();
  const ys = [], zs = [];
  for (let i = 0; i < 24; i++) { c.update(0.35 / 20, r, av(), 'running', false, false); ys.push(c.y - base); zs.push(c.z); assert.ok(near(c.x, r.x - c.sol.back, 1e-12)); }
  assert.ok(near(zs[0], 0.1, 1e-12) && near(ys[0], 0, 1e-12), 'the first frame is at the full 0.10 m, sideways');
  assert.ok(Math.max(...zs.map(Math.abs)) <= 0.1 + 1e-12 && Math.max(...ys.map(Math.abs)) <= 0.1 + 1e-12);
  const env = (a, b) => Math.max(...zs.slice(a, b).map(Math.abs), ...ys.slice(a, b).map(Math.abs));
  assert.ok(env(0, 8) > env(8, 16) && env(8, 16) > env(16, 23) && env(16, 23) < 0.02, 'decays: ' + [env(0, 8), env(8, 16), env(16, 23)]);
  assert.ok(Math.abs(zs[18]) > 1e-6, 'still alive at 0.33 s');
  assert.equal(zs[22], 0, 'over after 0.35 s');
  assert.ok(near(ys[22], 0, 1e-12));
  // about 7 Hz: zero crossings of the oscillation over the first 0.35 s
  const c2 = cam();
  c2.update(0.016, r, av(), 'running', false, true);
  c2.hit();
  let cross = 0, prev = null;
  for (let i = 0; i < 350; i++) { c2.update(0.001, r, av(), 'running', false, false); const s = Math.sign(c2.z - 0); if (prev !== null && s !== prev && s !== 0) cross++; if (s !== 0) prev = s; }
  assert.ok(cross >= 4 && cross <= 5, 'z crosses zero 4 to 5 times in 0.35 s at 7 Hz: ' + cross);
  // reduceMotion: no shake, no bob
  const rm = cam();
  rm.hit();
  rm.update(0.016, r, av({ gait: 1, phase: 0 }), 'running', true, false);
  assert.equal(rm.z, 0);
  assert.equal(rm.y, 3.6);
  for (let i = 0; i < 30; i++) rm.update(0.016, r, av(), 'running', true, false);
  rm.update(0.016, r, av(), 'running', false, false);
  assert.equal(rm.z, 0, 'a shake that began under reduceMotion does not come back when it is switched off');
});

test('camera: pitch is re-solved from the rig and s so the feet stay at the feet row', () => {
  for (const name of ['portrait', 'standard', 'wide']) {
    const c = cam(name), r = run({ v: 9.5 });
    for (const [phase, v] of [['ready', 0], ['running', 5], ['running', 9.5]]) {
      r.v = v;
      for (let i = 0; i < 300; i++) c.update(1 / 60, r, av(), phase, false, false);
      const sol = G.solveRig(G.RIGS[name], c.s);
      assert.ok(near(c.pitch, sol.pitch, 1e-12));
      const row = G.projectPx(sol, 800, 800, 0, 0, 0).y / 800;
      assert.ok(Math.abs(row - G.RIGS[name].feetRow) < 0.002, name + ' feet row ' + row);
    }
  }
});

test('tierKey and pickStartTier: coarse starts at T1, a fresh stored tier steps one up, stale or foreign records are ignored', () => {
  const now = 1.7e12, key = tierKey(3, 393, 852);
  assert.equal(key, '3|393');
  assert.equal(tierKey(2.0004, 1280.4, 800), '2|800', 'min of the sides, rounded');
  assert.equal(tierKey(1.75, 844, 390), '1.75|390');
  const rec = (t, o = {}) => ({ k: key, t, at: now - 1000, ...o });
  assert.equal(pickStartTier({ coarse: false, stored: null, key, now }), 0);
  assert.equal(pickStartTier({ coarse: true, stored: null, key, now }), 1);
  assert.equal(pickStartTier({ coarse: false, stored: rec(2), key, now }), 1, 'one step above the stored tier');
  assert.equal(pickStartTier({ coarse: false, stored: rec(3), key, now }), 2);
  assert.equal(pickStartTier({ coarse: true, stored: rec(2), key, now }), 1, 'never above the default');
  assert.equal(pickStartTier({ coarse: true, stored: rec(1), key, now }), 1);
  assert.equal(pickStartTier({ coarse: false, stored: rec(0), key, now }), 0);
  assert.equal(pickStartTier({ coarse: false, stored: rec(3, { k: '3|390' }), key, now }), 0, 'another screen');
  assert.equal(pickStartTier({ coarse: false, stored: rec(3, { at: now - 14 * 86400000 - 1 }), key, now }), 0, 'older than 14 days');
  assert.equal(pickStartTier({ coarse: false, stored: rec(3, { at: now - 13 * 86400000 }), key, now }), 2, 'under 14 days');
  assert.equal(pickStartTier({ coarse: false, stored: rec(3, { at: now + 3600000 }), key, now }), 0, 'from the future');
  for (const bad of ['x', 3, [], { k: key }, { k: key, t: 'a', at: now }, { k: key, t: 2 }]) assert.equal(pickStartTier({ coarse: false, stored: bad, key, now }), 0, JSON.stringify(bad));
  assert.equal(pickStartTier({ coarse: false, stored: rec(9), key, now }), 3, 'clamped to T3');
});

const threeP = import('three').catch(() => null);
const fakeCanvas = (getContext) => {
  const parent = { replaced: 0, replaceChild() { this.replaced++; } };
  const cv = { clientWidth: 390, clientHeight: 844, ownerDocument: { documentElement: { clientWidth: 390, clientHeight: 844 } }, parentNode: parent, getContext, addEventListener() {}, removeEventListener() {} };
  return { cv, parent };
};

test('create validates its inputs and fails cleanly without a WebGL2 context', async (t) => {
  const THREE = await threeP;
  if (!THREE) return t.skip('three is not installed (npm install)');
  const race = new LF.Race(400), popLayer = { appendChild() { throw new Error('nothing may be built'); } };
  assert.throws(() => LF.Scene3D.create(THREE, {}), /canvas/);
  assert.throws(() => LF.Scene3D.create(THREE, { canvas: {}, popLayer }), /race/);
  const seen = [];
  for (const caveat of [undefined, true, false]) {
    const { cv, parent } = fakeCanvas((type, attrs) => { seen.push([type, attrs]); return null; });
    assert.throws(() => LF.Scene3D.create(THREE, { canvas: cv, popLayer, race, storage: null, failIfMajorPerformanceCaveat: caveat }), /WebGL2/);
    assert.equal(parent.replaced, 0, 'a canvas that never got a context is left alone');
  }
  const base = { antialias: false, alpha: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default' };
  assert.deepEqual(seen.map((s) => s[0]), ['webgl2', 'webgl2', 'webgl2']);
  assert.deepEqual(seen[0][1], { ...base, failIfMajorPerformanceCaveat: true }, 'the caveat is on by default');
  assert.deepEqual(seen[1][1], { ...base, failIfMajorPerformanceCaveat: true });
  assert.deepEqual(seen[2][1], { ...base, failIfMajorPerformanceCaveat: false }, '?renderer=3d turns it off');
  const { cv } = fakeCanvas(() => { throw new Error('denied'); });
  assert.throws(() => LF.Scene3D.create(THREE, { canvas: cv, popLayer, race, storage: null }), /WebGL2/, 'a throwing getContext is a missing context');
});

test('the module exports its public surface', () => {
  assert.deepEqual(Object.keys(LF.Scene3D).sort(), ['ChaseCam', 'create', 'pickStartTier', 'tierKey']);
  assert.equal(typeof LF.Scene3D.create, 'function');
});
