/* Lane Four 3D actors: the runner (instanced bones and joints built from Geom.runnerPose), its
   shadow and charge glow, the particle points and the pooled DOM popups. Unlit MeshBasicMaterial
   only. Attaches LaneFour.Actors3D; scene3d.js is the only user. Needs core.js, geom.js and
   assets3d.js loaded first, and a DOM (the popups are elements).

   const actors = LaneFour.Actors3D.create(THREE, { glowTexture, popLayer, tier, reduceMotion })
     glowTexture   world.glowTexture (the greyscale radial the charge glow shares with the world)
     popLayer      the #popLayer element; POOL (6) .pop3d nodes are appended to it
     tier          0..3 index into Geom.TIERS (particle capacity: 256, 256, 128, 0)

   actors.root           THREE.Group of the runner, shadow, charge glow and particle points
   actors.update(f)      once per drawn frame; f = { race, av, phase, particles, popups, dt,
                         reduceMotion, camera } (camera already placed, matrixWorld up to date).
                         Creates no objects, arrays or closures per call except the popup style
                         strings while a popup is alive and moving.
   actors.setView(vfov, W, H, portrait)  after a rig or size change: particle size and popup clamp
   actors.setTier(n)     particle capacity for the tier
   actors.snap()         forget eased state (paused-gait easing, popup positions) after a teleport
   actors.prewarm(on)    show or hide the charge glow by hand (so renderer.compile sees its program)
   actors.pose           the last pose in metres relative to the runner (after the trail-leg lift), for tests
   actors.a3             the pose input copy of S.av (with the eased gait), for tests
   actors.dispose()      frees geometry, materials and popup nodes (the glow texture is the world's)

   Coordinates: three X = race x, Y = up, Z = minus race z. Pose index 0 is the near, bright limb
   and sits at +Z (legs +0.10 m, arms +0.21 m), index 1 at -Z. */
(function (root) {
  'use strict';
  const LF = root.LaneFour;
  if (!LF || !LF.Geom || !LF.Assets3D) throw new Error('actors3d.js needs core.js, geom.js and assets3d.js loaded first');
  const { clamp } = LF;
  const { runnerPose, makePose, approach, TIERS } = LF.Geom;
  const A = LF.Assets3D;

  const MAXP = 256; // particle capacity at T0 and T1
  const POOL = 6; // pooled popup nodes
  const LEG_Z = [0.10, -0.10];
  const ARM_Z = [0.21, -0.21];
  const R_LEG = 0.055;
  const R_ARM = 0.048;
  const R_FOOT = 0.04;
  const R_HEAD = 0.125;
  const NEAR = '#fbf8ef';
  const FAR = '#c9c4b6';

  function create(THREE, opts) {
    const T = THREE;
    const o = opts || {};
    if (!o.glowTexture || !o.popLayer) throw new Error('Actors3D.create needs opts.glowTexture and opts.popLayer');
    let tier = TIERS[clamp(o.tier | 0, 0, TIERS.length - 1)];
    let disposed = false;
    const rootG = new T.Group();

    // ---- runner: 11 bones (unit cylinders) and 13 joints (spheres), per-instance colour
    const mBody = new T.MeshBasicMaterial();
    const gBone = new T.CylinderGeometry(1, 1, 1, 6, 1);
    const gJoint = new T.SphereGeometry(0.055, 8, 6);
    const bones = new T.InstancedMesh(gBone, mBody, 11);
    const joints = new T.InstancedMesh(gJoint, mBody, 13);
    const cNear = new T.Color(NEAR), cFar = new T.Color(FAR), cTorso = new T.Color(A.AMBER);
    // bones: thigh x2, shin x2, foot x2, upper arm x2, forearm x2, torso. joints: hip, shoulder,
    // then knee, ankle, toe, elbow, wrist (a near and a far each), head.
    for (let i = 0; i < 10; i++) bones.setColorAt(i, i % 2 ? cFar : cNear);
    bones.setColorAt(10, cTorso);
    joints.setColorAt(0, cTorso);
    joints.setColorAt(1, cTorso);
    for (let i = 2; i < 12; i++) joints.setColorAt(i, i % 2 ? cFar : cNear);
    joints.setColorAt(12, cNear);
    for (const m of [bones, joints]) {
      m.instanceMatrix.setUsage(T.DynamicDrawUsage);
      m.frustumCulled = false;
      rootG.add(m);
    }

    // ---- shadow blob and charge glow
    const mShadow = new T.MeshBasicMaterial({ color: 0x000000, opacity: 0.3, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const gShadow = new T.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
    const shadow = new T.Mesh(gShadow, mShadow);
    shadow.position.y = 0.012;
    shadow.renderOrder = 3;
    shadow.frustumCulled = false;
    const mGlow = new T.MeshBasicMaterial({ map: o.glowTexture, color: '#57d98f', opacity: 0.45, transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false });
    const gGlow = A.geo.glowPlane(T, 1.8);
    const glow = new T.Mesh(gGlow, mGlow);
    glow.renderOrder = 5;
    glow.frustumCulled = false;
    glow.visible = false;
    rootG.add(shadow, glow);

    // ---- particles: one Points, preallocated buffers. Three's point size ignores the FOV, so the
    // size is p.size / tan(vfov / 2) (set in setView) times a per-point size attribute.
    const pPos = new Float32Array(MAXP * 3), pCol = new Float32Array(MAXP * 4), pSize = new Float32Array(MAXP);
    const gPts = new T.BufferGeometry();
    const aPos = new T.BufferAttribute(pPos, 3).setUsage(T.DynamicDrawUsage);
    const aCol = new T.BufferAttribute(pCol, 4).setUsage(T.DynamicDrawUsage);
    const aSize = new T.BufferAttribute(pSize, 1).setUsage(T.DynamicDrawUsage);
    gPts.setAttribute('position', aPos);
    gPts.setAttribute('color', aCol);
    gPts.setAttribute('psize', aSize);
    gPts.setDrawRange(0, 0);
    const mPts = new T.PointsMaterial({ size: 0.1, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false });
    mPts.onBeforeCompile = (sh) => { // per-point size; if three's shader text ever changes, size stays uniform
      if (!sh.vertexShader.includes('gl_PointSize = size;')) return;
      sh.vertexShader = 'attribute float psize;\n' + sh.vertexShader.replace('gl_PointSize = size;', 'gl_PointSize = size * psize;');
    };
    const points = new T.Points(gPts, mPts);
    points.frustumCulled = false;
    points.renderOrder = 8;
    rootG.add(points);
    const colMemo = new Map(); // 'r, g, b' (sRGB 0..255) -> linear [r, g, b]
    const tmpC = new T.Color();
    let capacity = tier.particles;
    let lastN = 0;

    function linear(str) {
      let c = colMemo.get(str);
      if (!c) {
        const p = String(str).split(',');
        tmpC.setRGB((+p[0] || 0) / 255, (+p[1] || 0) / 255, (+p[2] || 0) / 255, T.SRGBColorSpace);
        c = [tmpC.r, tmpC.g, tmpC.b];
        colMemo.set(str, c);
      }
      return c;
    }

    // ---- popups: pooled DOM nodes in #popLayer
    const nodes = [];
    for (let i = 0; i < POOL; i++) {
      const n = document.createElement('div');
      n.className = 'pop3d';
      n.hidden = true;
      o.popLayer.appendChild(n);
      nodes.push({ el: n, text: '', color: '', x: -9999, y: -9999, op: -1, shown: false });
    }
    let W = 1, H = 1, minRow = 0.22;

    // ---- per-frame scratch
    const P = makePose();
    const a3 = { phase: 0, target: 0, crouch: 0, air: 0, stumble: 0, gait: 0, charged: false, t: 0 };
    let gaitE = -1, easing = false; // gaitE < 0: take the live value next frame
    const _m = new T.Matrix4(), _q = new T.Quaternion(), _p = new T.Vector3(), _s = new T.Vector3(), _d = new T.Vector3();
    const UP = new T.Vector3(0, 1, 0);

    // World positions of the joints (points 0..12: hip, shoulder, knee x2, ankle x2, toe x2, elbow x2,
    // wrist x2, head) and the four limb roots (13-14 the hips of each leg at Z +-0.10, 15-16 the shoulders
    // of each arm at Z +-0.21), as x, y, z triples. Z never changes. Bones and joints read from here by
    // index, so no number is passed between functions (V8 boxes those).
    const jp = new Float64Array(17 * 3);
    jp[13 * 3 + 2] = LEG_Z[0];
    jp[14 * 3 + 2] = LEG_Z[1];
    jp[15 * 3 + 2] = ARM_Z[0];
    jp[16 * 3 + 2] = ARM_Z[1];
    for (let i = 0; i < 2; i++) {
      jp[(2 + i) * 3 + 2] = jp[(4 + i) * 3 + 2] = jp[(6 + i) * 3 + 2] = LEG_Z[i];
      jp[(8 + i) * 3 + 2] = jp[(10 + i) * 3 + 2] = ARM_Z[i];
    }
    const B_FROM = Uint8Array.of(13, 14, 2, 3, 4, 5, 15, 16, 8, 9, 0); // thigh x2, shin x2, foot x2, upper arm x2, forearm x2, torso
    const B_TO = Uint8Array.of(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1);
    const B_RX = Float64Array.of(R_LEG, R_LEG, R_LEG, R_LEG, R_FOOT, R_FOOT, R_ARM, R_ARM, R_ARM, R_ARM, 0.11);
    const B_RZ = Float64Array.of(R_LEG, R_LEG, R_LEG, R_LEG, R_FOOT, R_FOOT, R_ARM, R_ARM, R_ARM, R_ARM, 0.18);

    function bone(i) { // cylinder between two points, radius rx x rz
      const a = B_FROM[i] * 3, b = B_TO[i] * 3;
      _d.set(jp[b] - jp[a], jp[b + 1] - jp[a + 1], jp[b + 2] - jp[a + 2]);
      const len = _d.length();
      if (len < 1e-6) { _m.makeScale(0, 0, 0); bones.setMatrixAt(i, _m); return; }
      _q.setFromUnitVectors(UP, _d.multiplyScalar(1 / len));
      _p.set((jp[a] + jp[b]) / 2, (jp[a + 1] + jp[b + 1]) / 2, (jp[a + 2] + jp[b + 2]) / 2);
      _s.set(B_RX[i], len, B_RZ[i]);
      bones.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    function joint(i) { // sphere on point i (the head is the same sphere, scaled)
      const s = i === 12 ? R_HEAD / 0.055 : 1, k = i * 3;
      joints.setMatrixAt(i, _m.set(s, 0, 0, jp[k], 0, s, 0, jp[k + 1], 0, 0, s, jp[k + 2], 0, 0, 0, 1));
    }

    function updateRunner(f) {
      const r = f.race, av = f.av, dt = f.dt;
      a3.phase = av.phase;
      a3.target = av.target;
      a3.crouch = av.crouch;
      a3.air = av.air;
      a3.stumble = av.stumble;
      a3.charged = av.charged;
      a3.t = av.t;
      // S.av is never touched. While paused the gait eases to a stand instead of freezing mid-stride,
      // and it eases back to the live value on resume.
      if (gaitE < 0) gaitE = av.gait;
      if (f.phase === 'paused') { gaitE = approach(gaitE, 0, dt, 0.3); easing = true; }
      else if (easing) { gaitE = approach(gaitE, av.gait, dt, 0.15); if (Math.abs(gaitE - av.gait) < 0.01) easing = false; }
      a3.gait = easing ? gaitE : av.gait;
      if (!easing) gaitE = av.gait;
      runnerPose(a3, f.reduceMotion, P);
      if (av.air > 0.5) { // trail leg tucks higher over the board (3D only; the collision rule is unchanged)
        const l = 0.12 * av.air, leg = P.legs[1];
        leg.knee.y += l;
        leg.ankle.y += l;
        leg.toe.y += l;
      }
      const ox = r.x, oy = r.y;
      jp[0] = ox + P.hip.x;
      jp[1] = oy + P.hip.y;
      jp[3] = ox + P.shoulder.x;
      jp[4] = oy + P.shoulder.y;
      jp[36] = ox + P.head.x;
      jp[37] = oy + P.head.y;
      for (let i = 0; i < 2; i++) {
        const lg = P.legs[i], ar = P.arms[i];
        let k = (2 + i) * 3;
        jp[k] = ox + lg.knee.x;
        jp[k + 1] = oy + lg.knee.y;
        k = (4 + i) * 3;
        jp[k] = ox + lg.ankle.x;
        jp[k + 1] = oy + lg.ankle.y;
        k = (6 + i) * 3;
        jp[k] = ox + lg.toe.x;
        jp[k + 1] = oy + lg.toe.y;
        k = (8 + i) * 3;
        jp[k] = ox + ar.elbow.x;
        jp[k + 1] = oy + ar.elbow.y;
        k = (10 + i) * 3;
        jp[k] = ox + ar.wrist.x;
        jp[k + 1] = oy + ar.wrist.y;
        k = (13 + i) * 3; // limb roots
        jp[k] = jp[0];
        jp[k + 1] = jp[1];
        k = (15 + i) * 3;
        jp[k] = jp[3];
        jp[k + 1] = jp[4];
      }
      for (let i = 0; i < 11; i++) bone(i);
      for (let i = 0; i < 13; i++) joint(i);
      bones.instanceMatrix.needsUpdate = true;
      joints.instanceMatrix.needsUpdate = true;
      const k = clamp(1 - oy / 2.2, 0.35, 1);
      shadow.position.x = ox + 0.06;
      shadow.scale.set(0.42 * k, 1, 0.30 * k);
      const on = av.charged && av.air < 0.5;
      glow.visible = on;
      if (on) glow.position.set(jp[0] + 0.15, jp[1], 0);
    }

    // The sim moves bursts in x and height only, which from behind collapses a burst into one vertical
    // line. Fan them out sideways from where each one is: a stable direction from its own vx (it only
    // changes at a ground bounce), growing with its age.
    function fan(p) {
      const h = Math.sin(p.vx * 127.1 + 311.7) * 43758.5453;
      return (h - Math.floor(h) - 0.5) * 2 * 1.6 * (p.max - p.life);
    }
    function updateParticles(list) {
      const total = list ? list.length : 0;
      const n = Math.min(total, capacity);
      const first = total - n; // when over capacity keep the newest
      for (let i = 0; i < n; i++) {
        const p = list[first + i];
        const c = linear(p.col);
        pPos[i * 3] = p.x;
        pPos[i * 3 + 1] = p.h;
        pPos[i * 3 + 2] = -p.z + (p.size >= 0.05 && p.z === 0 ? fan(p) : 0);
        pCol[i * 4] = c[0];
        pCol[i * 4 + 1] = c[1];
        pCol[i * 4 + 2] = c[2];
        pCol[i * 4 + 3] = clamp(p.life / p.max, 0, 1);
        pSize[i] = p.size;
      }
      if (n > 0 || lastN > 0) {
        aPos.needsUpdate = true;
        aCol.needsUpdate = true;
        aSize.needsUpdate = true;
      }
      gPts.setDrawRange(0, n);
      lastN = n;
    }

    function hideNode(n) {
      if (!n.shown) return;
      n.shown = false;
      n.el.hidden = true;
    }
    // Slot i floats 0.55 m above slot i - 1, but the clamp stops anything rising past the HUD line,
    // so working from the top slot down each lower one is pushed at least a line below the one above.
    function updatePopups(list, r, cam) {
      const live = Math.min(list ? list.length : 0, POOL);
      for (let i = live; i < POOL; i++) hideNode(nodes[i]);
      const line = clamp(0.052 * Math.min(W, H), 20, 40) * 1.05; // .pop3d font: clamp(20px, 5.2vmin, 40px)
      let floor = minRow * H;
      for (let i = live - 1; i >= 0; i--) {
        const n = nodes[i], q = list[i];
        _p.set(r.x + 2.0, r.y + 1.9 + (q.max - q.life) * 0.6 + 0.55 * i, 0).project(cam);
        const px = (_p.x * 0.5 + 0.5) * W;
        const py = Math.max((0.5 - _p.y * 0.5) * H, floor);
        floor = py + line;
        if (q.text !== n.text) { n.text = q.text; n.el.textContent = q.text; }
        if (q.color !== n.color) { n.color = q.color; n.el.style.color = q.color; }
        const op = Math.round(Math.min(1, 1.6 * q.life / q.max) * 50) / 50;
        if (op !== n.op) { n.op = op; n.el.style.opacity = String(op); }
        if (Math.abs(px - n.x) > 0.5 || Math.abs(py - n.y) > 0.5) {
          n.x = px;
          n.y = py;
          n.el.style.transform = 'translate(-50%,-50%) translate3d(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px,0)';
        }
        if (!n.shown) { n.shown = true; n.el.hidden = false; }
      }
    }

    function update(f) {
      updateRunner(f);
      updateParticles(f.particles);
      updatePopups(f.popups, f.race, f.camera);
    }

    function setView(vfov, w, h, portrait) {
      W = w;
      H = h;
      minRow = portrait ? 0.22 : 0.15;
      mPts.size = 1 / Math.tan((vfov * Math.PI) / 360);
    }
    function setTier(n) {
      tier = TIERS[clamp(n | 0, 0, TIERS.length - 1)];
      capacity = Math.min(MAXP, tier.particles);
      points.visible = capacity > 0;
      if (capacity === 0) { gPts.setDrawRange(0, 0); lastN = 0; }
    }
    function prewarm(on) { glow.visible = on; } // so renderer.compile sees the (normally hidden) charge glow
    function snap() {
      easing = false;
      gaitE = -1;
      for (const n of nodes) { n.x = -9999; n.y = -9999; hideNode(n); }
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const n of nodes) if (n.el.parentNode) n.el.parentNode.removeChild(n.el);
      if (rootG.parent) rootG.parent.remove(rootG);
      bones.dispose();
      joints.dispose();
      for (const g of [gBone, gJoint, gShadow, gGlow, gPts]) g.dispose();
      for (const m of [mBody, mShadow, mGlow, mPts]) m.dispose();
    }

    setTier(TIERS.indexOf(tier));
    return { root: rootG, update, setView, setTier, snap, prewarm, dispose, pose: P, a3 };
  }

  Object.assign(LF, { Actors3D: { create, POOL, MAXP } });
})(typeof window !== 'undefined' ? window : globalThis);
