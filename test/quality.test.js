'use strict';
// Geom.QualityController: when 3D lowers its quality tier, and, as much, when it must not. It is driven with
// synthetic frame timelines the way scene3d.js render() feeds it: idle() behind a sheet, frame() then check()
// everywhere else. The rule it serves: the quality may go down, the view never leaves 3D.
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/core.js');
require('../src/geom.js');
const G = globalThis.LaneFour.Geom;
const LAST = G.TIERS.length - 1;

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ' expected ' + a + ' to be within ' + tol + ' of ' + b);
const HZ60 = 1000 / 60;
const hz = (f) => 1000 / f;
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// Drives ctl from `from` for `ms`. interval: ms between frames, or (msSinceFrom, tier) => ms. phase: a name, or
// (msSinceFrom) => name. 'intro' and 'results' are sheets (idle()); a step waits for a phase that is neither
// 'countdown' nor 'running'. Returns the end time and every verdict that was not 'none'.
function drive(ctl, from, ms, interval, phase = 'ready') {
  const acts = [];
  let t = from;
  const end = from + ms;
  while (t < end) {
    const ph = typeof phase === 'function' ? phase(t - from) : phase;
    if (ph === 'intro' || ph === 'results') ctl.idle(t);
    else {
      ctl.frame(t);
      const a = ctl.check(t, ph !== 'countdown' && ph !== 'running');
      if (a !== 'none') acts.push({ t, a, tier: ctl.tier, reason: ctl.reason });
    }
    t += typeof interval === 'function' ? interval(t - from, ctl.tier) : interval;
  }
  return { t, acts };
}
const alternating = (a, b) => { let k = 0; return () => (k++ % 2 ? a : b); }; // a frame interval of a, then b, then a...
const verdicts = (r) => r.acts.map((x) => x.a);
// A controller that has learned 60 fps (4 s of it) and is ready for what comes next.
function warmed(opts) {
  const ctl = new G.QualityController(opts);
  return { ctl, t: drive(ctl, 0, 4000, HZ60).t };
}

test('steady 60 fps never steps down, with or without jitter, in any phase', () => {
  const ctl = new G.QualityController();
  assert.deepEqual(drive(ctl, 0, 40000, HZ60).acts, []);
  assert.equal(ctl.tier, 0);
  near(ctl.target, 60, 1);
  const jit = new G.QualityController();
  assert.deepEqual(drive(jit, 0, 40000, (rel) => (rel % 2 < 1 ? 15 : 18)).acts, []);
  const race = new G.QualityController();
  const w = drive(race, 0, 4000, HZ60);
  assert.deepEqual(drive(race, w.t, 60000, HZ60, (rel) => (rel < 4000 ? 'countdown' : 'running')).acts, []);
  assert.equal(race.tier, 0);
  const hi = new G.QualityController(); // a 120 Hz device: the target is capped at 60
  assert.deepEqual(drive(hi, 0, 20000, 1000 / 120).acts, []);
  assert.equal(hi.target, 60);
});

test('the pose rate has no say: the controller takes none, so a camera-limited 15 or 20 fps changes nothing', () => {
  const ctl = new G.QualityController();
  for (const gone of ['pose', 'setView3d', 'baseline', 'slowSince', 'view3d']) assert.ok(!(gone in ctl), gone + ' is gone');
  // rAF at 60 fps while the camera delivers 15 or 20: the controller only ever sees the rAF side
  for (const cam of [15, 20]) {
    const c = new G.QualityController({ tier: 1 });
    const r = drive(c, 0, 60000, HZ60, (rel) => (rel < 6000 ? 'ready' : rel < 40000 ? 'running' : 'finished'));
    assert.deepEqual(r.acts, [], 'camera at ' + cam + ' fps');
    assert.equal(c.tier, 1);
  }
});

test('a steady cadence at 30, 24 or 20 fps is a display rate, not slowness: from the start, and switched on mid-session', () => {
  for (const f of [30, 24, 20]) {
    const a = new G.QualityController(); // from the first frame
    assert.deepEqual(drive(a, 0, 40000, hz(f)).acts, [], f + ' from the start');
    near(a.target, f, 0.5);
    assert.equal(a.tier, 0);
    const b = new G.QualityController(); // Low Power Mode or Energy Saver comes on 10 s in
    const r = drive(b, 0, 10000, HZ60);
    near(b.target, 60, 1);
    assert.deepEqual(drive(b, r.t, 40000, hz(f)).acts, [], f + ' mid-session');
    near(b.target, f, 0.5, 'the target follows the display');
    assert.ok(b.adopted && b.tier === 0 && b.steps === 0);
    assert.match(b.describe(r.t + 40000), /display rate/);
    // jitter of a couple of ms around the cadence does not make it "slow"
    const c = new G.QualityController();
    const rc = drive(c, 0, 10000, HZ60);
    assert.deepEqual(drive(c, rc.t, 40000, () => hz(f) + (rnd() - 0.5) * 4).acts, [], f + ' with jitter');
    // and a race on top of it is the same: nothing to defer
    const d = new G.QualityController();
    const rd = drive(d, 0, 10000, HZ60);
    assert.deepEqual(drive(d, rd.t, 40000, hz(f), 'running').acts, []);
  }
  const off = new G.QualityController(); // and when Low Power Mode goes off again, a later real slowdown is still seen
  let t = drive(off, 0, 10000, HZ60).t;
  t = drive(off, t, 20000, hz(30)).t;
  t = drive(off, t, 12000, HZ60).t;
  near(off.target, 60, 1, 'the target rises with the display');
  assert.deepEqual(verdicts(drive(off, t, 12000, hz(38))), ['down']);
});

test('a regular 38 fps or an irregular 40 fps is slowness: one step, then it settles', () => {
  for (const [name, iv] of [['regular 38 fps', () => hz(38)], ['alternating 16.7 / 33.3 ms', alternating(16.7, 33.3)]]) {
    const { ctl, t } = warmed();
    const slow = drive(ctl, t, 30000, iv);
    assert.deepEqual(verdicts(slow), ['down'], name);
    assert.equal(ctl.tier, 1);
    assert.match(slow.acts[0].reason, /^slow: \d+ of 10 windows under 0\.85 x 60 fps/);
    assert.ok(slow.acts[0].t - t < 3500, 'within about 3 s of the change');
  }
});

test('real sustained slowness steps down and settles, without thrash and never back up', () => {
  const { ctl, t } = warmed();
  const device = (rel, tier) => [26, 21, 17.5, 16.7][tier]; // ms per frame at each tier
  const r = drive(ctl, t, 90000, device);
  assert.deepEqual(verdicts(r), ['down'], 'T0 at 38 fps: one step to T1 (48 fps), where it is fine');
  assert.equal(ctl.tier, 1);
  near(ctl.target, 1000 / 21, 1.5, 'T1 is judged against what T1 does');
  // a device that stays under the floor keeps stepping, 8 s apart at the least, and stops at the lowest tier
  const hard = warmed();
  const h = drive(hard.ctl, hard.t, 90000, (rel, tier) => [70, 65, 60, 55][tier]);
  assert.deepEqual(verdicts(h), ['down', 'down', 'down']);
  assert.deepEqual(h.acts.map((a) => a.tier), [1, 2, 3]);
  for (let i = 1; i < h.acts.length; i++) assert.ok(h.acts[i].t - h.acts[i - 1].t >= 8000, 'cooldown ' + (h.acts[i].t - h.acts[i - 1].t));
  assert.equal(hard.ctl.tier, LAST);
  assert.ok(h.acts.every((a) => /^(floor|slow): /.test(a.reason)));
  // recovering never moves the tier back up
  drive(hard.ctl, h.t, 60000, HZ60);
  assert.equal(hard.ctl.tier, LAST);
});

test('T3, or any tier, is not judged against a target learned at another tier', () => {
  const { ctl, t } = warmed({ tier: 1 });
  near(ctl.target, 60, 1);
  const r = drive(ctl, t, 4000, hz(38));
  assert.deepEqual(verdicts(r), ['down']);
  assert.equal(ctl.tier, 2);
  assert.equal(ctl.target, 0, 'the target is forgotten at the step');
  assert.equal(ctl.state(r.t).name, 'learning');
  // T2 then holds a steady 38 fps for a minute: judged against T2's own first seconds (38), it is fine
  const after = drive(ctl, r.t, 60000, hz(38));
  assert.deepEqual(after.acts, []);
  near(ctl.target, 38, 1);
  // the old rule judged a T3 running 44 fps against 0.85 x 56: the lowest tier now has no relative rule at all
  const low = warmed({ tier: LAST });
  assert.deepEqual(drive(low.ctl, low.t, 60000, hz(44)).acts, []);
});

test('the display rate is learned from the first 3 s only, and a few slow windows are not enough', () => {
  const ctl = new G.QualityController();
  const early = drive(ctl, 0, 2500, HZ60);
  assert.equal(ctl.target, 0);
  const later = drive(ctl, early.t, 1000, HZ60);
  near(ctl.target, 60, 1);
  // five slow windows (about 1.25 s) of ten: under the 7 needed
  const brief = drive(ctl, later.t, 1250, 25);
  const back = drive(ctl, brief.t, 6000, HZ60);
  assert.deepEqual(brief.acts.concat(back.acts), []);
  assert.equal(ctl.tier, 0);
  assert.deepEqual(verdicts(drive(ctl, back.t, 2600, 25)), ['down'], 'eight of them are enough');
});

test('an emergency (under 12 fps, measured over real elapsed time) goes straight to the lowest tier, in any phase', () => {
  for (const phase of ['ready', 'countdown', 'running']) {
    const { ctl, t } = warmed();
    const r = drive(ctl, t, 8000, hz(8), phase);
    assert.equal(r.acts[0].a, 'emergency', phase);
    assert.equal(r.acts[0].tier, LAST, 'in one move, not three');
    assert.ok(r.acts[0].t - t < 2400, 'on the newest 7 windows (about 1.8 s of 8 fps), not a full ring of 10: ' + (r.acts[0].t - t));
    assert.match(r.acts[0].reason, /^emergency: \d+\.\d fps over the last \d\.\d s$/);
    assert.ok(verdicts(r).every((a) => a !== 'down'));
    assert.equal(ctl.tier, LAST);
  }
  // right after the windows were wiped (a step, a sheet) it does not wait for a full ring of 10 either
  const fresh = new G.QualityController();
  const early = drive(fresh, 0, 8000, hz(8));
  assert.equal(early.acts[0].a, 'emergency');
  assert.ok(early.acts[0].t < 2200, 'about 1.8 s of 8 fps: ' + early.acts[0].t);
  // it ignores the cooldown too: a step, then the crawl 2 s later
  const { ctl, t } = warmed();
  const step = drive(ctl, t, 4000, hz(38));
  assert.deepEqual(verdicts(step), ['down']);
  const crawl = drive(ctl, step.t, 8000, hz(8));
  assert.equal(crawl.acts[0].a, 'emergency');
  assert.ok(crawl.acts[0].t < step.acts[0].t + 8000, 'inside the 8 s of cooldown');
  // real elapsed time, not a count of windows: 140 / 30 ms alternating is 11.8 fps although half the windows hold 4 frames
  const alt = new G.QualityController();
  const a = drive(alt, 0, 8000, alternating(30, 140));
  assert.equal(a.acts[0].a, 'emergency', 'a fraction under 12 over 2.5 s or more');
  // ... and 12.5 fps is not an emergency (it is the floor, and steps one tier)
  const ok = new G.QualityController();
  const o = drive(ok, 0, 12000, alternating(100, 60));
  assert.ok(o.acts.length >= 1 && o.acts[0].a === 'down', 'floor, not emergency: ' + JSON.stringify(o.acts[0]));
  assert.equal(o.acts[0].tier, 1);
});

test('an ordinary step waits for a moment that is not the countdown or the race; evidence stays fresh', () => {
  const { ctl, t } = warmed();
  const racing = drive(ctl, t, 12000, 25, 'running');
  assert.deepEqual(racing.acts, [], '40 fps in a race: deferred');
  assert.equal(ctl.tier, 0);
  const free = drive(ctl, racing.t, 100, 25, 'ready');
  assert.deepEqual(verdicts(free), ['down']);
});

test('behind a sheet nothing is measured: the target is not learned under the intro sheet\'s light load', () => {
  const ctl = new G.QualityController();
  const intro = drive(ctl, 0, 10000, HZ60, 'intro');
  assert.equal(ctl.count, 0);
  assert.equal(ctl.target, 0, 'nothing learned behind the intro');
  assert.equal(ctl.state(intro.t).name, 'sheet');
  assert.equal(ctl.check(intro.t, true), 'none');
  // in the race the same device does 45 fps: that is what the target becomes, and it is not slow for it
  const play = drive(ctl, intro.t, 30000, hz(45));
  assert.deepEqual(play.acts, []);
  near(ctl.target, 45, 1);
  assert.equal(ctl.tier, 0);
  assert.equal(ctl.steps, 0);
  // the first two windows after a sheet are skipped (the draw rate changes from 15 to full)
  const c = new G.QualityController();
  const a = drive(c, 0, 5000, HZ60);
  const b = drive(c, a.t, 5000, HZ60, 'results');
  assert.equal(c.count, 0);
  drive(c, b.t, 480, HZ60);
  assert.equal(c.count, 0, 'two windows skipped');
  drive(c, b.t + 480, 400, HZ60);
  assert.ok(c.count >= 1);
});

test('no deferred cascade at the results screen: slowness seen in a race is not acted on there, and never twice', () => {
  const { ctl, t } = warmed();
  // a race at 40 fps against a target of 60; then the finish (1.8 s), the results sheet, and race again
  const phases = (rel) => (rel < 20000 ? 'running' : rel < 21800 ? 'finished' : rel < 50000 ? 'results' : rel < 54000 ? 'countdown' : 'running');
  const r = drive(ctl, t, 90000, 25, phases);
  const downs = r.acts.filter((a) => a.a === 'down');
  assert.ok(downs.length <= 1, 'at most one step: ' + JSON.stringify(r.acts));
  assert.ok(downs.every((a) => a.t >= t + 20000 && a.t < t + 21800 + 100), 'at the finish at the latest, never on the sheet');
  assert.equal(r.acts.filter((a) => a.t >= t + 21900 && a.t < t + 50000).length, 0, 'nothing on the results screen');
  assert.ok(ctl.tier <= 1);
  // straight from the race to the sheet: the evidence is dropped, not saved up for the next time
  const b = warmed();
  const race = drive(b.ctl, b.t, 20000, 25, 'running');
  assert.deepEqual(race.acts, []);
  const sheet = drive(b.ctl, race.t, 30000, HZ60, 'results');
  assert.deepEqual(sheet.acts, []);
  assert.equal(b.ctl.count, 0, 'the windows are gone');
  const next = drive(b.ctl, sheet.t, 20000, HZ60, (rel) => (rel < 4000 ? 'countdown' : 'running'));
  assert.deepEqual(next.acts, []);
  assert.equal(b.ctl.tier, 0);
});

test('the lowest tier has only an absolute rule: a hint after 10 s under 15 fps, once, never a step', () => {
  const { ctl, t } = warmed({ tier: LAST });
  assert.deepEqual(drive(ctl, t, 30000, hz(25)).acts, [], '25 fps at the lowest tier: fine');
  assert.deepEqual(drive(ctl, t + 30000, 30000, hz(17)).acts, [], '17 fps: nothing to step to, not under 15');
  const c = warmed({ tier: LAST });
  assert.deepEqual(drive(c.ctl, c.t, 9000, hz(14)).acts, [], 'not yet 10 s');
  const r = drive(c.ctl, c.t + 9000, 30000, hz(14));
  assert.deepEqual(verdicts(r), ['unplayable']);
  assert.match(r.acts[0].reason, /under 15 fps for 1\d s at the lowest tier/);
  assert.equal(c.ctl.tier, LAST);
  assert.equal(c.ctl.hinted, true);
  assert.equal(drive(c.ctl, r.t, 60000, hz(14)).acts.length, 0, 'said once');
  // a recovery in between starts the 10 s again
  const d = warmed({ tier: LAST });
  const a = drive(d.ctl, d.t, 8000, hz(14));
  const b = drive(d.ctl, a.t, 1500, HZ60);
  assert.deepEqual(drive(d.ctl, b.t, 8000, hz(14)).acts, []);
  // the emergency has nowhere to go at the lowest tier either
  const e = warmed({ tier: LAST });
  assert.ok(verdicts(drive(e.ctl, e.t, 20000, hz(8))).every((x) => x === 'unplayable'));
  assert.equal(e.ctl.tier, LAST);
});

test('a visit that starts at a stored tier carries on from there: it does not run the whole cascade again', () => {
  const ctl = new G.QualityController({ tier: 2 });
  assert.equal(ctl.startTier, 2);
  const r = drive(ctl, 0, 60000, (rel, tier) => (tier < LAST ? hz(13) : hz(20)));
  assert.deepEqual(verdicts(r), ['down']);
  assert.deepEqual(r.acts.map((a) => a.tier), [LAST]);
  assert.ok(r.acts[0].t < 4000, 'within the first seconds of play');
  // and a device that is fine at the tier it starts at never moves
  const fine = new G.QualityController({ tier: 2 });
  assert.deepEqual(drive(fine, 0, 60000, HZ60).acts, []);
  assert.equal(fine.tier, 2);
});

test('discard and clear drop windows instead of counting them; a long stall is not a slow frame', () => {
  const ctl = new G.QualityController();
  const warm = drive(ctl, 0, 4000, HZ60);
  assert.equal(ctl.count, 10);
  ctl.clear();
  assert.equal(ctl.count, 0);
  const a = drive(ctl, warm.t, 520, HZ60);
  assert.equal(ctl.count, 0, 'two windows are skipped after clear()');
  drive(ctl, a.t, 400, HZ60);
  assert.ok(ctl.count >= 1);
  const c = new G.QualityController();
  const w = drive(c, 0, 4000, HZ60);
  assert.deepEqual(drive(c, w.t + 20000, 6000, HZ60).acts, []);
  assert.equal(c.tier, 0);
  const s = new G.QualityController(); // a tab-hidden gap in the middle of the learning is skipped, not learned
  const w0 = drive(s, 0, 1500, HZ60);
  drive(s, w0.t + 30000, 4000, HZ60);
  near(s.target, 60, 1);
});

test('state() and describe() say what the controller is doing', () => {
  const ctl = new G.QualityController({ tier: 1 });
  const s0 = ctl.state(0);
  assert.equal(s0.name, 'learning');
  assert.equal(s0.tier, 1);
  assert.match(ctl.describe(0), /^learning the frame rate \(0 of 3 s\)$/);
  const w = drive(ctl, 0, 4000, HZ60);
  assert.equal(ctl.state(w.t).name, 'watching');
  assert.match(ctl.describe(w.t), /^target 60 fps, watching, 0 of 10 windows slow$/);
  const step = drive(ctl, w.t, 4000, hz(38));
  assert.equal(ctl.state(step.t).name, 'learning');
  assert.equal(ctl.state(step.acts[0].t + 100).name, 'learning');
  const settled = drive(ctl, step.t, 3500, hz(38));
  assert.match(ctl.describe(settled.t), /^target 38 fps, cooldown \d s$/);
  assert.equal(ctl.state(settled.t).steps, 1);
  const lowest = new G.QualityController({ tier: LAST });
  assert.match(lowest.describe(0), /^lowest tier, hint after 10 s under 15 fps \(0\.0 s\)$/);
  lowest.idle(0);
  assert.equal(lowest.describe(1), 'behind a sheet, not measuring');
});

test('there is no verdict that leaves 3D', () => {
  const seen = new Set();
  for (const f of [60, 38, 25, 17, 13, 8]) {
    for (const phase of ['ready', 'running']) {
      const c = new G.QualityController({ tier: f % 4 });
      for (const r of drive(c, 0, 90000, (rel) => (rel < 6000 ? HZ60 : hz(f)), phase).acts) seen.add(r.a);
    }
  }
  assert.deepEqual([...seen].filter((v) => !['down', 'emergency', 'unplayable'].includes(v)), []);
  assert.ok(![...seen].includes('to2d'));
});
