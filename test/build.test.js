'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'index.html');
const docsBefore = fs.existsSync(DOCS) ? fs.statSync(DOCS).mtimeMs : null;
const { build, threeVersion } = require('../build.js');
const html = build();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.devDependencies.three;

const SOURCES = ['style.css', 'core.js', 'geom.js', 'assets3d.js', 'world3d.js', 'scene3d.js', 'app.js', 'page.html'];

test('build() returns the page and does not write docs/index.html', () => {
  assert.equal(typeof html, 'string');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.equal(build(), html, 'deterministic');
  const after = fs.existsSync(DOCS) ? fs.statSync(DOCS).mtimeMs : null;
  assert.equal(after, docsBefore);
});

test('no marker and no version placeholder is left in the built page', () => {
  for (const m of ['STYLE', 'CORE', 'GEOM', 'ASSETS3D', 'WORLD3D', 'SCENE3D', 'APP']) {
    assert.ok(!html.includes('/*' + m + '*/'), 'leftover /*' + m + '*/');
  }
  assert.ok(!html.includes('__THREE_VERSION__'));
  assert.ok(html.includes('three@' + VERSION + '/build/three.core.js'));
});

test('no source file can close its inline script early', () => {
  for (const f of SOURCES) {
    const text = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    if (f === 'page.html') continue; // the template legitimately has </script> closers
    assert.ok(!text.includes('</script'), f + ' contains </script');
  }
  const opens = html.match(/<script\b/g).length;
  const closes = html.match(/<\/script>/g).length;
  assert.equal(opens, closes);
  assert.equal(opens, 7, 'import map, core, geom, assets3d, world3d, scene3d, app');
});

test('scripts are inlined in order between the import map and the end of the body', () => {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], body: m[2] }));
  assert.equal(blocks[0].attrs.trim(), 'type="importmap"');
  const marks = ['Lane Four core:', 'Lane Four geometry:', 'Lane Four 3D assets:', 'Lane Four 3D world:', 'Lane Four 3D scene:', 'Lane Four app:'];
  marks.forEach((mark, i) => {
    assert.ok(blocks[i + 1].body.includes(mark), 'script ' + (i + 1) + ' should be ' + mark);
    assert.equal(blocks[i + 1].attrs.trim(), '');
  });
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('<style>'), 'import map comes before the style');
});

test('every inline script parses and the import map is valid JSON', () => {
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (m[1].includes('importmap')) JSON.parse(m[2]);
    else new vm.Script(m[2]);
  }
});

test('the import map points both CDN hosts at the minified core, for the pinned version', () => {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  const map = JSON.parse(m[1]).imports;
  const jsd = 'https://cdn.jsdelivr.net/npm/three@' + VERSION + '/build/';
  const cdnjs = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/' + VERSION + '/';
  assert.deepStrictEqual(map, {
    [jsd + 'three.core.js']: jsd + 'three.core.min.js',
    [cdnjs + 'three.core.js']: cdnjs + 'three.core.min.js',
  });
  // Once the loader exists in app.js, its module URLs must resolve their
  // ./three.core.js import to exactly these keys.
  const loader = html.match(/THREE_URLS\s*=\s*\[([^\]]*)\]/);
  if (loader) {
    const urls = [...loader[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    assert.ok(urls.length >= 2);
    for (const u of urls) {
      assert.ok(u.endsWith('/three.module.min.js'), u);
      assert.ok(Object.prototype.hasOwnProperty.call(map, u.replace(/three\.module\.min\.js$/, 'three.core.js')), u);
    }
  }
});

test('three is pinned to one exact version', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(threeVersion(pkg), VERSION);
  for (const bad of ['^0.186.0', '~0.186.0', '0.186', '>=0.186.0', 'latest', '0.186.0-beta.1', '', undefined, 186]) {
    assert.throws(() => threeVersion({ devDependencies: { three: bad } }), /exact/, String(bad));
  }
  assert.throws(() => threeVersion({}), /exact/);
  assert.throws(() => threeVersion(null), /exact/);
  const installed = path.join(ROOT, 'node_modules', 'three', 'package.json');
  if (fs.existsSync(installed)) {
    assert.equal(JSON.parse(fs.readFileSync(installed, 'utf8')).version, VERSION, 'node_modules/three has drifted from package.json');
  }
});

test('the 3D chrome is in the page but hidden until the app unhides it', () => {
  assert.match(html, /<canvas id="world3d"[^>]*\bhidden\b/);
  assert.match(html, /<div id="popLayer" aria-hidden="true"><\/div>/);
  assert.match(html, /<div id="toast" role="status" hidden><\/div>/);
  assert.match(html, /<button class="chip" id="btnView"[^>]*\bhidden\b[^>]*>3D<\/button>/);
  assert.match(html, /<div class="pick" role="radiogroup" aria-label="View" hidden>/);
  assert.ok(html.indexOf('id="btnView"') < html.indexOf('id="btnSignals"'), 'btnView is the first hud button');
  assert.ok(html.indexOf('id="world"') < html.indexOf('id="world3d"') && html.indexOf('id="world3d"') < html.indexOf('id="popLayer"') && html.indexOf('id="popLayer"') < html.indexOf('id="hud"'));
});
