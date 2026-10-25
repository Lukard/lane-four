'use strict';
// LaneFour.ViewLife: the view state machine, driven with a fake clock, a fake three.js and fake scenes.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/viewlife.js');
const { ViewLife } = globalThis.LaneFour;
const { BACKOFF_MS, RESTORE_WAIT_MS, STABLE_MS, MAX_LOSSES, MAX_RENDER_ERRORS, KEEP } = ViewLife;

const flush = () => new Promise((r) => setImmediate(r));
console.warn = () => {}; // a hard failure warns, as it should; not in this output

// A fake world: clock with timers, a loader, and a scene factory that remembers every scene it made.
function world(over = {}) {
  let t = 1000;
  let nextId = 0;
  const timers = [];
  const clock = {
    now: () => t,
    setTimeout: (fn, ms) => { timers.push({ id: ++nextId, at: t + ms, fn }); return nextId; },
    clearTimeout: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const n = timers[0];
        if (!n || n.at > end) break;
        timers.shift();
        t = n.at;
        n.fn();
      }
      t = end;
    },
    pending: () => timers.length,
  };
  const w = { clock, scenes: [], changes: [], hidden: false, loads: 0, createFails: 0, loadError: null, webgl2: true, tierOf: 0 };
  const deps = {
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    isHidden: () => w.hidden,
    hasWebGL2: () => w.webgl2,
    loadThree: () => { w.loads++; return w.loadError ? Promise.reject(w.loadError) : Promise.resolve({ REVISION: '186' }); },
    createScene: (three, hooks) => {
      if (w.createFails > 0) { w.createFails--; throw new Error('WebGL2 is not available (the context could not be created).'); }
      const s = { hooks, tier: w.tierOf, disposed: false, dispose() { this.disposed = true; } };
      w.scenes.push(s);
      return s;
    },
    onChange: (v) => w.changes.push(v.status),
    version: '0.186.0',
    ...over,
  };
  w.vm = ViewLife.create(deps);
  w.view = w.vm.view;
  w.live = () => w.scenes.filter((s) => !s.disposed);
  w.last = () => w.scenes[w.scenes.length - 1];
  // start and bring the first scene to the ready state
  w.up = async () => {
    w.vm.start();
    await flush();
    w.vm.revealed();
    return w.last();
  };
  return w;
}

test('?renderer=2d: nothing is loaded, the status is off, the classic view is the whole story', async () => {
  const w = world({ classic: true });
  assert.equal(w.view.mode, '2d');
  assert.equal(w.view.status, 'off');
  w.vm.start();
  await flush();
  assert.equal(w.loads, 0);
  assert.equal(w.scenes.length, 0);
  assert.match(w.vm.line(''), /classic 2D \(\?renderer=2d/);
  assert.deepEqual(w.view.events.map((e) => e.event), ['classic']);
  assert.ok(w.changes.length >= 1, 'the app is told so it can show the classic canvas');
});

test('the normal start: loading, then a scene, then ready once its first frame is shown', async () => {
  const w = world();
  assert.equal(w.view.mode, '3d');
  assert.equal(w.view.status, 'loading');
  w.vm.start();
  assert.equal(w.view.scene, null);
  await flush();
  assert.equal(w.loads, 1);
  assert.equal(w.scenes.length, 1);
  assert.equal(w.view.scene, w.scenes[0]);
  assert.equal(w.view.status, 'loading', 'a scene that has not drawn is still loading');
  assert.equal(w.view.shown, false);
  assert.match(w.vm.line(''), /starting/);
  w.vm.revealed();
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.shown, true);
  assert.equal(w.vm.line('View: 3D chase · T0'), 'View: 3D chase · T0');
  assert.deepEqual(w.view.events.map((e) => e.event), ['three-loading', 'three-loaded', 'scene-created', 'revealed']);
  w.vm.revealed();
  assert.equal(w.view.events.length, 4, 'revealed is said once');
});

test('hard failure: three.js cannot load. 2D, a reason, once, and never a scene', async () => {
  const w = world();
  w.loadError = Object.assign(new Error('Could not load three.js'), { code: 'load' });
  w.vm.start();
  await flush();
  assert.equal(w.view.mode, '2d');
  assert.equal(w.view.status, 'failed');
  assert.equal(w.view.reason, 'Could not load three.js');
  assert.equal(w.scenes.length, 0);
  assert.match(w.vm.line(''), /^View: classic 2D \(3D unavailable: Could not load three\.js\)$/);
  const n = w.changes.length;
  w.vm.fail('something else');
  assert.equal(w.view.reason, 'Could not load three.js', 'the first reason stands');
  assert.equal(w.changes.length, n, 'and nothing is announced twice');
});

test('hard failure: no WebGL2 at all is immediate, without trying to load anything', async () => {
  const w = world();
  w.webgl2 = false;
  w.vm.start();
  await flush();
  assert.equal(w.loads, 0);
  assert.equal(w.view.status, 'failed');
  assert.match(w.view.reason, /WebGL2/);
});

test('one failed getContext is transient: retried after the backoff, and the player never leaves 3D', async () => {
  const w = world();
  w.createFails = 1;
  w.vm.start();
  await flush();
  assert.equal(w.scenes.length, 0);
  assert.equal(w.view.status, 'loading');
  assert.equal(w.view.mode, '3d');
  assert.equal(w.view.attempts, 1);
  w.clock.tick(BACKOFF_MS[0] - 1);
  assert.equal(w.scenes.length, 0, 'not before the backoff');
  w.clock.tick(1);
  assert.equal(w.scenes.length, 1);
  w.vm.revealed();
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.mode, '3d');
});

test('a scene that never starts is a hard failure only after every automatic attempt, with the last error as the reason', async () => {
  const w = world();
  w.createFails = 99;
  w.vm.start();
  await flush();
  const total = BACKOFF_MS.reduce((a, b) => a + b, 0);
  w.clock.tick(total - 1);
  assert.equal(w.view.status, 'loading', 'still trying just before the last backoff has run out');
  w.clock.tick(1);
  assert.equal(w.view.status, 'failed');
  assert.equal(w.view.mode, '2d');
  assert.match(w.view.reason, /WebGL2 is not available/);
  assert.equal(w.clock.pending(), 0, 'no timer is left behind');
  assert.ok(total >= 3000 && total <= 8000, 'a few seconds: ' + total);
});

test('a context lost and restored within 3 s is handled in place: same scene, no re-creation', async () => {
  const w = world();
  const s = await w.up();
  s.hooks.onContextLost({ cause: 'event' });
  assert.equal(w.view.status, 'restoring');
  assert.equal(w.view.lost, true);
  assert.equal(w.view.mode, '3d');
  assert.match(w.vm.line(''), /restoring graphics/);
  w.clock.tick(RESTORE_WAIT_MS - 1);
  assert.equal(w.view.scene, s);
  s.hooks.onContextRestored();
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.lost, false);
  assert.equal(w.view.scene, s);
  assert.equal(s.disposed, false);
  w.clock.tick(10000);
  assert.equal(w.scenes.length, 1, 'the restore cancelled the re-creation');
  assert.deepEqual(w.view.events.slice(-2).map((e) => e.event), ['context-lost', 'context-restored']);
});

test('no restore within 3 s: the scene is disposed and made again (tier kept), after the first backoff', async () => {
  const w = world();
  w.tierOf = 2;
  const first = await w.up();
  first.hooks.onContextLost({ cause: 'event' });
  w.clock.tick(RESTORE_WAIT_MS);
  assert.equal(first.disposed, true);
  assert.equal(w.view.scene, null);
  assert.equal(w.view.status, 'restoring');
  assert.equal(w.view.shown, false);
  assert.equal(w.view.attempts, 1);
  w.clock.tick(BACKOFF_MS[0]);
  const second = w.last();
  assert.notEqual(second, first);
  assert.equal(w.view.scene, second);
  assert.equal(second.hooks.tier, 2, 'the new scene starts at the tier the old one had reached');
  assert.equal(w.view.status, 'restoring', 'until the new scene has drawn');
  w.vm.revealed();
  assert.equal(w.view.status, 'ready');
  assert.equal(w.live().length, 1);
});

test('a late event from a disposed scene is ignored', async () => {
  const w = world();
  const first = await w.up();
  first.hooks.onContextLost({ cause: 'event' });
  w.clock.tick(RESTORE_WAIT_MS + BACKOFF_MS[0]);
  w.vm.revealed();
  const second = w.last();
  first.hooks.onContextRestored();
  first.hooks.onContextLost({ cause: 'event' });
  first.hooks.onFallback({ reason: 'slow' });
  assert.equal(w.view.scene, second);
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.lost, false);
  assert.ok(!w.view.events.some((e) => e.event === 'speed-fallback-ignored'));
});

test('the tab becoming visible with a lost context re-creates at once; while hidden the 3 s wait only defers', async () => {
  const w = world();
  const first = await w.up();
  w.hidden = true;
  first.hooks.onContextLost({ cause: 'event' });
  w.clock.tick(RESTORE_WAIT_MS + 5000);
  assert.equal(first.disposed, false, 'nothing is re-created while the tab is hidden');
  assert.equal(w.view.status, 'restoring');
  assert.ok(w.view.events.some((e) => e.event === 'restore-wait'));
  w.hidden = false;
  w.vm.onVisible();
  assert.equal(first.disposed, true);
  assert.equal(w.view.attempts, 1);
  w.clock.tick(BACKOFF_MS[0]);
  assert.equal(w.live().length, 1);
  w.vm.revealed();
  assert.equal(w.view.status, 'ready');
  // visible with nothing wrong: nothing happens
  const n = w.scenes.length;
  w.vm.onVisible();
  assert.equal(w.scenes.length, n);
});

test('a scene that finds its context lost when the tab becomes visible is re-created without waiting', async () => {
  const w = world();
  const first = await w.up();
  first.hooks.onContextLost({ cause: 'visibility' });
  assert.equal(first.disposed, true);
  assert.equal(w.view.status, 'restoring');
  w.clock.tick(BACKOFF_MS[0]);
  assert.equal(w.live().length, 1);
});

test('a restore that cannot show the picture (blank textures after a GPU crash) re-creates the scene without waiting out the 3 s', async () => {
  const w = world();
  w.tierOf = 1;
  const first = await w.up();
  first.hooks.onContextLost({ cause: 'event' });
  first.hooks.onRestoreFailed({ reason: 'the textures are blank after the restore' }); // said instead of onContextRestored
  assert.equal(first.disposed, true, 'thrown away at once');
  assert.equal(w.view.status, 'restoring');
  assert.equal(w.view.lost, false);
  assert.equal(w.view.attempts, 1, 'an automatic attempt like any other');
  assert.equal(w.view.mode, '3d');
  assert.deepEqual(w.view.events.slice(-4).map((e) => e.event), ['context-lost', 'restore-failed', 'recreate', 'retry']);
  assert.equal(w.view.events[w.view.events.length - 3].reason, 'the textures are blank after the restore');
  w.clock.tick(BACKOFF_MS[0]);
  const second = w.last();
  assert.notEqual(second, first);
  assert.equal(second.hooks.tier, 1);
  w.vm.revealed();
  assert.equal(w.view.status, 'ready');
  assert.equal(w.clock.pending(), 0, 'the 3 s restore timer of the first loss was cancelled');
  assert.equal(w.live().length, 1);
});

test('a first frame that finds the restored textures blank re-creates the scene even though it was reported restored', async () => {
  const w = world();
  const first = await w.up();
  first.hooks.onContextLost({ cause: 'event' });
  first.hooks.onContextRestored();
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.lost, false);
  first.hooks.onRestoreFailed({ reason: 'the textures are blank on the first frame after the restore' });
  assert.equal(first.disposed, true);
  assert.equal(w.view.status, 'restoring', 'the app pauses a running race and hides the canvas again');
  assert.equal(w.view.scene, null);
  w.clock.tick(BACKOFF_MS[0]);
  w.vm.revealed();
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.attempts, 1);
  assert.equal(w.live().length, 1);
  assert.equal(w.view.mode, '3d');
});

test('a failed restore from a scene that is already gone is ignored, and a blank picture every time ends in the hard failure with the reason', async () => {
  const w = world();
  const first = await w.up();
  first.hooks.onContextLost({ cause: 'event' });
  first.hooks.onRestoreFailed({ reason: 'blank 1' });
  w.clock.tick(BACKOFF_MS[0]);
  first.hooks.onRestoreFailed({ reason: 'late' }); // the old scene again
  assert.equal(w.view.scene, w.last());
  assert.equal(w.view.attempts, 1);
  assert.ok(!w.view.events.some((e) => e.reason === 'late'));
  for (let i = 2; i <= BACKOFF_MS.length; i++) {
    w.last().hooks.onRestoreFailed({ reason: 'blank ' + i });
    w.clock.tick(BACKOFF_MS[i - 1]);
    assert.equal(w.view.attempts, i);
  }
  assert.equal(w.view.status, 'restoring');
  w.last().hooks.onRestoreFailed({ reason: 'blank 4' });
  assert.equal(w.view.status, 'failed');
  assert.equal(w.view.mode, '2d');
  assert.equal(w.view.reason, 'the graphics context keeps failing');
  assert.equal(w.live().length, 0);
  assert.equal(w.clock.pending(), 0);
});

test('three automatic attempts, then a hard failure: the context keeps getting lost', async () => {
  const w = world();
  await w.up();
  for (let i = 1; i <= BACKOFF_MS.length; i++) {
    assert.equal(w.view.status === 'failed', false);
    w.last().hooks.onContextLost({ cause: 'event' });
    w.clock.tick(RESTORE_WAIT_MS);
    assert.equal(w.view.attempts, i);
    w.clock.tick(BACKOFF_MS[i - 1]);
    assert.equal(w.live().length, 1, 'attempt ' + i + ' made a scene');
    w.vm.revealed();
  }
  assert.equal(w.scenes.length, 1 + BACKOFF_MS.length);
  w.last().hooks.onContextLost({ cause: 'event' });
  w.clock.tick(RESTORE_WAIT_MS);
  assert.equal(w.view.status, 'failed');
  assert.equal(w.view.mode, '2d');
  assert.match(w.view.reason, /keeps failing/);
  assert.equal(w.live().length, 0, 'the last scene was disposed');
  assert.equal(w.clock.pending(), 0);
  assert.equal(w.scenes.length, 1 + BACKOFF_MS.length, 'and no fifth scene was tried');
});

test('after 30 s of stable drawing the counters reset, so a later loss gets the full three attempts again', async () => {
  const w = world();
  await w.up();
  w.last().hooks.onContextLost({ cause: 'event' });
  w.clock.tick(RESTORE_WAIT_MS + BACKOFF_MS[0]);
  w.vm.revealed();
  assert.equal(w.view.attempts, 1);
  assert.equal(w.view.losses, 1);
  w.vm.drawn();
  w.clock.tick(STABLE_MS - 1);
  w.vm.drawn();
  assert.equal(w.view.attempts, 1, 'not yet');
  w.clock.tick(1);
  w.vm.drawn();
  assert.equal(w.view.attempts, 0);
  assert.equal(w.view.losses, 0);
  assert.ok(w.view.events.some((e) => e.event === 'stable'));
});

test('drawing that is interrupted does not count towards the stable spell', async () => {
  const w = world();
  const s = await w.up();
  s.hooks.onContextLost({ cause: 'event' });
  w.vm.drawn();
  s.hooks.onContextRestored();
  w.vm.drawn();
  w.clock.tick(STABLE_MS - 1000);
  s.hooks.onContextLost({ cause: 'event' });
  s.hooks.onContextRestored();
  w.vm.drawn();
  w.clock.tick(2000);
  w.vm.drawn();
  assert.equal(w.view.losses, 2, 'the loss in the middle restarted the clock');
  w.clock.tick(STABLE_MS);
  w.vm.drawn();
  assert.equal(w.view.losses, 0);
});

test('a context that flaps (lost and restored again and again) is re-created rather than put up with forever', async () => {
  const w = world();
  const s = await w.up();
  for (let i = 0; i < MAX_LOSSES; i++) {
    s.hooks.onContextLost({ cause: 'event' });
    s.hooks.onContextRestored();
  }
  assert.equal(w.view.status, 'ready');
  assert.equal(s.disposed, false);
  s.hooks.onContextLost({ cause: 'event' });
  assert.equal(s.disposed, true, 'one loss too many');
  assert.equal(w.view.attempts, 1);
});

test('a hard failure while restoring cancels everything that was pending', async () => {
  const w = world();
  const s = await w.up();
  s.hooks.onContextLost({ cause: 'event' });
  w.vm.fail('because');
  assert.equal(w.view.status, 'failed');
  assert.equal(s.disposed, true);
  assert.equal(w.view.lost, false);
  w.clock.tick(60000);
  assert.equal(w.scenes.length, 1);
  assert.equal(w.clock.pending(), 0);
});

test('a loss before the first frame is restored back to loading, and the reveal then makes it ready', async () => {
  const w = world();
  w.vm.start();
  await flush();
  const s = w.last();
  s.hooks.onContextLost({ cause: 'event' });
  assert.equal(w.view.status, 'restoring');
  s.hooks.onContextRestored();
  assert.equal(w.view.status, 'loading');
  w.vm.revealed();
  assert.equal(w.view.status, 'ready');
});

test('a loss after a re-creation is noticed too (the new scene is a scene like any other)', async () => {
  const w = world();
  const first = await w.up();
  first.hooks.onContextLost({ cause: 'event' });
  w.clock.tick(RESTORE_WAIT_MS + BACKOFF_MS[0]);
  const second = w.last();
  assert.equal(w.view.status, 'restoring');
  assert.equal(w.view.lost, false, 'the new scene is fine until it says otherwise');
  second.hooks.onContextLost({ cause: 'event' });
  assert.equal(w.view.lost, true);
  w.clock.tick(RESTORE_WAIT_MS);
  assert.equal(second.disposed, true);
  assert.equal(w.view.attempts, 2);
});

test('render errors: three frames in a row re-create the scene, one good frame in between resets the count', async () => {
  const w = world();
  const s = await w.up();
  for (let i = 0; i < MAX_RENDER_ERRORS - 1; i++) w.vm.renderFailed(new Error('boom'));
  w.vm.drawn();
  for (let i = 0; i < MAX_RENDER_ERRORS - 1; i++) w.vm.renderFailed(new Error('boom'));
  assert.equal(s.disposed, false);
  w.vm.renderFailed(new Error('boom'));
  assert.equal(s.disposed, true);
  assert.equal(w.view.attempts, 1);
  assert.match(w.view.events.find((e) => e.event === 'recreate').reason, /render error: boom/);
});

test('the speed fallback of the quality controller is logged and changes nothing: slow is never a reason to leave 3D', async () => {
  const w = world();
  const s = await w.up();
  const changes = w.changes.length;
  s.hooks.onFallback({ reason: 'slow' });
  s.hooks.onFallback({ reason: 'emergency' });
  assert.equal(w.view.mode, '3d');
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.scene, s);
  assert.equal(s.disposed, false);
  assert.equal(w.changes.length, changes);
  assert.deepEqual(w.view.events.slice(-2).map((e) => e.reason), ['slow', 'emergency']);
  // and a context loss afterwards is still seen (the old build swallowed it after a fallback)
  s.hooks.onContextLost({ cause: 'event' });
  assert.equal(w.view.status, 'restoring');
  s.hooks.onContextRestored();
  assert.equal(w.view.status, 'ready');
});

test('events: a ring of the last 20 with time, event and reason, shown oldest first', async () => {
  const w = world();
  const s = await w.up();
  for (let i = 0; i < 30; i++) { s.hooks.onFallback({ reason: 'n' + i }); w.clock.tick(100); }
  assert.equal(w.view.events.length, KEEP);
  assert.equal(KEEP, 20);
  assert.equal(w.view.events[KEEP - 1].reason, 'n29');
  const times = w.view.events.map((e) => e.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const recent = w.vm.recent(3);
  assert.equal(recent.length, 3);
  assert.match(recent[2], /^\+\d+\.\d s speed-fallback-ignored · n29$/);
  assert.match(recent[0], /n27$/);
});

test('a throwing change handler cannot break the machine', async () => {
  const w = world({ onChange() { throw new Error('ui bug'); } });
  await w.up();
  assert.equal(w.view.status, 'ready');
});

test('invariants hold over 400 random sequences of 40 events each', async () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let run = 0; run < 400; run++) {
    const w = world({ classic: false });
    w.createFails = rnd() < 0.3 ? Math.floor(rnd() * 5) : 0;
    if (rnd() < 0.05) w.loadError = new Error('Could not load three.js');
    w.vm.start();
    await flush();
    for (let step = 0; step < 40; step++) {
      const op = pick(['lost', 'lostv', 'restored', 'blank', 'tick', 'tick', 'visible', 'hide', 'show', 'reveal', 'drawn', 'slow', 'rerr', 'fail', 'long']);
      const s = w.view.scene;
      const hooks = pick([s, s, s, w.scenes[0], w.last()]);
      if (op === 'lost' && hooks) hooks.hooks.onContextLost({ cause: 'event' });
      else if (op === 'lostv' && hooks) hooks.hooks.onContextLost({ cause: 'visibility' });
      else if (op === 'restored' && hooks) hooks.hooks.onContextRestored();
      else if (op === 'blank' && hooks) hooks.hooks.onRestoreFailed({ reason: 'blank' });
      else if (op === 'tick') w.clock.tick(Math.floor(rnd() * 3500));
      else if (op === 'long') w.clock.tick(40000);
      else if (op === 'visible') w.vm.onVisible();
      else if (op === 'hide') w.hidden = true;
      else if (op === 'show') w.hidden = false;
      else if (op === 'reveal') w.vm.revealed();
      else if (op === 'drawn') w.vm.drawn();
      else if (op === 'slow' && hooks) hooks.hooks.onFallback({ reason: 'slow' });
      else if (op === 'rerr') w.vm.renderFailed(new Error('x'));
      else if (op === 'fail' && rnd() < 0.05) w.vm.fail('fuzz');
      const v = w.view;
      const tag = 'run ' + run + ' step ' + step + ' after ' + op;
      assert.ok(['loading', 'ready', 'restoring', 'failed'].includes(v.status), tag + ': status ' + v.status);
      assert.equal(v.mode, v.status === 'failed' ? '2d' : '3d', tag + ': 3D unless failed');
      assert.ok(w.live().length <= 1, tag + ': one live scene at most');
      if (v.status === 'failed') {
        assert.equal(v.scene, null, tag);
        assert.equal(w.live().length, 0, tag);
        assert.equal(v.lost, false, tag);
        assert.ok(v.reason, tag + ': a reason');
      }
      if (v.status === 'ready') { assert.ok(v.scene && v.shown && !v.lost, tag + ': ready means drawing'); assert.equal(w.live()[0], v.scene, tag); }
      if (v.scene) assert.equal(w.live()[0], v.scene, tag + ': view.scene is the live one');
      if (v.lost) assert.ok(v.scene && v.status === 'restoring', tag + ': lost means restoring');
      assert.ok(v.attempts >= 0 && v.attempts <= BACKOFF_MS.length, tag + ': attempts ' + v.attempts);
      assert.ok(v.events.length <= KEEP, tag);
    }
    w.clock.tick(120000);
    if (w.view.status !== 'failed' && w.view.scene) {
      // given time with nothing wrong, a surviving machine is either ready or waiting for a first frame
      assert.ok(['loading', 'ready', 'restoring'].includes(w.view.status));
    }
    if (w.view.status === 'failed') assert.equal(w.clock.pending(), 0, 'run ' + run + ': nothing left pending after a hard failure');
  }
});

test('the module exports its public surface', () => {
  assert.deepEqual(Object.keys(ViewLife).sort(), ['BACKOFF_MS', 'KEEP', 'MAX_LOSSES', 'MAX_RENDER_ERRORS', 'RESTORE_WAIT_MS', 'STABLE_MS', 'create']);
  assert.equal(RESTORE_WAIT_MS, 3000);
  assert.equal(STABLE_MS, 30000);
  assert.equal(BACKOFF_MS.length, 3);
});
