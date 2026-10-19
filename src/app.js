/* Lane Four app: camera, MediaPipe, game loop, rendering, UI. */
(function () {
  'use strict';
  const LF = window.LaneFour;
  const { clamp } = LF;
  const Geom = LF.Geom;
  const $ = (id) => document.getElementById(id);

  const MP_VERSION = '1.0.1';
  const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + MP_VERSION;
  const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
  const DEFAULTS = { stepT: 0.045, squatDown: 0.4 };
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // ---------------------------------------------------------------- settings
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem('lanefour.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set(k, v) { try { localStorage.setItem('lanefour.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const settings = {
    stepT: store.get('stepT', DEFAULTS.stepT),
    squatDown: store.get('squatDown', DEFAULTS.squatDown),
    distance: store.get('distance', 400),
    sound: store.get('sound', true),
  };

  // --------------------------------------------------------------------- DOM
  const el = {};
  ['hud', 'hudEvent', 'distVal', 'progFill', 'progTicks', 'clock', 'btnSignals', 'btnSound', 'soundWave', 'btnFull',
    'meters', 'footL', 'footR', 'cadVal', 'squatMeter', 'squatFill', 'squatNotch',
    'pip', 'cam', 'skel', 'pipTag', 'banner', 'bannerMain', 'bannerSub', 'bannerBar',
    'intro', 'introError', 'btnCamera', 'btnManual',
    'results', 'resEvent', 'resTime', 'resBest', 'resHurdles', 'resStars', 'resSquats', 'resSteps', 'resCad', 'resTop', 'resHint', 'btnAgain', 'btnSetup',
    'tune', 'tuneClose', 'sigStep', 'sigSquat', 'sigStepVal', 'sigSquatVal', 'stepT', 'stepTOut', 'squatT', 'squatTOut', 'readout', 'btnRecal', 'btnResetT',
    'pads', 'padL', 'padR', 'padSquat', 'padStart'].forEach((id) => { el[id] = $(id); });

  const css = getComputedStyle(document.documentElement);
  const tok = (name, fallback) => (css.getPropertyValue(name) || '').trim() || fallback;
  const COL = {
    track: tok('--track', '#c4472d'),
    lane: tok('--lane', '#f4f1e8'),
    amber: tok('--amber', '#ffb22e'),
    good: tok('--good', '#57d98f'),
    bad: tok('--bad', '#ff6155'),
    runner: '#fbf8ef',
    runnerFar: '#c9c4b6',
    hurdleMark: '#3fbf6a',
  };
  const FONT_DISPLAY = '"Big Shoulders Display", "Arial Narrow", sans-serif';
  const FONT_LED = '"Doto", ui-monospace, Menlo, monospace';

  // ------------------------------------------------------------------- sound
  const Sound = (() => {
    let ac = null;
    let master = null;
    let noiseBuf = null;
    function ctx() {
      if (ac) return ac;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.55;
        master.connect(ac.destination);
        const len = Math.floor(ac.sampleRate * 0.6);
        noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } catch (e) { ac = null; }
      return ac;
    }
    function unlock() {
      const a = ctx();
      if (a && a.state === 'suspended') a.resume().catch(() => {});
    }
    function tone(freq, dur, o = {}) {
      if (!settings.sound) return;
      const a = ctx();
      if (!a) return;
      const t0 = a.currentTime + (o.delay || 0);
      const osc = a.createOscillator();
      const gn = a.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
      gn.gain.setValueAtTime(0.0001, t0);
      gn.gain.exponentialRampToValueAtTime(o.gain || 0.2, t0 + 0.01);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gn);
      gn.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }
    function noise(dur, o = {}) {
      if (!settings.sound) return;
      const a = ctx();
      if (!a) return;
      const t0 = a.currentTime + (o.delay || 0);
      const src = a.createBufferSource();
      src.buffer = noiseBuf;
      const f = a.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(o.freq || 1200, t0);
      f.Q.value = o.q || 0.8;
      if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
      const gn = a.createGain();
      gn.gain.setValueAtTime(o.gain || 0.3, t0);
      gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f);
      f.connect(gn);
      gn.connect(master);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    }
    return {
      unlock,
      step: (side) => tone(side === 'L' ? 660 : 560, 0.045, { type: 'triangle', gain: 0.07 }),
      charge: () => tone(180, 0.16, { gain: 0.18, to: 320 }),
      jump: (p) => { tone(320, 0.28, { type: 'triangle', gain: 0.16, to: 700 + 600 * p }); noise(0.22, { gain: 0.06, freq: 900, to: 3200 }); },
      clear: () => { tone(880, 0.12, { gain: 0.14 }); tone(1318, 0.2, { gain: 0.12, delay: 0.07 }); },
      star: () => [1568, 2093, 2637].forEach((f, i) => tone(f, 0.14, { gain: 0.1, delay: i * 0.06 })),
      hit: () => { tone(120, 0.32, { gain: 0.4, to: 50 }); noise(0.18, { gain: 0.25, freq: 500, q: 0.6 }); },
      beep: () => tone(784, 0.16, { type: 'square', gain: 0.07 }),
      gun: () => { noise(0.5, { gain: 0.7, freq: 2400, q: 0.4, to: 300 }); tone(90, 0.25, { gain: 0.3, to: 40 }); },
      finish: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.24, { type: 'triangle', gain: 0.14, delay: i * 0.12 })),
    };
  })();

  // Spoken prompts matter here: the player is 2-3 m from a small screen.
  let lastSaid = { text: '', t: 0 };
  function say(text, force) {
    if (!settings.sound || !('speechSynthesis' in window)) return;
    const now = performance.now();
    if (!force && (now - lastSaid.t < 3500 || (text === lastSaid.text && now - lastSaid.t < 8000))) return;
    lastSaid = { text, t: now };
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.lang = 'en-US';
      window.speechSynthesis.speak(u);
    } catch (e) { /* speech unavailable */ }
  }

  // ------------------------------------------------------------------- state
  const S = {
    mode: null, // 'camera' | 'manual'
    phase: 'intro', // intro | setup | ready | countdown | running | paused | finished
    race: null,
    baseline: null,
    eff: LF.effectiveThresholds(null, settings.stepT, settings.squatDown),
    pts: null,
    aspect: 4 / 3,
    framing: 'none',
    framingSince: 0,
    depth: 0,
    stepSig: 0,
    cadence: 0,
    pendingSteps: 0,
    pendingSquat: null,
    timers: [],
    resultsTimer: null,
    best: store.get('best', {}),
    av: { phase: 0, target: 0, crouch: 0, air: 0, stumble: 0, gait: 0, charged: false },
    particles: [],
    popups: [],
    poseFps: 0, poseFrames: 0, poseFpsT: 0, inferMs: 0, delegate: '',
    sig: [],
    marks: [],
    manual: { held: false, depth: 0 },
  };

  const smoother = new LF.PoseSmoother();
  const calibrator = new LF.Calibrator(1.0);
  const stepDet = new LF.StepDetector({ threshold: settings.stepT });
  const squatDet = new LF.SquatDetector({ down: settings.squatDown });
  const handsUp = new LF.HandsUpDetector();
  const cadence = new LF.CadenceMeter();

  function applyThresholds() {
    S.eff = LF.effectiveThresholds(S.mode === 'camera' ? S.baseline : null, settings.stepT, settings.squatDown);
    stepDet.threshold = S.eff.step;
    squatDet.setDown(S.eff.squat);
    if (S.race) S.race.squatDown = S.eff.squat;
    el.squatNotch.style.bottom = (clamp(S.eff.squat / 1.2, 0, 1) * 100).toFixed(1) + '%';
  }

  function newRace() {
    S.race = new LF.Race(settings.distance, { squatDown: S.eff.squat });
    S.particles = [];
    S.popups = [];
    S.pendingSteps = 0;
    S.pendingSquat = null;
    el.hudEvent.textContent = S.race.label + ' · Lane 4';
    buildTicks();
  }

  // ------------------------------------------------------------------ banner
  let bannerKey = null;
  function banner(main, sub, opts) {
    const o = opts || {};
    const key = main + '|' + (sub || '') + '|' + (o.tone || '');
    if (key === bannerKey) return;
    bannerKey = key;
    el.bannerMain.textContent = main;
    el.bannerSub.textContent = sub || '';
    el.banner.className = o.tone || '';
    if (o.pop && !reduceMotion) {
      el.bannerMain.classList.remove('banner-pop');
      void el.bannerMain.offsetWidth;
      el.bannerMain.classList.add('banner-pop');
    }
  }
  function bannerProgress(v) {
    if (v == null) { el.bannerBar.hidden = true; return; }
    el.bannerBar.hidden = false;
    el.bannerBar.firstElementChild.style.transform = 'scaleX(' + clamp(v, 0, 1).toFixed(3) + ')';
  }
  function clearBanner() { banner('', ''); bannerProgress(null); }

  const FRAMING = {
    none: ['Step into view', 'Stand 2 to 3 m from the camera, facing it.', 'Step into view'],
    feet: ['Step back', "I can't see your feet yet.", 'Step back so I can see your feet'],
    head: ['Step back', 'Get your head in the picture too.', 'Step back so your head is in the picture'],
    far: ['Come a little closer', "You're small in the picture, so tracking gets shaky.", 'Come a little closer'],
    side: ['Face the camera', 'Turn your shoulders square to the screen.', 'Face the camera'],
  };

  // ------------------------------------------------------------------ phases
  function setPhase(p) {
    S.phase = p;
    document.body.dataset.phase = p;
  }
  function clearTimers() {
    S.timers.forEach(clearTimeout);
    S.timers = [];
    clearTimeout(S.resultsTimer);
  }
  function blurActive() {
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
  }

  function showIntro(errorMsg) {
    clearTimers();
    setPhase('intro');
    el.intro.hidden = false;
    el.results.hidden = true;
    el.hud.hidden = true;
    el.meters.hidden = true;
    el.pads.hidden = true;
    el.pip.hidden = true;
    el.padStart.hidden = true;
    clearBanner();
    el.btnCamera.disabled = false;
    el.btnManual.disabled = false;
    el.introError.hidden = !errorMsg;
    el.introError.textContent = errorMsg || '';
    newRace();
  }

  function showPlayUi() {
    el.intro.hidden = true;
    el.results.hidden = true;
    el.hud.hidden = false;
    el.meters.hidden = false;
    el.pip.hidden = S.mode !== 'camera';
    el.pads.hidden = S.mode !== 'manual';
    document.body.classList.toggle('manual', S.mode === 'manual');
  }

  function resetDetectors() {
    smoother.reset();
    calibrator.reset();
    stepDet.reset();
    squatDet.reset();
    handsUp.reset();
    cadence.reset();
    S.depth = 0;
    S.stepSig = 0;
    S.sig = [];
    S.marks = [];
  }

  function enterSetup() {
    clearTimers();
    setPhase('setup');
    S.baseline = null;
    resetDetectors();
    applyThresholds();
    newRace();
    showPlayUi();
    keepAwake();
    bannerKey = null;
  }

  function enterReady() {
    setPhase('ready');
    handsUp.reset();
    bannerProgress(null);
    if (S.mode === 'camera') {
      banner('Raise both hands', 'to start the race', { tone: 'amber', pop: true });
      say('Raise both hands to start', true);
    } else {
      banner('Ready', 'Press Enter or tap Start race.', { tone: 'amber', pop: true });
      el.padStart.hidden = false;
    }
  }

  function startCountdown() {
    if (S.phase !== 'ready') return;
    Sound.unlock();
    clearTimers();
    el.padStart.hidden = true;
    el.results.hidden = true;
    setPhase('countdown');
    banner('On your marks', '', { tone: 'amber', pop: true });
    Sound.beep();
    say('On your marks', true);
    S.timers.push(setTimeout(() => {
      banner('Set', '', { tone: 'amber', pop: true });
      Sound.beep();
      say('Set', true);
    }, 1700));
    // Like a real starter, the hold after "Set" varies a little.
    S.timers.push(setTimeout(go, 1700 + 1100 + Math.random() * 600));
  }

  function go() {
    setPhase('running');
    cadence.reset();
    S.pendingSteps = 0;
    S.pendingSquat = null;
    banner('Go', '', { tone: 'amber', pop: true });
    Sound.gun();
    S.timers.push(setTimeout(() => { if (S.phase === 'running') clearBanner(); }, 800));
  }

  function pauseRace(reason) {
    if (S.phase !== 'running') return;
    setPhase('paused');
    S.pausedReason = reason;
    if (reason === 'hidden') banner('Paused', 'Come back to this tab to continue.', { tone: 'bad' });
  }

  function resumeRace() {
    if (S.phase !== 'paused') return;
    setPhase('running');
    banner('Go', '', { tone: 'amber', pop: true });
    S.timers.push(setTimeout(() => { if (S.phase === 'running') clearBanner(); }, 700));
  }

  function spokenTime(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(1);
    return (m ? m + (m === 1 ? ' minute ' : ' minutes ') : '') + s + ' seconds';
  }

  function onFinish(time) {
    setPhase('finished');
    Sound.finish();
    const d = S.race.distance;
    const prev = S.best[d];
    const isBest = prev == null || time < prev;
    if (isBest) {
      S.best[d] = time;
      store.set('best', S.best);
    }
    banner(LF.formatTime(time), isBest && prev != null ? 'New best' : 'Finished', { tone: 'amber', pop: true });
    say('Finished in ' + spokenTime(time), true);
    S.resultsTimer = setTimeout(() => showResults(time, isBest, prev), 1800);
  }

  function showResults(time, isBest, prev) {
    clearBanner();
    const r = S.race;
    const st = r.stats;
    el.resEvent.textContent = r.label;
    el.resTime.textContent = LF.formatTime(time);
    el.resBest.textContent = isBest ? (prev == null ? 'First run' : 'New best') : 'Best ' + LF.formatTime(prev);
    el.resHurdles.textContent = st.cleared + ' / ' + r.hurdles.length;
    el.resStars.textContent = String(st.stars);
    el.resSquats.textContent = String(st.squats);
    el.resSteps.textContent = String(st.steps);
    setStat(el.resCad, String(time > 0 ? Math.round(st.steps / (time / 60)) : 0), 'spm');
    setStat(el.resTop, (st.topSpeed * 3.6).toFixed(1), 'km/h');
    el.resHint.textContent = S.mode === 'camera' ? 'Raise both hands to race again.' : 'Press Enter or tap Race again.';
    el.pads.hidden = true;
    el.results.hidden = false;
    handsUp.reset();
  }

  function setStat(node, value, unit) {
    node.textContent = value;
    const u = document.createElement('small');
    u.textContent = ' ' + unit;
    node.appendChild(u);
  }

  function raceAgain() {
    if (S.phase !== 'finished') return;
    clearTimers();
    newRace();
    el.results.hidden = true;
    el.pads.hidden = S.mode !== 'manual';
    setPhase('ready');
    startCountdown();
  }

  // ------------------------------------------------------- camera + tracking
  let stream = null;
  let landmarker = null;
  let fileset = null;
  let recreating = false;
  let lastVideoTime = -1;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Vision) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.crossOrigin = 'anonymous';
      s.onload = () => resolve();
      s.onerror = () => reject(Object.assign(new Error('Could not load ' + src), { code: 'model' }));
      document.head.appendChild(s);
    });
  }

  function landmarkerOptions(delegate) {
    return {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    };
  }

  async function createLandmarker() {
    try {
      await loadScript(MP_BASE + '/vision_bundle.js');
      const { FilesetResolver, PoseLandmarker } = window.Vision;
      fileset = fileset || await FilesetResolver.forVisionTasks(MP_BASE + '/wasm');
      try {
        const lm = await PoseLandmarker.createFromOptions(fileset, landmarkerOptions('GPU'));
        S.delegate = 'GPU';
        return lm;
      } catch (gpuErr) {
        console.warn('GPU delegate unavailable, using CPU', gpuErr);
        const lm = await PoseLandmarker.createFromOptions(fileset, landmarkerOptions('CPU'));
        S.delegate = 'CPU';
        return lm;
      }
    } catch (err) {
      if (!err.code) err.code = 'model';
      throw err;
    }
  }

  function waitForVideo(video) {
    return new Promise((resolve, reject) => {
      if (video.videoWidth > 0) { resolve(); return; }
      const done = () => { clearTimeout(timer); video.removeEventListener('loadedmetadata', done); resolve(); };
      const timer = setTimeout(() => reject(Object.assign(new Error('Camera gave no picture'), { name: 'NotReadableError' })), 8000);
      video.addEventListener('loadedmetadata', done);
    });
  }

  function updateAspect() {
    const vw = el.cam.videoWidth || 640;
    const vh = el.cam.videoHeight || 480;
    S.aspect = vw / vh;
    el.pip.style.aspectRatio = vw + ' / ' + vh;
    el.skel.width = Math.round(LF.FRAME_H * S.aspect);
    el.skel.height = LF.FRAME_H;
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    el.cam.srcObject = null;
  }

  function cameraErrorMessage(err) {
    const name = err && (err.code || err.name);
    if (name === 'insecure') {
      return 'The camera only works on a secure page. On a computer, open this file in Chrome. On a phone, open it from an https:// address (GitHub Pages works).';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access is blocked. Allow the camera for this page in your browser settings, then try again.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found on this device. You can still play with keys or touch.';
    if (name === 'NotReadableError') return 'The camera is busy or gave no picture. Close other apps using it and try again.';
    if (name === 'model') return "Couldn't load the body tracking model. Check your internet connection and try again.";
    return 'The camera could not start (' + ((err && err.message) || 'unknown error') + ').';
  }

  async function startCamera() {
    Sound.unlock();
    el.introError.hidden = true;
    el.btnCamera.disabled = true;
    el.btnManual.disabled = true;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('insecure context'), { code: 'insecure' });
      }
      el.btnCamera.textContent = 'Starting camera…';
      if (!stream) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
        });
        el.cam.srcObject = stream;
      }
      await el.cam.play().catch(() => {});
      await waitForVideo(el.cam);
      updateAspect();
      if (!landmarker) {
        el.btnCamera.textContent = 'Loading body tracking…';
        landmarker = await createLandmarker();
      }
      S.mode = 'camera';
      blurActive();
      enterSetup();
    } catch (err) {
      console.warn(err);
      if (!landmarker) stopCamera();
      showIntro(cameraErrorMessage(err));
    } finally {
      el.btnCamera.textContent = 'Start with camera';
    }
  }

  async function recoverOnCpu() {
    if (recreating) return;
    recreating = true;
    const old = landmarker;
    landmarker = null;
    try { if (old) old.close(); } catch (e) { /* ignore */ }
    try {
      landmarker = await window.Vision.PoseLandmarker.createFromOptions(fileset, landmarkerOptions('CPU'));
      S.delegate = 'CPU';
    } catch (err) {
      console.warn(err);
      showIntro(cameraErrorMessage({ code: 'model' }));
    }
    recreating = false;
  }

  function detectPose(nowMs) {
    if (S.mode !== 'camera' || !landmarker || S.phase === 'intro' || el.cam.readyState < 2) return;
    if (el.cam.currentTime === lastVideoTime) return;
    lastVideoTime = el.cam.currentTime;
    const t0 = performance.now();
    let res;
    try {
      res = landmarker.detectForVideo(el.cam, nowMs);
    } catch (err) {
      console.warn('Pose detection failed', err);
      recoverOnCpu();
      return;
    }
    const ms = performance.now() - t0;
    S.inferMs = S.inferMs ? S.inferMs * 0.9 + ms * 0.1 : ms;
    S.poseFrames++;
    onPose(res, nowMs / 1000);
  }

  function setFraming(status, t) {
    if (status !== S.framing) {
      S.framing = status;
      S.framingSince = t;
    }
  }

  function onPose(res, t) {
    const lm = res && res.landmarks && res.landmarks[0];
    if (!lm) {
      S.pts = null;
      setFraming('none', t);
      if (S.phase === 'setup') calibrator.reset();
      drawSkeleton();
      return;
    }
    S.pts = smoother.apply(lm, S.aspect, t);
    setFraming(LF.assessFraming(S.pts, S.aspect).status, t);
    drawSkeleton();

    if (S.framing === 'ok') {
      const m = LF.measure(S.pts);
      if (!S.baseline) {
        if (S.phase === 'setup') {
          const b = calibrator.push(m, t);
          if (b) {
            S.baseline = b;
            applyThresholds();
            enterReady();
          }
        }
      } else {
        S.stepSig = LF.stepSignal(m, S.baseline);
        S.depth = LF.squatDepth(m, S.baseline);
        const side = stepDet.update(S.stepSig, t);
        if (side) onStep(side, t);
        const sq = squatDet.update(S.depth, t);
        if (sq) onSquat(sq, t);
        recordSignals(t);
      }
    } else if (S.phase === 'setup') {
      calibrator.reset();
    }
    if (handsUp.update(S.pts, t)) onHandsUp();
  }

  function onStep(side, t) {
    cadence.step(t);
    S.av.target += 0.5;
    flashFoot(side);
    S.marks.push({ t, type: side });
    if (S.phase === 'running') {
      S.pendingSteps++;
      Sound.step(side);
      spawnDust();
    }
  }

  function onSquat(sq, t) {
    S.marks.push({ t, type: sq.type });
    if (S.phase === 'running') {
      S.pendingSquat = sq;
      if (sq.type === 'down') Sound.charge();
    }
  }

  function onHandsUp() {
    if (S.phase === 'ready') startCountdown();
    else if (S.phase === 'finished' && !el.results.hidden) raceAgain();
  }

  // Prompts for camera mode, re-evaluated every frame.
  function updatePrompts(t) {
    if (S.mode !== 'camera') return;
    const f = S.framing;
    const held = t - S.framingSince;
    if (S.phase === 'setup') {
      if (f !== 'ok') {
        if (held > 0.5 || bannerKey === null) {
          const m = FRAMING[f];
          banner(m[0], m[1], { tone: 'bad' });
          bannerProgress(null);
          if (held > 1.5) say(m[2]);
        }
      } else {
        banner('Stand tall and still', 'Measuring your standing height for a second.', { tone: 'amber' });
        bannerProgress(calibrator.progress);
      }
    } else if (S.phase === 'ready') {
      if (f !== 'ok' && held > 0.6) {
        const m = FRAMING[f];
        banner(m[0], m[1], { tone: 'bad' });
      } else if (f === 'ok') {
        banner('Raise both hands', 'to start the race', { tone: 'amber' });
      }
    } else if (S.phase === 'running') {
      if (f !== 'ok' && held > 1.2) pauseRace(f);
    } else if (S.phase === 'paused' && S.pausedReason !== 'hidden') {
      if (f !== 'ok') {
        const m = FRAMING[f];
        banner(m[0], m[1] + ' The race is paused.', { tone: 'bad' });
        if (held > 1.5) say(m[2]);
      } else if (held > 0.6) {
        resumeRace();
      }
    }
  }

  // ------------------------------------------------------- keys/touch input
  function startManual() {
    Sound.unlock();
    stopCamera();
    S.mode = 'manual';
    clearTimers();
    resetDetectors();
    S.baseline = null;
    S.manual.held = false;
    S.manual.depth = 0;
    applyThresholds();
    newRace();
    showPlayUi();
    blurActive();
    keepAwake();
    enterReady();
  }

  function manualStep(side) {
    if (S.mode !== 'manual' || S.phase === 'intro') return;
    Sound.unlock();
    S.stepSig = side === 'R' ? 0.15 : -0.15;
    onStep(side, performance.now() / 1000);
  }

  function manualSquat(held) {
    if (S.mode !== 'manual') return;
    S.manual.held = held;
  }

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    const k = e.key;
    if ((k === 'd' || k === 'D') && !e.metaKey && !e.ctrlKey) { toggleTune(); return; }
    if (S.phase === 'intro') return;
    if (k === 'Enter') {
      e.preventDefault();
      if (S.phase === 'ready') startCountdown();
      else if (S.phase === 'finished' && !el.results.hidden) raceAgain();
      return;
    }
    if (S.mode !== 'manual') return;
    if (k === ' ' || k === 'ArrowDown') {
      e.preventDefault();
      if (e.repeat) return;
      if (S.phase === 'ready') startCountdown();
      else manualSquat(true);
      return;
    }
    if (e.repeat) return;
    if (k === 'ArrowLeft' || k === 'f' || k === 'F') { e.preventDefault(); manualStep('L'); }
    else if (k === 'ArrowRight' || k === 'j' || k === 'J') { e.preventDefault(); manualStep('R'); }
  });
  window.addEventListener('keyup', (e) => {
    if (S.mode === 'manual' && (e.key === ' ' || e.key === 'ArrowDown')) manualSquat(false);
  });

  function bindPad(btn, down, up) {
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      btn.classList.add('active');
      down();
    });
    const end = () => {
      if (!btn.classList.contains('active')) return;
      btn.classList.remove('active');
      if (up) up();
    };
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
    btn.addEventListener('lostpointercapture', end);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bindPad(el.padL, () => manualStep('L'));
  bindPad(el.padR, () => manualStep('R'));
  bindPad(el.padSquat, () => manualSquat(true), () => manualSquat(false));
  el.padStart.addEventListener('click', () => startCountdown());

  // -------------------------------------------------------------- game loop
  function update(dt, t) {
    if (S.mode === 'manual') {
      const m = S.manual;
      m.depth = m.held ? Math.min(1.05, m.depth + dt * 2.2) : Math.max(0, m.depth - dt * 6);
      S.depth = m.depth;
      const sq = squatDet.update(S.depth, t);
      if (sq) onSquat(sq, t);
      S.stepSig *= Math.exp(-dt / 0.12);
      if (S.phase !== 'intro') recordSignals(t);
    } else if (S.framing !== 'ok') {
      S.depth *= Math.exp(-dt / 0.3);
    }
    S.cadence = cadence.value(t);

    const r = S.race;
    if (S.phase === 'running' || S.phase === 'finished') {
      const running = S.phase === 'running';
      const events = r.update(dt, {
        steps: running ? S.pendingSteps : 0,
        cadence: running ? S.cadence : 0,
        depth: S.depth,
        squat: running ? S.pendingSquat : null,
      });
      for (const e of events) handleRaceEvent(e);
    }
    S.pendingSteps = 0;
    S.pendingSquat = null;

    updateAvatar(dt, t);
    updateParticles(dt);
    updatePrompts(t);
    updateHud();
  }

  function handleRaceEvent(e) {
    switch (e.type) {
      case 'jump': Sound.jump(e.power); break;
      case 'clear':
        Sound.clear();
        popup('Clear', e.hurdle.x + 0.4, 2.0, COL.good);
        burst(e.hurdle.x, 1.0, COL.amber, 8);
        updateTicks();
        break;
      case 'star':
        Sound.star();
        popup('Star', e.hurdle.x + 0.4, 2.8, COL.amber);
        burst(e.hurdle.x, 2.45, COL.amber, 18);
        updateTicks();
        break;
      case 'hit':
        Sound.hit();
        popup('Clipped', e.hurdle.x + 0.4, 2.0, COL.bad);
        updateTicks();
        break;
      case 'finish': onFinish(e.time); break;
      default: break;
    }
  }

  function updateAvatar(dt, t) {
    const a = S.av;
    const r = S.race;
    a.phase += (a.target - a.phase) * (1 - Math.exp(-dt / 0.11));
    const g = Math.max(r.v / 7.5, S.phase === 'running' ? 0 : S.cadence / 220);
    a.gait += (clamp(g, 0, 1) - a.gait) * (1 - Math.exp(-dt / 0.25));
    const crouchTarget = r.airborne ? 0 : clamp(S.depth, 0, 1.1) / 1.1;
    a.crouch += (crouchTarget - a.crouch) * (1 - Math.exp(-dt / 0.06));
    a.air += ((r.airborne ? 1 : 0) - a.air) * (1 - Math.exp(-dt / 0.07));
    a.stumble += ((r.stumble > 0 ? 1 : 0) - a.stumble) * (1 - Math.exp(-dt / 0.1));
    a.charged = squatDet.state === 'down';
    a.t = t;
  }

  // -------------------------------------------------------------------- HUD
  const hudCache = {};
  function setText(node, key, val) {
    if (hudCache[key] !== val) { hudCache[key] = val; node.textContent = val; }
  }
  function updateHud() {
    const r = S.race;
    setText(el.distVal, 'dist', String(clamp(Math.floor(r.x), 0, r.distance)));
    setText(el.clock, 'clock', LF.formatTime(r.finished ? r.finishTime : r.time));
    const prog = clamp(r.x / r.distance, 0, 1).toFixed(4);
    if (hudCache.prog !== prog) { hudCache.prog = prog; el.progFill.style.transform = 'scaleX(' + prog + ')'; }
    setText(el.cadVal, 'cad', String(Math.round(S.cadence)));
    const d = clamp(S.depth / 1.2, 0, 1).toFixed(3);
    if (hudCache.depth !== d) { hudCache.depth = d; el.squatFill.style.transform = 'scaleY(' + d + ')'; }
    const charged = squatDet.state === 'down';
    if (hudCache.charged !== charged) { hudCache.charged = charged; el.squatMeter.classList.toggle('charged', charged); }
    if (S.mode === 'camera') {
      const cls = S.framing === 'ok' ? 'good' : 'bad';
      if (hudCache.pip !== cls) { hudCache.pip = cls; el.pip.className = cls; }
    }
  }

  function buildTicks() {
    el.progTicks.textContent = '';
    for (const h of S.race.hurdles) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.style.left = (h.x / S.race.distance * 100).toFixed(2) + '%';
      el.progTicks.appendChild(tick);
    }
  }
  function updateTicks() {
    const ticks = el.progTicks.children;
    S.race.hurdles.forEach((h, i) => {
      const tick = ticks[i];
      if (!tick) return;
      tick.className = 'tick' + (h.state === 'cleared' ? ' cleared' : h.state === 'hit' ? ' hit' : '');
      if (h.starTaken && !tick.firstChild) {
        const star = document.createElement('i');
        star.className = 'star';
        tick.appendChild(star);
      }
    });
  }

  const footTimers = {};
  function flashFoot(side) {
    const node = side === 'L' ? el.footL : el.footR;
    node.classList.add('on');
    clearTimeout(footTimers[side]);
    footTimers[side] = setTimeout(() => node.classList.remove('on'), 140);
  }

  // ----------------------------------------------------------- world render
  const cv = $('world');
  const g = cv.getContext('2d');
  const V = {};

  function seeded(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function resize() {
    V.dpr = Math.min(2, window.devicePixelRatio || 1);
    V.W = Math.max(1, window.innerWidth);
    V.H = Math.max(1, window.innerHeight);
    cv.width = Math.round(V.W * V.dpr);
    cv.height = Math.round(V.H * V.dpr);
    const land = V.W >= V.H * 1.05;
    V.ground = Math.round(V.H * (land ? 0.72 : 0.62));
    V.ppm = clamp(Math.min((V.H * 0.21) / 1.8, V.W * (land ? 0.07 : 0.094)), 16, 140);
    V.rx = V.W * (land ? 0.3 : 0.22);
    V.laneH = V.ppm * 0.55; // lane width (1.22 m) seen at a shallow angle
    V.kz = V.laneH / 1.22; // screen px per meter across the track
    V.obl = V.ppm * 0.38; // oblique shift per meter across the track
    V.edges = [];
    for (let k = 0; k <= 8; k++) V.edges.push(V.ground + (k - 3.5) * V.laneH);
    V.trackTop = V.edges[0];
    V.grassTop = V.trackTop - Math.max(18, V.ppm * 1.1);
    V.standsTop = V.grassTop - Math.max(60, V.H * 0.16);
    buildSky();
    buildStands();
    buildGrain();
    sizeSigCanvases();
  }

  function buildSky() {
    const c = V.sky || (V.sky = document.createElement('canvas'));
    c.width = cv.width;
    c.height = Math.ceil((V.grassTop + 4) * V.dpr);
    const x = c.getContext('2d');
    x.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    const grd = x.createLinearGradient(0, 0, 0, V.grassTop);
    grd.addColorStop(0, '#050b20');
    grd.addColorStop(0.6, '#13244c');
    grd.addColorStop(1, '#2e4b86');
    x.fillStyle = grd;
    x.fillRect(0, 0, V.W, V.grassTop + 4);
    const rnd = seeded(11);
    const n = Math.round((V.W * V.standsTop) / 5000);
    for (let i = 0; i < n; i++) {
      const big = rnd() < 0.12;
      x.fillStyle = 'rgba(232, 238, 255, ' + (0.2 + rnd() * 0.55).toFixed(2) + ')';
      x.fillRect(rnd() * V.W, rnd() * V.standsTop * 0.85, big ? 2 : 1, big ? 2 : 1);
    }
  }

  // A seamless tile of far-side grandstand, crowd and perimeter boards.
  function buildStands() {
    const tw = 900;
    const th = Math.ceil(V.grassTop - V.standsTop) + 2;
    const c = V.stands || (V.stands = document.createElement('canvas'));
    c.width = Math.round(tw * V.dpr);
    c.height = Math.round(th * V.dpr);
    const x = c.getContext('2d');
    x.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    x.clearRect(0, 0, tw, th);
    x.fillStyle = '#0c1631';
    x.beginPath();
    x.moveTo(0, th);
    for (let px = 0; px < tw; px += 90) {
      const yy = th * (0.06 + 0.14 * Math.pow(Math.sin((px / tw) * Math.PI * 2), 2));
      x.lineTo(px, yy);
      x.lineTo(px + 90, yy);
    }
    x.lineTo(tw, th);
    x.closePath();
    x.fill();
    // tiers of crowd
    const rnd = seeded(5);
    const colors = ['201,107,90', '90,123,201', '217,212,197', '201,163,90', '108,143,106', '160,120,190'];
    const boardH = Math.max(8, th * 0.16);
    const rowGap = Math.max(5, th * 0.075);
    for (let y = th * 0.3; y < th - boardH - 3; y += rowGap) {
      x.fillStyle = 'rgba(30, 44, 88, .9)';
      x.fillRect(0, y + rowGap * 0.62, tw, 1);
      for (let px = 2; px < tw - 2; px += 4 + rnd() * 3) {
        if (rnd() < 0.18) continue;
        const col = colors[Math.floor(rnd() * colors.length)];
        x.fillStyle = 'rgba(' + col + ',' + (0.35 + rnd() * 0.4).toFixed(2) + ')';
        const s = rnd() < 0.5 ? 2 : 3;
        x.fillRect(px, y + rnd() * 2, s, s);
      }
    }
    // perimeter boards
    const by = th - boardH;
    x.fillStyle = '#121d42';
    x.fillRect(0, by, tw, boardH);
    for (let px = 0; px < tw; px += 75) {
      x.fillStyle = '#0a1230';
      x.fillRect(px, by, 2, boardH);
      x.fillStyle = 'rgba(244, 241, 232, .14)';
      x.fillRect(px + 14, by + boardH * 0.4, 30 + (px % 3) * 6, Math.max(2, boardH * 0.18));
    }
  }

  function buildGrain() {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const x = c.getContext('2d');
    const rnd = seeded(3);
    for (let i = 0; i < 900; i++) {
      x.fillStyle = rnd() < 0.5 ? 'rgba(0, 0, 0, .10)' : 'rgba(255, 220, 200, .07)';
      x.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 1.5, 1);
    }
    V.grain = g.createPattern(c, 'repeat');
  }

  // World (meters) to screen. z is across the track, + toward the far side.
  function sx(xm, z) { return V.rx + (xm - V.camX) * V.ppm + (z || 0) * V.obl; }
  function sy(hm, z) { return V.ground - (z || 0) * V.kz - hm * V.ppm; }

  // Paint on the track surface: units are cm along x and cm across, with the
  // glyph "up" direction pointing to the far side so text reads naturally.
  function groundPaint(xm, fn) {
    const d = V.dpr;
    g.setTransform((d * V.ppm) / 100, 0, (-d * V.obl) / 100, (d * V.kz) / 100, d * sx(xm, 0), d * V.ground);
    fn();
    g.setTransform(d, 0, 0, d, 0, 0);
  }

  function render(t) {
    const r = S.race;
    V.camX = r.x;
    const W = V.W;
    const H = V.H;
    const d = V.dpr;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.drawImage(V.sky, 0, 0, W, V.sky.height / d);

    // floodlights
    const lightPar = (V.camX * V.ppm * 0.22) % 520;
    for (let i = -1; i < W / 520 + 2; i++) {
      const lx = i * 520 - lightPar + 200;
      const top = V.standsTop - Math.max(40, V.H * 0.12);
      g.strokeStyle = '#0a1330';
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(lx, V.grassTop);
      g.lineTo(lx, top + 12);
      g.stroke();
      const glow = g.createRadialGradient(lx, top, 2, lx, top, 130);
      glow.addColorStop(0, 'rgba(255, 244, 214, .5)');
      glow.addColorStop(0.25, 'rgba(255, 236, 190, .14)');
      glow.addColorStop(1, 'rgba(255, 236, 190, 0)');
      g.fillStyle = glow;
      g.fillRect(lx - 130, top - 130, 260, 260);
      g.fillStyle = '#141f3f';
      g.fillRect(lx - 22, top - 6, 44, 18);
      g.fillStyle = '#fff6dc';
      for (let k = 0; k < 6; k++) g.fillRect(lx - 18 + k * 6.5, top - 2, 4, 4);
      for (let k = 0; k < 6; k++) g.fillRect(lx - 18 + k * 6.5, top + 5, 4, 4);
    }

    // grandstand
    const tw = 900;
    const stPar = (V.camX * V.ppm * 0.15) % tw;
    const stH = V.stands.height / d;
    for (let x0 = -stPar - tw; x0 < W; x0 += tw) g.drawImage(V.stands, x0, V.standsTop, tw, stH);

    // infield grass with mowing stripes
    g.fillStyle = '#235a30';
    g.fillRect(0, V.grassTop, W, V.trackTop - V.grassTop);
    const gPar = (V.camX * V.ppm * 0.7) % 120;
    const depth = V.trackTop - V.grassTop;
    g.fillStyle = 'rgba(0, 0, 0, .09)';
    for (let x0 = -gPar - 120; x0 < W + 120; x0 += 120) {
      g.beginPath();
      g.moveTo(x0, V.trackTop);
      g.lineTo(x0 + 60, V.trackTop);
      g.lineTo(x0 + 60 + depth * 0.7, V.grassTop);
      g.lineTo(x0 + depth * 0.7, V.grassTop);
      g.closePath();
      g.fill();
    }

    // track surface
    g.fillStyle = COL.track;
    g.fillRect(0, V.trackTop, W, H - V.trackTop);
    if (V.grain) {
      g.save();
      g.translate(-((V.camX * V.ppm) % 128), 0);
      g.fillStyle = V.grain;
      g.fillRect(0, V.trackTop, W + 256, H - V.trackTop);
      g.restore();
    }
    const shade = g.createLinearGradient(0, V.trackTop, 0, H);
    shade.addColorStop(0, 'rgba(10, 19, 48, .35)');
    shade.addColorStop(0.35, 'rgba(10, 19, 48, 0)');
    shade.addColorStop(1, 'rgba(10, 19, 48, .25)');
    g.fillStyle = shade;
    g.fillRect(0, V.trackTop, W, H - V.trackTop);
    // kerb and lane lines
    g.fillStyle = '#d9dde6';
    g.fillRect(0, V.trackTop - 3, W, 4);
    g.fillStyle = 'rgba(244, 241, 232, .88)';
    for (let k = 1; k <= 8; k++) {
      const y = V.edges[k];
      if (y > H + 2) break;
      g.fillRect(0, Math.round(y) - 1, W, 2);
    }

    const xMin = V.camX - V.rx / V.ppm - 6;
    const xMax = V.camX + (W - V.rx) / V.ppm + 3;
    const inView = (x) => x > xMin && x < xMax;

    // markings painted on the track
    g.fillStyle = 'rgba(244, 241, 232, .9)';
    if (inView(0)) groundPaint(0, () => { g.fillRect(-3, -427, 6, 1100); });
    if (inView(r.distance)) groundPaint(r.distance, () => { g.fillRect(-6, -427, 12, 1100); });
    for (const lx of [-2.4, r.distance - 2.4]) {
      if (!inView(lx)) continue;
      groundPaint(lx, () => {
        g.font = '900 70px ' + FONT_DISPLAY;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillStyle = 'rgba(244, 241, 232, .75)';
        for (let k = 1; k <= 8; k++) g.fillText(String(k), 0, -(4 - k) * 122);
      });
    }
    for (let m = 10; m < r.distance; m += 10) {
      if (!inView(m)) continue;
      groundPaint(m, () => {
        g.fillStyle = 'rgba(244, 241, 232, .55)';
        g.fillRect(-2, 38, 4, 23);
        if (m % 50 === 0) {
          g.font = '800 46px ' + FONT_DISPLAY;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillStyle = 'rgba(244, 241, 232, .4)';
          g.fillText(String(m), 30, 22);
        }
      });
    }
    // hurdle marks and take-off chevrons
    const next = r.nextHurdle();
    r.hurdles.forEach((h, i) => {
      if (!inView(h.x) && !inView(h.x - 5)) return;
      groundPaint(h.x, () => {
        g.fillStyle = COL.hurdleMark;
        g.fillRect(-6, -64, 12, 6);
        g.fillRect(-6, 58, 12, 6);
      });
      if (h.state !== 'up') return;
      const inZone = h === next && h.x - r.x <= 4.4 && h.x - r.x > 0;
      const pulse = inZone && !reduceMotion ? 0.55 + 0.4 * Math.sin(t * 14) : 0.6;
      for (const off of [3.6, 2.7, 1.8]) {
        groundPaint(h.x - off, () => {
          g.strokeStyle = 'rgba(255, 178, 46, ' + pulse.toFixed(2) + ')';
          g.lineWidth = 10;
          g.lineCap = 'round';
          g.lineJoin = 'round';
          g.beginPath();
          g.moveTo(-22, -40);
          g.lineTo(18, 0);
          g.lineTo(-22, 40);
          g.stroke();
        });
      }
      if (i < 2 && S.phase !== 'finished') {
        groundPaint(h.x - 5.6, () => {
          g.font = '900 52px ' + FONT_DISPLAY;
          g.textAlign = 'center';
          g.textBaseline = 'middle';
          g.fillStyle = 'rgba(255, 178, 46, .85)';
          g.fillText('SQUAT', 0, 0);
        });
      }
    });

    drawFinishPost(r);
    for (const h of r.hurdles) if (inView(h.x)) drawHurdle(h);
    drawStars(t, r, inView);
    drawRunner(t);
    drawParticles();
  }

  function drawFinishPost(r) {
    const z = 4.75;
    const bx = sx(r.distance, z);
    if (bx < -80 || bx > V.W + 80) return;
    const by = sy(0, z);
    const top = sy(1.9, z);
    g.strokeStyle = '#d9dde6';
    g.lineWidth = Math.max(2, V.ppm * 0.06);
    g.beginPath();
    g.moveTo(bx, by);
    g.lineTo(bx, top);
    g.stroke();
    const bw = V.ppm * 1.35;
    const bh = V.ppm * 0.5;
    g.fillStyle = '#070b17';
    g.fillRect(bx - bw / 2, top - bh, bw, bh);
    g.strokeStyle = '#1f2b4d';
    g.lineWidth = 2;
    g.strokeRect(bx - bw / 2, top - bh, bw, bh);
    g.fillStyle = COL.amber;
    g.font = '900 ' + Math.round(bh * 0.6) + 'px ' + FONT_LED;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(LF.formatTime(r.finished ? r.finishTime : r.time), bx, top - bh / 2);
  }

  // Hurdle seen from the side at a 3/4 angle. When hit it tips forward, the
  // way real hurdles do, pivoting on the front of its base.
  function drawHurdle(h) {
    const HH = 0.914;
    const ang = h.state === 'hit' ? Geom.easeOutBack(h.fall) * 1.38 : 0;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const rot = (dx, hm) => [dx * ca + hm * sa, -dx * sa + hm * ca];
    const pt = (dx, hm, z) => {
      const [rx, rh] = rot(dx, hm);
      return [sx(h.x + rx, z), sy(rh, z)];
    };
    const lw = Math.max(2, V.ppm * 0.05);
    g.lineCap = 'round';
    for (const z of [0.56, -0.56]) {
      const [x0, y0] = pt(-0.7, 0, z);
      const [x1, y1] = pt(0, 0, z);
      const [x2, y2] = pt(0, HH - 0.03, z);
      g.strokeStyle = z > 0 ? '#9aa2b4' : '#e6e9f0';
      g.lineWidth = lw;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    // top board, striped black and white
    const corners = [pt(-0.02, HH, 0.6), pt(-0.02, HH, -0.6), pt(-0.02, HH - 0.07, -0.6), pt(-0.02, HH - 0.07, 0.6)];
    g.fillStyle = '#f4f1e8';
    g.beginPath();
    g.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) g.lineTo(corners[i][0], corners[i][1]);
    g.closePath();
    g.fill();
    g.fillStyle = '#10131c';
    for (let k = 0; k < 4; k++) {
      const z0 = 0.6 - (k * 2 + 0.5) * 0.15;
      const z1 = z0 - 0.15;
      const a = pt(-0.02, HH, z0);
      const b = pt(-0.02, HH, z1);
      const c = pt(-0.02, HH - 0.07, z1);
      const e = pt(-0.02, HH - 0.07, z0);
      g.beginPath();
      g.moveTo(a[0], a[1]);
      g.lineTo(b[0], b[1]);
      g.lineTo(c[0], c[1]);
      g.lineTo(e[0], e[1]);
      g.closePath();
      g.fill();
    }
  }

  function drawStar(cx, cy, rad, rot) {
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = rot + (i * Math.PI) / 5 - Math.PI / 2;
      const rr = i % 2 ? rad * 0.45 : rad;
      g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  }

  function drawStars(t, r, inView) {
    for (const h of r.hurdles) {
      if (h.state !== 'up' || !inView(h.x)) continue;
      const bob = reduceMotion ? 0 : Math.sin(t * 3 + h.x) * 0.06;
      const cx = sx(h.x, 0);
      const cy = sy(2.45 + bob, 0);
      const rad = V.ppm * 0.2;
      const glow = g.createRadialGradient(cx, cy, 1, cx, cy, rad * 2.6);
      glow.addColorStop(0, 'rgba(255, 178, 46, .45)');
      glow.addColorStop(1, 'rgba(255, 178, 46, 0)');
      g.fillStyle = glow;
      g.fillRect(cx - rad * 2.6, cy - rad * 2.6, rad * 5.2, rad * 5.2);
      g.fillStyle = COL.amber;
      drawStar(cx, cy, rad, reduceMotion ? 0 : t * 0.8);
    }
  }

  function drawRunner() {
    const r = S.race;
    const a = S.av;
    const p = Geom.runnerPose(a, reduceMotion);
    const ox = V.rx;
    const oy = V.ground - r.y * V.ppm;
    const X = (q) => ox + q.x * V.ppm;
    const Y = (q) => oy - q.y * V.ppm;
    const k = clamp(1 - r.y / 2.2, 0.35, 1);
    g.fillStyle = 'rgba(0, 0, 0, .3)';
    g.beginPath();
    g.ellipse(ox + 0.06 * V.ppm, V.ground + 1, 0.42 * V.ppm * k, 0.08 * V.ppm * k, 0, 0, Math.PI * 2);
    g.fill();
    if (a.charged && a.air < 0.5) {
      const gl = g.createRadialGradient(X(p.hip), Y(p.hip), 2, X(p.hip), Y(p.hip), V.ppm * 0.9);
      gl.addColorStop(0, 'rgba(87, 217, 143, .45)');
      gl.addColorStop(1, 'rgba(87, 217, 143, 0)');
      g.fillStyle = gl;
      g.fillRect(X(p.hip) - V.ppm, Y(p.hip) - V.ppm, V.ppm * 2, V.ppm * 2);
    }
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const limb = (pts, col, w) => {
      g.strokeStyle = col;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(X(pts[0]), Y(pts[0]));
      for (let i = 1; i < pts.length; i++) g.lineTo(X(pts[i]), Y(pts[i]));
      g.stroke();
    };
    const w = Math.max(3, 0.11 * V.ppm);
    limb([p.hip, p.legs[1].knee, p.legs[1].ankle, p.legs[1].toe], COL.runnerFar, w);
    limb([p.shoulder, p.arms[1].elbow, p.arms[1].wrist], COL.runnerFar, w * 0.88);
    limb([p.hip, p.shoulder], COL.amber, Math.max(5, 0.22 * V.ppm));
    g.fillStyle = COL.runner;
    g.beginPath();
    g.arc(X(p.head), Y(p.head), Math.max(3, 0.125 * V.ppm), 0, Math.PI * 2);
    g.fill();
    limb([p.hip, p.legs[0].knee, p.legs[0].ankle, p.legs[0].toe], COL.runner, w);
    limb([p.shoulder, p.arms[0].elbow, p.arms[0].wrist], COL.runner, w * 0.88);
  }

  // ------------------------------------------------- particles and popups
  function spawnDust() {
    if (reduceMotion) return;
    const r = S.race;
    for (let i = 0; i < 3; i++) {
      S.particles.push({
        x: r.x - 0.1 + Math.random() * 0.25, h: 0.03, z: (Math.random() - 0.5) * 0.5,
        vx: -0.4 - Math.random() * 0.8, vh: 0.5 + Math.random() * 0.9,
        life: 0.3 + Math.random() * 0.2, max: 0.5, col: '226, 120, 92', size: 0.035,
      });
    }
  }
  function burst(x, h, col, n) {
    if (reduceMotion) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 2.5;
      S.particles.push({
        x, h, z: 0, vx: Math.cos(a) * sp, vh: Math.sin(a) * sp + 1, life: 0.5 + Math.random() * 0.4, max: 0.9,
        col: col === COL.amber ? '255, 178, 46' : '244, 241, 232', size: 0.05,
      });
    }
  }
  function popup(text, x, h, color) { S.popups.push({ text, x, h, color, life: 1.1, max: 1.1 }); }

  function updateParticles(dt) {
    for (const p of S.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.h += p.vh * dt;
      p.vh -= 7 * dt;
      if (p.h < 0) { p.h = 0; p.vh *= -0.3; p.vx *= 0.6; }
    }
    S.particles = S.particles.filter((p) => p.life > 0);
    for (const q of S.popups) { q.life -= dt; q.h += dt * 0.6; }
    S.popups = S.popups.filter((q) => q.life > 0);
  }

  function drawParticles() {
    for (const p of S.particles) {
      const a = clamp(p.life / p.max, 0, 1);
      g.fillStyle = 'rgba(' + p.col + ',' + a.toFixed(2) + ')';
      const s = Math.max(2, p.size * V.ppm);
      g.fillRect(sx(p.x, p.z) - s / 2, sy(p.h, p.z) - s / 2, s, s);
    }
    for (const q of S.popups) {
      const a = clamp(q.life / q.max, 0, 1);
      g.globalAlpha = Math.min(1, a * 1.6);
      g.font = '900 ' + Math.round(Math.max(18, V.ppm * 0.42)) + 'px ' + FONT_DISPLAY;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(5, 9, 22, .75)';
      const tx = sx(q.x, 0);
      const ty = sy(q.h, 0);
      g.strokeText(q.text.toUpperCase(), tx, ty);
      g.fillStyle = q.color;
      g.fillText(q.text.toUpperCase(), tx, ty);
      g.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------ camera overlay
  const sk = el.skel.getContext('2d');
  const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
  function drawSkeleton() {
    sk.clearRect(0, 0, el.skel.width, el.skel.height);
    const pts = S.pts;
    if (!pts) return;
    const col = S.framing === 'ok' ? COL.amber : COL.bad;
    sk.lineWidth = 6;
    sk.lineCap = 'round';
    sk.strokeStyle = col;
    for (const [a, b] of BONES) {
      const p = pts[a];
      const q = pts[b];
      if (!p || !q || p.v < 0.4 || q.v < 0.4) continue;
      sk.beginPath();
      sk.moveTo(p.x, p.y);
      sk.lineTo(q.x, q.y);
      sk.stroke();
    }
    sk.fillStyle = '#ffffff';
    for (const i of [0, 15, 16, 25, 26, 27, 28]) {
      const p = pts[i];
      if (!p || p.v < 0.4) continue;
      sk.beginPath();
      sk.arc(p.x, p.y, 5, 0, Math.PI * 2);
      sk.fill();
    }
  }

  // ------------------------------------------------------- signals panel
  function recordSignals(t) {
    S.sig.push({ t, s: S.stepSig, d: S.depth });
    while (S.sig.length && t - S.sig[0].t > 6) S.sig.shift();
    while (S.marks.length && t - S.marks[0].t > 6) S.marks.shift();
  }

  function sizeSigCanvases() {
    for (const c of [el.sigStep, el.sigSquat]) {
      const w = c.clientWidth || 300;
      const h = c.clientHeight || 72;
      c.width = Math.round(w * V.dpr);
      c.height = Math.round(h * V.dpr);
    }
  }

  function plot(canvas, get, min, max, lines, marks, t, labelFor) {
    const x = canvas.getContext('2d');
    const w = canvas.width / V.dpr;
    const h = canvas.height / V.dpr;
    x.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    x.clearRect(0, 0, w, h);
    const Y = (v) => h - ((clamp(v, min, max) - min) / (max - min)) * h;
    const X = (tt) => w - ((t - tt) / 6) * w;
    x.strokeStyle = 'rgba(244, 241, 232, .18)';
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(0, Y(0));
    x.lineTo(w, Y(0));
    x.stroke();
    x.setLineDash([4, 4]);
    for (const ln of lines) {
      x.strokeStyle = ln.color;
      x.beginPath();
      x.moveTo(0, Y(ln.v));
      x.lineTo(w, Y(ln.v));
      x.stroke();
    }
    x.setLineDash([]);
    x.strokeStyle = COL.lane;
    x.lineWidth = 1.5;
    x.beginPath();
    S.sig.forEach((p, i) => (i ? x.lineTo(X(p.t), Y(get(p))) : x.moveTo(X(p.t), Y(get(p)))));
    x.stroke();
    x.font = '700 10px ' + FONT_DISPLAY;
    x.textAlign = 'center';
    for (const m of marks) {
      const lab = labelFor(m);
      if (!lab) continue;
      x.fillStyle = lab.color;
      x.fillRect(X(m.t) - 0.5, 0, 1, h);
      x.fillText(lab.text, X(m.t), 10);
    }
  }

  let readoutT = 0;
  function drawSignals(t) {
    if (el.tune.hidden) return;
    plot(el.sigStep, (p) => p.s, -0.3, 0.3,
      [{ v: S.eff.step, color: COL.amber }, { v: -S.eff.step, color: COL.amber }],
      S.marks, t, (m) => (m.type === 'L' || m.type === 'R' ? { text: m.type, color: 'rgba(255, 178, 46, .8)' } : null));
    plot(el.sigSquat, (p) => p.d, -0.2, 1.3,
      [{ v: S.eff.squat, color: COL.amber }, { v: S.eff.squat * 0.5, color: 'rgba(244, 241, 232, .35)' }],
      S.marks, t, (m) => (m.type === 'down' ? { text: '▼', color: COL.good } : m.type === 'up' ? { text: '▲', color: COL.amber } : null));
    el.sigStepVal.textContent = S.stepSig.toFixed(2);
    el.sigSquatVal.textContent = S.depth.toFixed(2);
    if (t - readoutT > 0.25) {
      readoutT = t;
      const lines = [];
      if (S.mode === 'camera') {
        lines.push('Tracking: ' + (S.delegate || 'loading') + ' · ' + Math.round(S.poseFps) + ' fps · ' + S.inferMs.toFixed(0) + ' ms per frame');
        lines.push('Framing: ' + S.framing + (S.baseline ? '' : ' · not calibrated'));
        if (S.baseline) {
          lines.push('Noise floor: steps ' + S.baseline.stepNoise.toFixed(3) + ' · squat ' + S.baseline.depthNoise.toFixed(2));
        }
      } else {
        lines.push('Keys/touch mode: signals are simulated.');
      }
      lines.push('In use: step ' + S.eff.step.toFixed(3) + ' · squat ' + S.eff.squat.toFixed(2) + ' · cadence ' + Math.round(S.cadence) + ' spm');
      el.readout.textContent = lines.join('\n');
      el.readout.style.whiteSpace = 'pre-line';
    }
  }

  function toggleTune(force) {
    const open = force == null ? el.tune.hidden : force;
    el.tune.hidden = !open;
    el.btnSignals.setAttribute('aria-pressed', String(open));
    if (open) sizeSigCanvases();
  }

  function syncControls() {
    el.stepT.value = settings.stepT;
    el.stepTOut.textContent = Number(settings.stepT).toFixed(3);
    el.squatT.value = settings.squatDown;
    el.squatTOut.textContent = Number(settings.squatDown).toFixed(2);
    el.btnSound.setAttribute('aria-pressed', String(settings.sound));
    el.soundWave.style.opacity = settings.sound ? '1' : '0';
    document.querySelectorAll('.pick button[data-dist]').forEach((b) => b.setAttribute('aria-checked', String(Number(b.dataset.dist) === settings.distance)));
  }

  // ---------------------------------------------------------------- wake lock
  let wakeLock = null;
  async function keepAwake() {
    try {
      if (!wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }

  // ------------------------------------------------------------------ wiring
  el.btnCamera.addEventListener('click', startCamera);
  el.btnManual.addEventListener('click', startManual);
  el.btnAgain.addEventListener('click', () => raceAgain());
  el.btnSetup.addEventListener('click', () => showIntro());
  el.btnSignals.addEventListener('click', () => toggleTune());
  el.tuneClose.addEventListener('click', () => toggleTune(false));
  el.btnSound.addEventListener('click', () => {
    settings.sound = !settings.sound;
    store.set('sound', settings.sound);
    if (!settings.sound && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    else Sound.unlock();
    syncControls();
  });
  if (!document.fullscreenEnabled || !document.documentElement.requestFullscreen) {
    el.btnFull.hidden = true;
  } else {
    el.btnFull.addEventListener('click', () => {
      const p = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    });
  }
  el.stepT.addEventListener('input', () => {
    settings.stepT = Number(el.stepT.value);
    store.set('stepT', settings.stepT);
    applyThresholds();
    syncControls();
  });
  el.squatT.addEventListener('input', () => {
    settings.squatDown = Number(el.squatT.value);
    store.set('squatDown', settings.squatDown);
    applyThresholds();
    syncControls();
  });
  el.btnResetT.addEventListener('click', () => {
    settings.stepT = DEFAULTS.stepT;
    settings.squatDown = DEFAULTS.squatDown;
    store.set('stepT', settings.stepT);
    store.set('squatDown', settings.squatDown);
    applyThresholds();
    syncControls();
  });
  el.btnRecal.addEventListener('click', () => {
    if (S.mode === 'camera' && S.phase !== 'intro') enterSetup();
  });
  document.querySelectorAll('.pick button[data-dist]').forEach((b) => {
    b.addEventListener('click', () => {
      settings.distance = Number(b.dataset.dist);
      store.set('distance', settings.distance);
      syncControls();
      newRace();
    });
  });
  document.addEventListener('pointerdown', () => Sound.unlock(), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (S.phase === 'running') pauseRace('hidden');
    } else {
      if (S.mode) keepAwake();
      if (S.phase === 'paused' && S.pausedReason === 'hidden') {
        if (S.mode === 'manual' || S.framing === 'ok') resumeRace();
        else S.pausedReason = 'framing';
      }
    }
  });
  window.addEventListener('resize', resize);

  let lastFrame = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
    lastFrame = now;
    const t = now / 1000;
    detectPose(now);
    update(dt, t);
    render(t);
    drawSignals(t);
    if (now - S.poseFpsT > 1000) {
      S.poseFps = (S.poseFrames * 1000) / (now - S.poseFpsT || 1);
      S.poseFrames = 0;
      S.poseFpsT = now;
    }
  }

  resize();
  syncControls();
  applyThresholds();
  showIntro();
  requestAnimationFrame(frame);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { hudCache.dist = null; });

  // Read-only handle for debugging in the console.
  window.laneFour = { state: S, settings };
})();
