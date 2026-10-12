// Test double for MediaPipe's vision bundle. Instead of looking at the camera,
// detectForVideo returns a synthetic body driven by a bot that reads the game
// state: stands still to calibrate, raises both hands to start, jogs in place
// at 170 spm and squats ahead of each hurdle. This exercises the real camera
// code path (smoothing, framing, calibration, detectors, race) end to end.
(function () {
  'use strict';
  const W = 640;
  const H = 480;

  function standing() {
    return {
      0: [0, 1.62], 11: [0.2, 1.45], 12: [-0.2, 1.45], 13: [0.24, 1.17], 14: [-0.24, 1.17],
      15: [0.26, 0.92], 16: [-0.26, 0.92], 23: [0.1, 0.92], 24: [-0.1, 0.92],
      25: [0.11, 0.5], 26: [-0.11, 0.5], 27: [0.12, 0.08], 28: [-0.12, 0.08],
    };
  }
  function inPlace(t, cadence) {
    const p = standing();
    const w = 2 * Math.PI * (cadence / 120) * t;
    const liftL = Math.max(0, Math.sin(w));
    const liftR = Math.max(0, -Math.sin(w));
    p[27][1] += 0.1 * liftL; p[25][1] += 0.07 * liftL;
    p[28][1] += 0.1 * liftR; p[26][1] += 0.07 * liftR;
    const bob = 0.02 * Math.abs(Math.sin(w));
    for (const k of [0, 11, 12, 13, 14, 15, 16, 23, 24]) p[k][1] += bob;
    return p;
  }
  function squatAt(q) {
    const p = standing();
    const hipY = 0.92 - 0.42 * q;
    const lean = 0.6 * q;
    p[23][1] = hipY; p[24][1] = hipY;
    p[25][1] -= 0.05 * q; p[26][1] -= 0.05 * q;
    const tv = 0.53 * Math.cos(lean);
    p[11][1] = hipY + tv; p[12][1] = hipY + tv;
    p[0][1] = hipY + tv + 0.17 * Math.cos(lean);
    p[13][1] = hipY + tv - 0.12; p[14][1] = hipY + tv - 0.12;
    p[15][1] = hipY + tv - 0.1; p[16][1] = hipY + tv - 0.1;
    return p;
  }
  function handsUp() {
    const p = standing();
    p[13][1] = 1.75; p[14][1] = 1.75; p[15][1] = 2.0; p[16][1] = 2.0;
    return p;
  }
  function project(j) {
    const out = [];
    for (let i = 0; i < 33; i++) {
      const q = j[i];
      if (!q) { out.push({ x: 0.5, y: 0.5, z: 0, visibility: 0.1 }); continue; }
      const n = () => (Math.random() - 0.5) * 2.4;
      const px = W / 2 + q[0] * 210 + n();
      const py = H / 2 - (q[1] - 0.9) * 210 + n();
      out.push({ x: px / W, y: py / H, z: 0, visibility: 0.95 });
    }
    return out;
  }

  const bot = { squatting: false, sqStart: 0, riseAt: -10, squats: 0 };
  function poseAt(t) {
    const st = window.laneFour && window.laneFour.state;
    if (!st) return standing();
    if (st.phase === 'ready') return handsUp();
    if (st.phase !== 'running') return standing();
    const r = st.race;
    const h = r.nextHurdle();
    const toH = h ? h.x - r.x : Infinity;
    if (!bot.squatting && t - bot.riseAt > 0.6 && toH < 5.5 && toH > 3.0 && !r.airborne) {
      bot.squatting = true;
      bot.sqStart = t;
      bot.squats++;
    }
    if (bot.squatting && (toH <= 2.9 || t - bot.sqStart > 3)) {
      bot.squatting = false;
      bot.riseAt = t;
    }
    if (bot.squatting) return squatAt(Math.min(1, (t - bot.sqStart) / 0.45));
    if (t - bot.riseAt < 0.3) return squatAt(1 - (t - bot.riseAt) / 0.3);
    return inPlace(t, 170);
  }

  let t0 = null;
  window.Vision = {
    __fake: true,
    bot,
    FilesetResolver: { forVisionTasks: async () => ({}) },
    PoseLandmarker: {
      createFromOptions: async () => ({
        detectForVideo(video, ts) {
          const t = ts / 1000;
          if (t0 === null) t0 = t;
          return { landmarks: [project(poseAt(t - t0))], worldLandmarks: [] };
        },
        close() {},
      }),
    },
  };
})();
