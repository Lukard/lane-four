'use strict';
// Geometry and texture-layout checks for the 3D world's procedural assets. They load three
// from node_modules (npm install) and skip when it is missing. No WebGL or DOM needed.
const test = require('node:test');
const assert = require('node:assert/strict');

const threeP = import('three').catch(() => null);
// Wraps a test body: resolves three first, and skips the test when it is not installed.
const withThree = (fn) => async (t) => {
  const THREE = await threeP;
  if (!THREE) return t.skip('three is not installed (npm install)');
  return fn(THREE);
};

require('../src/core.js');
require('../src/geom.js');
require('../src/assets3d.js');
require('../src/world3d.js');
const LF = globalThis.LaneFour;
const { Mesher, geo, bakeAtlas, rgb, ATLAS } = LF.Assets3D;

const bbox = (g) => { g.computeBoundingBox(); return g.boundingBox; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Face normals computed from the index, so winding errors show up.
function faceNormals(THREE, g) {
  const p = g.attributes.position, idx = g.index.array, out = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < idx.length; i += 3) {
    a.fromBufferAttribute(p, idx[i]);
    b.fromBufferAttribute(p, idx[i + 1]);
    c.fromBufferAttribute(p, idx[i + 2]);
    out.push(b.clone().sub(a).cross(c.clone().sub(a)).normalize());
  }
  return out;
}

test('World3D attaches build() and refuses to start without a race', withThree((THREE) => {
  assert.equal(typeof LF.World3D.build, 'function');
  assert.throws(() => LF.World3D.build(THREE, {}), /needs opts.race/);
}));

test('Mesher.quad winds to face the requested direction whatever the corner order', withThree((THREE) => {
  const corners = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]];
  for (const hint of [[0, 1, 0], [0, -1, 0]]) {
    for (const order of [corners, [...corners].reverse()]) {
      const m = new Mesher(false, false);
      m.quad(order[0], order[1], order[2], order[3], hint);
      const ns = faceNormals(THREE, m.geometry(THREE));
      assert.equal(ns.length, 2);
      for (const n of ns) assert.ok(n.y * hint[1] > 0.999, 'normal ' + n.toArray() + ' for hint ' + hint);
    }
  }
}));

test('Mesher.box has 12 triangles, outward faces, and -X keeps the exact colour', withThree((THREE) => {
  const m = new Mesher(true, false), white = rgb(THREE, '#f4f1e8');
  m.box(0, 0, 0, 2, 4, 6, white);
  const g = m.geometry(THREE);
  assert.equal(g.index.count / 3, 12);
  assert.equal(g.attributes.position.count, 24);
  const ns = faceNormals(THREE, g), p = g.attributes.position, idx = g.index.array;
  ns.forEach((n, f) => { // a point on the face, relative to the centre, points the same way as the normal
    const v = new THREE.Vector3().fromBufferAttribute(p, idx[f * 3]);
    assert.ok(v.dot(n) > 0, 'face ' + f + ' faces outward');
  });
  const col = g.attributes.color;
  ns.forEach((n, f) => { // per face: -X is the exact colour, +X is shaded to 75%
    const k = n.x < -0.99 ? 1 : n.x > 0.99 ? 0.75 : null;
    if (k === null) return;
    for (let j = 0; j < 3; j++) assert.ok(near(col.getX(idx[f * 3 + j]), white[0] * k), 'face ' + f + ' shade');
  });
}));

test('hurdle geometry: origin at the front of the base, foot 0.7 m back, board y 0.734 to 0.914, 1.2 m wide', withThree((THREE) => {
  const g = geo.hurdle(THREE), b = bbox(g);
  assert.ok(near(b.min.x, -0.7) && near(b.max.x, 0), 'x ' + b.min.x + '..' + b.max.x);
  assert.ok(near(b.max.y, 0.914) && near(b.min.y, 0), 'y ' + b.min.y + '..' + b.max.y);
  assert.ok(near(b.min.z, -0.6) && near(b.max.z, 0.6), 'z ' + b.min.z + '..' + b.max.z);
  // the near (+Z) leg is the bright #e6e9f0, the far one #9aa2b4: compare the lowest vertex on each side
  const p = g.attributes.position, c = g.attributes.color;
  const lum = (z) => { for (let i = 0; i < p.count; i++) if (near(p.getZ(i), z, 0.03) && near(p.getY(i), 0.884, 1e-6) && near(p.getX(i), -0.05)) return c.getX(i); return null; };
  assert.ok(lum(0.585) > lum(-0.535), 'near leg is brighter than the far leg');
}));

test('chevron lies flat facing up, 1.2 m across (Z) and 0.6 m deep (X)', withThree((THREE) => {
  const g = geo.chevron(THREE), b = bbox(g);
  assert.ok(near(b.max.z - b.min.z, 1.2) && near(b.max.x - b.min.x, 0.6), b.min.toArray() + ' ' + b.max.toArray());
  assert.ok(near(b.min.y, 0) && near(b.max.y, 0));
  assert.ok(b.max.x > 0.25, 'the apex points down the track (+X)');
  for (const n of faceNormals(THREE, g)) assert.ok(n.y > 0.999);
}));

test('star is upright in the YZ plane and faces the camera (-X)', withThree((THREE) => {
  const g = geo.star(THREE), b = bbox(g);
  assert.ok(near(b.min.x, 0) && near(b.max.x, 0));
  assert.ok(near(b.max.y, 0.2) && near(b.max.z, 0.2 * Math.sin((2 * Math.PI) / 5), 1e-6));
  const p = g.attributes.position;
  let top = null;
  for (let i = 0; i < p.count; i++) if (near(p.getY(i), 0.2)) top = p.getZ(i);
  assert.ok(near(top, 0), 'a point at the top, centred');
  for (const n of faceNormals(THREE, g)) assert.ok(n.x < -0.999);
  assert.ok(near(bbox(geo.glowPlane(THREE, 1.04)).max.y, 0.52));
  for (const n of faceNormals(THREE, geo.glowPlane(THREE, 1))) assert.ok(n.x < -0.999);
}));

test('sky dome is #1b2f5c at and below the horizon and #050b20 at the zenith', withThree((THREE) => {
  const g = geo.skyDome(THREE), p = g.attributes.position, c = g.attributes.color;
  const want = (hex) => rgb(THREE, hex);
  let horizon = 0, zenith = 0;
  for (let i = 0; i < p.count; i++) {
    const col = [c.getX(i), c.getY(i), c.getZ(i)];
    const eq = (w) => w.every((v, k) => near(v, col[k], 1e-5));
    if (p.getY(i) < 1e-6) { assert.ok(eq(want('#1b2f5c')), 'horizon and below'); horizon++; }
    if (p.getY(i) > 99.9) { assert.ok(eq(want('#050b20')), 'zenith'); zenith++; }
  }
  assert.ok(horizon > 24 && zenith >= 1);
  assert.equal(geo.skyStars(THREE).attributes.position.count, 150);
}));

// A canvas context stand-in: text is `k` em per character, so wide and narrow fonts can be tried.
function fakeCtx(k) {
  const ctx = {
    font: '', calls: [], tf: [],
    fillRect() {}, save() {}, restore() {}, translate() {}, scale() {},
    measureText(t) { const px = parseFloat(this.font.split('px')[0].split(' ').pop()); return { width: t.length * px * k, actualBoundingBoxAscent: px * 0.72, actualBoundingBoxDescent: 0 }; },
    fillText(t) { this.calls.push(t); },
  };
  return ctx;
}

test('glyph atlas: every item gets a rect inside 1024 x 256, rows do not overlap, for narrow and wide fonts', () => {
  for (const k of [0.42, 0.55, 0.7]) {
    const ctx = fakeCtx(k);
    const rects = bakeAtlas(ctx);
    const keys = Object.keys(rects);
    assert.equal(keys.length, 8 + 1 + 7);
    assert.deepEqual(ctx.calls.sort(), ['1', '100', '150', '2', '200', '250', '3', '300', '350', '4', '5', '50', '6', '7', '8', 'SQUAT'].sort());
    for (const key of keys) {
      const r = rects[key];
      assert.ok(r.x >= 0 && r.x + r.w <= ATLAS.w + 1e-9 && r.y >= 0 && r.y + r.h <= ATLAS.h, key + ' fits (k=' + k + ')');
    }
    for (const a of keys) {
      for (const b of keys) {
        if (a >= b) continue;
        const A = rects[a], B = rects[b];
        const overlap = A.x < B.x + B.w - 1e-9 && B.x < A.x + A.w - 1e-9 && A.y < B.y + B.h && B.y < A.y + A.h;
        assert.ok(!overlap, a + ' overlaps ' + b + ' (k=' + k + ')');
      }
    }
    assert.ok(rects.sq.w > 150, 'SQUAT keeps a wide cell');
  }
});
