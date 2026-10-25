'use strict';
// LaneFour.ViewLife over random sequences of events (losses, restores, hidden tab, quality reports, failures): the
// invariants of the view hold whatever the order.
const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/viewlife.js');
const { world, flush } = require('./viewworld.js');
const { BACKOFF_MS, KEEP } = globalThis.LaneFour.ViewLife;

test('invariants hold over 400 random sequences of 40 events each', async () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let run = 0; run < 400; run++) {
    const w = world({ classic: false });
    let reducedSeen = false;
    w.createFails = rnd() < 0.3 ? Math.floor(rnd() * 5) : 0;
    if (rnd() < 0.05) w.loadError = new Error('Could not load three.js');
    w.vm.start();
    await flush();
    for (let step = 0; step < 40; step++) {
      const op = pick(['lost', 'lostv', 'restored', 'blank', 'tick', 'tick', 'visible', 'hide', 'show', 'reveal', 'drawn', 'slow', 'lowest', 'unplayable', 'rerr', 'fail', 'long']);
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
      else if (op === 'slow' && hooks) hooks.hooks.onQuality({ kind: 'tier', from: 0, tier: 1, lowest: false, reason: 'slow' });
      else if (op === 'lowest' && hooks) { if (hooks === w.view.scene) reducedSeen = true; hooks.hooks.onQuality({ kind: 'tier', from: 1, tier: 3, lowest: true, emergency: true, reason: 'emergency' }); }
      else if (op === 'unplayable' && hooks) hooks.hooks.onQuality({ kind: 'unplayable', tier: 3, reason: 'unplayable' });
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
      assert.ok(!v.reduced || reducedSeen, tag + ': reduced only after a live scene reported the lowest tier');
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
