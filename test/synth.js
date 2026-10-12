// Synthetic MediaPipe-style pose sequences for testing the detectors.
// Produces normalized landmarks (x, y in 0..1, visibility) for a 640x480 frame.
'use strict';

const W = 640, H = 480;

// Seeded RNG so tests are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Standing skeleton in meters, x to the person's left (their left = image
// right when not mirrored, irrelevant here), y up from the floor.
function standing() {
  return {
    0: [0, 1.62],
    11: [0.2, 1.45], 12: [-0.2, 1.45],
    13: [0.24, 1.17], 14: [-0.24, 1.17],
    15: [0.26, 0.92], 16: [-0.26, 0.92],
    23: [0.1, 0.92], 24: [-0.1, 0.92],
    25: [0.11, 0.5], 26: [-0.11, 0.5],
    27: [0.12, 0.08], 28: [-0.12, 0.08],
  };
}

// Pose functions return joint positions (meters) for time t.
const poses = {
  still() { return standing(); },

  // style: 'jog' | 'march' | 'highknees' | 'buttkicks'
  inPlace(t, { cadence = 160, style = 'jog' } = {}) {
    const p = standing();
    const f = cadence / 120; // leg cycles per second (2 steps per cycle)
    const w = 2 * Math.PI * f * t;
    const cfg = {
      jog: { foot: 0.08, knee: 0.05, bob: 0.02 },
      march: { foot: 0.2, knee: 0.18, bob: 0.01 },
      highknees: { foot: 0.32, knee: 0.3, bob: 0.03 },
      buttkicks: { foot: 0.34, knee: 0.04, bob: 0.03 },
    }[style];
    const liftL = Math.max(0, Math.sin(w));
    const liftR = Math.max(0, -Math.sin(w));
    p[27][1] += cfg.foot * liftL; p[25][1] += cfg.knee * liftL;
    p[28][1] += cfg.foot * liftR; p[26][1] += cfg.knee * liftR;
    const bob = cfg.bob * Math.abs(Math.sin(w));
    for (const k of [0, 11, 12, 13, 14, 15, 16, 23, 24]) p[k][1] += bob;
    // arms swing a little
    p[15][1] += 0.06 * Math.sin(w); p[16][1] -= 0.06 * Math.sin(w);
    return p;
  },

  // q in 0..1, 1 = thighs parallel. Hips drop, torso leans (shortening the
  // projected torso), knees travel forward toward the camera.
  squatAt(q) {
    const p = standing();
    const drop = 0.42 * q;
    const lean = 0.6 * q;
    const hipY = 0.92 - drop;
    p[23][1] = hipY; p[24][1] = hipY;
    p[25][1] -= 0.05 * q; p[26][1] -= 0.05 * q;
    const torsoV = 0.53 * Math.cos(lean);
    for (const k of [11, 12]) p[k][1] = hipY + torsoV;
    p[0][1] = hipY + torsoV + 0.17 * Math.cos(lean);
    // arms forward for balance
    for (const k of [13, 14]) p[k][1] = hipY + torsoV - 0.12;
    for (const k of [15, 16]) p[k][1] = hipY + torsoV - 0.1;
    return p;
  },

  handsUp() {
    const p = standing();
    p[13][1] = 1.75; p[14][1] = 1.75;
    p[15][1] = 2.0; p[16][1] = 2.0;
    p[13][0] = 0.25; p[14][0] = -0.25;
    return p;
  },
};

// Squat sequence: n reps of (down, hold, up, rest) with depth q.
function squatSeq(t, { reps = 5, q = 1, down = 0.8, hold = 0.3, up = 0.6, rest = 0.8, start = 0 } = {}) {
  const cycle = down + hold + up + rest;
  const tt = t - start;
  if (tt < 0 || tt >= reps * cycle) return poses.still();
  const c = tt % cycle;
  let k;
  if (c < down) k = 0.5 - 0.5 * Math.cos((Math.PI * c) / down);
  else if (c < down + hold) k = 1;
  else if (c < down + hold + up) k = 0.5 + 0.5 * Math.cos((Math.PI * (c - down - hold)) / up);
  else k = 0;
  return poses.squatAt(q * k);
}

// Project meters to normalized landmarks. scale = px per meter, camera at
// height camH (meters) mapped to image row cy. Points outside the frame get
// low visibility, like MediaPipe.
function project(joints, { scale = 210, camH = 0.9, cy = H * 0.5, cx = W * 0.5, noise = 1.5, r = Math.random } = {}) {
  const out = [];
  for (let i = 0; i < 33; i++) {
    const j = joints[i];
    if (!j) { out.push({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }); continue; }
    const n = i >= 25 ? noise * 1.4 : noise;
    const px = cx + j[0] * scale + gauss(r) * n;
    const py = cy - (j[1] - camH) * scale + gauss(r) * n;
    const inside = px > 0 && px < W && py > 0 && py < H;
    out.push({ x: px / W, y: py / H, z: 0, visibility: inside ? 0.95 : 0.15 });
  }
  return out;
}

module.exports = { W, H, rng, poses, squatSeq, project, standing };
