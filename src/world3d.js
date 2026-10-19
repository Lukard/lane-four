/* Lane Four 3D world: the static stadium, built once from a THREE namespace passed in.
   Unlit MeshBasicMaterial only (no lights, no addons, no imports). Attaches LaneFour.World3D.
   Needs core.js, geom.js and assets3d.js loaded first, and a DOM (textures are canvases).

   const world = LaneFour.World3D.build(THREE, { race, tier, reduceMotion, anisotropy })
     race          LaneFour.Race (distance and hurdles drive the geometry; at most 24 hurdles)
     tier          0..3, an index into LaneFour.Geom.TIERS (default 0)
     reduceMotion  boolean; update(ctx) re-reads ctx.reduceMotion every frame
     anisotropy    renderer.capabilities.getMaxAnisotropy(); textures use min(4, it)

   world.root      THREE.Group. Add it to the scene once. Race space: X = race x, Y = up,
                   Z = minus race z (infield on -Z, lane k centre at Z = (k - 4) * 1.22).
                   Static: root and its meshes never move. The chevron sets stay hidden until
                   the first update(), so call update() once before renderer.compile().
   world.sky       THREE.Group inside root: sky dome plus star points. update() copies the
                   camera position onto it. Do not add it to the scene again.
   world.update(ctx)  once per frame, ctx = { race, t, dt, camera, reduceMotion, phase }
                   (t seconds, dt clamped seconds, camera a PerspectiveCamera of which only the
                   position is read, phase the app phase: SQUAT cues hide when 'finished').
                   Creates no objects, arrays or closures per call (sampled at about 5 bytes per
                   call of V8 number boxing, 0.6 us on a desktop). Calls setRace() itself when
                   ctx.race is a new object, and snaps its caches and the cheer flash when race x
                   drops by more than 1 m.
   world.setRace(race)  rebuilds only what depends on distance or hurdles (ground, stands,
                   boards, paint, labels, gantry, LED board, floodlights, instance counts) and
                   disposes the old BufferGeometry. Textures and materials persist.
   world.setTier(n)  hides the sky stars and every additive glow (star glow, floodlight glow)
                   at T2+, and scales the sky dome to 0.85 * tier.far so a short far plane
                   never clips it. Returns the tier. The scene still sets camera.far and
                   scene.fog from tier.far, tier.fogNear and tier.fogFar.
   world.cheer(kind)  'clear' flashes the stands to 0.6, 'star' and 'finish' to 1.0 (never
                   lowers a stronger flash); other kinds are ignored. Decays with tau 0.5 s.
   world.rebake()  redraws the glyph atlas and LED board; runs by itself when the fonts load.
   world.glowTexture  opaque greyscale radial gradient for additive blending, shared so the
                   runner's charge glow needs no texture of its own.
   world.stats()   { drawCalls, triangles, geometries, textures, textureMB, tier } of what is visible.
   world.dispose() frees geometry, materials and textures and removes root from its parent.

   Fog: the scene sets THREE.Fog(0x1b2f5c, near, far); sky and glows opt out (fog: false).
   Colour: textures are SRGBColorSpace (the glyph atlas is a linear alpha map) and vertex colours
   come from new THREE.Color(hex), so hex values match the HUD and the 2D renderer. */
(function (root) {
  'use strict';
  const LF = root.LaneFour;
  if (!LF || !LF.Geom || !LF.Assets3D) throw new Error('world3d.js needs core.js, geom.js and assets3d.js loaded first');
  const { clamp } = LF;
  const { laneZ, tipAngle, farScale, TIERS } = LF.Geom;
  const A = LF.Assets3D;
  const { Mesher, AMBER, ATLAS } = A;

  const X0 = -14; // the ground starts this far behind the start line
  const END = 100; // ... and runs this far past the finish, which the far fog hides
  const ZA = -4.27; // inside kerb (three Z)
  const ZB = 5.49; // outside edge of lane 8
  const STRETCH = 1.6; // ground decals are 1.6x longer along X so they read at a shallow pitch
  const MPP_DIGIT = 0.0083; // natural metres per atlas pixel: a lane digit is about 0.6 m tall
  const MPP_LABEL = 0.0056; // a 50 m label about 0.33 m tall
  const MAX_HURDLES = 24; // chevron change detection packs hurdle states into one 24-bit mask

  function build(THREE, opts) {
    const T = THREE;
    const o = opts || {};
    let race = o.race;
    if (!race || !race.hurdles) throw new Error('World3D.build needs opts.race');
    const aniso = clamp(o.anisotropy || 1, 1, 4);
    let reduce = !!o.reduceMotion;
    let tier = TIERS[clamp(o.tier | 0, 0, TIERS.length - 1)];
    let disposed = false;
    const rgb = (hex) => A.rgb(T, hex);

    // ---- textures
    const texList = [];
    function makeTex(w, h, draw, linear) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      draw(c.getContext('2d'));
      const t = new T.CanvasTexture(c);
      if (!linear) t.colorSpace = T.SRGBColorSpace;
      texList.push(t);
      return t;
    }
    const tTrack = makeTex(512, 128, A.painters.track);
    tTrack.wrapT = T.RepeatWrapping;
    const tGrass = makeTex(64, 256, A.painters.grass);
    tGrass.wrapT = T.RepeatWrapping;
    const tAtlas = makeTex(ATLAS.w, ATLAS.h, () => {}, true);
    const tCrowd = makeTex(512, 256, A.painters.crowd);
    tCrowd.wrapS = T.RepeatWrapping;
    const tBoards = makeTex(256, 64, A.painters.boards);
    tBoards.wrapS = T.RepeatWrapping;
    const tLed = makeTex(512, 128, () => {});
    const tGlow = makeTex(128, 128, A.painters.glow);
    for (const t of [tTrack, tGrass, tAtlas, tCrowd, tBoards]) t.anisotropy = aniso;

    // ---- materials (the track first, so it draws before the grass beneath it)
    const std = (p) => new T.MeshBasicMaterial(p);
    const decal = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
    const glow = { transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false };
    const mTrack = std({ map: tTrack });
    const mGrass = std({ map: tGrass });
    const mPaint = std({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mGlyph = std({ alphaMap: tAtlas, vertexColors: true, ...decal });
    const mChevIdle = std({ color: AMBER, opacity: 0.6, ...decal });
    const mChevAct = std({ color: AMBER, opacity: 0.6, ...decal });
    const mCrowd = std({ map: tCrowd });
    const mBoards = std({ map: tBoards });
    const mPole = std({ color: '#0f1936' });
    const mVert = std({ vertexColors: true }); // gantry, hurdles, floodlight heads
    const mFlood = std({ map: tGlow, color: '#ffecbe', opacity: 0.5, ...glow });
    const mLed = std({ map: tLed });
    const mStar = std({ color: AMBER });
    const mStarGlow = std({ map: tGlow, color: AMBER, opacity: 0.45, ...glow });

    // ---- scene graph: static parts (geometry swapped by setRace) and instanced sets
    const rootG = new T.Group();
    const parts = {};
    const I = {};
    function part(name, mat, order) {
      const m = new T.Mesh(new T.BufferGeometry(), mat);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = order || 0;
      rootG.add(m);
      parts[name] = m;
    }
    function swap(name, geo) {
      const old = parts[name].geometry;
      parts[name].geometry = geo;
      old.dispose();
    }
    function inst(name, geo, mat, n, order) {
      let m = I[name];
      if (m && m.instanceMatrix.count >= n) return m;
      if (m) { rootG.remove(m); m.dispose(); }
      m = I[name] = new T.InstancedMesh(geo, mat, Math.max(n, 12));
      m.instanceMatrix.setUsage(T.DynamicDrawUsage);
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = order || 0;
      m.count = 0;
      m.visible = false;
      rootG.add(m);
      return m;
    }

    // ---- sky: a camera-following group (dome plus stars)
    const skyG = new T.Group();
    rootG.add(skyG);
    const skyMesh = new T.Mesh(A.geo.skyDome(T), std({ vertexColors: true, side: T.BackSide, fog: false, depthWrite: false }));
    skyMesh.renderOrder = -10;
    skyMesh.frustumCulled = false;
    const skyStars = new T.Points(A.geo.skyStars(T), new T.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    skyStars.renderOrder = -9;
    skyStars.frustumCulled = false;
    skyG.add(skyMesh, skyStars);

    // ---- fixed geometry
    const gChevron = A.geo.chevron(T), gHurdle = A.geo.hurdle(T), gStar = A.geo.star(T), gHead = A.geo.head(T);
    const gStarGlow = A.geo.glowPlane(T, 1.04), gFloodGlow = A.geo.glowPlane(T, 16), gPole = new T.BoxGeometry(0.45, 14, 0.45).translate(0, 7, 0);

    // ---- distance dependent geometry
    const groundGeo = (x1, za, zb, y, vlen) => { // u across the track, v = x / vlen
      const m = new Mesher(false, true);
      m.quad([X0, y, za], [X0, y, zb], [x1, y, zb], [x1, y, za], [0, 1, 0], null, [[0, X0 / vlen], [1, X0 / vlen], [1, x1 / vlen], [0, x1 / vlen]]);
      return m.geometry(T);
    };
    // A raked stand (Z 7.6, Y 1.0 up to Z 19, Y 8.5) and a 1 m perimeter board (Z 7.3) on each side.
    const sideGeo = (x1, stand) => {
      const m = new Mesher(false, true), len = stand ? 24 : 6;
      for (const s of [-1, 1]) {
        const a = stand ? [7.6 * s, 1, 19 * s, 8.5] : [7.3 * s, 0, 7.3 * s, 1]; // z0, y0, z1, y1
        m.quad([X0, a[1], a[0]], [x1, a[1], a[0]], [x1, a[3], a[2]], [X0, a[3], a[2]], [0, stand ? 1 : 0, -s],
          null, [[X0 / len, 0], [x1 / len, 0], [x1 / len, 1], [X0 / len, 1]]);
      }
      return m.geometry(T);
    };
    const paintGeo = (r) => {
      const m = new Mesher(true, false);
      const line = rgb('#f4f1e8'), tick = new T.Color('#f4f1e8').lerp(new T.Color('#c4472d'), 0.45), mark = rgb('#3fbf6a');
      const rect = (xa, xb, za, zb, c) => m.quad([xa, 0.005, za], [xa, 0.005, zb], [xb, 0.005, zb], [xb, 0.005, za], [0, 1, 0], c);
      rect(-0.03, 0.03, ZA, ZB, line);
      rect(r.distance - 0.06, r.distance + 0.06, ZA, ZB, line);
      for (let k = 10; k < r.distance; k += 10) rect(k - 0.03, k + 0.03, 0.38, 0.68, [tick.r, tick.g, tick.b]);
      for (const h of r.hurdles) { rect(h.x - 0.06, h.x + 0.06, 0.58, 0.82, mark); rect(h.x - 0.06, h.x + 0.06, -0.82, -0.58, mark); }
      return m.geometry(T);
    };
    const gantryGeo = (d) => { // posts and top rail, 3.05 m tall
      const m = new Mesher(true, false), c = rgb('#d9dde6');
      m.box(d, 1.525, -4.75, 0.16, 3.05, 0.16, c);
      m.box(d, 1.525, 5.95, 0.16, 3.05, 0.16, c);
      m.box(d, 3.025, 0.6, 0.12, 0.05, 10.86, c);
      return m.geometry(T);
    };
    const ledGeo = (d) => { // 3.6 x 0.9 m board, normal -X, hanging from the rail
      const m = new Mesher(false, true), x = d - 0.09;
      m.quad([x, 2.1, -1.2], [x, 2.1, 2.4], [x, 3.0, 2.4], [x, 3.0, -1.2], [-1, 0, 0], null, [[0, 0], [1, 0], [1, 1], [0, 1]]);
      return m.geometry(T);
    };

    // Glyph quads lie on the ground: text-right = +Z, text-up = +X, normal +Y.
    let rects = {};
    let squatCount = 0;
    const glyphQuad = (m, key, xc, zc, wz, hx, c) => {
      const r = rects[key], x0 = xc - hx / 2, x1 = xc + hx / 2, z0 = zc - wz / 2, z1 = zc + wz / 2;
      const u0 = r.x / ATLAS.w, u1 = (r.x + r.w) / ATLAS.w, v0 = 1 - (r.y + r.h) / ATLAS.h, v1 = 1 - r.y / ATLAS.h;
      m.quad([x0, 0.01, z0], [x0, 0.01, z1], [x1, 0.01, z1], [x1, 0.01, z0], [0, 1, 0], c, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]);
    };
    function buildLabels() { // lane numbers at both ends, 50 m labels, SQUAT cues for hurdles 0 and 1
      const r = race, d = r.distance, white = rgb('#f4f1e8');
      const nums = new Mesher(true, true), sq = new Mesher(true, true);
      const dig = (key, xc, zc) => glyphQuad(nums, key, xc, zc, rects[key].w * MPP_DIGIT, ATLAS.cell * MPP_DIGIT * STRETCH, white);
      for (let k = 1; k <= 8; k++) { dig('d' + k, -2.4, laneZ(k)); dig('d' + k, d - 2.4, laneZ(k)); }
      for (let q = 50; q < d; q += 50) {
        const key = 'm' + q;
        if (rects[key]) glyphQuad(nums, key, q + 0.3, 0.22, rects[key].w * MPP_LABEL, ATLAS.cell * MPP_LABEL * STRETCH, white);
      }
      squatCount = Math.min(2, r.hurdles.length);
      for (let i = 0; i < squatCount; i++) glyphQuad(sq, 'sq', r.hurdles[i].x - 6.0, 0, 3.4, 2.4, rgb(AMBER));
      swap('numbers', nums.geometry(T));
      swap('squat', sq.geometry(T));
      squatMask = -1;
    }

    part('track', mTrack);
    part('grass', mGrass);
    part('paint', mPaint);
    part('stands', mCrowd);
    part('boards', mBoards);
    part('gantry', mVert);
    part('led', mLed);
    part('numbers', mGlyph, 1);
    part('squat', mGlyph, 2);

    // ---- per-frame state, preallocated
    const _m = new T.Matrix4();
    const hS = new Float64Array(MAX_HURDLES), hA = new Float64Array(MAX_HURDLES), starLive = new Uint8Array(MAX_HURDLES);
    let chevSig = -1, chevNext = -2, squatMask = -1, ledQ = NaN, ledStr = '0:00.0', flash = 0, lastX = 0;

    function invalidate() { // forget every cached matrix, cue and string; next update redraws all
      hS.fill(NaN);
      hA.fill(NaN);
      starLive.fill(255);
      chevSig = -1;
      squatMask = -1;
      ledQ = NaN;
      flash = 0;
      lastX = race.x;
    }

    function bake() {
      rects = A.bakeAtlas(tAtlas.image.getContext('2d'));
      tAtlas.needsUpdate = true;
    }
    function redrawLed(str) {
      ledStr = str;
      A.drawLed(tLed.image.getContext('2d'), str);
      tLed.needsUpdate = true;
    }

    function setRace(r) {
      const d = r.distance, n = r.hurdles.length;
      if (n > MAX_HURDLES) throw new Error('World3D supports at most ' + MAX_HURDLES + ' hurdles');
      race = r;
      swap('track', groundGeo(d + END, ZA, ZB, 0, 4));
      swap('grass', groundGeo(d + END, -7.3, 7.3, -0.02, 8));
      swap('stands', sideGeo(d + END, true));
      swap('boards', sideGeo(d + END, false));
      swap('paint', paintGeo(r));
      swap('gantry', gantryGeo(d));
      swap('led', ledGeo(d));
      buildLabels();
      redrawLed('0:00.0');
      const hm = inst('hurdle', gHurdle, mVert, n, 3);
      const sm = inst('star', gStar, mStar, n, 4);
      const gm = inst('starGlow', gStarGlow, mStarGlow, n, 6);
      inst('chevIdle', gChevron, mChevIdle, 3 * n, 2);
      inst('chevAct', gChevron, mChevAct, 3, 2);
      for (const m of [hm, sm, gm]) { m.count = n; m.visible = n > 0; }
      gm.visible = n > 0 && tier.glows;
      // floodlights every 60 m on both sides, the heads turned toward the track
      const per = Math.floor((d + END) / 60) + 1, cnt = per * 2;
      const pm = inst('pole', gPole, mPole, cnt, 0), hd = inst('head', gHead, mVert, cnt, 0), fg = inst('flood', gFloodGlow, mFlood, cnt, 7);
      for (let s = 0; s < 2; s++) {
        for (let i = 0; i < per; i++) {
          const x = i * 60, z = s ? 9 : -9, k = s * per + i, f = s ? -1 : 1;
          pm.setMatrixAt(k, _m.set(1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, z, 0, 0, 0, 1));
          hd.setMatrixAt(k, _m.set(f, 0, 0, x, 0, 1, 0, 14.2, 0, 0, f, z, 0, 0, 0, 1));
          fg.setMatrixAt(k, _m.set(1, 0, 0, x, 0, 1, 0, 14.2, 0, 0, 1, z, 0, 0, 0, 1));
        }
      }
      for (const m of [pm, hd, fg]) { m.count = cnt; m.visible = true; m.instanceMatrix.needsUpdate = true; }
      fg.visible = tier.glows;
      invalidate();
    }

    function setTier(n) {
      tier = TIERS[clamp(n | 0, 0, TIERS.length - 1)];
      skyStars.visible = tier.stars;
      skyMesh.scale.setScalar(Math.min(1, (tier.far * 0.85) / 100));
      skyStars.scale.copy(skyMesh.scale);
      if (I.flood) I.flood.visible = tier.glows;
      if (I.starGlow) I.starGlow.visible = tier.glows && race.hurdles.length > 0;
      return tier;
    }

    // ---- per-frame updates: scratch matrix, typed arrays and indexed loops only
    function updateHurdles(r) {
      const hs = r.hurdles, mesh = I.hurdle;
      let dirty = false;
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i];
        const s = h.state === 'up' ? farScale(h.x - r.x) : 1;
        const a = tipAngle(h);
        if (s === hS[i] && a === hA[i]) continue;
        hS[i] = s;
        hA[i] = a;
        const c = Math.cos(a) * s, sn = Math.sin(a) * s; // T(x) * Rz(-a) * S(s): scaled about the base, tipped forward
        mesh.setMatrixAt(i, _m.set(c, sn, 0, h.x, -sn, c, 0, 0, 0, 0, s, 0, 0, 0, 0, 1));
        dirty = true;
      }
      if (dirty) mesh.instanceMatrix.needsUpdate = true;
    }

    function updateStars(r, t, cam) {
      const hs = r.hurdles, ms = I.star, mg = I.starGlow;
      const cx = cam ? cam.position.x : r.x - 6, cy = cam ? cam.position.y : 3.6, cz = cam ? cam.position.z : 0;
      let any = false;
      for (let i = 0; i < hs.length; i++) {
        const h = hs[i];
        if (h.state !== 'up') {
          if (starLive[i] === 0) continue;
          starLive[i] = 0;
          _m.set(0, 0, 0, h.x, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
        } else {
          starLive[i] = 1;
          const y = 2.45 + (reduce ? 0 : Math.sin(3 * t + h.x) * 0.06);
          const dx = h.x - cx, dy = y - cy;
          const sc = clamp(Math.sqrt(dx * dx + dy * dy + cz * cz) / 14, 1, 2.2); // bigger far away, so it stays readable
          const ang = reduce ? 0 : 0.8 * t;
          const c = Math.cos(ang) * sc, s = Math.sin(ang) * sc;
          _m.set(sc, 0, 0, h.x, 0, c, -s, y, 0, s, c, 0, 0, 0, 0, 1);
        }
        ms.setMatrixAt(i, _m);
        mg.setMatrixAt(i, _m);
        any = true;
      }
      if (any) { ms.instanceMatrix.needsUpdate = true; mg.instanceMatrix.needsUpdate = true; }
    }

    function updateChevrons(r, t) {
      const hs = r.hurdles, idle = I.chevIdle, act = I.chevAct;
      let next = -1, mask = 0;
      for (let i = 0; i < hs.length; i++) {
        if (hs[i].state !== 'up') continue;
        mask |= 1 << i;
        if (next < 0 && hs[i].x >= r.x) next = i;
      }
      if (mask !== chevSig || next !== chevNext) { // only when the next hurdle or a hurdle state changed
        chevSig = mask;
        chevNext = next;
        let n = 0;
        for (let i = 0; i < hs.length; i++) {
          if (!(mask & (1 << i)) || i === next) continue;
          for (let k = 0; k < 3; k++) idle.setMatrixAt(n++, _m.set(1, 0, 0, hs[i].x - 3.6 + 0.9 * k, 0, 1, 0, 0.012, 0, 0, 1, 0, 0, 0, 0, 1));
        }
        idle.count = n;
        idle.visible = n > 0;
        idle.instanceMatrix.needsUpdate = true;
        for (let k = 0; k < 3 && next >= 0; k++) act.setMatrixAt(k, _m.set(1, 0, 0, hs[next].x - 3.6 + 0.9 * k, 0, 1, 0, 0.012, 0, 0, 1, 0, 0, 0, 0, 1));
        act.count = next >= 0 ? 3 : 0;
        act.visible = next >= 0;
        act.instanceMatrix.needsUpdate = true;
      }
      if (next >= 0) {
        const d = hs[next].x - r.x;
        mChevAct.opacity = d > 0 && d <= 4.4 && !reduce ? 0.55 + 0.4 * Math.sin(14 * t) : 0.6;
      }
    }

    function updateSquat(r, phase) {
      const hs = r.hurdles;
      let mask = 0;
      if (!r.finished && phase !== 'finished') {
        for (let i = 0; i < squatCount; i++) if (hs[i].state === 'up') mask |= 1 << i;
      }
      if (mask === squatMask) return;
      squatMask = mask;
      const m = parts.squat;
      m.visible = mask !== 0;
      m.geometry.setDrawRange(mask === 2 ? 6 : 0, mask === 3 ? 12 : 6); // quad i is indices 6i .. 6i+5
    }

    function updateLed(r) {
      if (!(r.finished || r.distance - r.x < 70)) return;
      const tm = r.finished ? r.finishTime : r.time;
      const q = Math.floor(tm * 10);
      if (q === ledQ) return;
      ledQ = q;
      redrawLed(LF.formatTime(tm));
    }

    function update(ctx) {
      const r = ctx.race || race;
      if (r !== race) setRace(r);
      else if (r.x < lastX - 1) invalidate();
      lastX = r.x;
      reduce = !!ctx.reduceMotion;
      if (ctx.camera) skyG.position.copy(ctx.camera.position);
      updateHurdles(r);
      updateStars(r, ctx.t, ctx.camera);
      updateChevrons(r, ctx.t);
      updateSquat(r, ctx.phase);
      updateLed(r);
      flash = flash > 0.002 ? flash * Math.exp(-(ctx.dt > 0 ? ctx.dt : 0) / 0.5) : 0;
      mCrowd.color.setScalar(1 + 0.35 * flash * (reduce ? 0.4 : 1));
    }

    function cheer(kind) {
      const v = kind === 'clear' ? 0.6 : kind === 'star' || kind === 'finish' ? 1 : 0;
      if (v > flash) flash = v;
    }

    function rebake() {
      if (disposed) return;
      bake();
      buildLabels();
      redrawLed(ledStr);
    }

    function stats() {
      let calls = 0, tris = 0, texBytes = 0;
      const geos = new Set();
      rootG.traverseVisible((ob) => {
        if (!ob.isMesh && !ob.isPoints) return;
        const g = ob.geometry;
        geos.add(g.uuid);
        calls++;
        if (!ob.isMesh) return;
        const n = Math.min(g.index ? g.index.count : g.attributes.position.count, g.drawRange.count);
        tris += (n / 3) * (ob.isInstancedMesh ? ob.count : 1);
      });
      for (const t of texList) texBytes += t.image.width * t.image.height * 4 * 1.34; // with mipmaps
      return { drawCalls: calls, triangles: Math.round(tris), geometries: geos.size, textures: texList.length, textureMB: +(texBytes / 1048576).toFixed(2), tier: tier.name };
    }

    function dispose() {
      disposed = true;
      if (rootG.parent) rootG.parent.remove(rootG);
      rootG.traverse((ob) => {
        if (ob.geometry) ob.geometry.dispose();
        if (ob.material) ob.material.dispose();
        if (ob.isInstancedMesh) ob.dispose();
      });
      for (const g of [gChevron, gHurdle, gStar, gHead, gStarGlow, gFloodGlow, gPole]) g.dispose();
      for (const t of texList) t.dispose();
    }

    // ---- first build now with fallback fonts; re-bake when the real faces arrive (never blocks)
    bake();
    setRace(race);
    setTier(TIERS.indexOf(tier));
    const fonts = typeof document !== 'undefined' && document.fonts;
    if (fonts && fonts.load) {
      for (const spec of ['900 64px "Big Shoulders Display"', '900 64px Doto']) {
        fonts.load(spec).then((faces) => { if (faces && faces.length) rebake(); }, () => {});
      }
    }

    return { root: rootG, sky: skyG, update, setRace, setTier, cheer, rebake, stats, dispose, glowTexture: tGlow };
  }

  Object.assign(LF, { World3D: { build } });
})(typeof window !== 'undefined' ? window : globalThis);
