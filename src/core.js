/* Lane Four core: pose signals, detectors and race simulation.
   No DOM access, so the same code runs in the browser and in Node tests. */
(function (root) {
  'use strict';

  // MediaPipe Pose landmark indices we use.
  const LM = Object.freeze({
    NOSE: 0, L_SHOULDER: 11, R_SHOULDER: 12, L_ELBOW: 13, R_ELBOW: 14,
    L_WRIST: 15, R_WRIST: 16, L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26,
    L_ANKLE: 27, R_ANKLE: 28,
  });
  const TRACKED = new Set([0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]);

  // All pose math happens in a virtual frame 480 units tall, so filter and
  // threshold values don't depend on the camera's real resolution.
  const FRAME_H = 480;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mix = (a, b, k) => a + (b - a) * k;
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
  const sd = (arr) => {
    const m = mean(arr);
    return Math.sqrt(mean(arr.map((v) => (v - m) * (v - m))));
  };

  // ---------------------------------------------------------------------------
  // One Euro filter (Casiez et al. 2012): smooths jitter at rest, stays
  // responsive during fast motion.
  class OneEuro {
    constructor(minCutoff = 1.7, beta = 0.03, dCutoff = 1.0) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.dCutoff = dCutoff;
      this.reset();
    }
    reset() { this.x = null; this.dx = 0; this.t = null; }
    static alpha(cutoff, dt) {
      const tau = 1 / (2 * Math.PI * cutoff);
      return 1 / (1 + tau / dt);
    }
    filter(x, t) {
      if (this.x === null) { this.x = x; this.t = t; this.dx = 0; return x; }
      const dt = t - this.t;
      if (dt <= 0) return this.x;
      if (dt > 0.5) { this.x = x; this.t = t; this.dx = 0; return x; } // tracking gap
      const dx = (x - this.x) / dt;
      this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
      this.x += OneEuro.alpha(cutoff, dt) * (x - this.x);
      this.t = t;
      return this.x;
    }
  }

  // Converts MediaPipe's normalized landmarks to virtual-frame units and
  // smooths the joints the game reads.
  class PoseSmoother {
    constructor(minCutoff = 1.7, beta = 0.03) {
      this.minCutoff = minCutoff;
      this.beta = beta;
      this.filters = new Map();
    }
    reset() { this.filters.clear(); }
    apply(landmarks, aspect, t) {
      const fw = FRAME_H * aspect;
      const pts = new Array(33);
      for (let i = 0; i < 33; i++) {
        const lm = landmarks[i];
        if (!lm) { pts[i] = null; continue; }
        let x = lm.x * fw;
        let y = lm.y * FRAME_H;
        if (TRACKED.has(i)) {
          let f = this.filters.get(i);
          if (!f) {
            f = [new OneEuro(this.minCutoff, this.beta), new OneEuro(this.minCutoff, this.beta)];
            this.filters.set(i, f);
          }
          x = f[0].filter(x, t);
          y = f[1].filter(y, t);
        }
        pts[i] = { x, y, v: lm.visibility == null ? 1 : lm.visibility };
      }
      return pts;
    }
  }

  // ---------------------------------------------------------------------------
  // Raw body measurements from smoothed points (virtual-frame units, y down).
  function measure(pts) {
    const ls = pts[LM.L_SHOULDER], rs = pts[LM.R_SHOULDER];
    const lh = pts[LM.L_HIP], rh = pts[LM.R_HIP];
    const lk = pts[LM.L_KNEE], rk = pts[LM.R_KNEE];
    const la = pts[LM.L_ANKLE], ra = pts[LM.R_ANKLE];
    const shoulderW = Math.max(1e-3, Math.hypot(ls.x - rs.x, ls.y - rs.y));
    const hipY = (lh.y + rh.y) / 2;
    // The planted foot is the lower one on screen; using it keeps high knees
    // and butt kicks from reading as a squat.
    const ankleLow = Math.max(la.y, ra.y);
    const leg = ankleLow - hipY;
    // > 0 when the right foot/knee is higher than the left.
    const stepRaw = ((la.y - ra.y) + (lk.y - rk.y)) / 2;
    const torso = Math.hypot((ls.x + rs.x) / 2 - (lh.x + rh.x) / 2, (ls.y + rs.y) / 2 - hipY);
    return { shoulderW, hipY, ankleLow, leg, stepRaw, torso };
  }

  // Is the whole body usable? Returns one status the UI can explain.
  function assessFraming(pts, aspect) {
    if (!pts) return { status: 'none' };
    const fw = FRAME_H * aspect;
    const ok = (i) => {
      const p = pts[i];
      return !!p && p.v >= 0.5 && p.x > 2 && p.x < fw - 2 && p.y > 2 && p.y < FRAME_H - 2;
    };
    const all = (ids) => ids.every(ok);
    if (!all([LM.L_SHOULDER, LM.R_SHOULDER]) || !all([LM.L_HIP, LM.R_HIP])) return { status: 'none' };
    if (!all([LM.L_KNEE, LM.R_KNEE, LM.L_ANKLE, LM.R_ANKLE])) return { status: 'feet' };
    if (!ok(LM.NOSE)) return { status: 'head' };
    const height = Math.max(pts[LM.L_ANKLE].y, pts[LM.R_ANKLE].y) - pts[LM.NOSE].y;
    if (height < FRAME_H * 0.3) return { status: 'far', height };
    const m = measure(pts);
    if (m.shoulderW < m.torso * 0.35) return { status: 'side', height };
    return { status: 'ok', height };
  }

  // Squat depth: how much the hip-to-planted-ankle distance has shrunk,
  // normalized by shoulder width so stepping closer or farther doesn't
  // count. 0 = standing tall, ~1 = thighs parallel.
  function squatDepth(m, base) {
    const ratio = m.leg / m.shoulderW;
    return (1 - ratio / base.ratio) / 0.5;
  }

  // Alternating-feet signal, in leg lengths. Feet moving together (squats,
  // hops) cancel out; alternating feet swing it positive and negative.
  function stepSignal(m, base) {
    return m.stepRaw / (base.ratio * m.shoulderW);
  }

  // ---------------------------------------------------------------------------
  // Captures the standing baseline once the player holds still for `hold` s.
  class Calibrator {
    constructor(hold = 1.0) { this.hold = hold; this.reset(); }
    reset() { this.samples = []; this.progress = 0; }
    push(m, t) {
      const s = { t, ratio: m.leg / m.shoulderW, hipY: m.hipY, shoulderW: m.shoulderW, leg: m.leg, stepRaw: m.stepRaw };
      this.samples.push(s);
      while (this.samples.length > 1 && t - this.samples[0].t > this.hold) this.samples.shift();
      const ratios = this.samples.map((x) => x.ratio);
      const hips = this.samples.map((x) => x.hipY);
      // Loose enough for a jittery, distant camera; a half squat moves the
      // hips about 4x more than this allows.
      const hipRange = (Math.max(...hips) - Math.min(...hips)) / mean(this.samples.map((x) => x.leg));
      const steady = sd(ratios) / mean(ratios) < 0.07 && hipRange < 0.12;
      if (!steady) {
        this.samples = [s];
        this.progress = 0;
        return null;
      }
      const span = t - this.samples[0].t;
      this.progress = clamp(span / this.hold, 0, 1);
      if (span >= this.hold * 0.97) {
        const ratio = mean(ratios);
        // Noise floor of each signal while standing still. The app keeps its
        // thresholds above this so a jittery camera can't fake steps.
        const steps = this.samples.map((x) => x.stepRaw / (ratio * x.shoulderW));
        return {
          ratio,
          shoulderW: mean(this.samples.map((x) => x.shoulderW)),
          leg: mean(this.samples.map((x) => x.leg)),
          stepNoise: sd(steps),
          depthNoise: (sd(ratios) / ratio) / 0.5,
        };
      }
      return null;
    }
  }

  // Thresholds actually used: the player's setting, raised above the noise
  // floor measured during calibration.
  function effectiveThresholds(base, stepT, squatDown) {
    return {
      step: Math.max(stepT, base ? 3.2 * base.stepNoise : 0),
      squat: Math.max(squatDown, base ? 3.5 * base.depthNoise : 0),
    };
  }

  // Counts a step each time the raised foot switches sides.
  class StepDetector {
    constructor({ threshold = 0.045, minInterval = 0.15, idleReset = 1.0 } = {}) {
      this.threshold = threshold;
      this.minInterval = minInterval;
      this.idleReset = idleReset;
      this.reset();
    }
    reset() { this.lastSide = null; this.lastT = -Infinity; this.needNeutral = true; }
    update(s, t) {
      const T = this.threshold;
      if (this.lastSide !== null && t - this.lastT > this.idleReset) {
        // After a pause, wait for both feet down before counting again, so
        // standing on one leg doesn't produce phantom steps.
        this.lastSide = null;
        this.needNeutral = true;
      }
      if (this.needNeutral) {
        if (Math.abs(s) < T * 0.5) this.needNeutral = false;
        else return null;
      }
      const side = s >= T ? 'R' : s <= -T ? 'L' : null;
      if (side && side !== this.lastSide && t - this.lastT >= this.minInterval) {
        this.lastSide = side;
        this.lastT = t;
        return side;
      }
      return null;
    }
  }

  // Steps per minute from recent step times, easing to 0 when steps stop.
  class CadenceMeter {
    constructor({ window = 3.0, maxSteps = 6, idle = 1.25 } = {}) {
      this.window = window;
      this.maxSteps = maxSteps;
      this.idle = idle;
      this.times = [];
    }
    reset() { this.times = []; }
    step(t) {
      this.times.push(t);
      if (this.times.length > this.maxSteps) this.times.shift();
    }
    value(t) {
      const ts = this.times.filter((x) => t - x <= this.window);
      if (ts.length < 2) return 0;
      const last = ts[ts.length - 1];
      const gap = t - last;
      if (gap > this.idle) return 0;
      const interval = (last - ts[0]) / (ts.length - 1);
      if (interval <= 0) return 0;
      const spm = 60 / interval;
      return gap > interval ? spm * (interval / gap) : spm;
    }
  }

  // Squat state machine with hysteresis: 'down' when depth passes `down`
  // for `minHold` s, 'up' when it drops below half of that.
  class SquatDetector {
    constructor({ down = 0.4, minHold = 0.08, refractory = 0.25 } = {}) {
      this.minHold = minHold;
      this.refractory = refractory;
      this.setDown(down);
      this.reset();
    }
    setDown(v) { this.down = v; this.up = v * 0.5; }
    reset() { this.state = 'up'; this.pendingT = null; this.maxDepth = 0; this.downT = 0; this.lastUpT = -Infinity; }
    update(d, t) {
      if (this.state === 'up') {
        if (d >= this.down && t - this.lastUpT >= this.refractory) {
          if (this.pendingT === null) this.pendingT = t;
          if (t - this.pendingT >= this.minHold) {
            this.state = 'down';
            this.downT = t;
            this.maxDepth = d;
            this.pendingT = null;
            return { type: 'down', depth: d };
          }
        } else {
          this.pendingT = null;
        }
        return null;
      }
      this.maxDepth = Math.max(this.maxDepth, d);
      if (d <= this.up) {
        this.state = 'up';
        this.lastUpT = t;
        return { type: 'up', maxDepth: this.maxDepth, duration: t - this.downT };
      }
      return null;
    }
  }

  // Both hands raised above the head for `hold` s. Fires once per raise.
  class HandsUpDetector {
    constructor({ hold = 0.5 } = {}) { this.hold = hold; this.reset(); }
    reset() { this.since = null; this.fired = false; }
    update(pts, t) {
      const nose = pts && pts[LM.NOSE];
      const raised = (wi, ei) => {
        const w = pts[wi], e = pts[ei];
        return (w && w.v >= 0.4 && w.y < nose.y) || (e && e.v >= 0.4 && e.y < nose.y);
      };
      const up = !!nose && nose.v >= 0.4 && raised(LM.L_WRIST, LM.L_ELBOW) && raised(LM.R_WRIST, LM.R_ELBOW);
      if (!up) { this.since = null; this.fired = false; return false; }
      if (this.since === null) this.since = t;
      if (!this.fired && t - this.since >= this.hold) { this.fired = true; return true; }
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Race simulation. Distances in meters, times in seconds.
  // Hurdle spacing is the real 400 m hurdles layout: first hurdle at 45 m,
  // then every 35 m, 40 m run-in. Men's hurdle height is 0.914 m.
  const RACES = {
    400: { distance: 400, label: '400 m hurdles', hurdles: [45, 80, 115, 150, 185, 220, 255, 290, 325, 360] },
    200: { distance: 200, label: '200 m hurdles', hurdles: [45, 80, 115, 150, 185] },
  };

  const PHYS = {
    stride: 1.9,        // meters per step at running cadence
    vMax: 9.5,
    firstStepV: 2.2,    // a single step still nudges you forward
    tauUp: 0.35, tauDown: 0.9, tauSquat: 2.4, tauAir: 6.0,
    g: 8.5,
    hMin: 1.0, hMax: 1.8,           // jump apex (foot clearance), shallow to deep squat
    hurdleH: 0.914, clearH: 0.72,   // forgiving: feet above 0.72 m clear the bar
    starH: 1.35,                    // feet this high over a hurdle collect its star
    assistTime: 0.42,               // still squatting this many seconds from a hurdle: jump for you
    stumbleSlow: 0.35, stumbleTime: 0.6,
  };

  class Race {
    constructor(distance = 400, opts = {}) {
      const cfg = RACES[distance] || RACES[400];
      this.p = Object.assign({}, PHYS, opts.phys || {});
      this.squatDown = opts.squatDown == null ? 0.4 : opts.squatDown;
      this.distance = cfg.distance;
      this.label = cfg.label;
      this.hurdles = cfg.hurdles.map((x) => ({ x, state: 'up', fall: 0, starTaken: false }));
      this.x = -0.8; // set up behind the start line
      this.v = 0; this.y = 0; this.vy = 0;
      this.time = 0;
      this.finished = false;
      this.finishTime = null;
      this.charging = false;
      this.chargeMax = 0;
      this.consumed = false;
      this.stumble = 0;
      this.stats = { steps: 0, squats: 0, cleared: 0, clipped: 0, stars: 0, topSpeed: 0 };
    }
    get airborne() { return this.y > 0 || this.vy > 0; }
    nextHurdle() {
      for (const h of this.hurdles) if (h.state === 'up' && h.x >= this.x) return h;
      return null;
    }
    power(maxDepth) { return clamp((maxDepth - this.squatDown) / (1 - this.squatDown), 0, 1); }
    jump(power, events) {
      const h = this.p.hMin + (this.p.hMax - this.p.hMin) * clamp(power, 0, 1);
      this.vy = Math.sqrt(2 * this.p.g * h);
      this.y = 1e-4;
      events.push({ type: 'jump', power });
    }
    // input: { steps, cadence, depth, squat: null | {type:'down'|'up', depth?, maxDepth?} }
    update(dt, input) {
      const p = this.p;
      const inp = input || {};
      const events = [];

      for (const h of this.hurdles) if (h.state === 'hit' && h.fall < 1) h.fall = Math.min(1, h.fall + dt / 0.35);

      if (!this.finished) {
        this.time += dt;
        if (inp.steps) this.stats.steps += inp.steps;
        if (inp.squat) {
          if (inp.squat.type === 'down') {
            this.charging = true;
            this.consumed = false;
            this.chargeMax = inp.squat.depth || 0;
            this.stats.squats++;
            events.push({ type: 'charge' });
          } else if (inp.squat.type === 'up') {
            if (this.charging && !this.consumed && !this.airborne) {
              this.jump(this.power(Math.max(this.chargeMax, inp.squat.maxDepth || 0)), events);
            }
            this.charging = false;
          }
        }
        if (this.charging) this.chargeMax = Math.max(this.chargeMax, inp.depth || 0);

        // Time-based so the jump peaks over the bar at any speed (a fixed
        // distance launches too late when sprinting).
        const nh = this.nextHurdle();
        if (this.charging && !this.consumed && !this.airborne && nh && nh.x - this.x <= Math.max(0.35, this.v * p.assistTime)) {
          this.consumed = true;
          this.jump(this.power(this.chargeMax), events);
          events.push({ type: 'assist' });
        }
      }

      // Speed follows cadence while running on the ground; squatting and
      // flying keep momentum but don't add to it.
      let target;
      let tau;
      if (this.finished) {
        target = 0; tau = 1.2;
      } else if (this.airborne) {
        target = 0; tau = p.tauAir;
      } else if (this.charging) {
        target = 0; tau = p.tauSquat;
      } else {
        target = inp.cadence > 0 ? Math.min(p.vMax, (inp.cadence / 60) * p.stride) : 0;
        if (inp.steps > 0) target = Math.max(target, p.firstStepV);
        tau = target > this.v ? p.tauUp : p.tauDown;
      }
      this.v += (target - this.v) * (1 - Math.exp(-dt / tau));
      if (this.v < 0.01 && target === 0) this.v = 0;
      if (this.stumble > 0) this.stumble = Math.max(0, this.stumble - dt);
      this.stats.topSpeed = Math.max(this.stats.topSpeed, this.v);

      const x0 = this.x;
      this.x += this.v * dt;

      if (this.airborne) {
        this.vy -= p.g * dt;
        this.y += this.vy * dt;
        if (this.y <= 0) {
          this.y = 0;
          this.vy = 0;
          events.push({ type: 'land' });
        }
      }

      for (const h of this.hurdles) {
        if (h.state !== 'up' || !(x0 < h.x && this.x >= h.x)) continue;
        if (this.y >= p.clearH) {
          h.state = 'cleared';
          this.stats.cleared++;
          events.push({ type: 'clear', hurdle: h });
          if (this.y >= p.starH) {
            h.starTaken = true;
            this.stats.stars++;
            events.push({ type: 'star', hurdle: h });
          }
        } else {
          h.state = 'hit';
          this.stats.clipped++;
          this.v *= p.stumbleSlow;
          this.stumble = p.stumbleTime;
          events.push({ type: 'hit', hurdle: h });
        }
      }

      if (!this.finished && this.x >= this.distance) {
        this.finished = true;
        const over = (this.x - this.distance) / Math.max(this.v, 0.1);
        this.finishTime = Math.max(0, this.time - over);
        events.push({ type: 'finish', time: this.finishTime });
      }
      return events;
    }
  }

  function formatTime(sec) {
    if (sec == null || !isFinite(sec)) return '0:00.0';
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const rest = s - m * 60;
    const tenths = Math.floor(rest * 10) / 10;
    return m + ':' + (tenths < 10 ? '0' : '') + tenths.toFixed(1);
  }

  root.LaneFour = {
    LM, FRAME_H, RACES, PHYS, clamp, mix,
    OneEuro, PoseSmoother, measure, assessFraming, squatDepth, stepSignal,
    Calibrator, effectiveThresholds, StepDetector, CadenceMeter, SquatDetector, HandsUpDetector, Race, formatTime,
  };
})(typeof window !== 'undefined' ? window : globalThis);
