"""Page-side probes and the checks that read them, shared by the runs that look at the 3D picture."""
import json
import re

from browser_tests.common import check, vinfo

CAM_CHECK = """() => new Promise((resolve) => {
  const lf = window.laneFour, sc = lf.view.scene;
  if (!sc || lf.view.mode !== '3d') { resolve(null); return; }
  const before = sc.drawn;
  let n = 0;
  const tick = () => {  // runs after the app's own frame, so a frame that drew has the camera on the runner
    if (sc.drawn !== before || ++n > 150) {
      const r = lf.state.race, p = sc.parts;
      resolve({ camX: p.camera.position.x, rx: r.x, back: p.cam.sol.back, drew: sc.drawn !== before, phase: lf.state.phase });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})"""

# Records how the next hurdle projects on screen each time it comes within 14 m and 20 m.
SIGHT_WATCH = """() => {
  if (window.__sight) return;
  const rows = [], prev = {};
  window.__sight = rows;
  let lastDrawn = -1;
  const G = window.LaneFour.Geom;
  const loop = () => {
    requestAnimationFrame(loop);
    const lf = window.laneFour, v = lf.view, sc = v.scene;
    if (!sc || v.mode !== '3d' || sc.drawn === lastDrawn) return;
    lastDrawn = sc.drawn;
    if (lf.state.phase !== 'running') return;
    const r = lf.state.race, h = r.nextHurdle();
    if (!h) return;
    const d = h.x - r.x, p = prev[h.x];
    prev[h.x] = d;
    if (p === undefined) return;
    for (const th of [14, 20]) {
      if (p > th && d <= th) {
        const base = sc.project(h.x - 0.07, 0, 0);
        const by = base.y, depth = base.depth;
        const top = sc.project(h.x - 0.07, 0.914 * G.farScale(d), 0);
        rows.push({ th, d: +d.toFixed(2), px: +(by - top.y).toFixed(1), topFrac: +(top.y / innerHeight).toFixed(3), depth: +depth.toFixed(1), rig: sc.rig, w: innerWidth, h: innerHeight });
      }
    }
  };
  requestAnimationFrame(loop);
}"""


def three_checks(page, label):
    """Static facts about a page that is showing the 3D view."""
    v = vinfo(page)
    check(f"{label}: view.mode is 3d and status ready", v["mode"] == "3d" and v["status"] == "ready", f"{v['mode']}/{v['status']}")
    check(f"{label}: tier is locked to 3 by ?tier=3", v["tier"] == 3, v["tier"])
    check(f"{label}: the 3D canvas is shown and three.js is the engine", v["on3d"] and not v["hidden3d"] and "three.js" in v["engine"], v["engine"])
    check(f"{label}: the classic canvas was never built or shown", v["hidden2d"] and v["w2d"] <= 300, f"hidden={v['hidden2d']} width={v['w2d']}")
    check(f"{label}: Start is offered", v["startDisabled"] == [False, False] and v["startText"] == ["Start with camera", "Play with keys or touch"], v["startText"])


def three_race_checks(page, label, probes):
    """Probes taken mid-race and at the end."""
    pr = probes.get("probe")
    if check(f"{label}: probe() answered", pr is not None):
        check(f"{label}: probe sees >= 4 distinct colours", pr["distinct"] >= 4, pr["distinct"])
        check(f"{label}: probe sees a red-dominant track pixel at (.5W,.9H)", pr["redDominant"], pr["at"])
    mid = probes.get("stats_mid")
    if check(f"{label}: stats() answered mid-race", mid is not None):
        check(f"{label}: draw calls within 12..60", 12 <= mid["calls"] <= 60, mid["calls"])
        check(f"{label}: triangles under 60k", mid["triangles"] < 60000, mid["triangles"])
        check(f"{label}: the Signals line is formatted", re.match(r"^View: 3D chase · T3 · \d+ fps \(p95 \d+ ms\) · [\d.]+ MP · \d+ calls · [\d.]+k tris · \w+$", mid["line"]) is not None, mid["line"])
    first, end = probes.get("stats_first"), probes.get("stats_end")
    if check(f"{label}: stats() taken at x >= 10 and at the finish", first is not None and end is not None):
        check(f"{label}: geometries do not grow between x=10 and the finish", end["geometries"] - first["geometries"] <= 2, f"{first['geometries']} -> {end['geometries']}")
        check(f"{label}: textures do not grow between x=10 and the finish", end["textures"] - first["textures"] <= 2, f"{first['textures']} -> {end['textures']}")
    cam = probes.get("cam")
    if check(f"{label}: camera sample taken", cam is not None and cam["drew"], cam):
        check(f"{label}: camera x equals race x minus the rig's back distance", abs(cam["camX"] - (cam["rx"] - cam["back"])) < 1e-6, cam)


def sight_checks(page, label, rig=None):
    rows = page.evaluate("() => window.__sight || []")
    if rig:
        rows = [r for r in rows if r["rig"] == rig]
    at14 = [r for r in rows if r["th"] == 14]
    at20 = [r for r in rows if r["th"] == 20]
    print("  sight rows:", json.dumps(rows))
    if check(f"{label}: the next hurdle was measured at 14 m", len(at14) >= 1, len(at14)):
        check(f"{label}: hurdle at 14 m is at least 23 px tall", all(r["px"] >= 23 for r in at14), [r["px"] for r in at14])
        check(f"{label}: hurdle at 14 m has its top below the HUD line (22% of H)", all(r["topFrac"] >= 0.22 for r in at14), [r["topFrac"] for r in at14])
    if at20:
        check(f"{label}: hurdle at 20 m is at least 21 px tall", all(r["px"] >= 21 for r in at20), [r["px"] for r in at20])

