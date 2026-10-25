'use strict';
// LaneFour.ViewLife: the view state machine, driven with a fake clock, a fake three.js and fake scenes.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/viewlife.js');
const { world, flush } = require('./viewworld.js');
const { ViewLife } = globalThis.LaneFour;
const { BACKOFF_MS, RESTORE_WAIT_MS, STABLE_MS, MAX_LOSSES, MAX_RENDER_ERRORS, KEEP } = ViewLife;

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
  first.hooks.onQuality({ kind: 'tier', from: 0, tier: 3, lowest: true, reason: 'stale' });
  first.hooks.onQuality({ kind: 'unplayable', tier: 3, reason: 'stale' });
  assert.equal(w.view.scene, second);
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.lost, false);
  assert.ok(!w.view.events.some((e) => e.event === 'tier' || e.event === 'unplayable'), 'a disposed scene says nothing about quality');
  assert.equal(w.view.reduced, false);
  assert.equal(w.view.unplayable, false);
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

test('quality events are logged and never change the view: a tier step is silent, the lowest tier and an unplayable device are said once', async () => {
  const w = world();
  const s = await w.up();
  const changes = w.changes.length;
  s.hooks.onQuality({ kind: 'tier', from: 0, tier: 1, lowest: false, emergency: false, reason: 'slow: 7 of 10 windows under 0.85 x 60 fps (median 38.0)' });
  assert.equal(w.changes.length, changes, 'an ordinary step tells the page nothing');
  assert.equal(w.view.reduced, false);
  assert.match(w.view.events[w.view.events.length - 1].reason, /^T0 to T1 · slow: 7 of 10/);
  s.hooks.onQuality({ kind: 'tier', from: 1, tier: 3, lowest: true, emergency: true, reason: 'emergency: 9.0 fps over the last 1.8 s' });
  assert.equal(w.view.reduced, true);
  assert.equal(w.changes.length, changes + 1, 'the lowest tier is announced once');
  assert.match(w.view.events[w.view.events.length - 1].reason, /^T1 to T3 \(emergency\) · emergency: 9\.0 fps/);
  s.hooks.onQuality({ kind: 'tier', from: 2, tier: 3, lowest: true, reason: 'again' });
  assert.equal(w.changes.length, changes + 1, 'and not again');
  s.hooks.onQuality({ kind: 'unplayable', tier: 3, reason: 'under 15 fps for 10 s at the lowest tier' });
  s.hooks.onQuality({ kind: 'unplayable', tier: 3, reason: 'under 15 fps for 11 s at the lowest tier' });
  assert.equal(w.view.unplayable, true);
  assert.equal(w.changes.length, changes + 2);
  // none of it is a reason to leave 3D, or to touch the scene
  assert.equal(w.view.mode, '3d');
  assert.equal(w.view.status, 'ready');
  assert.equal(w.view.scene, s);
  assert.equal(s.disposed, false);
  assert.equal(w.view.attempts, 0);
  // a scene made again carries on at the lowest tier and the page keeps what it knows
  s.tier = 3; // what the real scene's own tier is by now
  s.hooks.onContextLost({ cause: 'event' });
  w.clock.tick(RESTORE_WAIT_MS + BACKOFF_MS[0]);
  const second = w.last();
  assert.notEqual(second, s);
  assert.equal(second.hooks.tier, 3, 'the new scene starts at the tier the old one had reached');
  assert.equal(w.view.reduced, true);
  // and a context loss afterwards is still seen
  w.vm.revealed();
  second.hooks.onContextLost({ cause: 'event' });
  assert.equal(w.view.status, 'restoring');
  second.hooks.onContextRestored();
  assert.equal(w.view.status, 'ready');
  assert.ok(!('slow' in w.view) && !('fallback' in w.view), 'there is no slow state any more');
});

test('events: a ring of the last 20 with time, event and reason, shown oldest first', async () => {
  const w = world();
  const s = await w.up();
  for (let i = 0; i < 30; i++) { s.hooks.onQuality({ kind: 'tier', from: 0, tier: 1, lowest: false, reason: 'n' + i }); w.clock.tick(100); }
  assert.equal(w.view.events.length, KEEP);
  assert.equal(KEEP, 20);
  assert.equal(w.view.events[KEEP - 1].reason, 'T0 to T1 · n29');
  const times = w.view.events.map((e) => e.t);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  const recent = w.vm.recent(3);
  assert.equal(recent.length, 3);
  assert.match(recent[2], /^\+\d+\.\d s tier · T0 to T1 · n29$/);
  assert.match(recent[0], /n27$/);
});

test('a throwing change handler cannot break the machine', async () => {
  const w = world({ onChange() { throw new Error('ui bug'); } });
  await w.up();
  assert.equal(w.view.status, 'ready');
});

test('the module exports its public surface', () => {
  assert.deepEqual(Object.keys(ViewLife).sort(), ['BACKOFF_MS', 'KEEP', 'MAX_LOSSES', 'MAX_RENDER_ERRORS', 'RESTORE_WAIT_MS', 'STABLE_MS', 'create']);
  assert.equal(RESTORE_WAIT_MS, 3000);
  assert.equal(STABLE_MS, 30000);
  assert.equal(BACKOFF_MS.length, 3);
});
