"""Headless browser checks for Lane Four. Strict: every check is counted, a failed one makes the
process exit 1.

A: real MediaPipe + fake camera (a still photo)   -> model loads, landmarks flow (not strict)
B: scripted bot through the camera path, 200 m     -> full race, run as 3D and as 2D
C: keys mode on a phone-sized viewport             -> intro, race, results, rotate; as 3D and as 2D
D: three.js unreachable, default URL               -> the race finishes in 2D, toast, view.status failed
E: graphics context lost while waiting to start    -> lands in 2D with the toast, the race continues

Usage:  python3 test/browser_test.py [A][B][C][D][E]     (default: BCDE)

B and C as 2D and D need only Playwright (pip install playwright && python3 -m playwright install
chromium). The 3D runs (B, C) and E also need `npm install`: they serve three.js from
node_modules/three, which stands in for the CDN. Without it they print SKIP and D still runs. A also
needs local copies of what the page loads from the network, see README.md. Screenshots go to
test/shots/ (suffix _3d or _2d for the two views).

The 3D runs use ?renderer=3d&tier=3: the lowest quality tier on SwiftShader, locked so the quality
controller cannot change it under the test.
"""
import functools
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:  # pragma: no cover
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHICH = (sys.argv[1] if len(sys.argv) > 1 else "BCDE").upper()
OUT = os.path.join(ROOT, "test", "shots")
os.makedirs(OUT, exist_ok=True)
SITE = os.path.join(ROOT, "docs")
MP = os.path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision")
THREE_BUILD = os.path.join(ROOT, "node_modules", "three", "build")
MODEL = os.path.join(ROOT, "test", "assets", "pose_landmarker_lite.task")
Y4M = os.path.join(ROOT, "test", "assets", "fake-camera.y4m")
FAKE = os.path.join(ROOT, "test", "fake-vision.js")
URL = "http://localhost:8123/index.html"
Q3D = "?renderer=3d&tier=3"
Q2D = "?renderer=2d"
HAVE_THREE = os.path.exists(os.path.join(THREE_BUILD, "three.module.js")) and os.path.exists(os.path.join(THREE_BUILD, "three.core.js"))

if "A" in WHICH:
    missing = [p for p in (MP, MODEL, Y4M) if not os.path.exists(p)]
    if missing:
        print("Skipping A, missing: " + ", ".join(os.path.relpath(m, ROOT) for m in missing))
        WHICH = WHICH.replace("A", "")

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SITE)
handler.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8123), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

CORS = {"Access-Control-Allow-Origin": "*"}
THREE_HOSTS = ("https://cdn.jsdelivr.net/npm/three@", "https://cdnjs.cloudflare.com/ajax/libs/three.js/")

FAILURES = []
CURRENT = ["-"]


def check(name, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + name + (f"   [{detail}]" if detail != "" else ""))
    if not ok:
        FAILURES.append(f"{CURRENT[0]}: {name} {detail}".strip())
    return bool(ok)


def route_assets(page, fake=False, block_three=False):
    """Stand-in for the network. three.js comes from node_modules/three for both CDN hosts: the
    minified module is the plain module and the minified core is the plain core. Any other three
    URL, and every three URL when block_three is set, is aborted."""
    def handle(route):
        url = route.request.url
        if url.startswith("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/"):
            rel = url.split("@1.0.1/")[1].split("?")[0]
            if fake and rel == "vision_bundle.js":
                return route.fulfill(path=FAKE, content_type="text/javascript", headers=CORS)
            path = os.path.join(MP, rel)
            ctype = "application/wasm" if path.endswith(".wasm") else "text/javascript"
            return route.fulfill(path=path, content_type=ctype, headers=CORS)
        if url.startswith("https://storage.googleapis.com/mediapipe-models/"):
            return route.fulfill(path=MODEL, content_type="application/octet-stream", headers=CORS)
        if "fonts.googleapis.com" in url or "fonts.gstatic.com" in url:
            return route.fulfill(body="", content_type="text/css")
        if url.startswith(THREE_HOSTS):
            name = url.split("?")[0].rsplit("/", 1)[1]
            if block_three or not HAVE_THREE:
                return route.abort()
            if name == "three.module.min.js":
                return route.fulfill(path=os.path.join(THREE_BUILD, "three.module.js"), content_type="text/javascript", headers=CORS)
            if name in ("three.core.min.js", "three.core.js"):
                return route.fulfill(path=os.path.join(THREE_BUILD, "three.core.js"), content_type="text/javascript", headers=CORS)
            return route.abort()
        return route.continue_()

    page.route("**/*", handle)


def attach_logs(page, logs, reqs=None):
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))
    if reqs is not None:
        page.on("request", lambda r: reqs.append(r.url) if r.url.startswith(THREE_HOSTS) else None)


def errors_of(logs, allow=()):
    return [l for l in logs if (l.startswith("[error]") or l.startswith("[pageerror]")) and not any(a in l for a in allow)]


def state(page):
    return page.evaluate(
        """() => { const s = window.laneFour.state, r = s.race, h = r.nextHurdle(); return {
        phase: s.phase, mode: s.mode, framing: s.framing, delegate: s.delegate, fps: Math.round(s.poseFps),
        ms: Math.round(s.inferMs), hasPts: !!s.pts, x: +r.x.toFixed(1), v: +r.v.toFixed(2), y: +r.y.toFixed(2),
        time: +r.time.toFixed(1), stats: r.stats, finished: r.finished, finishTime: r.finishTime,
        banner: document.getElementById('bannerMain').textContent + ' / ' + document.getElementById('bannerSub').textContent,
        baseline: s.baseline, eff: s.eff, cadence: Math.round(s.cadence), nh: h ? +(h.x - r.x).toFixed(2) : 999 }; }"""
    )


def vinfo(page):
    return page.evaluate(
        """() => { const v = window.laneFour.view, s = v.scene, c = document.getElementById('world3d'),
        w = document.getElementById('world'); return { mode: v.mode, status: v.status, reason: v.reason, shown: v.shown,
        retried: v.retried, hasScene: !!s, tier: s ? s.tier : null, drawn: s ? s.drawn : 0, pref: window.laneFour.settings.renderer,
        on3d: c.classList.contains('on'), hidden3d: c.hidden, hidden2d: w.hidden, w2d: w.width,
        engine: c.dataset.engine || '', toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent,
        chipDisabled: document.getElementById('btnView').disabled, chipPressed: document.getElementById('btnView').getAttribute('aria-pressed'),
        chipTitle: document.getElementById('btnView').title, saved: localStorage.getItem('lanefour.renderer') }; }"""
    )


def wait_js(page, expr, timeout=30.0, step=0.1):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(expr):
            return True
        time.sleep(step)
    return False


READY_3D = "() => { const v = window.laneFour.view; return v.mode === '3d' && v.shown && !!v.scene && v.scene.drawn > 4 }"
MODE_2D = "() => window.laneFour.view.mode === '2d'"


def launch(p, video=None):
    args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    if video:
        args.append(f"--use-file-for-fake-video-capture={video}")
    return p.chromium.launch(args=args)


# --------------------------------------------------------------------------- drift guards
def drift_guard():
    """node_modules/three, package.json, the built import map and docs/index.html must agree."""
    CURRENT[0] = "drift"
    print("=== guard: three.js version and docs/index.html ===")
    with open(os.path.join(ROOT, "package.json")) as f:
        pinned = json.load(f)["devDependencies"]["three"]
    with open(os.path.join(SITE, "index.html")) as f:
        html = f.read()
    m = re.search(r'<script type="importmap">(.*?)</script>', html, re.S)
    imports = json.loads(m.group(1))["imports"] if m else {}
    versions = set()
    for k in list(imports) + list(imports.values()):
        versions.update(re.findall(r"three@(\d+\.\d+\.\d+)/|three\.js/(\d+\.\d+\.\d+)/", k))
    seen = {a or b for a, b in versions}
    check("built import map names exactly the pinned three.js version", seen == {pinned}, f"pinned {pinned}, map {sorted(seen)}")
    if HAVE_THREE:
        with open(os.path.join(ROOT, "node_modules", "three", "package.json")) as f:
            installed = json.load(f)["version"]
        check("node_modules/three is the pinned version", installed == pinned, f"installed {installed}, pinned {pinned}")
    try:
        fresh = subprocess.run(["node", "-e", "process.stdout.write(require('./build.js').build())"], cwd=ROOT,
                               capture_output=True, text=True, timeout=60, check=True).stdout
        check("docs/index.html is what `npm run build` produces now", fresh == html, "run npm run build" if fresh != html else "")
    except (OSError, subprocess.SubprocessError) as e:  # node missing: the unit tests cover the build
        print(f"  skip docs/index.html freshness: {e}")


# --------------------------------------------------------------------------- page-side probes
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
    check(f"{label}: the 2D layer was released", v["hidden2d"] and v["w2d"] == 1, f"hidden={v['hidden2d']} width={v['w2d']}")


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


# --------------------------------------------------------------------------- A
def test_a(p):
    CURRENT[0] = "A"
    print("=== A: real MediaPipe, still photo as camera ===")
    b = launch(p, Y4M)
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, permissions=["camera"])
    page = ctx.new_page()
    logs = []
    attach_logs(page, logs)
    route_assets(page, fake=False)
    page.goto(URL + Q2D)
    page.wait_for_timeout(500)
    page.click("#btnCamera")
    t0 = time.time()
    while time.time() - t0 < 90:
        s = state(page)
        if s["phase"] != "intro" or not page.is_visible("#btnCamera") or page.is_visible("#introError"):
            if s["phase"] == "setup" and s["hasPts"]:
                break
            if page.is_visible("#introError"):
                break
        time.sleep(0.5)
    page.wait_for_timeout(2500)
    s = state(page)
    err = page.inner_text("#introError") if page.is_visible("#introError") else ""
    print(json.dumps({k: s[k] for k in ("phase", "framing", "delegate", "fps", "ms", "hasPts", "banner")}), "error:", err)
    page.screenshot(path=os.path.join(OUT, "A_setup_real_mediapipe.png"))
    pts = page.evaluate("() => { const p = window.laneFour.state.pts; return p ? [0,11,12,23,24,25,27].map(i => p[i] && [Math.round(p[i].x), Math.round(p[i].y), +p[i].v.toFixed(2)]) : null }")
    print("landmarks (nose, shoulders, hips, knee, ankle):", pts)
    print("\n".join(l for l in logs if "error" in l.lower() or "warn" in l.lower())[:3000])
    b.close()


# --------------------------------------------------------------------------- B
def test_b(p, flavour):
    is3d = flavour == "3d"
    CURRENT[0] = f"B {flavour}"
    print(f"=== B ({flavour}): scripted bot through the camera path, 200 m ===")
    b = launch(p)
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, permissions=["camera"])
    page = ctx.new_page()
    logs, reqs = [], []
    attach_logs(page, logs, reqs)
    route_assets(page, fake=True)
    page.goto(URL + (Q3D if is3d else Q2D))
    sfx = "_" + flavour
    probes = {}
    if is3d:
        ok = check("B: 3D view is up before Start is pressed (idle preload on a fine pointer)", wait_js(page, READY_3D, 45), vinfo(page))
        if not ok:
            b.close()
            return
        three_checks(page, "B")
        page.evaluate(SIGHT_WATCH)
    else:
        page.wait_for_timeout(1200)
        v = vinfo(page)
        check("B: renderer=2d stays 2D and never loads three.js", v["mode"] == "2d" and v["status"] == "idle" and not reqs, f"{v['mode']}/{v['status']} reqs={len(reqs)}")
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, f"B_intro{sfx}.png"))
    page.click(".pick button[data-dist='200']")
    page.click("#btnCamera")
    t0 = time.time()
    seen = []
    shot_mid = shot_cal = shot_squat = shot14 = False
    got_first = got_probe = False
    while time.time() - t0 < 150:
        s = state(page)
        if not seen or seen[-1] != s["phase"]:
            seen.append(s["phase"])
            print(f"{time.time()-t0:5.1f}s phase={s['phase']} banner='{s['banner']}' eff={s['eff']}")
        if s["phase"] == "setup" and not shot_cal and time.time() - t0 > 0.8:
            page.screenshot(path=os.path.join(OUT, f"B_calibrating{sfx}.png"))
            shot_cal = True
        if is3d and s["phase"] == "running" and not got_first and s["x"] >= 10:
            probes["stats_first"] = page.evaluate("() => window.laneFour.view.scene.stats()")
            got_first = True
        if s["phase"] == "running" and not shot14 and s["nh"] <= 14.6:
            page.screenshot(path=os.path.join(OUT, f"B_sight14{sfx}.png"))
            shot14 = True
        if s["phase"] == "running" and not shot_mid and s["x"] > 38:
            page.screenshot(path=os.path.join(OUT, f"B_approach_hurdle{sfx}.png"))
            shot_mid = True
            if is3d:
                probes["probe"] = page.evaluate("() => window.laneFour.view.scene.probe()")
                probes["stats_mid"] = page.evaluate("() => window.laneFour.view.scene.stats()")
                probes["cam"] = page.evaluate(CAM_CHECK)
        if s["phase"] == "running" and not shot_squat and s["y"] > 0.8:
            page.screenshot(path=os.path.join(OUT, f"B_over_hurdle{sfx}.png"))
            shot_squat = True
        if s["phase"] == "finished" and page.is_visible("#results"):
            break
        time.sleep(0.05 if (s["phase"] == "running" and s["nh"] < 20) else 0.2)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "time", "finishTime", "stats", "cadence")}))
    print("bot squats:", page.evaluate("() => window.Vision.bot.squats"))
    page.screenshot(path=os.path.join(OUT, f"B_results{sfx}.png"))
    check("B: the race finished", s["phase"] == "finished" and s["finished"], s["phase"])
    check("B: the bot cleared all 5 hurdles", s["stats"]["cleared"] == 5, s["stats"])
    check("B: the 200 m time is plausible", 30 < (s["finishTime"] or 0) < 70, s["finishTime"])
    if is3d:
        probes["stats_end"] = page.evaluate("() => window.laneFour.view.scene.stats()")
        three_race_checks(page, "B", probes)
        sight_checks(page, "B")
        v = vinfo(page)
        check("B: still 3D at the end", v["mode"] == "3d", v["mode"])
        core_min = [u for u in reqs if u.endswith("three.core.min.js")]
        core_plain = [u for u in reqs if u.endswith("/three.core.js")]
        check("B: the import map swapped in the minified core", len(core_min) >= 1 and not core_plain, f"min={len(core_min)} plain={len(core_plain)}")
        check("B: three.js was fetched from one host", len({u.split("/")[2] for u in reqs}) == 1, sorted(set(u.split("/")[2] for u in reqs)))
    else:
        v = vinfo(page)
        check("B: 2D run never left 2D", v["mode"] == "2d" and v["status"] == "idle" and not reqs, f"{v['mode']}/{v['status']} reqs={len(reqs)}")
    errs = errors_of(logs)
    check("B: no console errors or page errors", not errs, errs[:5])
    b.close()


# --------------------------------------------------------------------------- C
def play_keys(page, timeout=90, on_tick=None):
    """Jog with F/J and hold Space (squat) before each hurdle until the race is finished."""
    side = 0
    holding = False
    t0 = time.time()
    s = None
    while time.time() - t0 < timeout:
        s = state(page)
        if s["phase"] == "finished":
            break
        nh = s["nh"]
        if not holding and 3.2 < nh < 5.0:
            page.keyboard.down(" ")
            holding = True
        elif holding and (nh <= 2.6 or nh > 20):
            page.keyboard.up(" ")
            holding = False
        if not holding:
            page.keyboard.press("f" if side == 0 else "j")
            side ^= 1
        if on_tick:
            on_tick(s)
        time.sleep(0.17)
    return s


def test_c(p, flavour):
    is3d = flavour == "3d"
    CURRENT[0] = f"C {flavour}"
    print(f"=== C ({flavour}): keys mode, phone portrait ===")
    b = launch(p)
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    logs, reqs = [], []
    attach_logs(page, logs, reqs)
    route_assets(page, fake=True)
    page.goto(URL + (Q3D if is3d else Q2D))
    sfx = "_" + flavour
    page.wait_for_timeout(600)
    page.screenshot(path=os.path.join(OUT, f"C_intro_phone{sfx}.png"), full_page=False)
    coarse = page.evaluate("() => matchMedia('(pointer: coarse)').matches")
    check("C: the phone has a coarse pointer", coarse is True, coarse)
    check("C: nothing from the three.js CDN is fetched before Start", not reqs, reqs)
    v = vinfo(page)
    check("C: the View radios are shown in the intro", page.is_visible(".pick button[data-view='3d']") and page.is_visible(".pick button[data-view='2d']"))
    if is3d:
        # the intro radios: Classic then 3D chase, persisted
        page.click(".pick button[data-view='2d']")
        v = vinfo(page)
        check("C: choosing Classic in the intro is saved", v["saved"] == '"2d"' and v["pref"] == "2d", v["saved"])
        check("C: ... and fetches nothing", not reqs, reqs)
        page.click(".pick button[data-view='3d']")
        v = vinfo(page)
        check("C: choosing 3D chase in the intro is saved as auto and starts loading", v["saved"] == '"auto"' and v["status"] in ("loading", "ready"), f"{v['saved']} {v['status']}")
        ok = check("C: the 3D view comes up behind the intro", wait_js(page, READY_3D, 45), vinfo(page))
        if not ok:
            b.close()
            return
        page.screenshot(path=os.path.join(OUT, f"C_intro_3d_behind{sfx}.png"))
        page.evaluate(SIGHT_WATCH)
    else:
        check("C: renderer=2d stays 2D", v["mode"] == "2d" and v["status"] == "idle", f"{v['mode']}/{v['status']}")
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(300)
    if is3d:
        ok = check("C: the 3D view is up in ready", wait_js(page, READY_3D, 45), vinfo(page))
        if not ok:
            b.close()
            return
        three_checks(page, "C")
    page.screenshot(path=os.path.join(OUT, f"C_ready_phone{sfx}.png"))
    if is3d:
        # the toggle: chip to 2D, key V back to 3D
        page.click("#btnView")
        check("C: the chip switches to 2D", wait_js(page, MODE_2D, 10), vinfo(page))
        v = vinfo(page)
        check("C: ... which is saved, shows the 2D canvas again and hides the 3D one", v["saved"] == '"2d"' and not v["hidden2d"] and v["w2d"] > 1 and v["hidden3d"], v)
        check("C: ... and the chip says so", v["chipPressed"] == "false", v["chipPressed"])
        page.screenshot(path=os.path.join(OUT, f"C_ready_phone_toggled2d{sfx}.png"))
        page.keyboard.press("v")
        check("C: key V switches back to 3D", wait_js(page, READY_3D, 30), vinfo(page))
        v = vinfo(page)
        check("C: ... and the 2D layer is released again", wait_js(page, "() => document.getElementById('world').hidden", 5), v)
    page.keyboard.press("Enter")
    t0 = time.time()
    while state(page)["phase"] != "running" and time.time() - t0 < 8:
        time.sleep(0.05)
    if is3d:
        page.keyboard.press("v")
        page.wait_for_timeout(250)
        v = vinfo(page)
        check("C: V does nothing in a race", v["mode"] == "3d" and v["chipDisabled"], f"{v['mode']} disabled={v['chipDisabled']}")
    shot = {"mid": False, "s14": False}
    got = {"first": False, "probe": False}
    probes = {}

    def on_tick(s):
        if is3d and s["phase"] == "running" and not got["first"] and s["x"] >= 10:
            got["first"] = True
            probes["stats_first"] = page.evaluate("() => window.laneFour.view.scene.stats()")
        if s["phase"] == "running" and not shot["s14"] and s["nh"] <= 14.6:
            shot["s14"] = True
            page.screenshot(path=os.path.join(OUT, f"C_sight14_phone{sfx}.png"))
        if not shot["mid"] and s["x"] > 40:
            shot["mid"] = True
            page.screenshot(path=os.path.join(OUT, f"C_race_phone{sfx}.png"))
            if is3d:
                probes["probe"] = page.evaluate("() => window.laneFour.view.scene.probe()")
                probes["stats_mid"] = page.evaluate("() => window.laneFour.view.scene.stats()")
                probes["cam"] = page.evaluate(CAM_CHECK)

    s = play_keys(page, 90, on_tick)
    page.wait_for_timeout(2600)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "finishTime", "stats")}))
    page.screenshot(path=os.path.join(OUT, f"C_results_phone{sfx}.png"))
    check("C: the race finished", s["phase"] == "finished", s["phase"])
    check("C: every hurdle was either cleared or clipped", s["stats"]["cleared"] + s["stats"]["clipped"] == 5, s["stats"])
    if is3d:
        probes["stats_end"] = page.evaluate("() => window.laneFour.view.scene.stats()")
        three_race_checks(page, "C", probes)
        sight_checks(page, "C")
    # rotate to landscape and race again
    page.set_viewport_size({"width": 844, "height": 390})
    if is3d:
        ok = wait_js(page, "() => { const s = window.laneFour.view.scene.stats(); return s.rig === 'wide' && s.cssWidth === 844 && s.cssHeight === 390 }", 10)
        st = page.evaluate("() => window.laneFour.view.scene.stats()")
        cw = page.evaluate("() => { const c = document.getElementById('world3d'); return [c.width, c.height, c.clientWidth, c.clientHeight] }")
        check("C: after rotating to 844x390 the rig class is wide", ok, f"{st['rig']} {st['cssWidth']}x{st['cssHeight']}")
        check("C: ... and the backing size is css size times the pixel ratio", cw[0] == int(844 * st["pixelRatio"]) and cw[1] == int(390 * st["pixelRatio"]), f"{cw} pr={st['pixelRatio']}")
    else:
        page.wait_for_timeout(500)
    page.wait_for_timeout(400)
    page.click("#btnAgain")
    page.wait_for_timeout(3600)
    for _ in range(14):
        page.keyboard.press("f")
        page.wait_for_timeout(90)
        page.keyboard.press("j")
        page.wait_for_timeout(90)
    page.screenshot(path=os.path.join(OUT, f"C_race_landscape{sfx}.png"))
    side = 0
    t0 = time.time()
    while time.time() - t0 < 30:  # keep jogging until the first hurdle is 14 m away
        nh = state(page)["nh"]
        if nh <= 14.0:
            break
        page.keyboard.press("f" if side == 0 else "j")
        side ^= 1
        time.sleep(0.09)
    page.screenshot(path=os.path.join(OUT, f"C_sight14_landscape{sfx}.png"))
    page.click("#btnSignals")
    page.wait_for_timeout(600)
    page.screenshot(path=os.path.join(OUT, f"C_signals_landscape{sfx}.png"))
    readout = page.inner_text("#readout")
    if is3d:
        sight_checks(page, "C (after rotating)", rig="wide")
        check("C: the Signals panel shows the 3D view line", re.search(r"View: 3D chase · T3 · \d+ fps \(p95 \d+ ms\) · [\d.]+ MP · \d+ calls · [\d.]+k tris · wide", readout) is not None, readout)
    else:
        check("C: the Signals panel says the classic view was chosen", "View: classic 2D (chosen)" in readout, readout)
        check("C: renderer=2d never fetched three.js", not reqs, reqs)
    errs = errors_of(logs)
    check("C: no console errors or page errors", not errs, errs[:5])
    b.close()


# --------------------------------------------------------------------------- D
def test_d(p):
    CURRENT[0] = "D"
    print("=== D: three.js unreachable (routes aborted), default URL ===")
    b = launch(p)
    ctx = b.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    logs, reqs = [], []
    attach_logs(page, logs, reqs)
    route_assets(page, fake=True, block_three=True)
    page.goto(URL)
    ok = wait_js(page, "() => window.laneFour.view.status === 'failed'", 30)
    v = vinfo(page)
    check("D: view.status becomes failed", ok, v)
    check("D: the toast is shown", "3D view unavailable. Using the classic view." in v["toast"], v["toast"])
    page.screenshot(path=os.path.join(OUT, "D_toast_intro.png"))
    check("D: both CDN hosts were tried, once each", len(reqs) >= 2 and len({u.split("/")[2] for u in reqs}) == 2 and len(reqs) == len(set(reqs)), reqs)
    check("D: the player is in 2D", v["mode"] == "2d" and not v["hidden2d"] and v["w2d"] > 1 and v["hidden3d"], v)
    check("D: the View chip is disabled and says why", v["chipDisabled"] and "unavailable" in v["chipTitle"], v["chipTitle"])
    page.wait_for_timeout(4600)
    check("D: the toast goes away by itself", vinfo(page)["toast"] == "", vinfo(page)["toast"])
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, "D_ready.png"))
    page.keyboard.press("Enter")
    t0 = time.time()
    while state(page)["phase"] != "running" and time.time() - t0 < 8:
        time.sleep(0.05)
    s = play_keys(page, 90)
    page.wait_for_timeout(2600)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "finishTime", "stats")}))
    page.screenshot(path=os.path.join(OUT, "D_results.png"))
    check("D: the race finished in 2D", s["phase"] == "finished" and vinfo(page)["mode"] == "2d", s["phase"])
    page.keyboard.press("d")
    page.wait_for_timeout(600)
    readout = page.inner_text("#readout")
    check("D: the Signals panel says why", "View: classic 2D (3D unavailable:" in readout, readout)
    check("D: a warning was logged", any(l.startswith("[warning]") and "3D view unavailable" in l for l in logs), [l for l in logs if "3D" in l][:3])
    errs = errors_of(logs, allow=("ERR_FAILED",))
    check("D: no console or page errors besides the aborted requests", not errs, errs[:5])
    b.close()


# --------------------------------------------------------------------------- E
def test_e(p):
    CURRENT[0] = "E"
    print("=== E: graphics context lost in ready, then one retry ===")
    b = launch(p)
    ctx = b.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    logs, reqs = [], []
    attach_logs(page, logs, reqs)
    route_assets(page, fake=True)
    page.goto(URL + Q3D)
    if not check("E: the 3D view is up", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(500)
    check("E: waiting in ready", state(page)["phase"] == "ready", state(page)["phase"])
    page.evaluate("() => window.laneFour.view.scene.forceContextLoss()")
    ok = wait_js(page, MODE_2D, 15)
    v = vinfo(page)
    check("E: the player lands in 2D", ok and not v["hidden2d"] and v["hidden3d"] and not v["on3d"], v)
    check("E: view.status is failed with the reason context-lost", v["status"] == "failed" and v["reason"] == "context-lost" and not v["hasScene"], f"{v['status']} {v['reason']}")
    check("E: the toast is shown", "3D view unavailable. Using the classic view." in v["toast"], v["toast"])
    check("E: the chip offers one retry", not v["chipDisabled"] and "again" in v["chipTitle"], v["chipTitle"])
    check("E: the 2D canvas is back at full size", v["w2d"] >= 1280, v["w2d"])
    page.wait_for_timeout(500)
    page.screenshot(path=os.path.join(OUT, "E_after_loss.png"))
    page.keyboard.press("Enter")
    t0 = time.time()
    while state(page)["phase"] != "running" and time.time() - t0 < 8:
        time.sleep(0.05)
    check("E: the race starts in 2D", state(page)["phase"] == "running", state(page)["phase"])
    s = play_keys(page, 90)
    page.wait_for_timeout(2600)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "finishTime", "stats")}))
    page.screenshot(path=os.path.join(OUT, "E_results.png"))
    check("E: the race finished", s["phase"] == "finished", s["phase"])
    check("E: it was 2D all the way", vinfo(page)["mode"] == "2d", vinfo(page)["mode"])
    # the one retry, with the module already loaded
    page.keyboard.press("v")  # the results sheet covers the chip, key V does the same
    ok = wait_js(page, READY_3D, 30)
    v = vinfo(page)
    check("E: the toggle brings 3D back once", ok and v["retried"] is True and v["status"] == "ready", v)
    page.screenshot(path=os.path.join(OUT, "E_retry_3d.png"))
    page.evaluate("() => window.laneFour.view.scene.forceContextLoss()")
    ok = wait_js(page, MODE_2D, 15)
    v = vinfo(page)
    check("E: a second loss lands in 2D", ok and v["status"] == "failed", v)
    check("E: ... and now the chip is disabled for good", v["chipDisabled"] and "unavailable" in v["chipTitle"], v["chipTitle"])
    errs = errors_of(logs)
    check("E: no console or page errors", not errs, errs[:5])
    b.close()


def run(name, fn, *args):
    try:
        fn(*args)
    except Exception:  # a crash in one run is a failure, and the others still run
        traceback.print_exc()
        FAILURES.append(f"{name}: crashed, see the traceback above")


with sync_playwright() as p:
    if any(c in WHICH for c in "BCDE"):
        run("drift", drift_guard)
    if "A" in WHICH:
        run("A", test_a, p)
    if "B" in WHICH:
        if HAVE_THREE:
            run("B 3d", test_b, p, "3d")
        else:
            print("SKIP B as 3D: node_modules/three is missing (run npm install)")
        run("B 2d", test_b, p, "2d")
    if "C" in WHICH:
        if HAVE_THREE:
            run("C 3d", test_c, p, "3d")
        else:
            print("SKIP C as 3D: node_modules/three is missing (run npm install)")
        run("C 2d", test_c, p, "2d")
    if "D" in WHICH:
        run("D", test_d, p)
    if "E" in WHICH:
        if HAVE_THREE:
            run("E", test_e, p)
        else:
            print("SKIP E: node_modules/three is missing (run npm install)")
srv.shutdown()

print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) FAILED:")
    for f in FAILURES:
        print("  - " + f)
    sys.exit(1)
print("all checks passed")
