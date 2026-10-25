'use strict';
// Shared by the ViewLife tests (not a test itself): a fake world with a clock, timers, a loader and a scene factory.
require('../src/viewlife.js');
const { ViewLife } = globalThis.LaneFour;

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

module.exports = { world, flush };
