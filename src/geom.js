/* Lane Four geometry: pure maths shared by the 2D and 3D renderers.
   No DOM access, so Node tests load it directly (require core.js first).
   Attaches LaneFour.Geom. */
(function (root) {
  'use strict';
  const LF = root.LaneFour;
  if (!LF || !LF.mix || !LF.clamp) throw new Error('geom.js needs core.js loaded first');
  const { clamp, mix } = LF;

  // ------------------------------------------------------------------ runner
  // Procedural runner in the style of a sports pictogram. Meters, y up,
  // origin on the ground under the hips. Moved verbatim from app.js: the
  // arithmetic is unchanged, only the intermediate objects are gone so a
  // caller can pass a preallocated `out` (from makePose) and allocate nothing.
  function makePose() {
    const pt = () => ({ x: 0, y: 0 });
    return {
      hip: pt(), shoulder: pt(), head: pt(),
      arms: [{ elbow: pt(), wrist: pt() }, { elbow: pt(), wrist: pt() }],
      legs: [{ knee: pt(), ankle: pt(), toe: pt() }, { knee: pt(), ankle: pt(), toe: pt() }],
    };
  }

  const legRel = new Float64Array(12); // scratch: per leg knee, ankle, toe (x, y), relative to the hip

  function runnerPose(a, reduceMotion, out) {
    const TH = 0.46;
    const SH = 0.46;
    const TOR = 0.55;
    const UA = 0.29;
    const FA = 0.27;
    const o = out || makePose();
    const s = a.gait;
    for (let i = 0; i < 2; i++) {
      const w = 2 * Math.PI * (a.phase + i * 0.5);
      let th = (0.06 + 0.62 * s) * Math.sin(w);
      let kn = (0.12 + 1.45 * s) * (0.5 + 0.5 * Math.cos(w + 0.3));
      th = mix(th, 1.12, a.crouch);
      kn = mix(kn, 2.05, a.crouch);
      th = mix(th, i === 0 ? 1.45 : -0.25, a.air);
      kn = mix(kn, i === 0 ? 0.12 : 1.85, a.air);
      const kx = TH * Math.sin(th);
      const ky = -TH * Math.cos(th);
      const shin = th - kn;
      const ax = kx + SH * Math.sin(shin);
      const ay = ky - SH * Math.cos(shin);
      const fa = shin + Math.PI / 2 - 0.15;
      const b = i * 6;
      legRel[b] = kx;
      legRel[b + 1] = ky;
      legRel[b + 2] = ax;
      legRel[b + 3] = ay;
      legRel[b + 4] = ax + 0.15 * Math.sin(fa);
      legRel[b + 5] = ay - 0.15 * Math.cos(fa);
    }
    const low = Math.min(legRel[3], legRel[9], legRel[5], legRel[11]);
    const breathe = s < 0.05 && a.air < 0.1 && !reduceMotion ? Math.sin((a.t || 0) * 1.6) * 0.008 : 0;
    const hip = o.hip;
    hip.x = 0;
    hip.y = -low + 0.05 + breathe;
    let lean = 0.05 + 0.18 * s;
    lean = mix(lean, 0.5, a.crouch * 0.9);
    lean = mix(lean, 0.62, a.air);
    lean += 0.75 * a.stumble;
    const shoulder = o.shoulder;
    shoulder.x = hip.x + TOR * Math.sin(lean);
    shoulder.y = hip.y + TOR * Math.cos(lean);
    const head = o.head;
    head.x = shoulder.x + 0.21 * Math.sin(lean * 0.8);
    head.y = shoulder.y + 0.21 * Math.cos(lean * 0.8);
    for (let j = 0; j < 2; j++) {
      const w = 2 * Math.PI * (a.phase + (1 - j) * 0.5);
      let al = (0.1 + 0.85 * s) * Math.sin(w);
      let el2 = 0.35 + 1.15 * s;
      al = mix(al, -0.85, a.crouch);
      el2 = mix(el2, 0.5, a.crouch);
      al = mix(al, j === 1 ? 1.55 : -0.55, a.air);
      el2 = mix(el2, j === 1 ? 0.25 : 1.2, a.air);
      al = mix(al, 2.3, a.stumble * 0.8);
      const arm = o.arms[j];
      arm.elbow.x = shoulder.x + UA * Math.sin(al);
      arm.elbow.y = shoulder.y - UA * Math.cos(al);
      arm.wrist.x = arm.elbow.x + FA * Math.sin(al + el2);
      arm.wrist.y = arm.elbow.y - FA * Math.cos(al + el2);
    }
    for (let i = 0; i < 2; i++) {
      const leg = o.legs[i];
      const b = i * 6;
      leg.knee.x = hip.x + legRel[b];
      leg.knee.y = hip.y + legRel[b + 1];
      leg.ankle.x = hip.x + legRel[b + 2];
      leg.ankle.y = hip.y + legRel[b + 3];
      leg.toe.x = hip.x + legRel[b + 4];
      leg.toe.y = hip.y + legRel[b + 5];
    }
    return o;
  }

  // ----------------------------------------------------------------- hurdles
  function easeOutBack(k) {
    const c1 = 1.4;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  }

  // Forward tip of a hit hurdle in radians: overshoots to 1.477, settles at 1.38.
  function tipAngle(h) { return h.state === 'hit' ? easeOutBack(h.fall) * 1.38 : 0; }

  // Race lane k (0 to 8) to the three.js Z of its centre. Lane 4 is Z 0; the
  // track spans Z -4.27 (inside kerb) to +5.49 (3D Z is race z negated).
  function laneZ(k) { return (k - 4) * 1.22; }

  function smoothstep(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Upcoming hurdles are drawn larger the further ahead they are, so they stay
  // readable from the chase camera: 1.0 inside 8 m, 1.4 beyond 28 m. `d` is
  // hurdle.x minus runner.x.
  function farScale(d) { return 1 + 0.4 * smoothstep(8, 28, d); }

  // Frame-rate independent exponential smoothing toward a target.
  function approach(cur, tgt, dt, tau) { return cur + (tgt - cur) * (1 - Math.exp(-dt / tau)); }

  // ------------------------------------------------------------- chase camera
  // Three rig classes picked from the canvas aspect. feetRow is where the
  // runner's feet sit on screen (0 top, 1 bottom), chosen to leave the HUD clear.
  // Wide differs from the design table: back is 6.5, not 6.0. At 844x390 the
  // table's 6.0 puts the board top above the 22% HUD line at 14 m (row 0.182 at
  // s=0, 0.212 at s=1); 6.5 gives 0.227 and still clears 24 px.
  const RIGS = Object.freeze({
    portrait: Object.freeze({ name: 'portrait', vfov: 52, back: 5.5, height: 3.6, feetRow: 0.72 }),
    standard: Object.freeze({ name: 'standard', vfov: 56, back: 5.5, height: 3.4, feetRow: 0.74 }),
    wide: Object.freeze({ name: 'wide', vfov: 41, back: 6.5, height: 3.6, feetRow: 0.74 }),
  });

  function rigFor(w, h) {
    const aspect = h > 0 ? w / h : 1.6;
    if (aspect < 1.0) return RIGS.portrait;
    if (aspect < 1.9) return RIGS.standard;
    return RIGS.wide;
  }

  // Pinhole model. Lengths in metres relative to the runner's feet, with the
  // camera hanging at (x = -back, y = height), looking along +X (three.js X is
  // race x), pitched down by `pitch`. s in [0,1] is the speed zoom-out: the
  // camera drifts back 0.5 m and up 0.15 m at full speed.
  //
  // For a point (dx ahead of the runner, y up, z three.js Z):
  //   rx = dx + back,  ry = y - height            (offset from the camera)
  //   depth = rx cos(pitch) - ry sin(pitch)       (along the optical axis)
  //   up    = rx sin(pitch) + ry cos(pitch)
  //   ndcY  = up / (depth tanHalf)                (+1 top edge, -1 bottom edge)
  //   ndcX  = z / (depth tanHalf aspect)          (+Z is screen right)
  // The feet (dx 0, y 0) have ndcY = 1 - 2 feetRow. With A = atan(height/back)
  // the angle of the feet below horizontal, that means
  //   tan(pitch - A) = (1 - 2 feetRow) tanHalf
  //   pitch = atan(height/back) - atan((2 feetRow - 1) tanHalf)
  // so the feet land on feetRow exactly, whatever s is. `out` is optional.
  function solveRig(rig, s, out) {
    const o = out || { back: 0, height: 0, pitch: 0, tanHalf: 0, vfov: 0 };
    const k = clamp(s, 0, 1);
    const tanHalf = Math.tan((rig.vfov * Math.PI) / 360);
    o.back = rig.back + 0.5 * k;
    o.height = rig.height + 0.15 * k;
    o.tanHalf = tanHalf;
    o.vfov = rig.vfov;
    o.pitch = Math.atan(o.height / o.back) - Math.atan((2 * rig.feetRow - 1) * tanHalf);
    return o;
  }

  // Pixel position of a point seen through a solved rig on a W x H canvas.
  // dx is metres ahead of the runner (hurdle.x - runner.x), y metres of
  // height, z the three.js Z (race z negated). Fills out.x, out.y (pixels from
  // the top left) and out.depth (metres along the optical axis).
  function projectPx(sol, W, H, dx, y, z, out) {
    const o = out || { x: 0, y: 0, depth: 0 };
    const c = Math.cos(sol.pitch);
    const sn = Math.sin(sol.pitch);
    const rx = dx + sol.back;
    const ry = y - sol.height;
    const depth = rx * c - ry * sn;
    const up = rx * sn + ry * c;
    const ndcY = up / (depth * sol.tanHalf);
    const ndcX = z / (depth * sol.tanHalf * (W / H));
    o.x = (0.5 + 0.5 * ndcX) * W;
    o.y = (0.5 - 0.5 * ndcY) * H;
    o.depth = depth;
    return o;
  }

  // ------------------------------------------------------------------ quality
  // Render quality tiers, best first. dprCap and maxMP bound the backing store;
  // fps is the render cadence cap. T2 and T3 drop stars and glows.
  const TIERS = Object.freeze([
    Object.freeze({ name: 'T0', dprCap: 2, maxMP: 2.0, particles: 256, far: 120, fogNear: 36, fogFar: 85, stars: true, glows: true, fps: 60 }),
    Object.freeze({ name: 'T1', dprCap: 1.5, maxMP: 1.4, particles: 256, far: 120, fogNear: 36, fogFar: 85, stars: true, glows: true, fps: 60 }),
    Object.freeze({ name: 'T2', dprCap: 1.25, maxMP: 0.9, particles: 128, far: 90, fogNear: 30, fogFar: 70, stars: false, glows: false, fps: 60 }),
    Object.freeze({ name: 'T3', dprCap: 1.0, maxMP: 0.55, particles: 0, far: 90, fogNear: 30, fogFar: 70, stars: false, glows: false, fps: 30 }),
  ]);

  // Device pixel ratio to render at: the tier's cap, the megapixel budget and the
  // real DPR, whichever is smallest. `tier` is an index into TIERS or a tier.
  function pixelRatio(dpr, w, h, tier) {
    const t = typeof tier === 'number' ? TIERS[clamp(Math.round(tier), 0, TIERS.length - 1)] : tier;
    const d = dpr > 0 ? dpr : 1;
    return Math.min(d, t.dprCap, Math.sqrt((t.maxMP * 1e6) / (w * h)));
  }

  // Decides when 3D should lower its quality tier. Pure: it is fed timestamps in ms and returns a verdict, and never
  // touches the renderer. It only ever LOWERS quality: no verdict leaves 3D.
  //   frame(t)           once per rAF while the player is being drawn for (setup, ready, countdown, running, ...)
  //   idle(t)            once per rAF behind a sheet (intro, results). Draws are capped at 15 fps there, so the frame
  //                      rate says nothing about a race: nothing is measured, no verdict is given, what was measured
  //                      is dropped, and the first two windows after the sheet are skipped
  //   discard(n)         after a resize or tier change: skip the open window and the next n closed ones
  //   clear()            when the tab becomes visible again: forget the windows
  //   check(t, canApply) -> 'none' | 'down' | 'emergency' | 'unplayable'
  //   state(t), describe(t)   what it is doing, for the Signals panel and for bug reports
  // Frames are grouped into 250 ms windows (rate = frames / real elapsed ms) kept in a ring of 10:
  //  * emergency: the newest 7 windows run under 12 fps over their real elapsed time: straight to the lowest tier, at
  //    once, in any phase (ignores canApply and the cooldown), and ahead of an ordinary step on the same evidence.
  //  * floor: 7 of 10 windows under 18 fps, whatever the target: one step down.
  //  * slow: 7 of 10 windows under 0.85 x target: one step down, unless those windows are one steady cadence at 30, 24
  //    or 20 fps (Low Power Mode, Energy Saver, a 30 Hz display): that is the display rate now, so it becomes the
  //    target and nothing steps. The target is the median window rate of a tier's first 3 s (capped at 60), learned
  //    again after every tier change; a median 10% above it raises it.
  // Steps wait for canApply (no countdown or race) and an 8 s cooldown, and clear the windows. The lowest tier has
  // nothing to step to: only 'unplayable' is left, once, after 10 s of windows under 15 fps. The pose rate plays no
  // part: it is a property of the camera and the model, which a 3D tier cannot fix.
  const WINDOW_MS = 250;
  const RING = 10;
  const WARM_MS = 3000;
  const COOLDOWN_MS = 8000;
  const SLOW_FRAC = 0.85;
  const SLOW_WINDOWS = 7;
  const FLOOR_FPS = 18;
  const EMERGENCY_FPS = 12;
  const HINT_FPS = 15;
  const HINT_MS = 10000;
  const LOCKED_FPS = [30, 24, 20];
  const LOCK_TOL = 0.08; // the windows' median this near a locked cadence, and this steady: 12% apart at most
  const LOCK_SPREAD = 0.12;
  const RAISE = 1.1;

  // The display rate a sorted run of slow windows adopts: 0 unless, one outlier dropped at each end (the window the
  // change fell in, a hitch), they are one steady locked cadence.
  const medianOf = (a, n) => (a[(n - 1) >> 1] + a[n >> 1]) / 2;
  function lockedRate(a, n) {
    const c = a.subarray(1, n - 1);
    const med = medianOf(c, c.length);
    if (!(med > 0) || c[c.length - 1] - c[0] > LOCK_SPREAD * med) return 0;
    return LOCKED_FPS.some((r) => Math.abs(med - r) <= LOCK_TOL * r) ? med : 0;
  }

  class QualityController {
    constructor(opts) {
      this.tier = clamp(((opts && opts.tier) | 0), 0, TIERS.length - 1);
      this.startTier = this.tier;
      this.ring = new Float64Array(RING); // per window: fps, frames, ms
      this.ringF = new Float64Array(RING);
      this.ringD = new Float64Array(RING);
      this.sorted = new Float64Array(RING);
      this.warm = new Float64Array(16);
      this.reset();
    }

    reset() { // full restart: windows, target, cooldown, counters
      this.target = 0; // fps; 0 until the first 3 s of this tier have been measured
      this.adopted = false; // the target is a display rate adopted from a steady lower cadence
      this.cooldownUntil = -1;
      this.sheet = false;
      this.hinted = false;
      this.steps = 0;
      this.reason = '';
      this.lastT = -1;
      this.warmN = this.skip = 0;
      this.warmStart = -1;
      this.wipe();
    }

    wipe() { // the windows and what was read from them, not the target
      this.count = 0;
      this.pos = 0;
      this.winStart = -1;
      this.winFrames = 0;
      this.hintSince = -1;
      this.nSlow = 0;
      this.nFloor = 0;
      this.med = 0;
      this.rate = 0;
      this.span = 0;
    }

    frame(t) {
      if (this.sheet) { this.sheet = false; this.lastT = -1; this.discard(2); }
      const gap = this.lastT < 0 ? 0 : t - this.lastT;
      this.lastT = t;
      if (gap > 1000 || gap < 0) this.discard(2); // a stall, not a slow frame
      if (this.winStart < 0) {
        this.winStart = t;
        this.winFrames = 0;
        if (this.warmStart < 0) this.warmStart = t;
        return;
      }
      this.winFrames++;
      const el = t - this.winStart;
      if (el < WINDOW_MS) return;
      const frames = this.winFrames;
      this.winStart = t;
      this.winFrames = 0;
      if (this.skip > 0) { this.skip--; return; }
      this.close(frames, el, t);
    }

    idle() {
      if (this.sheet) return;
      this.sheet = true;
      this.wipe();
      this.lastT = -1;
      if (this.target === 0) { this.warmN = 0; this.warmStart = -1; }
    }

    close(frames, el, t) {
      const fps = (frames * 1000) / el;
      this.ring[this.pos] = fps;
      this.ringF[this.pos] = frames;
      this.ringD[this.pos] = el;
      this.pos = (this.pos + 1) % RING;
      if (this.count < RING) this.count++;
      if (this.target === 0) this.warmUp(fps, t);
      if (this.tier >= TIERS.length - 1) {
        if (fps >= HINT_FPS) this.hintSince = -1;
        else if (this.hintSince < 0) this.hintSince = t - el;
      }
      this.analyse();
    }

    warmUp(fps, t) {
      if (this.warmN < this.warm.length) this.warm[this.warmN++] = fps;
      if (t - this.warmStart < WARM_MS || this.warmN < 4) return;
      const m = this.warm.slice(0, this.warmN).sort();
      this.target = Math.min(60, medianOf(m, this.warmN));
    }

    analyse() { // once per closed window: what the ring says
      this.nSlow = this.nFloor = 0;
      if (this.count < SLOW_WINDOWS) return;
      let frames = 0;
      let ms = 0;
      for (let k = 1; k <= SLOW_WINDOWS; k++) { // the newest 7 windows, over their real elapsed time
        const i = (this.pos - k + RING) % RING;
        frames += this.ringF[i];
        ms += this.ringD[i];
      }
      this.rate = (frames * 1000) / ms;
      this.span = ms;
      if (this.count < RING) return;
      this.sorted.set(this.ring);
      this.sorted.sort();
      this.med = medianOf(this.sorted, RING);
      while (this.nFloor < RING && this.sorted[this.nFloor] < FLOOR_FPS) this.nFloor++;
      if (!(this.target > 0)) return;
      let n = 0; // the windows under the limit are the lowest n of the sorted ring
      while (n < RING && this.sorted[n] < SLOW_FRAC * this.target) n++;
      if (n >= SLOW_WINDOWS) {
        const lock = lockedRate(this.sorted.subarray(0, n), n);
        if (lock) { this.target = lock; this.adopted = true; } else this.nSlow = n;
      } else if (this.med > RAISE * this.target) {
        this.target = Math.min(60, this.med);
        this.adopted = false;
      }
    }

    discard(n) { // skip the open window and the next n closed ones
      this.skip = Math.max(this.skip, n === undefined ? 2 : n);
      this.winStart = -1;
      this.winFrames = 0;
      this.hintSince = -1;
    }

    clear() {
      this.wipe();
      this.discard(2);
    }

    moveTo(n, t) { // the windows go and the target is learned again (T3 is never judged against a T1 target)
      if (n !== this.tier) this.steps++;
      this.tier = n;
      this.cooldownUntil = t + COOLDOWN_MS;
      this.target = 0;
      this.adopted = false;
      this.warmN = 0;
      this.warmStart = -1;
      this.clear();
    }

    check(t, canApply) {
      if (this.sheet) return 'none';
      const last = TIERS.length - 1;
      if (this.tier >= last) {
        if (this.hinted || this.hintSince < 0 || t - this.hintSince < HINT_MS) return 'none';
        this.hinted = true;
        this.reason = 'under ' + HINT_FPS + ' fps for ' + Math.round((t - this.hintSince) / 1000) + ' s at the lowest tier';
        return 'unplayable';
      }
      if (this.count >= SLOW_WINDOWS && this.rate < EMERGENCY_FPS) {
        this.reason = 'emergency: ' + this.rate.toFixed(1) + ' fps over the last ' + (this.span / 1000).toFixed(1) + ' s';
        this.moveTo(last, t);
        return 'emergency';
      }
      if (this.count < RING || t < this.cooldownUntil || !canApply) return 'none';
      if (this.nFloor >= SLOW_WINDOWS) this.reason = 'floor: ' + this.nFloor + ' of ' + RING + ' windows under ' + FLOOR_FPS + ' fps (median ' + this.med.toFixed(1) + ')';
      else if (this.nSlow >= SLOW_WINDOWS) this.reason = 'slow: ' + this.nSlow + ' of ' + RING + ' windows under ' + SLOW_FRAC + ' x ' + this.target.toFixed(0) + ' fps (median ' + this.med.toFixed(1) + ')';
      else return 'none';
      this.moveTo(this.tier + 1, t);
      return 'down';
    }

    state(t) { // allocates: for the Signals panel, not for every frame
      const lowest = this.tier >= TIERS.length - 1;
      const name = this.sheet ? 'sheet' : lowest ? 'lowest' : this.target === 0 ? 'learning' : t < this.cooldownUntil ? 'cooldown' : 'watching';
      return {
        name, tier: this.tier, startTier: this.startTier, steps: this.steps, target: this.target, adopted: this.adopted,
        windows: this.count, slow: this.nSlow, floor: this.nFloor, median: this.med, rate: this.rate, reason: this.reason,
        cooldownMs: Math.max(0, this.cooldownUntil - t), learnedMs: this.warmStart < 0 ? 0 : Math.max(0, t - this.warmStart),
        hintMs: this.hintSince < 0 ? 0 : t - this.hintSince, hinted: this.hinted,
      };
    }

    describe(t) {
      const s = this.state(t);
      switch (s.name) {
        case 'sheet': return 'behind a sheet, not measuring';
        case 'lowest': return 'lowest tier, hint after ' + HINT_MS / 1000 + ' s under ' + HINT_FPS + ' fps (' + (s.hintMs / 1000).toFixed(1) + ' s' + (s.hinted ? ', shown' : '') + ')';
        case 'learning': return 'learning the frame rate (' + Math.min(WARM_MS, s.learnedMs) / 1000 + ' of ' + WARM_MS / 1000 + ' s)';
        default: return 'target ' + s.target.toFixed(0) + ' fps' + (s.adopted ? ' (display rate)' : '') + ', ' + (s.name === 'cooldown' ? 'cooldown ' + (s.cooldownMs / 1000).toFixed(0) + ' s' : 'watching, ' + Math.max(s.slow, s.floor) + ' of ' + RING + ' windows slow');
      }
    }
  }

  const SHAKE_T = 0.35;
  const SHAKE_AMP = 0.10;
  const SHAKE_HZ = 7;

  // ----------------------------------------------------------- chase camera (no THREE; Scene3D re-exports it)
  class ChaseCam {
    constructor() {
      this.rig = RIGS.standard;
      this.sol = solveRig(this.rig, 0);
      this.s = 0; // speed zoom-out, 0..1
      this.yS = 0; // smoothed runner height
      this.left = 0; // seconds of hit shake left
      this.x = 0;
      this.y = 3.4;
      this.z = 0;
      this.pitch = this.sol.pitch;
    }
    setRig(rig) {
      this.rig = rig;
      solveRig(rig, this.s, this.sol);
      this.pitch = this.sol.pitch;
    }
    hit() { this.left = SHAKE_T; }
    // snap: jump every smoothed value to where it is heading (new race, first frame, restart).
    update(dt, r, av, phase, reduce, snap) {
      const vEff = phase === 'paused' ? 0 : r.v;
      const tgt = reduce ? 0 : clamp(vEff / 9.5, 0, 1);
      this.s = snap || reduce ? tgt : approach(this.s, tgt, dt, 0.6);
      this.yS = snap ? r.y : approach(this.yS, r.y, dt, reduce ? 0.25 : 0.12);
      if (snap || reduce) this.left = 0;
      const sol = solveRig(this.rig, this.s, this.sol);
      let y = sol.height + 0.4 * this.yS - 0.25 * av.crouch;
      let z = 0;
      if (!reduce) {
        y += 0.02 * av.gait * Math.cos(4 * Math.PI * av.phase);
        if (this.left > 0) {
          const el = SHAKE_T - this.left, k = 1 - el / SHAKE_T, amp = SHAKE_AMP * k * k, w = 2 * Math.PI * SHAKE_HZ * el;
          y += amp * Math.sin(w);
          z = amp * Math.cos(w);
          this.left = Math.max(0, this.left - dt);
        }
      }
      this.x = r.x - sol.back; // never lags: a hit drops v to 35% in one step
      this.y = Math.max(3.15, y); // the finish board top is 3.0 m
      this.z = z;
      this.pitch = sol.pitch;
    }
  }

  Object.assign(LF, {
    Geom: {
      makePose, runnerPose, easeOutBack, tipAngle, laneZ, farScale, approach,
      RIGS, rigFor, solveRig, projectPx, TIERS, pixelRatio, QualityController, ChaseCam,
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
