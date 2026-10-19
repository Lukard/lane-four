// Inlines the stylesheet and scripts into one self-contained page:
// docs/index.html, which GitHub Pages serves from the /docs folder.
// `node build.js` writes the file; `require('./build.js').build()` only returns the HTML.
'use strict';
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');

// Marker in src/page.html -> source file inlined in its place.
const PARTS = {
  STYLE: 'style.css',
  CORE: 'core.js',
  GEOM: 'geom.js',
  ASSETS3D: 'assets3d.js',
  WORLD3D: 'world3d.js',
  ACTORS3D: 'actors3d.js',
  SCENE3D: 'scene3d.js',
  APP: 'app.js',
};

// three.js is loaded from a CDN at run time, pinned to one exact version that
// lives only in package.json (devDependencies.three).
function threeVersion(pkg) {
  const v = pkg && pkg.devDependencies && pkg.devDependencies.three;
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error('devDependencies.three must be an exact x.y.z version, got ' + JSON.stringify(v));
  }
  return v;
}

function build() {
  const template = src('page.html');
  const content = {};
  for (const [key, file] of Object.entries(PARTS)) {
    const marker = '/*' + key + '*/';
    if (!template.includes(marker)) throw new Error('Missing marker ' + marker);
    content[key] = src(file);
    if (content[key].includes('</script')) throw new Error(file + ' contains </script>');
  }
  const version = threeVersion(JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')));
  // One pass over the template, so inlined code is never scanned for markers.
  const re = new RegExp('/\\*(' + Object.keys(PARTS).join('|') + ')\\*/', 'g');
  return template.replace(re, (m, key) => content[key]).split('__THREE_VERSION__').join(version);
}

module.exports = { build, threeVersion };

if (require.main === module) {
  const html = build();
  const outDir = path.join(__dirname, 'docs');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'index.html');
  fs.writeFileSync(out, html);
  console.log('Wrote ' + path.relative(process.cwd(), out) + ' (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
}
