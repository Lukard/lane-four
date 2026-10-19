'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/core.js');
require('../src/geom.js');
const LF = globalThis.LaneFour;
const G = LF.Geom;

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + a + ' to be within ' + tol + ' of ' + b);
const deg = (r) => (r * 180) / Math.PI;

// --------------------------------------------------------------- runnerPose
// The function as it was in app.js before it moved, for a bit-for-bit comparison.
function legacyRunnerPose(a, reduceMotion) {
  const { mix } = LF;
  const TH = 0.46;
  const SH = 0.46;
  const TOR = 0.55;
  const UA = 0.29;
  const FA = 0.27;
  const s = a.gait;
  const legs = [];
  for (let i = 0; i < 2; i++) {
    const w = 2 * Math.PI * (a.phase + i * 0.5);
    let th = (0.06 + 0.62 * s) * Math.sin(w);
    let kn = (0.12 + 1.45 * s) * (0.5 + 0.5 * Math.cos(w + 0.3));
    th = mix(th, 1.12, a.crouch);
    kn = mix(kn, 2.05, a.crouch);
    th = mix(th, i === 0 ? 1.45 : -0.25, a.air);
    kn = mix(kn, i === 0 ? 0.12 : 1.85, a.air);
    const knee = { x: TH * Math.sin(th), y: -TH * Math.cos(th) };
    const shin = th - kn;
    const ankle = { x: knee.x + SH * Math.sin(shin), y: knee.y - SH * Math.cos(shin) };
    const fa = shin + Math.PI / 2 - 0.15;
    const toe = { x: ankle.x + 0.15 * Math.sin(fa), y: ankle.y - 0.15 * Math.cos(fa) };
    legs.push({ knee, ankle, toe });
  }
  const low = Math.min(legs[0].ankle.y, legs[1].ankle.y, legs[0].toe.y, legs[1].toe.y);
  const breathe = s < 0.05 && a.air < 0.1 && !reduceMotion ? Math.sin((a.t || 0) * 1.6) * 0.008 : 0;
  const hip = { x: 0, y: -low + 0.05 + breathe };
  let lean = 0.05 + 0.18 * s;
  lean = mix(lean, 0.5, a.crouch * 0.9);
  lean = mix(lean, 0.62, a.air);
  lean += 0.75 * a.stumble;
  const shoulder = { x: hip.x + TOR * Math.sin(lean), y: hip.y + TOR * Math.cos(lean) };
  const head = { x: shoulder.x + 0.21 * Math.sin(lean * 0.8), y: shoulder.y + 0.21 * Math.cos(lean * 0.8) };
  const arms = [];
  for (let j = 0; j < 2; j++) {
    const w = 2 * Math.PI * (a.phase + (1 - j) * 0.5);
    let al = (0.1 + 0.85 * s) * Math.sin(w);
    let el2 = 0.35 + 1.15 * s;
    al = mix(al, -0.85, a.crouch);
    el2 = mix(el2, 0.5, a.crouch);
    al = mix(al, j === 1 ? 1.55 : -0.55, a.air);
    el2 = mix(el2, j === 1 ? 0.25 : 1.2, a.air);
    al = mix(al, 2.3, a.stumble * 0.8);
    const elbow = { x: shoulder.x + UA * Math.sin(al), y: shoulder.y - UA * Math.cos(al) };
    const wrist = { x: elbow.x + FA * Math.sin(al + el2), y: elbow.y - FA * Math.cos(al + el2) };
    arms.push({ elbow, wrist });
  }
  const abs = (p) => ({ x: hip.x + p.x, y: hip.y + p.y });
  return {
    hip, shoulder, head, arms,
    legs: legs.map((l) => ({ knee: abs(l.knee), ankle: abs(l.ankle), toe: abs(l.toe) })),
  };
}

function av(over) { return Object.assign({ gait: 0, phase: 0, crouch: 0, air: 0, stumble: 0, charged: false, t: 0 }, over); }

function* poseSweep() {
  for (const gait of [0, 0.03, 0.4, 1]) {
    for (let k = 0; k < 11; k++) {
      for (const crouch of [0, 0.5, 1]) {
        for (const air of [0, 0.5, 1]) {
          for (const stumble of [0, 0.5]) for (const t of [0, 1.3]) yield av({ gait, phase: k / 10, crouch, air, stumble, t });
        }
      }
    }
  }
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

test('runnerPose matches the pre-move app.js implementation exactly', () => {
  let n = 0;
  for (const a of poseSweep()) {
    for (const rm of [false, true]) {
      assert.deepStrictEqual(G.runnerPose(a, rm), legacyRunnerPose(a, rm));
      n++;
    }
  }
  assert.ok(n > 3000);
});

test('runnerPose with a preallocated out gives the same numbers and returns out', () => {
  const out = G.makePose();
  for (const a of poseSweep()) {
    const fresh = G.runnerPose(a, false);
    const r = G.runnerPose(a, false, out);
    assert.equal(r, out);
    assert.deepStrictEqual(out, fresh);
  }
  const a = av({ gait: 0.7, phase: 0.2 });
  assert.notEqual(G.runnerPose(a, false), G.runnerPose(a, false), 'without out each call allocates');
  assert.deepStrictEqual(Object.keys(G.makePose()), ['hip', 'shoulder', 'head', 'arms', 'legs']);
});

test('runnerPose heights: standing, crouched and airborne', () => {
  const HEAD_R = 0.125;
  for (let k = 0; k < 20; k++) {
    const p = G.runnerPose(av({ phase: k / 20 }), true);
    near(p.hip.y, 1.0, 0.015, 'standing hip');
    near(p.head.y + HEAD_R, 1.88, 0.015, 'standing head top');
  }
  const crouch = G.runnerPose(av({ crouch: 1 }), true);
  const air = G.runnerPose(av({ air: 1 }), true);
  near(crouch.hip.y, 0.66, 0.01, 'crouch hip');
  near(crouch.head.y + HEAD_R, 1.47, 0.01, 'crouch head top');
  near(air.hip.y, 0.38, 0.01, 'air hip is r.y + 0.38');
  near(air.head.y + HEAD_R, 1.14, 0.01, 'air head top is r.y + 1.14');
});

test('runnerPose keeps the lowest ankle or toe at 0.05 and the segment lengths fixed', () => {
  for (const a of poseSweep()) {
    const p = G.runnerPose(a, true); // no breathing, so the floor is exact
    const low = Math.min(p.legs[0].ankle.y, p.legs[1].ankle.y, p.legs[0].toe.y, p.legs[1].toe.y);
    near(low, 0.05, 1e-9, 'lowest point');
    for (const leg of p.legs) {
      near(dist(p.hip, leg.knee), 0.46, 1e-9, 'thigh');
      near(dist(leg.knee, leg.ankle), 0.46, 1e-9, 'shin');
    }
    for (const arm of p.arms) {
      near(dist(p.shoulder, arm.elbow), 0.29, 1e-9, 'upper arm');
      near(dist(arm.elbow, arm.wrist), 0.27, 1e-9, 'forearm');
    }
  }
});

test('reduceMotion removes the breathing bob', () => {
  const rest = (t, rm) => G.runnerPose(av({ t }), rm).hip.y;
  assert.equal(rest(0.3, true), rest(1.1, true));
  assert.notEqual(rest(0.3, false), rest(1.1, false));
  near(Math.abs(rest(0.3, false) - rest(0.3, true)), Math.abs(Math.sin(0.48)) * 0.008, 1e-9);
  // moving or airborne: no breathing either way
  assert.equal(G.runnerPose(av({ gait: 0.5, t: 0.3 }), false).hip.y, G.runnerPose(av({ gait: 0.5, t: 0.3 }), true).hip.y);
});

// ------------------------------------------------------------------ hurdles
test('easeOutBack peaks at 1.0706 near 0.61 and ends at 1', () => {
  let best = 0;
  let at = 0;
  for (let i = 0; i <= 1000; i++) {
    const v = G.easeOutBack(i / 1000);
    if (v > best) { best = v; at = i / 1000; }
  }
  near(best, 1.0706, 0.0001);
  near(at, 0.61, 0.005);
  assert.equal(G.easeOutBack(0), 0);
  assert.equal(G.easeOutBack(1), 1);
});

test('tipAngle: overshoots to 1.477 and settles at 1.38 only for hit hurdles', () => {
  assert.equal(G.tipAngle({ state: 'up', fall: 0.6 }), 0);
  assert.equal(G.tipAngle({ state: 'cleared', fall: 1 }), 0);
  assert.equal(G.tipAngle({ state: 'hit', fall: 0 }), 0);
  near(G.tipAngle({ state: 'hit', fall: 0.61 }), 1.477, 0.001);
  near(G.tipAngle({ state: 'hit', fall: 1 }), 1.38, 1e-12);
  near(deg(G.tipAngle({ state: 'hit', fall: 0.61 })), 84.6, 0.1);
  near(deg(G.tipAngle({ state: 'hit', fall: 1 })), 79.1, 0.1);
});

test('laneZ: lane 4 is Z 0 and the track runs from -4.27 to +5.49', () => {
  assert.equal(G.laneZ(4), 0);
  near(G.laneZ(0) - 0.61, -5.49, 1e-9);
  near(G.laneZ(8) + 0.61, 5.49, 1e-9);
  near(G.laneZ(0) + 0.61, -4.27, 1e-9);
  near(G.laneZ(5) - G.laneZ(4), 1.22, 1e-12);
});

test('farScale: 1.0 inside 8 m, 1.4 beyond 28 m, smooth and rising between', () => {
  assert.equal(G.farScale(0), 1);
  assert.equal(G.farScale(8), 1);
  assert.equal(G.farScale(28), 1.4);
  assert.equal(G.farScale(60), 1.4);
  near(G.farScale(18), 1.2, 1e-12);
  let prev = 1;
  for (let d = 8; d <= 28; d += 0.5) {
    const f = G.farScale(d);
    assert.ok(f >= prev);
    prev = f;
  }
});

// ------------------------------------------------------------- chase camera
const VIEWS = [
  { w: 390, h: 844, cls: 'portrait' },
  { w: 844, h: 390, cls: 'wide' },
  { w: 1280, h: 800, cls: 'standard' },
];

test('rigFor picks the class from the aspect ratio', () => {
  assert.equal(G.rigFor(390, 844), G.RIGS.portrait);
  assert.equal(G.rigFor(999, 1000), G.RIGS.portrait);
  assert.equal(G.rigFor(1000, 1000), G.RIGS.standard);
  assert.equal(G.rigFor(1280, 800), G.RIGS.standard);
  assert.equal(G.rigFor(1899, 1000), G.RIGS.standard);
  assert.equal(G.rigFor(1900, 1000), G.RIGS.wide);
  assert.equal(G.rigFor(844, 390), G.RIGS.wide);
  for (const v of VIEWS) assert.equal(G.rigFor(v.w, v.h).name, v.cls);
});

test('solveRig: pitch follows the design table (wide differs, see geom.js)', () => {
  const p = (name, s) => deg(G.solveRig(G.RIGS[name], s).pitch);
  near(p('portrait', 0), 21.1, 0.05);
  near(p('standard', 0), 17.4, 0.05);
  for (const name of ['portrait', 'standard', 'wide']) {
    const r = G.RIGS[name];
    const sol = G.solveRig(r, 0);
    assert.deepStrictEqual([sol.back, sol.height], [r.back, r.height]);
    const tanHalf = Math.tan((r.vfov * Math.PI) / 360);
    near(sol.pitch, Math.atan(r.height / r.back) - Math.atan((2 * r.feetRow - 1) * tanHalf), 1e-12);
    const fast = G.solveRig(r, 1);
    near(fast.back, r.back + 0.5, 1e-12);
    near(fast.height, r.height + 0.15, 1e-12);
    const preset = { back: 0, height: 0, pitch: 0, tanHalf: 0, vfov: 0 };
    assert.equal(G.solveRig(r, 1, preset), preset);
    assert.deepStrictEqual(preset, fast);
  }
});

test('solveRig: the feet stay on the feet row at every speed and in every class', () => {
  for (const v of VIEWS) {
    const rig = G.rigFor(v.w, v.h);
    for (const s of [0, 0.25, 0.5, 1]) {
      const sol = G.solveRig(rig, s);
      const f = G.projectPx(sol, v.w, v.h, 0, 0, 0);
      near(f.y / v.h, rig.feetRow, 0.002, v.cls + ' s=' + s);
      near(f.x, v.w / 2, 1e-9);
    }
  }
});

test('projectPx: +Z is screen right, nearer is lower, depth grows with distance', () => {
  const sol = G.solveRig(G.RIGS.standard, 0);
  const mid = G.projectPx(sol, 1280, 800, 10, 0, 0);
  assert.ok(G.projectPx(sol, 1280, 800, 10, 0, 1.22).x > mid.x);
  assert.ok(G.projectPx(sol, 1280, 800, 10, 0, -1.22).x < mid.x);
  assert.ok(G.projectPx(sol, 1280, 800, 5, 0, 0).y > mid.y);
  assert.ok(G.projectPx(sol, 1280, 800, 20, 0, 0).depth > mid.depth);
  const o = { x: 0, y: 0, depth: 0 };
  assert.equal(G.projectPx(sol, 1280, 800, 10, 0, 0, o), o);
  assert.deepStrictEqual(o, mid);
});

// Pixel size of the next hurdle through the chase camera: ground to board top
// (y 0 to 0.914, scaled about its base by farScale), which is what the design
// table's pixel column measures. The 0.18 m board strip alone (y 0.734 to
// 0.914) is only 4.7 to 9.0 px tall in these views, too small for a 24 px floor.
function hurdleView(v, s, d) {
  const sol = G.solveRig(G.rigFor(v.w, v.h), s);
  const f = G.farScale(d);
  const base = G.projectPx(sol, v.w, v.h, d, 0, 0);
  const top = G.projectPx(sol, v.w, v.h, d, 0.914 * f, 0);
  return { px: base.y - top.y, topRow: top.y / v.h };
}

test('sight guarantee: the hurdle is at least 24 px tall at 14 m and 22 px at 20 m', () => {
  for (const v of VIEWS) {
    for (const s of [0, 0.5, 1]) {
      assert.ok(hurdleView(v, s, 14).px >= 24, v.cls + ' s=' + s + ' 14 m: ' + hurdleView(v, s, 14).px);
      assert.ok(hurdleView(v, s, 20).px >= 22, v.cls + ' s=' + s + ' 20 m: ' + hurdleView(v, s, 20).px);
    }
  }
});

test('sight guarantee: the board top stays below the HUD line (22% of H) at 14 m', () => {
  for (const v of VIEWS) {
    for (const s of [0, 0.5, 1]) {
      const { topRow } = hurdleView(v, s, 14);
      assert.ok(topRow >= 0.22, v.cls + ' s=' + s + ' top row ' + topRow);
    }
  }
});

test('sight guarantee: the wide class needs farScale to hold it', () => {
  // Unscaled, the 0.914 m hurdle at 20 m on a 844x390 phone is about 19 px.
  const v = VIEWS[1];
  const sol = G.solveRig(G.rigFor(v.w, v.h), 1);
  const plain = G.projectPx(sol, v.w, v.h, 20, 0, 0).y - G.projectPx(sol, v.w, v.h, 20, 0.914, 0).y;
  assert.ok(plain < 22, 'unscaled ' + plain);
  assert.ok(hurdleView(v, 1, 20).px >= 22);
});

// ---------------------------------------------------------------- smoothing
test('approach is frame-rate independent', () => {
  const run = (dt) => {
    let x = 0;
    for (let i = 0; i < Math.round(1 / dt); i++) x = G.approach(x, 1, dt, 0.6);
    return x;
  };
  const exact = 1 - Math.exp(-1 / 0.6);
  for (const dt of [1, 0.5, 1 / 30, 1 / 60, 1 / 144]) near(run(dt), exact, 1e-12, 'dt ' + dt);
  assert.equal(G.approach(3, 9, 0, 0.5), 3);
  near(G.approach(3, 9, 100, 0.5), 9, 1e-12);
  near(G.approach(5, 1, 0.2, 0.2), 1 + 4 * Math.exp(-1), 1e-12);
});

// ------------------------------------------------------------------ quality
test('TIERS follow the design table', () => {
  const rows = G.TIERS.map((t) => [t.name, t.dprCap, t.maxMP, t.particles, t.far, t.fogNear, t.fogFar, t.stars, t.glows, t.fps]);
  assert.deepStrictEqual(rows, [
    ['T0', 2, 2.0, 256, 120, 36, 85, true, true, 60],
    ['T1', 1.5, 1.4, 256, 120, 36, 85, true, true, 60],
    ['T2', 1.25, 0.9, 128, 90, 30, 70, false, false, 60],
    ['T3', 1.0, 0.55, 0, 90, 30, 70, false, false, 30],
  ]);
});

test('pixelRatio: tier cap, megapixel budget and real DPR, whichever is smallest', () => {
  const t = (tier) => G.pixelRatio(3, 393, 852, tier);
  assert.equal(t(0), 2);
  assert.equal(t(1), 1.5);
  assert.equal(t(2), 1.25);
  assert.equal(t(3), 1);
  assert.equal(G.pixelRatio(3, 393, 852, G.TIERS[1]), 1.5);
  assert.equal(G.pixelRatio(1, 393, 852, 0), 1);
  // 1920x1080 css is 2.07 MP before any scaling, so the budget binds
  near(G.pixelRatio(2, 1920, 1080, 0), Math.sqrt(2.0e6 / (1920 * 1080)), 1e-12);
  near(G.pixelRatio(2, 1920, 1080, 1), Math.sqrt(1.4e6 / (1920 * 1080)), 1e-12);
  near(G.pixelRatio(2, 1920, 1080, 3), Math.sqrt(0.55e6 / (1920 * 1080)), 1e-12);
  // the rendered pixel count never exceeds the budget
  for (const [w, h] of [[390, 844], [844, 390], [1280, 800], [2560, 1440]]) {
    for (let k = 0; k < 4; k++) {
      const r = G.pixelRatio(3, w, h, k);
      assert.ok(r * r * w * h <= G.TIERS[k].maxMP * 1e6 * (1 + 1e-9));
    }
  }
});

// Feeds a controller frames every `interval` ms for `ms` ms and returns the end time and any verdicts.
function drive(ctl, from, ms, interval, opts) {
  const o = Object.assign({ canApply: true, pose: 0 }, opts);
  const acts = [];
  let t = from;
  const end = from + ms;
  while (t < end) {
    ctl.frame(t);
    if (o.pose) ctl.pose(t, typeof o.pose === 'function' ? o.pose(t) : o.pose);
    const a = ctl.check(t, o.canApply);
    if (a !== 'none') acts.push({ t, a });
    t += interval;
  }
  return { t, acts };
}
const HZ60 = 1000 / 60;

test('QualityController: steady 60 fps never steps down', () => {
  const ctl = new G.QualityController();
  const { acts } = drive(ctl, 0, 40000, HZ60);
  assert.deepStrictEqual(acts, []);
  assert.equal(ctl.tier, 0);
  near(ctl.target, 60, 1);
  const jit = new G.QualityController(); // frame-time jitter around 60 fps is still 60 fps
  for (let i = 0, t = 0; i < 3000; i++, t += i % 2 ? 18 : 15) { jit.frame(t); assert.equal(jit.check(t, true), 'none'); }
  assert.equal(jit.tier, 0);
});

test('QualityController: 40 fps for 3 s gives exactly one step', () => {
  const ctl = new G.QualityController();
  const warm = drive(ctl, 0, 4000, HZ60);
  assert.deepStrictEqual(warm.acts, []);
  const slow = drive(ctl, warm.t, 3000, 25);
  assert.equal(slow.acts.length, 1);
  assert.equal(slow.acts[0].a, 'down');
  assert.ok(slow.acts[0].t - warm.t < 3000);
  assert.equal(ctl.tier, 1);
});

test('QualityController: the target is only set after the first 3 s, and a few slow windows are not enough', () => {
  const ctl = new G.QualityController();
  const early = drive(ctl, 0, 2500, HZ60);
  assert.equal(ctl.target, 0);
  const later = drive(ctl, early.t, 1000, HZ60);
  near(ctl.target, 60, 1);
  // five slow windows (about 1.25 s) out of ten: under the 7 needed
  const brief = drive(ctl, later.t, 1250, 25);
  const back = drive(ctl, brief.t, 6000, HZ60);
  assert.deepStrictEqual(brief.acts.concat(back.acts), []);
  assert.equal(ctl.tier, 0);
  // eight of them are enough
  const long = drive(ctl, back.t, 2200, 25);
  assert.equal(long.acts.length, 1);
});

test('QualityController: a locked 33 ms frame time is a 30 Hz device, not a slow one', () => {
  const ctl = new G.QualityController();
  const { acts } = drive(ctl, 0, 40000, 100 / 3);
  assert.deepStrictEqual(acts, []);
  assert.equal(ctl.tier, 0);
  near(ctl.target, 30, 1);
});

test('QualityController: the target is capped at 60 on a 120 Hz device', () => {
  const ctl = new G.QualityController();
  assert.deepStrictEqual(drive(ctl, 0, 20000, 1000 / 120).acts, []);
  assert.equal(ctl.target, 60);
});

test('QualityController: 8 s cooldown between steps', () => {
  const ctl = new G.QualityController();
  const warm = drive(ctl, 0, 4000, HZ60);
  const first = drive(ctl, warm.t, 3000, 25);
  const t1 = first.acts[0].t;
  const during = drive(ctl, first.t, t1 + 8000 - first.t - 1, 25);
  assert.deepStrictEqual(during.acts, [], 'no second step inside the cooldown');
  const after = drive(ctl, during.t, 4000, 25);
  assert.equal(after.acts.length, 1);
  assert.ok(after.acts[0].t >= t1 + 8000);
  assert.equal(ctl.tier, 2);
});

test('QualityController: down only, and past T3 it gives up on 3D', () => {
  const ctl = new G.QualityController();
  const slow = drive(ctl, drive(ctl, 0, 4000, HZ60).t, 60000, 25);
  assert.deepStrictEqual(slow.acts.map((a) => a.a), ['down', 'down', 'down', 'to2d']);
  assert.equal(ctl.tier, 3);
  assert.equal(ctl.emergency, false);
  assert.equal(drive(ctl, slow.t, 20000, 25).acts.length, 0, 'finished: nothing more to say');
  // recovering never moves the tier back up
  const ok = new G.QualityController();
  const s = drive(ok, drive(ok, 0, 4000, HZ60).t, 3000, 25);
  assert.equal(ok.tier, 1);
  drive(ok, s.t, 60000, HZ60);
  assert.equal(ok.tier, 1);
});

test('QualityController: steps wait for a phase that allows them, emergencies do not', () => {
  const ctl = new G.QualityController();
  const warm = drive(ctl, 0, 4000, HZ60);
  const racing = drive(ctl, warm.t, 5000, 25, { canApply: false });
  assert.deepStrictEqual(racing.acts, []);
  assert.equal(ctl.tier, 0);
  const free = drive(ctl, racing.t, 100, 25, { canApply: true });
  assert.equal(free.acts.length, 1);
  assert.equal(free.acts[0].a, 'down');

  const dead = new G.QualityController();
  const w2 = drive(dead, 0, 4000, HZ60);
  const crawl = drive(dead, w2.t, 6000, 100, { canApply: false });
  assert.equal(crawl.acts.length, 1);
  assert.equal(crawl.acts[0].a, 'to2d');
  assert.equal(dead.emergency, true);
});

test('QualityController: discard and clear drop windows instead of counting them', () => {
  const ctl = new G.QualityController();
  const warm = drive(ctl, 0, 4000, HZ60);
  assert.equal(ctl.count, 10);
  ctl.clear();
  assert.equal(ctl.count, 0);
  const a = drive(ctl, warm.t, 520, HZ60);
  assert.equal(ctl.count, 0, 'two windows are skipped after clear()');
  drive(ctl, a.t, 400, HZ60);
  assert.ok(ctl.count >= 1);
  // a long stall (tab hidden) is not a slow frame
  const c = new G.QualityController();
  const w = drive(c, 0, 4000, HZ60);
  const afterStall = drive(c, w.t + 20000, 6000, HZ60);
  assert.deepStrictEqual(afterStall.acts, []);
  assert.equal(c.tier, 0);
});

test('QualityController: slow pose rate steps down after 3 s, judged against the 2D baseline', () => {
  const run = (baselineFps, poseFps, ms) => {
    const ctl = new G.QualityController();
    let t = 0;
    if (baselineFps) {
      for (; t < 3000; t += HZ60) { ctl.frame(t); ctl.pose(t, baselineFps); ctl.check(t, true); }
    } else {
      for (; t < 3000; t += HZ60) { ctl.frame(t); ctl.check(t, true); }
    }
    ctl.setView3d(t, true);
    const r = drive(ctl, t, ms, HZ60, { pose: poseFps });
    return { acts: r.acts.map((x) => x.a), ctl, started: t, at: r.acts.length ? r.acts[0].t : 0 };
  };
  const bad = run(30, 18, 3500);
  assert.deepStrictEqual(bad.acts, ['down']);
  near(bad.at - bad.started, 3000, 40);
  assert.equal(bad.ctl.tier, 1);
  near(bad.ctl.baseline, 30, 0.001);
  assert.deepStrictEqual(run(30, 18, 2800).acts, [], 'not yet 3 s');
  assert.deepStrictEqual(run(30, 25, 6000).acts, [], '25 fps is above the 22 fps floor');
  assert.deepStrictEqual(run(20, 18, 6000).acts, [], 'pose was already slow in 2D, 3D is not to blame');
  assert.deepStrictEqual(run(0, 18, 3500).acts, ['down'], 'no baseline: absolute 22 fps rule');
  assert.equal(run(0, 18, 3500).ctl.baseline, null);
  const ctl = new G.QualityController(); // a recovery inside the 3 s resets the timer
  ctl.setView3d(0, true);
  assert.deepStrictEqual(drive(ctl, 0, 5500, HZ60, { pose: (t) => (t >= 2900 && t < 3100 ? 40 : 18) }).acts, []);
});
