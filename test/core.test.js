'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/core.js');
const LF = globalThis.LaneFour;
const { W, H, rng, poses, squatSeq, project } = require('./synth.js');

const ASPECT = W / H;

// Runs a synthetic sequence through the same pipeline the app uses.
// The first `calib` seconds are standing still for calibration.
function run(seqFn, opts = {}) {
  const {
    seconds = 10, fps = 30, seed = 7, calib = 1.5, noise = 1.5,
    scaleFn = () => 210, cyFn = () => H * 0.5, stepT = 0.045, squatDown = 0.4,
  } = opts;
  const r = rng(seed);
  const smoother = new LF.PoseSmoother();
  const cal = new LF.Calibrator(1.0);
  const stepDet = new LF.StepDetector({ threshold: stepT });
  const squatDet = new LF.SquatDetector({ down: squatDown });
  const hands = new LF.HandsUpDetector();
  const cadence = new LF.CadenceMeter();
  const out = { base: null, baseT: null, steps: [], squats: [], hands: 0, framing: {}, cadenceAt: [], maxDepth: 0, maxAbsStep: 0 };
  const total = calib + seconds;
  for (let i = 0; i <= Math.round(total * fps); i++) {
    const t = i / fps;
    const joints = t < calib ? poses.still() : seqFn(t - calib);
    const lm = project(joints, { scale: scaleFn(t), cy: cyFn(t), noise, r });
    const pts = smoother.apply(lm, ASPECT, t);
    const fr = LF.assessFraming(pts, ASPECT);
    out.framing[fr.status] = (out.framing[fr.status] || 0) + 1;
    if (hands.update(pts, t)) out.hands++;
    if (fr.status !== 'ok') continue;
    const m = LF.measure(pts);
    if (!out.base) {
      const b = cal.push(m, t);
      if (b) {
        out.base = b; out.baseT = t;
        const eff = LF.effectiveThresholds(b, stepT, squatDown);
        stepDet.threshold = eff.step;
        squatDet.setDown(eff.squat);
        out.eff = eff;
      }
      continue;
    }
    const s = LF.stepSignal(m, out.base);
    const d = LF.squatDepth(m, out.base);
    out.maxDepth = Math.max(out.maxDepth, d);
    if (t >= calib) out.maxAbsStep = Math.max(out.maxAbsStep, Math.abs(s));
    const side = stepDet.update(s, t);
    if (side) { out.steps.push({ t, side }); cadence.step(t); }
    const sq = squatDet.update(d, t);
    if (sq) out.squats.push({ t, ...sq });
    out.cadenceAt.push({ t, spm: cadence.value(t) });
  }
  out.downs = out.squats.filter((s) => s.type === 'down');
  out.ups = out.squats.filter((s) => s.type === 'up');
  return out;
}

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: got ${actual}, expected ${expected} ± ${tol}`);

test('calibrates within ~1.2 s of standing still', () => {
  const o = run(() => poses.still(), { seconds: 2 });
  assert.ok(o.base, 'baseline captured');
  assert.ok(o.baseT <= 1.3, `baseline at ${o.baseT}s`);
  near(o.base.ratio, (412 - 232) / 84, 0.25, 'leg/shoulder ratio'); // ~2.14 at 210 px/m
});

test('standing still with jitter: no steps, no squats', () => {
  const o = run(() => poses.still(), { seconds: 12, noise: 2.5 });
  assert.equal(o.steps.length, 0);
  assert.equal(o.downs.length, 0);
});

test('jogging in place at 160 spm counts steps and cadence', () => {
  const o = run((t) => poses.inPlace(t, { cadence: 160, style: 'jog' }), { seconds: 10 });
  near(o.steps.length, 26.7, 2.5, 'steps');
  assert.equal(o.downs.length, 0, 'no squats while jogging');
  const late = o.cadenceAt.filter((c) => c.t > 6 && c.t < 11);
  near(late.reduce((s, c) => s + c.spm, 0) / late.length, 160, 12, 'cadence');
  // steps alternate sides
  for (let i = 1; i < o.steps.length; i++) assert.notEqual(o.steps[i].side, o.steps[i - 1].side);
});

test('marching at 110 spm', () => {
  const o = run((t) => poses.inPlace(t, { cadence: 110, style: 'march' }), { seconds: 10 });
  near(o.steps.length, 18.3, 2, 'steps');
  assert.equal(o.downs.length, 0);
});

test('high knees at 180 spm never read as squats', () => {
  const o = run((t) => poses.inPlace(t, { cadence: 180, style: 'highknees' }), { seconds: 8 });
  near(o.steps.length, 24, 2.5, 'steps');
  assert.equal(o.downs.length, 0);
});

test('butt kicks at 170 spm', () => {
  const o = run((t) => poses.inPlace(t, { cadence: 170, style: 'buttkicks' }), { seconds: 8 });
  near(o.steps.length, 22.7, 2.5, 'steps');
  assert.equal(o.downs.length, 0);
});

test('five deep squats: five down/up pairs, no steps', () => {
  const o = run((t) => squatSeq(t, { reps: 5, q: 1 }), { seconds: 13 });
  assert.equal(o.downs.length, 5);
  assert.equal(o.ups.length, 5);
  assert.equal(o.steps.length, 0, 'squats are not steps');
  for (const u of o.ups) near(u.maxDepth, 1, 0.2, 'max depth of a parallel squat');
});

test('half squats count, shallow dips do not', () => {
  const half = run((t) => squatSeq(t, { reps: 5, q: 0.55 }), { seconds: 13 });
  assert.equal(half.downs.length, 5, 'half squats');
  const dip = run((t) => squatSeq(t, { reps: 5, q: 0.25 }), { seconds: 13 });
  assert.equal(dip.downs.length, 0, 'shallow dips');
});

test('stepping toward or away from the camera is not a squat', () => {
  const closer = run(() => poses.still(), { seconds: 6, scaleFn: (t) => (t < 2 ? 210 : Math.min(260, 210 + (t - 2) * 15)) });
  assert.equal(closer.downs.length, 0, 'closer');
  assert.equal(closer.steps.length, 0, 'closer steps');
  const farther = run(() => poses.still(), { seconds: 6, scaleFn: (t) => (t < 2 ? 210 : Math.max(160, 210 - (t - 2) * 15)) });
  assert.equal(farther.downs.length, 0, 'farther');
});

test('noisy, distant camera: thresholds rise above the noise floor', () => {
  const far = { noise: 4, scaleFn: () => 150 };
  const still = run(() => poses.still(), { seconds: 12, ...far });
  assert.ok(still.eff.step > 0.045, `raised step threshold ${still.eff.step}`);
  assert.ok(still.steps.length <= 1, `phantom steps ${still.steps.length}`);
  const jog = run((t) => poses.inPlace(t, { cadence: 160 }), { seconds: 10, noise: 3, scaleFn: () => 150 });
  near(jog.steps.length, 26.7, 4, 'steps while jogging far away');
});

test('raising both hands fires once per raise', () => {
  const o = run((t) => (t > 1 && t < 2.2) || (t > 3 && t < 4.2) ? poses.handsUp() : poses.still(), { seconds: 5 });
  assert.equal(o.hands, 2);
});

test('feet out of frame reports "feet"', () => {
  const o = run(() => poses.still(), { seconds: 2, cyFn: () => H * 0.5 + 120 });
  assert.ok((o.framing.feet || 0) > 30, JSON.stringify(o.framing));
  assert.equal(o.base, null, 'no calibration without feet');
});

test('cannot calibrate mid-squat', () => {
  const o = run((t) => squatSeq(t, { reps: 3, q: 1, rest: 0 }), { seconds: 5, calib: 0 });
  assert.equal(o.base, null);
});

// --------------------------------------------------------------------------
// Race simulation

// Steps at a fixed cadence; squat policy decides when to squat and stand.
function race({ distance = 400, cadence = 160, policy = () => null, fps = 60, maxT = 300 }) {
  const r = new LF.Race(distance, { squatDown: 0.4 });
  const meter = new LF.CadenceMeter();
  const ev = [];
  let nextStep = 0;
  let squatting = false;
  let depth = 0;
  for (let i = 0; i < maxT * fps && !r.finished; i++) {
    const t = i / fps;
    const dt = 1 / fps;
    let steps = 0;
    const h = r.nextHurdle();
    const toH = h ? h.x - r.x : Infinity;
    const act = policy(toH, r, squatting);
    let squat = null;
    if (act === 'down' && !squatting) { squatting = true; depth = act.depth || 1; squat = { type: 'down', depth: 1 }; }
    if (act && act.type === 'down' && !squatting) { squatting = true; depth = act.depth; squat = { type: 'down', depth: act.depth }; }
    if (act === 'up' && squatting) { squatting = false; squat = { type: 'up', maxDepth: depth }; }
    if (!squatting && t >= nextStep) { steps = 1; meter.step(t); nextStep = t + 60 / cadence; }
    if (squatting) nextStep = t + 0.3; // first step after standing comes shortly after
    const out = r.update(dt, { steps, cadence: meter.value(t), depth: squatting ? depth : 0, squat });
    for (const e of out) ev.push({ t, ...e });
  }
  return { r, ev };
}

test('steady jogging with well-timed squats clears every hurdle', () => {
  const { r } = race({ policy: (toH, _r, sq) => (toH < 5.5 && toH > 2.8 && !sq ? 'down' : sq && toH <= 2.8 ? 'up' : null) });
  assert.ok(r.finished);
  assert.equal(r.stats.cleared, 10, JSON.stringify(r.stats));
  assert.equal(r.stats.clipped, 0);
  assert.ok(r.finishTime > 70 && r.finishTime < 110, `time ${r.finishTime}`);
});

test('never squatting clips every hurdle but still finishes', () => {
  const { r } = race({});
  assert.ok(r.finished);
  assert.equal(r.stats.clipped, 10);
  assert.equal(r.stats.cleared, 0);
});

test('holding a squat into the hurdle jumps for you', () => {
  const { r, ev } = race({ policy: (toH, _r, sq) => (toH < 4 && !sq ? 'down' : sq && toH > 30 ? 'up' : null) });
  assert.equal(r.stats.cleared, 10, JSON.stringify(r.stats));
  assert.ok(ev.filter((e) => e.type === 'assist').length >= 9, 'assisted jumps');
});

test('the squat-and-hold assist still clears hurdles at sprint speed', () => {
  const { r } = race({ cadence: 250, policy: (toH, _r, sq) => (toH < 4.5 && !sq ? 'down' : sq && toH > 30 ? 'up' : null) });
  assert.equal(r.stats.cleared, 10, JSON.stringify(r.stats));
});

test('jumping far too early clips the hurdle', () => {
  const { r } = race({ distance: 200, policy: (toH, _r, sq) => (toH < 12 && toH > 10 && !sq ? 'down' : sq && toH <= 10 ? 'up' : null) });
  assert.equal(r.stats.clipped, 5, JSON.stringify(r.stats));
});

test('a deep squat timed near the apex collects the star', () => {
  const { r } = race({ distance: 200, policy: (toH, _r, sq) => (toH < 6.5 && toH > 2.7 && !sq ? { type: 'down', depth: 1.05 } : sq && toH <= 2.7 ? 'up' : null) });
  assert.equal(r.stats.cleared, 5, JSON.stringify(r.stats));
  assert.ok(r.stats.stars >= 4, `stars ${r.stats.stars}`);
});

test('formatTime', () => {
  assert.equal(LF.formatTime(0), '0:00.0');
  assert.equal(LF.formatTime(9.99), '0:09.9');
  assert.equal(LF.formatTime(72.46), '1:12.4');
});
