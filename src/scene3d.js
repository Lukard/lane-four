/* Lane Four 3D scene: the WebGL renderer, chase camera, quality tiers, context loss and lifecycle,
   built from a THREE namespace passed in. Attaches LaneFour.Scene3D. Needs core.js, geom.js,
   assets3d.js, world3d.js and actors3d.js loaded first, and a DOM.

   const scene = LaneFour.Scene3D.create(THREE, opts)       // throws if WebGL cannot start
     canvas        the #world3d element (it gets a WebGL2 context; dispose() swaps it for a fresh clone)
     popLayer      the #popLayer element
     race          the current LaneFour.Race
     tier          0..3 to start there; omit to pick (coarse pointer: T1 else T0, stepped from the stored tier)
     lockTier      true: never change tier and never fall back for speed (?tier=N, tests)
     reduceMotion  initial only; render(ctx) re-reads ctx.reduceMotion every frame
     failIfMajorPerformanceCaveat  default true; pass false under ?renderer=3d
     onFallback    function({ reason, message, tier, emergency }) called once when 3D must give way to 2D:
                   reason 'context-lost' (scene already disposing itself), 'slow' or 'emergency'
     dpr, coarse, storage   overrides for devicePixelRatio, (pointer:coarse) and localStorage (tests)

   scene.render(ctx)    once per rAF while 3D is the visible view; returns true when it drew a frame.
                        ctx = { race, av, phase, particles, popups, t, dt, reduceMotion, poseFps, mode, sheet }
                        (av = S.av, particles = S.particles, popups = S.popups, t seconds, dt clamped seconds,
                        poseFps = S.poseFps, mode 'camera' | 'manual', sheet true while the intro or the results
                        sheet covers the picture: 15 fps). Allocation free except popup style strings.
   scene.idle(ctx)      once per rAF while the scene exists but 2D is visible (feeds the 2D pose-rate baseline)
   scene.onEvent(e)     every race event: 'hit' shakes the camera, 'clear' 'star' 'finish' cheer the stands
   scene.layout()       re-read the canvas size and DPR; true if anything changed
   scene.setTier(n)     force a tier (debug); scene.discardTiming() after anything that disturbs frame times
   scene.stats()        { line, tier, tierName, rig, fps, p95ms, megapixels, calls, triangles, ... } (allocates; <= 4 Hz)
   scene.project(x,y,z) pixel position of a point (race x, height, three Z = minus race z) as { x, y, depth }
   scene.probe()        render, then read a 7x7 grid of pixels in the same task
   scene.forceContextLoss(), scene.dispose() (idempotent), scene.parts (debug handles)
   Properties: canvas, tier, rig, lost, disposed, drawn (frames drawn). */
(function (root) {
  'use strict';
  const LF = root.LaneFour;
  if (!LF || !LF.Geom || !LF.World3D || !LF.Actors3D) throw new Error('scene3d.js needs core.js, geom.js, assets3d.js, world3d.js and actors3d.js loaded first');
  const { clamp } = LF;
  const G = LF.Geom;
  const { approach, TIERS, RIGS } = G;

  const CLEAR = 0x1b2f5c;
  const SHAKE_T = 0.35;
  const SHAKE_AMP = 0.10;
  const SHAKE_HZ = 7;
  const STORE_KEY = 'lanefour.tier3d';
  const STORE_MS = 14 * 24 * 3600 * 1000;
  const STABLE_MS = 30000; // a tier that held this long while racing is remembered
  const RING = 300;

  // ----------------------------------------------------------- chase camera (no THREE)
  class ChaseCam {
    constructor() {
      this.rig = RIGS.standard;
      this.sol = G.solveRig(this.rig, 0);
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
      G.solveRig(rig, this.s, this.sol);
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
      const sol = G.solveRig(this.rig, this.s, this.sol);
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

  // ------------------------------------------------------------------- start tier
  const tierKey = (dpr, w, h) => (Math.round(dpr * 100) / 100) + '|' + Math.round(Math.min(w, h));

  // Coarse pointer starts at T1, others at T0. A stored tier under 14 days old for the same
  // dpr and screen starts one step above it, so a bad session heals. Pure.
  function pickStartTier(o) {
    const def = o.coarse ? 1 : 0;
    const s = o.stored;
    if (s && typeof s === 'object' && s.k === o.key && Number.isFinite(s.t) && Number.isFinite(s.at)) {
      const age = o.now - s.at;
      if (age >= -60000 && age < STORE_MS) return clamp(Math.max(Math.round(s.t) - 1, def), 0, TIERS.length - 1);
    }
    return def;
  }
  function safeStorage() { try { return root.localStorage || null; } catch (e) { return null; } }
  function readStored(st) { try { return st ? JSON.parse(st.getItem(STORE_KEY)) : null; } catch (e) { return null; } }
  function writeStored(st, rec) { try { if (st) st.setItem(STORE_KEY, JSON.stringify(rec)); } catch (e) { /* storage unavailable */ } }

  // ------------------------------------------------------------------------ create
  function create(THREE, opts) {
    const T = THREE;
    const o = opts || {};
    const canvas = o.canvas;
    if (!canvas || !o.popLayer || !o.race) throw new Error('Scene3D.create needs opts.canvas, opts.popLayer and opts.race');
    const doc = canvas.ownerDocument || root.document;
    const dprNow = () => o.dpr || root.devicePixelRatio || 1;
    const storage = o.storage !== undefined ? o.storage : safeStorage();
    const lockTier = o.lockTier === true;
    let sw = 1, sh = 1; // scratch: last measured CSS size
    const measure = () => {
      sw = canvas.clientWidth;
      sh = canvas.clientHeight;
      if (!(sw > 0 && sh > 0)) { // display:none until the first frame: use the viewport the canvas will fill
        const d = doc.documentElement;
        sw = d.clientWidth || root.innerWidth || 1;
        sh = d.clientHeight || root.innerHeight || 1;
      }
    };
    measure();
    const key = tierKey(dprNow(), sw, sh);
    const coarse = o.coarse !== undefined ? !!o.coarse : !!(root.matchMedia && root.matchMedia('(pointer:coarse)').matches);
    const defTier = coarse ? 1 : 0;
    const stored = readStored(storage);
    let tierIdx = typeof o.tier === 'number' ? clamp(o.tier | 0, 0, TIERS.length - 1) : pickStartTier({ coarse, stored, key, now: Date.now() });
    let tier = TIERS[tierIdx];

    // A canvas that has had a WebGL context can never get another one, so retiring it leaves a pristine
    // clone (same id and attributes, hidden) in its place for the next create().
    function retireCanvas() {
      if (!canvas.parentNode) return;
      const fresh = canvas.cloneNode(false);
      fresh.removeAttribute('width');
      fresh.removeAttribute('height');
      fresh.removeAttribute('style');
      fresh.removeAttribute('data-engine'); // three's own mark
      fresh.className = '';
      fresh.hidden = true;
      canvas.parentNode.replaceChild(fresh, canvas);
    }

    // The context first, with exactly the options of the spec (three's own constructor would force
    // alpha: true): if WebGL cannot start, nothing else has been built yet.
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false,
        powerPreference: 'default', failIfMajorPerformanceCaveat: o.failIfMajorPerformanceCaveat !== false,
      });
    } catch (e) { gl = null; }
    if (!gl) throw new Error('WebGL2 is not available (the context could not be created).');
    let renderer;
    try {
      renderer = new T.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'default' });
    } catch (e) {
      retireCanvas();
      throw e;
    }
    let world = null, actors = null, dead = false, failed = null, lost = false;
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(50, 1, 0.3, tier.far);
    camera.rotation.order = 'YXZ';
    const cam = new ChaseCam();
    const ctl = new G.QualityController({ tier: tierIdx });

    // ---- per-frame state, all preallocated
    const wctx = { race: null, t: 0, dt: 0, camera, reduceMotion: false, phase: 'ready' };
    const fa = { race: null, av: null, phase: 'ready', particles: null, popups: null, dt: 0, reduceMotion: false, camera };
    const av0 = { phase: 0, target: 0, crouch: 0, air: 0, stumble: 0, gait: 0, charged: false, t: 0 };
    const ring = new Float32Array(RING);
    const _v = new T.Vector3();
    const pout = { x: 0, y: 0, depth: 0 };
    const px = new Uint8Array(4);
    let W = 0, H = 0, PR = 0;
    let ringN = 0, ringPos = 0, lastCall = -1;
    let nextDraw = 0, lastCap = 0, accDt = 0, nowMs = 0;
    let lastRace = null, lastX = 0;
    let visible = false, drawn = 0, stableT0 = 0, persisted = false, reduceNow = !!o.reduceMotion;
    let onVis = null;

    function disposeAll() { // used by dispose() and by a failed create()
      if (dead) return;
      dead = true;
      if (onVis && doc) doc.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('webglcontextlost', onLost);
      try { if (actors) actors.dispose(); } catch (e) { /* keep going */ }
      try { if (world) world.dispose(); } catch (e) { /* keep going */ }
      scene.clear();
      try { renderer.dispose(); } catch (e) { /* keep going */ }
      try { if (!gl.isContextLost()) renderer.forceContextLoss(); } catch (e) { /* keep going */ }
      retireCanvas();
    }
    function fail(reason, message, emergency) {
      if (failed) return;
      failed = { reason, message };
      if (typeof o.onFallback === 'function') {
        try { o.onFallback({ reason, message, tier: tierIdx, emergency: !!emergency }); } catch (e) { /* the app's problem */ }
      }
      if (reason === 'context-lost') disposeAll();
    }
    function onLost(ev) {
      ev.preventDefault();
      lost = true;
      fail('context-lost', 'The graphics context was lost.', true);
    }
    canvas.addEventListener('webglcontextlost', onLost);

    try {
      if (!gl || gl.isContextLost()) throw new Error('WebGL context unavailable');
      renderer.setClearColor(CLEAR);
      scene.fog = new T.Fog(CLEAR, tier.fogNear, tier.fogFar);
      world = LF.World3D.build(T, { race: o.race, tier: tierIdx, reduceMotion: reduceNow, anisotropy: renderer.capabilities.getMaxAnisotropy() });
      actors = LF.Actors3D.create(T, { glowTexture: world.glowTexture, popLayer: o.popLayer, tier: tierIdx, reduceMotion: reduceNow });
      scene.add(world.root, actors.root);
    } catch (e) {
      disposeAll();
      throw e;
    }

    // ---- layout: CSS size, rig class, pixel ratio
    function layout() {
      if (dead) return false;
      measure();
      const pr = G.pixelRatio(dprNow(), sw, sh, tierIdx);
      if (sw === W && sh === H && Math.abs(pr - PR) < 1e-6) return false;
      W = sw;
      H = sh;
      PR = pr;
      renderer.setPixelRatio(pr);
      renderer.setSize(W, H, false);
      const rig = G.rigFor(W, H);
      cam.setRig(rig);
      camera.fov = rig.vfov;
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
      actors.setView(rig.vfov, W, H, rig === RIGS.portrait);
      ctl.discard(2);
      return true;
    }

    function applyTier(n) {
      tierIdx = clamp(n | 0, 0, TIERS.length - 1);
      tier = TIERS[tierIdx];
      camera.far = tier.far;
      camera.updateProjectionMatrix();
      scene.fog.near = tier.fogNear;
      scene.fog.far = tier.fogFar;
      world.setTier(tierIdx);
      actors.setTier(tierIdx);
      layout(); // the pixel ratio depends on the tier
      lastCap = 0;
    }
    function setTier(n) {
      if (dead) return tier;
      applyTier(n);
      ctl.tier = tierIdx;
      ctl.clear();
      stableT0 = nowMs;
      persisted = true;
      return tier;
    }

    // Everything one drawn frame needs except renderer.render itself.
    function step(r, av, phase, dt, t, reduce, parts, pops, snap) {
      cam.update(dt, r, av, phase, reduce, snap);
      camera.position.set(cam.x, cam.y, cam.z);
      camera.rotation.set(-cam.pitch, -Math.PI / 2, 0);
      camera.updateMatrixWorld();
      wctx.race = r;
      wctx.t = t;
      wctx.dt = dt;
      wctx.reduceMotion = reduce;
      wctx.phase = phase;
      world.update(wctx);
      if (snap) actors.snap();
      fa.race = r;
      fa.av = av;
      fa.phase = phase;
      fa.particles = parts;
      fa.popups = pops;
      fa.dt = dt;
      fa.reduceMotion = reduce;
      actors.update(fa);
    }

    // ---- the frame
    function render(ctx) {
      if (dead) return false;
      const t = ctx.t, tMs = t * 1000;
      nowMs = tMs;
      if (!visible) { // 3D just became the visible view
        visible = true;
        ctl.setView3d(tMs, true);
        ctl.discard(2);
        if (failed && failed.reason !== 'context-lost') { failed = null; ctl.reset(); ctl.setView3d(tMs, true); }
        nextDraw = 0;
        accDt = 0;
        lastCall = -1;
        lastRace = null;
        stableT0 = tMs;
        persisted = false;
      }
      if (lastCall >= 0) {
        const iv = tMs - lastCall;
        if (iv > 0 && iv < 1000) { ring[ringPos] = iv; ringPos = (ringPos + 1) % RING; if (ringN < RING) ringN++; }
      }
      lastCall = tMs;
      ctl.frame(tMs);
      if (ctx.mode === 'camera' && ctx.poseFps > 0) ctl.pose(tMs, ctx.poseFps);
      const phase = ctx.phase;
      let verdict = 'none';
      if (!lockTier) verdict = ctl.check(tMs, phase !== 'countdown' && phase !== 'running');
      if (verdict === 'down') { applyTier(ctl.tier); stableT0 = tMs; persisted = false; }
      accDt += ctx.dt;

      // 15 fps behind a sheet: the app has no 'results' phase (the results sheet shows during 'finished'), so it says so with ctx.sheet
      const cap = ctx.sheet === true || phase === 'intro' || phase === 'results' ? 15 : tier.fps === 30 ? 30 : 62;
      if (cap !== lastCap) { lastCap = cap; nextDraw = 0; }
      let did = false;
      if (t >= nextDraw - 0.0015) {
        const iv = 1 / cap;
        nextDraw = t - nextDraw > iv ? t + iv : nextDraw + iv;
        const dt = Math.min(0.25, accDt);
        accDt = 0;
        const r = ctx.race;
        const snap = r !== lastRace || r.x < lastX - 1 || lastRace === null;
        lastRace = r;
        lastX = r.x;
        reduceNow = !!ctx.reduceMotion;
        if (!W) layout();
        step(r, ctx.av, phase, dt, t, reduceNow, ctx.particles, ctx.popups, snap);
        renderer.render(scene, camera);
        drawn++;
        did = true;
        if (!persisted && !lockTier && phase === 'running' && tMs - stableT0 > STABLE_MS) {
          persisted = true;
          if (tierIdx > defTier || stored) writeStored(storage, { k: key, t: tierIdx, at: Date.now() });
        }
      }
      if (verdict === 'to2d') fail(ctl.emergency ? 'emergency' : 'slow', ctl.emergency ? 'The 3D view could not keep up.' : 'The 3D view is too slow on this device.', ctl.emergency);
      return did;
    }

    // The scene exists but 2D is what the player sees: keep the 2D pose rate as the baseline.
    function idle(ctx) {
      if (dead) return;
      const tMs = ctx.t * 1000;
      if (visible) { visible = false; ctl.setView3d(tMs, false); }
      if (ctx.mode === 'camera' && ctx.poseFps > 0) ctl.pose(tMs, ctx.poseFps);
    }

    function onEvent(e) {
      if (dead || !e) return;
      switch (e.type) {
        case 'hit': if (!reduceNow) cam.hit(); break;
        case 'clear': case 'star': case 'finish': world.cheer(e.type); break;
        default: break;
      }
    }

    function project(x, y, z) {
      camera.updateMatrixWorld();
      _v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      pout.depth = -_v.z;
      _v.applyMatrix4(camera.projectionMatrix);
      pout.x = (_v.x * 0.5 + 0.5) * W;
      pout.y = (0.5 - _v.y * 0.5) * H;
      return pout;
    }

    // Re-render, then read the 7x7 grid straight away (the drawing buffer is cleared after compositing).
    function probe() {
      if (dead || gl.isContextLost()) return null;
      renderer.render(scene, camera);
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const seen = new Set(), samples = [];
      const read = (fx, fy) => {
        gl.readPixels(Math.min(w - 1, Math.floor(fx * w)), Math.max(0, h - 1 - Math.floor(fy * h)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [px[0], px[1], px[2]];
      };
      for (let j = 0; j < 7; j++) {
        for (let i = 0; i < 7; i++) {
          const c = read((i + 0.5) / 7, (j + 0.5) / 7);
          samples.push(c);
          seen.add((c[0] >> 3) + ',' + (c[1] >> 3) + ',' + (c[2] >> 3));
        }
      }
      const low = read(0.5, 0.9);
      return { w, h, distinct: seen.size, samples, at: low, redDominant: low[0] > 100 && low[0] > low[1] * 1.4 && low[0] > low[2] * 1.4 };
    }

    function stats() {
      const info = renderer.info;
      let fps = 0, p95 = 0;
      if (ringN > 0) {
        const a = ring.slice(0, ringN).sort();
        let sum = 0;
        for (let i = 0; i < ringN; i++) sum += a[i];
        fps = (1000 * ringN) / sum;
        p95 = a[Math.min(ringN - 1, Math.floor(ringN * 0.95))];
      }
      const mp = (canvas.width * canvas.height) / 1e6;
      const calls = info.render.calls, tris = info.render.triangles;
      const rigName = cam.rig.name;
      return {
        line: 'View: 3D chase · ' + tier.name + ' · ' + Math.round(fps) + ' fps (p95 ' + Math.round(p95) + ' ms) · ' + mp.toFixed(2) + ' MP · ' + calls + ' calls · ' + (tris / 1000).toFixed(1) + 'k tris · ' + rigName,
        tier: tierIdx, tierName: tier.name, rig: rigName, fps, p95ms: p95, megapixels: mp, pixelRatio: PR, cssWidth: W, cssHeight: H,
        calls, triangles: tris, geometries: info.memory.geometries, textures: info.memory.textures,
        textureMB: world.stats().textureMB, frames: drawn, lost, locked: lockTier, controllerTarget: ctl.target,
        fallback: failed ? failed.reason : null,
      };
    }

    onVis = () => {
      if (dead || !doc || doc.hidden) return;
      ctl.clear();
      nextDraw = 0;
      accDt = 0;
      lastCall = -1;
      if (gl.isContextLost()) onLost({ preventDefault() {} });
    };
    doc.addEventListener('visibilitychange', onVis);

    // ---- prime: first-frame state, programs compiled once (the charge glow too, which is hidden until a squat)
    try {
      layout();
      step(o.race, av0, 'ready', 0.016, 0, reduceNow, null, null, true);
      lastRace = o.race;
      lastX = o.race.x;
      actors.prewarm(true);
      renderer.compile(scene, camera);
      actors.prewarm(false);
      if (gl.isContextLost()) throw new Error('WebGL context lost while starting');
    } catch (e) {
      disposeAll();
      throw e;
    }

    return {
      canvas, render, idle, onEvent, layout, setTier, project, probe, stats,
      discardTiming() { ctl.discard(2); },
      forceContextLoss() { if (!dead) renderer.forceContextLoss(); },
      dispose: disposeAll,
      get tier() { return tierIdx; },
      get rig() { return cam.rig.name; },
      get lost() { return lost; },
      get disposed() { return dead; },
      get drawn() { return drawn; },
      parts: { renderer, scene, camera, cam, ctl, world, actors },
    };
  }

  Object.assign(root.LaneFour, { Scene3D: { create, ChaseCam, pickStartTier, tierKey } });
})(typeof window !== 'undefined' ? window : globalThis);
