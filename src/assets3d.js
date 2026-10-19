/* Lane Four 3D assets: the procedural pieces the 3D world is made of. Texture painters
   (each draws on a 2D canvas context), the glyph atlas, the LED board face, a vertex-colour
   mesh builder and the fixed geometries (sky, stars, chevron, hurdle, floodlight head).
   Attaches LaneFour.Assets3D; world3d.js is the only user. Nothing here touches the
   DOM itself (painters take a context), and THREE is always passed in. */
(function (root) {
  'use strict';
  const LF = root.LaneFour;
  if (!LF || !LF.clamp) throw new Error('assets3d.js needs core.js loaded first');
  const { clamp } = LF;

  const FONT_DISPLAY = '"Big Shoulders Display", "Arial Narrow", sans-serif';
  const FONT_LED = '"Doto", ui-monospace, Menlo, monospace';
  const AMBER = '#ffb22e';
  const ATLAS = Object.freeze({ w: 1024, h: 256, cell: 128 });

  function seeded(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  const rgb = (T, hex) => { const c = new T.Color(hex); return [c.r, c.g, c.b]; };

  // Collects quads and boxes into one indexed BufferGeometry. A quad is four [x, y, z]
  // corners going round plus the direction it must face, so the winding is always right.
  // Box faces carry a fixed shade in their colour; the face seen from behind (-X) keeps
  // the exact hex, so hurdles read true from the chase camera.
  class Mesher {
    constructor(color, uv) {
      this.color = color;
      this.uv = uv;
      this.p = [];
      this.c = [];
      this.t = [];
      this.i = [];
    }
    quad(a, b, c, d, hint, col, uvs) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const dot = (uy * vz - uz * vy) * hint[0] + (uz * vx - ux * vz) * hint[1] + (ux * vy - uy * vx) * hint[2];
      const n = this.p.length / 3;
      this.p.push(...a, ...b, ...c, ...d);
      for (let k = 0; k < 4; k++) {
        if (this.color) this.c.push(col[0], col[1], col[2]);
        if (this.uv) this.t.push(uvs[k][0], uvs[k][1]);
      }
      if (dot >= 0) this.i.push(n, n + 1, n + 2, n, n + 2, n + 3);
      else this.i.push(n, n + 2, n + 1, n, n + 3, n + 2);
    }
    box(cx, cy, cz, sx, sy, sz, col) {
      const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
      const f = (a, b, c, d, n, k) => this.quad(a, b, c, d, n, [col[0] * k, col[1] * k, col[2] * k]);
      f([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0], 1);
      f([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], 0.75);
      f([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], 1);
      f([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], 0.6);
      f([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], 0.82);
      f([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], 0.82);
    }
    geometry(T) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
      if (this.color) g.setAttribute('color', new T.Float32BufferAttribute(this.c, 3));
      if (this.uv) g.setAttribute('uv', new T.Float32BufferAttribute(this.t, 2));
      g.setIndex(this.i);
      return g;
    }
  }

  // ---------------------------------------------------------------- textures
  const painters = {
    track(x) { // 512 across (9.76 m) x 128 along (4 m)
      x.fillStyle = '#c4472d';
      x.fillRect(0, 0, 512, 128);
      const rnd = seeded(3);
      for (let i = 0; i < 3600; i++) {
        x.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,.10)' : 'rgba(255,220,200,.07)';
        x.fillRect(rnd() * 512, rnd() * 128, 1 + rnd() * 1.5, 1);
      }
      x.fillStyle = '#d9dde6'; // 25 cm kerb
      x.fillRect(0, 0, 13, 128);
      x.fillStyle = '#f4f1e8'; // 6 cm lane lines every 1.22 m = 64 px
      for (let j = 1; j <= 8; j++) x.fillRect(Math.min(j * 64 - 1.6, 512 - 3.2), 0, 3.2, 128);
    },
    grass(x) { // 64 across x 256 along (8 m): one plain band, one darker
      x.fillStyle = '#235a30';
      x.fillRect(0, 0, 64, 256);
      x.fillStyle = 'rgba(0,0,0,.09)';
      x.fillRect(0, 128, 64, 128);
    },
    crowd(x) { // 512 x 256 per 24 m; row 0 is the top of the stand
      x.fillStyle = '#0c1631';
      x.fillRect(0, 0, 512, 256);
      const rnd = seeded(5);
      const cols = ['201,107,90', '90,123,201', '217,212,197', '201,163,90', '108,143,106', '160,120,190'];
      for (let y = 18; y < 248; y += 14) {
        x.fillStyle = 'rgba(30,44,88,.9)';
        x.fillRect(0, y + 9, 512, 1);
        for (let px = 2; px < 508; px += 6 + rnd() * 4) {
          if (rnd() < 0.18) continue;
          x.fillStyle = 'rgba(' + cols[Math.floor(rnd() * cols.length)] + ',' + (0.35 + rnd() * 0.4).toFixed(2) + ')';
          x.fillRect(px, y + rnd() * 2, rnd() < 0.5 ? 3 : 4, 3);
        }
      }
    },
    boards(x) { // 256 x 64 = 6 m x 1 m, two panels
      x.fillStyle = '#121d42';
      x.fillRect(0, 0, 256, 64);
      for (let p = 0; p < 2; p++) {
        x.fillStyle = '#0a1230';
        x.fillRect(p * 128, 0, 3, 64);
        x.fillStyle = 'rgba(244,241,232,.14)';
        x.fillRect(p * 128 + 18, 26, 60 + p * 12, 12);
      }
    },
    glow(x) { // greyscale for additive blending, so no alpha is involved
      const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
      g.addColorStop(0, '#fff');
      g.addColorStop(0.3, '#6b6b6b');
      g.addColorStop(1, '#000');
      x.fillStyle = g;
      x.fillRect(0, 0, 128, 128);
    },
  };

  // Glyph atlas: row 0 holds the lane digits and SQUAT, row 1 the 50 m labels. It is
  // greyscale (grey level = alpha, used as an alphaMap); colour comes from vertex colours.
  const ITEMS = [];
  for (let k = 1; k <= 8; k++) ITEMS.push({ key: 'd' + k, text: String(k), row: 0, font: 104, grey: 191 });
  ITEMS.push({ key: 'sq', text: 'SQUAT', row: 0, font: 100, grey: 217, fixedW: 290 });
  for (let m = 50; m <= 350; m += 50) ITEMS.push({ key: 'm' + m, text: String(m), row: 1, font: 84, grey: 102 });

  // Lays the items out in two 128 px rows and paints them; returns key -> pixel rect.
  // Run again when the display font arrives: the glyph widths, so the rects, change.
  function bakeAtlas(g) {
    const rects = {};
    g.fillStyle = '#000';
    g.fillRect(0, 0, ATLAS.w, ATLAS.h);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    for (let row = 0; row < 2; row++) {
      const its = ITEMS.filter((it) => it.row === row);
      const widths = its.map((it) => { g.font = '900 ' + it.font + 'px ' + FONT_DISPLAY; return g.measureText(it.text).width; });
      const cells = its.map((it, i) => it.fixedW || widths[i] + 16);
      const k = Math.min(1, ATLAS.w / cells.reduce((s, w) => s + w, 0));
      let x = 0;
      its.forEach((it, i) => {
        const cw = cells[i] * k;
        g.save();
        g.font = '900 ' + it.font + 'px ' + FONT_DISPLAY;
        const m = g.measureText(it.text);
        const asc = m.actualBoundingBoxAscent || it.font * 0.72;
        const desc = m.actualBoundingBoxDescent || 0;
        g.translate(x + cw / 2, row * ATLAS.cell + ATLAS.cell / 2 + (asc - desc) / 2);
        g.scale(Math.min(1, (cw - 10) / widths[i]), 1);
        g.fillStyle = 'rgb(' + it.grey + ',' + it.grey + ',' + it.grey + ')';
        g.fillText(it.text, 0, 0);
        g.restore();
        rects[it.key] = { x, y: row * ATLAS.cell, w: cw, h: ATLAS.cell };
        x += cw;
      });
    }
    return rects;
  }

  function drawLed(g, str) { // the 512 x 128 finish board face
    g.fillStyle = '#070b17';
    g.fillRect(0, 0, 512, 128);
    g.strokeStyle = '#1f2b4d';
    g.lineWidth = 6;
    g.strokeRect(3, 3, 506, 122);
    g.fillStyle = AMBER;
    g.font = '900 80px ' + FONT_LED;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(str, 256, 68);
  }

  // --------------------------------------------------------------- geometry
  const basis = (T, g, x, y, z) => g.applyMatrix4(new T.Matrix4().makeBasis(x, y, z));
  const V = (T, x, y, z) => new T.Vector3(x, y, z);

  const geo = {
    // Inverted sphere with a vertical gradient: zenith #050b20, #13244c at 35 deg, horizon #1b2f5c.
    skyDome(T) {
      const g = new T.SphereGeometry(100, 24, 8);
      const pos = g.attributes.position, cols = new Float32Array(pos.count * 3);
      const zen = new T.Color('#050b20'), mid = new T.Color('#13244c'), hor = new T.Color('#1b2f5c'), c = new T.Color();
      for (let i = 0; i < pos.count; i++) {
        const e = (Math.asin(clamp(pos.getY(i) / 100, -1, 1)) * 180) / Math.PI;
        if (e <= 35) c.copy(hor).lerp(mid, clamp(e / 35, 0, 1));
        else c.copy(mid).lerp(zen, clamp((e - 35) / 55, 0, 1));
        cols.set([c.r, c.g, c.b], i * 3);
      }
      g.setAttribute('color', new T.BufferAttribute(cols, 3));
      return g;
    },
    // 150 seeded stars in the forward half of the sky (the camera never turns).
    skyStars(T) {
      const g = new T.BufferGeometry();
      const rnd = seeded(11), p = new Float32Array(450), c = new Float32Array(450), base = new T.Color('#e8eeff');
      for (let i = 0; i < 150; i++) {
        const az = (rnd() - 0.5) * 2.8, el = 0.14 + rnd() * 1.17, b = 0.2 + rnd() * 0.55;
        p.set([95 * Math.cos(el) * Math.cos(az), 95 * Math.sin(el), 95 * Math.cos(el) * Math.sin(az)], i * 3);
        c.set([base.r * b, base.g * b, base.b * b], i * 3);
      }
      g.setAttribute('position', new T.BufferAttribute(p, 3));
      g.setAttribute('color', new T.BufferAttribute(c, 3));
      return g;
    },
    // Take-off chevron, 1.2 m wide and 0.6 m deep, apex toward +X, lying flat (drawn as (Z, X)).
    chevron(T) {
      const s = new T.Shape();
      s.moveTo(0, 0.3).lineTo(0.6, -0.12).lineTo(0.6, -0.3).lineTo(0, 0.12).lineTo(-0.6, -0.3).lineTo(-0.6, -0.12).closePath();
      return basis(T, new T.ShapeGeometry(s), V(T, 0, 0, 1), V(T, 1, 0, 0), V(T, 0, 1, 0));
    },
    // Hurdle with its origin at the front of the base: L-shaped legs (post at x 0, foot 0.7 m back),
    // a 1.2 x 0.18 m board on the camera side of the posts, striped. +Z is the near, bright leg.
    hurdle(T) {
      const m = new Mesher(true, false), near = rgb(T, '#e6e9f0'), far = rgb(T, '#9aa2b4'), white = rgb(T, '#f4f1e8'), ink = rgb(T, '#10131c');
      for (const [z, c] of [[0.56, near], [-0.56, far]]) {
        m.box(-0.025, 0.442, z, 0.05, 0.884, 0.05, c);
        m.box(-0.35, 0.025, z, 0.7, 0.05, 0.05, c);
      }
      m.box(-0.07, 0.824, 0, 0.04, 0.18, 1.2, white); // y 0.734 .. 0.914
      for (const z of [-0.45, -0.15, 0.15, 0.45]) m.box(-0.07, 0.824, z, 0.044, 0.179, 0.15, ink);
      return m.geometry(T);
    },
    // Ten-point star (r 0.2, inner 0.09) in the YZ plane, upright, facing the camera (-X).
    star(T) {
      const s = new T.Shape();
      for (let i = 0; i < 10; i++) {
        const a = Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.09 : 0.2;
        if (i) s.lineTo(Math.cos(a) * r, Math.sin(a) * r); else s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      return basis(T, new T.ShapeGeometry(s), V(T, 0, 0, 1), V(T, 0, 1, 0), V(T, -1, 0, 0));
    },
    // A square glow plane facing the camera (-X).
    glowPlane(T, size) { return basis(T, new T.PlaneGeometry(size, size), V(T, 0, 0, 1), V(T, 0, 1, 0), V(T, -1, 0, 0)); },
    // Floodlight head centred on the pole top: #141f3f box with a 6 x 2 grid of lamps on its +Z face.
    head(T) {
      const m = new Mesher(true, false), lamp = rgb(T, '#fff6dc');
      m.box(0, 0, 0, 3.4, 1.5, 0.7, rgb(T, '#141f3f'));
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 2; j++) {
          const cx = -1.4 + i * 0.56, cy = -0.35 + j * 0.7;
          m.quad([cx - 0.22, cy - 0.2, 0.36], [cx + 0.22, cy - 0.2, 0.36], [cx + 0.22, cy + 0.2, 0.36], [cx - 0.22, cy + 0.2, 0.36], [0, 0, 1], lamp);
        }
      }
      return m.geometry(T);
    },
  };

  Object.assign(LF, { Assets3D: { FONT_DISPLAY, FONT_LED, AMBER, ATLAS, seeded, rgb, Mesher, painters, bakeAtlas, drawLed, geo } });
})(typeof window !== 'undefined' ? window : globalThis);
