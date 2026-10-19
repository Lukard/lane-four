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

  // Decides when 3D should step down a tier or give up for 2D. Pure: it is fed
  // timestamps in ms and returns a verdict, and never touches the renderer.
  //
  //   frame(t)           once per rAF with the rAF timestamp
  //   pose(t, fps)       every frame in camera mode with S.poseFps
  //   setView3d(t, on)   when the 3D view becomes (in)visible; capturing the 2D
  //                      pose-rate baseline over the 2 s before the swap
  //   discard(n)         after a resize, tier change or visibility change
  //   clear()            when the tab becomes visible again
  //   check(t, canApply) -> 'none' | 'down' | 'to2d'
  //
  // Frames are grouped into 250 ms windows (fps each), kept in a ring of 10. The
  // target is the median window rate of the first 3 s, capped at 60, so a
  // device locked at 30 Hz is not "slow". Down-only: a step happens when 7 of
  // the 10 windows are under 0.85 x target, or in camera mode when pose fps
  // stays under 22 for 3 s and under 0.8 x the 2D baseline (any baseline-less
  // value under 22 counts). After a step: 8 s cooldown, windows cleared. At the
  // last tier the same condition returns 'to2d'. Ten windows under 12 fps is an
  // emergency and returns 'to2d' at once, even if canApply is false (which
  // defers ordinary steps, e.g. during a race).
  const WINDOW_MS = 250;
  const RING = 10;
  const WARM_MS = 3000;
  const COOLDOWN_MS = 8000;
  const SLOW_FRAC = 0.85;
  const SLOW_WINDOWS = 7;
  const EMERGENCY_FPS = 12;
  const POSE_FLOOR = 22;
  const POSE_HOLD_MS = 3000;
  const POSE_REL = 0.8;
  const BASE_MS = 2000;

  class QualityController {
    constructor(opts) {
      this.tier = clamp(((opts && opts.tier) | 0), 0, TIERS.length - 1);
      this.ring = new Float64Array(RING);
      this.warm = new Float64Array(16);
      this.scratch = new Float64Array(16);
      this.psT = new Float64Array(256);
      this.psV = new Float64Array(256);
      this.reset();
    }

    // Full restart: windows, target estimation, cooldown, pose state.
    reset() {
      this.count = 0; // windows in the ring
      this.pos = 0;
      this.winStart = -1;
      this.winFrames = 0;
      this.lastT = -1;
      this.skip = 0;
      this.warmN = 0;
      this.warmStart = -1;
      this.target = 0; // fps; 0 until the first 3 s have been measured
      this.cooldownUntil = -1;
      this.done = false;
      this.emergency = false;
      this.baseline = null;
      this.view3d = false;
      this.slowSince = -1;
      this.psN = 0;
      this.psPos = 0;
    }

    frame(t) {
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
      const fps = (this.winFrames * 1000) / el;
      this.winStart = t;
      this.winFrames = 0;
      if (this.skip > 0) { this.skip--; return; }
      this.ring[this.pos] = fps;
      this.pos = (this.pos + 1) % RING;
      if (this.count < RING) this.count++;
      if (this.target === 0) this.warmUp(fps, t);
    }

    warmUp(fps, t) {
      if (this.warmN < this.warm.length) this.warm[this.warmN++] = fps;
      if (t - this.warmStart < WARM_MS || this.warmN < 4) return;
      const m = this.scratch.subarray(0, this.warmN);
      m.set(this.warm.subarray(0, this.warmN));
      m.sort();
      const mid = this.warmN >> 1;
      const med = this.warmN % 2 ? m[mid] : (m[mid - 1] + m[mid]) / 2;
      this.target = Math.min(60, med);
    }

    // Skip the open window and the next n closed ones, and restart the pose timer.
    discard(n) {
      this.skip = Math.max(this.skip, n === undefined ? 2 : n);
      this.winStart = -1;
      this.winFrames = 0;
      this.slowSince = -1;
    }

    clear() {
      this.count = 0;
      this.pos = 0;
      this.discard(2);
    }

    pose(t, fps) {
      if (!(fps > 0)) return;
      if (!this.view3d) {
        this.psT[this.psPos] = t;
        this.psV[this.psPos] = fps;
        this.psPos = (this.psPos + 1) % this.psT.length;
        if (this.psN < this.psT.length) this.psN++;
        return;
      }
      const bad = fps < POSE_FLOOR && (this.baseline === null || fps < POSE_REL * this.baseline);
      if (!bad) this.slowSince = -1;
      else if (this.slowSince < 0) this.slowSince = t;
    }

    setView3d(t, on) {
      if (on === this.view3d) return;
      this.view3d = on;
      this.slowSince = -1;
      if (!on) { this.psN = 0; this.psPos = 0; return; }
      let sum = 0;
      let n = 0;
      for (let i = 0; i < this.psN; i++) {
        if (t - this.psT[i] <= BASE_MS && t >= this.psT[i]) { sum += this.psV[i]; n++; }
      }
      this.baseline = n >= 5 ? sum / n : null;
    }

    check(t, canApply) {
      if (this.done) return 'none';
      if (this.count === RING) {
        let allDead = true;
        for (let i = 0; i < RING; i++) if (this.ring[i] >= EMERGENCY_FPS) { allDead = false; break; }
        if (allDead) { this.done = true; this.emergency = true; return 'to2d'; }
      }
      if (t < this.cooldownUntil) return 'none';
      let slow = false;
      if (this.target > 0 && this.count === RING) {
        let n = 0;
        const lim = SLOW_FRAC * this.target;
        for (let i = 0; i < RING; i++) if (this.ring[i] < lim) n++;
        slow = n >= SLOW_WINDOWS;
      }
      if (!slow && this.view3d && this.slowSince >= 0 && t - this.slowSince >= POSE_HOLD_MS) slow = true;
      if (!slow || !canApply) return 'none';
      if (this.tier >= TIERS.length - 1) { this.done = true; return 'to2d'; }
      this.tier++;
      this.cooldownUntil = t + COOLDOWN_MS;
      this.clear();
      return 'down';
    }
  }

  Object.assign(LF, {
    Geom: {
      makePose, runnerPose, easeOutBack, tipAngle, laneZ, farScale, approach,
      RIGS, rigFor, solveRig, projectPx, TIERS, pixelRatio, QualityController,
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
