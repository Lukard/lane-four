// Inlines the stylesheet and scripts into one self-contained page:
// docs/index.html, which GitHub Pages serves from the /docs folder.
'use strict';
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');

let html = src('page.html');
const parts = { '/*STYLE*/': src('style.css'), '/*CORE*/': src('core.js'), '/*APP*/': src('app.js') };
for (const [marker, content] of Object.entries(parts)) {
  if (!html.includes(marker)) throw new Error('Missing marker ' + marker);
  if (content.includes('</script')) throw new Error('Inline content contains </script>');
  html = html.split(marker).join(content);
}
const outDir = path.join(__dirname, 'docs');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'index.html');
fs.writeFileSync(out, html);
console.log('Wrote ' + path.relative(process.cwd(), out) + ' (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
