/* Lane Four view lifecycle: the state machine behind "3D is the renderer". No DOM and no three.js: every
   effect comes in through deps, so the tests drive it with fakes. Attaches LaneFour.ViewLife.

   The page is committed to 3D from the first moment. There is no 2D phase, no toggle and no automatic
   swap. The classic view is only ever shown for a HARD failure (three.js cannot load, WebGL2 cannot start,
   the graphics context keeps failing) or when the developer asked for it with ?renderer=2d.

   const vm = LaneFour.ViewLife.create(deps)
     classic        true for ?renderer=2d: nothing is loaded and the status is 'off'
     loadThree()    Promise of the three.js namespace; rejects with an Error whose message is the player-facing reason
     createScene(three, hooks)   the scene, or throws. hooks = { tier, onContextLost({ cause }), onContextRestored(),
                                 onRestoreFailed({ reason }), onQuality(info) }; tier is a number to start at (after
                                 a re-creation: the tier the old scene had reached) or null
     disposeScene(scene)         default scene.dispose()
     hasWebGL2()    false: do not even try (default: the WebGL2RenderingContext global exists)
     isHidden()     true while the tab is hidden (default document.hidden)
     onChange(view) after every change of mode, status, reason or shown
     now, setTimeout, clearTimeout   clock and timers (tests)
     version        the three.js version, only for display

   vm.view  (the app reads it, the machine writes it)
     mode      '3d' until a hard failure, then '2d'; '2d' from the start under ?renderer=2d
     status    'off'        ?renderer=2d, the developer override
               'loading'    from the start until the first scene has drawn its first frame
               'ready'      3D is drawing
               'restoring'  the graphics context is lost: waiting for the browser to restore it, or re-creating the scene
               'failed'     hard failure: the classic view is showing, with view.reason as the why
     reason    why, for 'failed' and 'restoring'
     lost      the current scene's graphics context is lost right now: do not draw it
     reduced   the quality controller has taken the scene to the lowest tier, on this page (stays true across
               re-creations: the app says so once)
     unplayable  at the lowest tier it was still under 15 fps for 10 s, on this page (the app gives a hint, once)
     scene, three, shown (the 3D canvas has drawn and is visible), attempts, losses, events

   vm.start()             begins loading three.js (call once, at page load)
   vm.revealed()          the app drew the scene's first frame and made the 3D canvas visible
   vm.drawn()             once per drawn frame: after about 30 s of it the attempt and loss counters reset
   vm.renderFailed(err)   renderer.render threw; three in a row re-create the scene
   vm.onVisible()         the tab became visible again
   vm.fail(reason, err)   hard failure (idempotent)
   vm.line(sceneLine)     the "View:" line of the Signals panel; sceneLine is the scene's own line while 'ready'
   vm.recent(n)           the last n events as text, oldest first

   Quality is the scene's own business and never leaves 3D: its tier steps are logged ('tier') and, once the
   lowest tier is reached, view.reduced says so. There is no speed fallback, no 'slow' state and no way to 2D.

   Context loss is recovered in place: the scene keeps its canvas and stops drawing, the app pauses a running
   race, and a restore resumes everything. If no restore arrives within 3 s, or the tab becomes visible with a
   lost context, or the restore comes but the scene finds its textures blank (onRestoreFailed: a real GPU
   process crash empties the 2D canvases behind them), the scene is disposed and made again on a fresh canvas.
   That is an automatic attempt; three are allowed, with a backoff, and the counter resets after 30 s of stable
   rendering. The fourth failure is a hard one. The same attempts cover a scene that cannot be created (one null
   getContext is often transient). */
(function (root) {
  'use strict';
  const LF = root.LaneFour || (root.LaneFour = {});

  const RESTORE_WAIT_MS = 3000; // a lost context gets this long to come back by itself
  const STABLE_MS = 30000; // this much steady drawing resets the counters
  const BACKOFF_MS = [400, 1200, 2800]; // before automatic attempt 1, 2 and 3
  const MAX_LOSSES = 5; // losses per stable spell, restored or not, before in-place recovery is given up for a re-creation
  const MAX_RENDER_ERRORS = 3; // render() throwing this many frames in a row counts as a lost scene
  const KEEP = 20; // events kept

  const describe = (err) => (err && err.message) || String(err || 'unknown error');

  function create(deps) {
    const d = deps || {};
    const now = d.now || (() => (root.performance ? root.performance.now() : Date.now()));
    const setT = d.setTimeout || ((fn, ms) => root.setTimeout(fn, ms));
    const clearT = d.clearTimeout || ((h) => root.clearTimeout(h));
    const isHidden = d.isHidden || (() => !!(root.document && root.document.hidden));
    const hasWebGL2 = d.hasWebGL2 || (() => typeof root.WebGL2RenderingContext !== 'undefined');
    const dispose = d.disposeScene || ((s) => s.dispose());
    const t0 = now();

    const view = {
      mode: d.classic ? '2d' : '3d',
      status: d.classic ? 'off' : 'loading',
      reason: '',
      scene: null, three: null, version: d.version || '',
      shown: false, lost: false, attempts: 0, losses: 0, events: [],
      reduced: false, unplayable: false,
    };

    let gen = 0; // generation of the current scene: a hook of an older one is stale and ignored
    let restoreTimer = 0;
    let buildTimer = 0;
    let stableSince = -1;
    let renderErrors = 0;
    let lastTier = null;

    function log(event, reason) {
      view.events.push({ t: Math.round(now() - t0), event, reason: reason || '' });
      if (view.events.length > KEEP) view.events.shift();
    }
    function emit() {
      if (typeof d.onChange !== 'function') return;
      try { d.onChange(view); } catch (e) { if (root.console) root.console.warn('view change handler failed', e); }
    }
    function set(status, reason) {
      view.status = status;
      view.reason = reason || '';
      emit();
    }
    function stop(timer) { if (timer) clearT(timer); return 0; }

    // ---------------------------------------------------------------- loading
    function start() {
      if (view.mode === '2d') {
        log('classic', '?renderer=2d');
        emit();
        return;
      }
      log('three-loading');
      if (!hasWebGL2()) {
        fail('WebGL2 is not available in this browser');
        return;
      }
      Promise.resolve().then(() => d.loadThree()).then(onLoaded, (err) => fail(describe(err), err));
    }

    function onLoaded(three) {
      if (view.status === 'failed') return;
      view.three = three;
      log('three-loaded');
      build('start');
    }

    function hooks(token) {
      return {
        tier: lastTier,
        onContextLost: (info) => contextLost(token, info),
        onContextRestored: () => contextRestored(token),
        onRestoreFailed: (info) => restoreFailed(token, info),
        onQuality: (info) => quality(token, info),
      };
    }

    // Makes a scene now. A failure is an attempt used up; the fourth one is a hard failure.
    function build(cause) {
      buildTimer = 0;
      if (view.status === 'failed') return;
      const token = ++gen;
      let scene;
      try {
        scene = d.createScene(view.three, hooks(token));
      } catch (err) {
        log('scene-failed', describe(err));
        retry('scene could not start', describe(err));
        return;
      }
      view.scene = scene;
      log('scene-created', cause);
      emit();
    }

    function retry(cause, message) {
      if (view.status === 'failed') return;
      if (view.attempts >= BACKOFF_MS.length) {
        fail(message || 'the graphics context keeps failing');
        return;
      }
      const wait = BACKOFF_MS[view.attempts++];
      log('retry', cause + ' · attempt ' + view.attempts + ' of ' + BACKOFF_MS.length + ' in ' + wait + ' ms');
      buildTimer = stop(buildTimer);
      buildTimer = setT(() => build(cause), wait);
    }

    // Dispose the scene and make a new one on a fresh canvas (the scene swaps its canvas out when disposed).
    function recreate(cause) {
      if (view.status === 'failed' || buildTimer) return;
      restoreTimer = stop(restoreTimer);
      const old = view.scene;
      view.scene = null;
      view.shown = false;
      view.lost = false;
      gen++;
      if (old) {
        try { lastTier = old.tier; } catch (e) { /* keep the previous one */ }
        try { dispose(old); } catch (e) { /* already gone */ }
      }
      log('recreate', cause);
      set('restoring', cause);
      retry(cause, null);
    }

    // ---------------------------------------------------------------- quality
    // The scene lowered its own tier, or found the lowest one still unplayable. Logged, and the two facts the app
    // shows once are kept on the view; the view itself (mode, status) never changes for speed.
    function quality(token, info) {
      if (token !== gen || !view.scene || !info) return;
      if (info.kind === 'tier') {
        lastTier = info.tier;
        log('tier', 'T' + info.from + ' to T' + info.tier + (info.emergency ? ' (emergency)' : '') + ' · ' + (info.reason || ''));
        if (info.lowest && !view.reduced) { view.reduced = true; emit(); }
      } else if (info.kind === 'unplayable') {
        log('unplayable', info.reason);
        if (!view.unplayable) { view.unplayable = true; emit(); }
      }
    }

    // ---------------------------------------------------------- context events
    function contextLost(token, info) {
      if (token !== gen || !view.scene || view.lost || view.status === 'failed') return;
      const found = info && info.cause === 'visibility';
      view.lost = true;
      view.losses++;
      stableSince = -1;
      log('context-lost', found ? 'found lost when the tab became visible' : 'webglcontextlost');
      set('restoring', 'context lost');
      restoreTimer = stop(restoreTimer);
      if (found) recreate('lost while the tab was hidden');
      else if (view.losses > MAX_LOSSES) recreate('lost ' + view.losses + ' times');
      else restoreTimer = setT(onRestoreTimeout, RESTORE_WAIT_MS);
    }

    function onRestoreTimeout() {
      restoreTimer = 0;
      if (!view.lost || !view.scene) return;
      if (isHidden()) { log('restore-wait', 'tab hidden: re-creating when it is visible'); return; }
      recreate('no restore within ' + RESTORE_WAIT_MS / 1000 + ' s');
    }

    function contextRestored(token) {
      if (token !== gen || !view.scene || !view.lost) return;
      restoreTimer = stop(restoreTimer);
      view.lost = false;
      log('context-restored', 'in place');
      stableSince = -1;
      set(view.shown ? 'ready' : 'loading', '');
    }

    // The context came back but the scene cannot show the stadium (its texture canvases are blank, as after a real
    // GPU process crash). No point waiting: make a new scene now. This is an automatic attempt like any other.
    function restoreFailed(token, info) {
      if (token !== gen || !view.scene || view.status === 'failed') return;
      const why = (info && info.reason) || 'the restored picture is blank';
      log('restore-failed', why);
      view.lost = true; // not drawable, whether or not the restore was reported first
      restoreTimer = stop(restoreTimer);
      recreate(why);
    }

    function onVisible() {
      if (view.lost && view.scene) recreate('tab visible with a lost context');
    }

    // ------------------------------------------------------------- the frame
    function revealed() {
      if (!view.scene || view.shown || view.lost) return;
      view.shown = true;
      renderErrors = 0;
      stableSince = now();
      log('revealed');
      if (view.status !== 'ready') set('ready', '');
      else emit();
    }

    function drawn() {
      renderErrors = 0;
      if (view.status !== 'ready') { stableSince = -1; return; }
      const t = now();
      if (stableSince < 0) { stableSince = t; return; }
      if ((view.attempts || view.losses) && t - stableSince >= STABLE_MS) {
        view.attempts = 0;
        view.losses = 0;
        log('stable', 'counters reset');
      }
    }

    function renderFailed(err) {
      if (!view.scene || view.lost || view.status === 'failed') return;
      log('render-error', describe(err));
      if (++renderErrors >= MAX_RENDER_ERRORS) {
        renderErrors = 0;
        recreate('render error: ' + describe(err));
      }
    }

    // ------------------------------------------------------------ hard failure
    function fail(reason, err) {
      if (view.status === 'failed') return;
      restoreTimer = stop(restoreTimer);
      buildTimer = stop(buildTimer);
      gen++;
      const old = view.scene;
      view.scene = null;
      view.shown = false;
      view.lost = false;
      view.mode = '2d';
      log('hard-failure', reason);
      if (root.console) root.console.warn('3D view unavailable: ' + reason, err || '');
      if (old) { try { dispose(old); } catch (e) { /* already gone */ } }
      set('failed', reason);
    }

    // -------------------------------------------------------------- reporting
    function line(sceneLine) {
      switch (view.status) {
        case 'off': return 'View: classic 2D (?renderer=2d, the developer override)';
        case 'failed': return 'View: classic 2D (3D unavailable: ' + view.reason + ')';
        case 'loading': return view.scene ? 'View: 3D chase (starting)' : 'View: loading the 3D stadium';
        case 'restoring': return 'View: 3D chase (restoring graphics: ' + view.reason + ', ' + view.attempts + ' of ' + BACKOFF_MS.length + ' automatic attempts used)';
        default: return sceneLine || 'View: 3D chase';
      }
    }

    function recent(n) {
      return view.events.slice(-n).map((e) => '+' + (e.t / 1000).toFixed(1) + ' s ' + e.event + (e.reason ? ' · ' + e.reason : ''));
    }

    return { view, start, revealed, drawn, renderFailed, onVisible, fail, line, recent };
  }

  Object.assign(LF, { ViewLife: { create, RESTORE_WAIT_MS, STABLE_MS, BACKOFF_MS, MAX_LOSSES, MAX_RENDER_ERRORS, KEEP } });
})(typeof window !== 'undefined' ? window : globalThis);
