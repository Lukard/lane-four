"""Headless browser checks for Lane Four. Strict: every check is counted, a failed one makes the
process exit 1.

3D is the renderer: the page loads three.js at load time on every device, draws nothing in 2D while it
does, and only a hard failure (or the developer parameter ?renderer=2d) shows the classic view.

A: real MediaPipe + fake camera (a still photo)   -> model loads, landmarks flow (not strict)
B: scripted bot through the camera path, 200 m     -> full race on a desktop, run as 3D and as ?renderer=2d
C: keys mode on a phone-sized viewport             -> 3D at the intro with no 2D phase (also with a 2g /
                                                      data-saver connection and a stale saved '2d'), no view
                                                      controls, no storage writes, race, results, rotate;
                                                      as ?renderer=2d; and with a late three.js: Start waits
                                                      ("Loading stadium"), race 1 is already 3D
D: three.js unreachable / WebGL2 cannot start       -> hard failure: classic view, a persistent notice with a
                                                      Reload button, the Signals line says why, race plays in 2D
E: graphics context loss                            -> recovered in place in 3D in every phase, a loss during
                                                      a race pauses it and resumes it, re-creation on a fresh
                                                      canvas when no restore comes, a loss after a speed
                                                      fallback, a transient getContext failure, repeated loss

Usage:  python3 test/browser_test.py [A][B][C][D][E]     (default: BCDE)

B (as 2D) and D need only Playwright (pip install playwright && python3 -m playwright install
chromium). Every 3D run (B, C, E) also needs `npm install`: they serve three.js from
node_modules/three, which stands in for the CDN. Without it they print SKIP and D still runs. A also
needs local copies of what the page loads from the network, see README.md. Screenshots go to
test/shots/ (suffix _3d or _2d for the two views).

The 3D runs use ?tier=3: the lowest quality tier on SwiftShader, locked so the quality controller cannot
change it under the test.
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
Q3D = "?tier=3"
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


class Hold:
    """A delayed CDN: while active, every three.js request waits until release() lets it through."""

    def __init__(self):
        self.active = True
        self.routes = []

    def release(self):
        self.active = False
        held, self.routes = self.routes, []
        for route, name in held:
            serve_three(route, name)


def serve_three(route, name):
    if name == "three.module.min.js":
        return route.fulfill(path=os.path.join(THREE_BUILD, "three.module.js"), content_type="text/javascript", headers=CORS)
    if name in ("three.core.min.js", "three.core.js"):
        return route.fulfill(path=os.path.join(THREE_BUILD, "three.core.js"), content_type="text/javascript", headers=CORS)
    return route.abort()

FAILURES = []
CURRENT = ["-"]


def check(name, ok, detail=""):
    shown = str(detail)
    if ok and len(shown) > 220:  # a passing check keeps the log short; a failing one prints everything
        shown = shown[:220] + "..."
    print(("  ok   " if ok else "  FAIL ") + name + (f"   [{shown if ok else detail}]" if detail != "" else ""))
    if not ok:
        FAILURES.append(f"{CURRENT[0]}: {name} {detail}".strip())
    return bool(ok)


def route_assets(page, fake=False, block_three=False, hold=None):
    """Stand-in for the network. three.js comes from node_modules/three for both CDN hosts: the
    minified module is the plain module and the minified core is the plain core. Any other three
    URL, and every three URL when block_three is set, is aborted. With a Hold, three.js requests
    wait until hold.release()."""
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
            if hold is not None and hold.active:
                hold.routes.append((route, name))
                return None
            return serve_three(route, name)
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
        w = document.getElementById('world'), n = document.getElementById('notice'),
        bc = document.getElementById('btnCamera'), bm = document.getElementById('btnManual');
        if (s && !s.__id) s.__id = (window.__sid = (window.__sid || 0) + 1);
        return { mode: v.mode, status: v.status, reason: v.reason, shown: v.shown, lost: v.lost, attempts: v.attempts, losses: v.losses,
        hasScene: !!s, sceneId: s ? s.__id : 0, tier: s ? s.tier : null, drawn: s ? s.drawn : 0,
        on3d: c.classList.contains('on'), hidden3d: c.hidden, hidden2d: w.hidden, w2d: w.width,
        engine: c.dataset.engine || '', events: v.events.map((e) => e.event),
        noticeKind: n.hidden ? '' : n.dataset.kind, noticeText: n.hidden ? '' : (document.getElementById('noticeTitle').textContent + ' ' + document.getElementById('noticeBody').textContent).trim(),
        reloadShown: !document.getElementById('btnReload').hidden,
        startDisabled: [bc.disabled, bm.disabled], startText: [bc.textContent, bm.textContent],
        saved: localStorage.getItem('lanefour.renderer') }; }"""
    )


def wait_js(page, expr, timeout=30.0, step=0.1):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if page.evaluate(expr):
            return True
        time.sleep(step)
    return False


READY_3D = "() => { const v = window.laneFour.view; return v.mode === '3d' && v.shown && !!v.scene && v.scene.drawn > 4 }"


# Runs in every page before the app: seeds a stale saved View choice and a data-saver connection on request,
# counts localStorage writes, lets a test hide the tab, and watches every frame for the classic canvas showing
# while the page is meant to be in 3D (there must be no 2D phase).
WATCH = """(() => {
  window.__sets = []; window.__bad = [];
  try { if (window.__seedStale) localStorage.setItem('lanefour.renderer', JSON.stringify('2d')); } catch (e) {}
  const so = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { window.__sets.push(String(k)); return so.apply(this, arguments); };
  const H = window.__h = { hidden: false };
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => H.hidden });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (H.hidden ? 'hidden' : 'visible') });
  const loop = () => {
    requestAnimationFrame(loop);
    const lf = window.laneFour; if (!lf) return;
    const w = document.getElementById('world');
    if (!w.hidden && lf.view.mode === '3d' && window.__bad.length < 10) window.__bad.push('2D canvas visible, status ' + lf.view.status);
  };
  requestAnimationFrame(loop);
})();"""
CONNECTION_2G = """Object.defineProperty(navigator, 'connection', { configurable: true,
  value: { effectiveType: '2g', saveData: true, downlink: 0.1, addEventListener() {}, removeEventListener() {} } });"""
STALE_2D = "window.__seedStale = true;"


def new_page(b, viewport, scale=1, touch=False, permissions=None, init=(), **route):
    kw = dict(viewport=viewport, device_scale_factor=scale)
    if touch:
        kw.update(has_touch=True, is_mobile=True)
    if permissions:
        kw["permissions"] = permissions
    ctx = b.new_context(**kw)
    for script in list(init) + [WATCH]:
        ctx.add_init_script(script)
    page = ctx.new_page()
    logs, reqs = [], []
    attach_logs(page, logs, reqs)
    route_assets(page, **route)
    return page, logs, reqs


def no_2d_phase(page, label):
    bad = page.evaluate("() => window.__bad")
    check(f"{label}: the classic canvas was never visible while the page was in 3D (no 2D phase)", not bad, bad[:3])


def no_toggle_checks(page, label):
    """There is no player-facing View control, no V key and no saved View choice."""
    n = page.evaluate("""() => ({ chip: !!document.getElementById('btnView'), radios: document.querySelectorAll('[data-view]').length,
        group: document.querySelectorAll('[aria-label="View"]').length, toast: !!document.getElementById('toast') })""")
    check(f"{label}: no View chip, no View radios, no toast element", not n["chip"] and n["radios"] == 0 and n["group"] == 0 and not n["toast"], n)
    before = vinfo(page)
    page.keyboard.press("v")
    page.keyboard.press("V")
    page.wait_for_timeout(300)
    after = vinfo(page)
    check(f"{label}: key V does nothing", (before["mode"], before["status"], before["sceneId"]) == (after["mode"], after["status"], after["sceneId"]), f"{before['mode']}/{before['status']} -> {after['mode']}/{after['status']}")


def storage_checks(page, label):
    sets = page.evaluate("() => window.__sets")
    check(f"{label}: nothing wrote the saved View choice (lanefour.renderer), and it is absent", "lanefour.renderer" not in sets and vinfo(page)["saved"] is None, [k for k in sets if "renderer" in k])


def no_swap_checks(page, label):
    v = vinfo(page)
    bad = [e for e in v["events"] if e in ("recreate", "hard-failure", "classic")]
    check(f"{label}: the view never left 3D (no re-creation, no failure, no classic)", v["mode"] == "3d" and not bad, f"{v['mode']} {bad}")
    no_2d_phase(page, label)


def lose(page):
    page.evaluate("() => window.laneFour.view.scene.forceContextLoss()")


def restore(page):
    """The browser gives the context back. A no-op when the page has already given up on that scene."""
    page.evaluate("() => { const s = window.laneFour.view.scene; if (s) s.forceContextRestore(); }")


def set_hidden(page, hidden):
    page.evaluate("(h) => { window.__h.hidden = h; document.dispatchEvent(new Event('visibilitychange')); }", hidden)


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
    page, logs, reqs = new_page(b, {"width": 1280, "height": 800}, permissions=["camera"], fake=True)
    page.goto(URL + (Q3D if is3d else Q2D))
    sfx = "_" + flavour
    probes = {}
    if is3d:
        ok = check("B: the 3D view is up at the intro, before Start is pressed", wait_js(page, READY_3D, 45), vinfo(page))
        if not ok:
            b.close()
            return
        three_checks(page, "B")
        check("B: three.js was requested at page load", len(reqs) >= 1, reqs)
        no_toggle_checks(page, "B")
        page.evaluate(SIGHT_WATCH)
    else:
        page.wait_for_timeout(1200)
        v = vinfo(page)
        check("B: ?renderer=2d shows the classic view at once, Start is enabled, three.js is never requested",
              v["mode"] == "2d" and v["status"] == "off" and not v["hidden2d"] and v["w2d"] > 1 and v["startDisabled"] == [False, False] and not reqs,
              f"{v['mode']}/{v['status']} reqs={len(reqs)} start={v['startDisabled']}")
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
        check("B: still 3D at the end", v["mode"] == "3d" and v["status"] == "ready", f"{v['mode']}/{v['status']}")
        no_swap_checks(page, "B")
        storage_checks(page, "B")
        core_min = [u for u in reqs if u.endswith("three.core.min.js")]
        core_plain = [u for u in reqs if u.endswith("/three.core.js")]
        check("B: the import map swapped in the minified core", len(core_min) >= 1 and not core_plain, f"min={len(core_min)} plain={len(core_plain)}")
        check("B: three.js was fetched from one host", len({u.split("/")[2] for u in reqs}) == 1, sorted(set(u.split("/")[2] for u in reqs)))
    else:
        v = vinfo(page)
        check("B: the 2D run never left 2D", v["mode"] == "2d" and v["status"] == "off" and not reqs, f"{v['mode']}/{v['status']} reqs={len(reqs)}")
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
    """flavour: 3d (immediate three.js; a 2g data-saver connection and a stale saved '2d' must change
    nothing), 2d (?renderer=2d) or late (three.js is held back for a few seconds)."""
    is3d = flavour in ("3d", "late")
    late = flavour == "late"
    CURRENT[0] = f"C {flavour}"
    print(f"=== C ({flavour}): keys mode, phone portrait ===")
    b = launch(p)
    hold = Hold() if late else None
    init = [STALE_2D, CONNECTION_2G] if flavour == "3d" else []
    page, logs, reqs = new_page(b, {"width": 390, "height": 844}, scale=2, touch=True, init=init, fake=True, hold=hold)
    page.goto(URL + (Q2D if flavour == "2d" else Q3D))
    sfx = "_" + flavour
    page.wait_for_timeout(600)
    coarse = page.evaluate("() => matchMedia('(pointer: coarse)').matches")
    check("C: the phone has a coarse pointer", coarse is True, coarse)
    if flavour == "3d":
        check("C: the page is on a 2g, data-saver connection with a stale saved '2d'", page.evaluate("() => navigator.connection.effectiveType === '2g' && navigator.connection.saveData === true && window.__seedStale === true"))
    if late:
        check("C: three.js was requested at page load, even on a phone", len(reqs) >= 1, reqs)
        page.wait_for_timeout(1400)
        v = vinfo(page)
        check("C: while three.js loads the page waits in 3D mode with nothing drawn (status loading, no scene, no canvas showing)",
              v["status"] == "loading" and v["mode"] == "3d" and not v["hasScene"] and v["hidden2d"] and not v["on3d"], v)
        check("C: ... and both Start buttons are disabled and say Loading stadium", v["startDisabled"] == [True, True] and all(t.startswith("Loading stadium") for t in v["startText"]), v["startText"])
        page.screenshot(path=os.path.join(OUT, f"C_intro_loading_phone{sfx}.png"))
        page.evaluate("() => { document.getElementById('btnManual').click(); document.getElementById('btnCamera').click(); }")
        page.wait_for_timeout(300)
        check("C: pressing Start while it loads does nothing", state(page)["phase"] == "intro", state(page)["phase"])
        page.wait_for_timeout(1500)
        check("C: still loading after three more seconds, nothing swapped in", vinfo(page)["status"] == "loading" and vinfo(page)["hidden2d"], vinfo(page)["status"])
        hold.release()
        ok = check("C: the 3D view comes up at the intro once three.js arrives", wait_js(page, READY_3D, 45), vinfo(page))
        if not ok:
            b.close()
            return
        v = vinfo(page)
        check("C: ... and Start is offered", v["startDisabled"] == [False, False] and v["startText"] == ["Start with camera", "Play with keys or touch"], v["startText"])
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(OUT, f"C_intro_phone{sfx}.png"), full_page=False)
        page.evaluate(SIGHT_WATCH)
    elif is3d:
        ok = check("C: the 3D view is up at the intro on a phone, before Start is pressed", wait_js(page, READY_3D, 45), vinfo(page))
        if not ok:
            b.close()
            return
        check("C: three.js was requested at page load (a 2g data-saver connection changes nothing)", len(reqs) >= 1, reqs)
        check("C: the stale saved '2d' is deleted at boot and was never written back", vinfo(page)["saved"] is None)
        page.wait_for_timeout(400)
        page.screenshot(path=os.path.join(OUT, f"C_intro_phone{sfx}.png"), full_page=False)
        page.evaluate(SIGHT_WATCH)
    else:
        page.screenshot(path=os.path.join(OUT, f"C_intro_phone{sfx}.png"), full_page=False)
        v = vinfo(page)
        check("C: ?renderer=2d shows the classic view, status off, three.js never requested", v["mode"] == "2d" and v["status"] == "off" and not v["hidden2d"] and not reqs, f"{v['mode']}/{v['status']} reqs={len(reqs)}")
    if is3d:
        no_toggle_checks(page, "C")
        scene_at_start = vinfo(page)["sceneId"]
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
    page.keyboard.press("Enter")
    t0 = time.time()
    while state(page)["phase"] != "running" and time.time() - t0 < 8:
        time.sleep(0.05)
    if is3d:
        v = vinfo(page)
        check("C: race 1 starts in 3D" + (" (three.js arrived late)" if late else ""), state(page)["phase"] == "running" and v["mode"] == "3d" and v["shown"] and v["on3d"], v)
        page.keyboard.press("v")
        page.wait_for_timeout(250)
        v = vinfo(page)
        check("C: V does nothing in a race", v["mode"] == "3d" and v["sceneId"] == scene_at_start, f"{v['mode']} scene {v['sceneId']} vs {scene_at_start}")
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
    if late:
        # "Race again" after a late three.js must stay in 3D with the same scene: nothing swaps in behind the player
        page.wait_for_timeout(400)
        page.click("#btnAgain")
        page.wait_for_timeout(2500)
        v = vinfo(page)
        check("C: Race again after a late three.js is still 3D, the same scene, no swap", v["mode"] == "3d" and v["sceneId"] == scene_at_start and v["status"] == "ready" and v["hidden2d"], v)
        page.screenshot(path=os.path.join(OUT, f"C_race_again_phone{sfx}.png"))
        no_swap_checks(page, "C")
        storage_checks(page, "C")
        errs = errors_of(logs)
        check("C: no console errors or page errors", not errs, errs[:5])
        b.close()
        return
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
        check("C: ... and the last view events", "three-loaded" in readout and "revealed" in readout, readout)
        v = vinfo(page)
        check("C: the whole session used one scene", v["sceneId"] == scene_at_start, f"{scene_at_start} -> {v['sceneId']}")
        no_swap_checks(page, "C")
        storage_checks(page, "C")
    else:
        check("C: the Signals panel says the classic view is the developer override", "View: classic 2D (?renderer=2d, the developer override)" in readout, readout)
        check("C: ?renderer=2d never fetched three.js", not reqs, reqs)
    errs = errors_of(logs)
    check("C: no console errors or page errors", not errs, errs[:5])
    b.close()


# --------------------------------------------------------------------------- D
def hard_failure_checks(page, label, why):
    v = vinfo(page)
    check(f"{label}: view.status is failed and the page is in 2D", v["status"] == "failed" and v["mode"] == "2d" and not v["hidden2d"] and v["w2d"] > 1 and v["hidden3d"], v)
    check(f"{label}: a persistent notice says why", v["noticeKind"] == "failed" and "3D view unavailable" in v["noticeText"] and why in v["noticeText"], v["noticeText"])
    check(f"{label}: ... with a Reload button", v["reloadShown"])
    check(f"{label}: Start is enabled, in the classic view", v["startDisabled"] == [False, False] and v["startText"] == ["Start with camera", "Play with keys or touch"], v["startText"])
    check(f"{label}: the view events say hard-failure", "hard-failure" in v["events"], v["events"])


def test_d(p):
    CURRENT[0] = "D"
    print("=== D: three.js unreachable (routes aborted), default URL ===")
    b = launch(p)
    page, logs, reqs = new_page(b, {"width": 1280, "height": 800}, fake=True, block_three=True)
    page.goto(URL)
    ok = wait_js(page, "() => window.laneFour.view.status === 'failed'", 30)
    check("D: view.status becomes failed", ok, vinfo(page))
    hard_failure_checks(page, "D", "Could not load three.js")
    page.screenshot(path=os.path.join(OUT, "D_notice_intro.png"))
    check("D: both CDN hosts were tried, once each", len(reqs) >= 2 and len({u.split("/")[2] for u in reqs}) == 2 and len(reqs) == len(set(reqs)), reqs)
    page.wait_for_timeout(5600)
    v = vinfo(page)
    check("D: the notice does not go away by itself (a toast would have, after 4 s)", v["noticeKind"] == "failed" and v["reloadShown"], v["noticeKind"])
    no_toggle_checks(page, "D")
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, "D_ready.png"))
    page.keyboard.press("Enter")
    t0 = time.time()
    while state(page)["phase"] != "running" and time.time() - t0 < 8:
        time.sleep(0.05)
    page.wait_for_timeout(1500)
    page.keyboard.press("f")
    page.screenshot(path=os.path.join(OUT, "D_race_notice.png"))
    s = play_keys(page, 90)
    page.wait_for_timeout(2600)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "finishTime", "stats")}))
    page.screenshot(path=os.path.join(OUT, "D_results.png"))
    check("D: the race finished in 2D", s["phase"] == "finished" and vinfo(page)["mode"] == "2d", s["phase"])
    check("D: the notice is still there at the end", vinfo(page)["noticeKind"] == "failed")
    page.keyboard.press("d")
    page.wait_for_timeout(600)
    readout = page.inner_text("#readout")
    check("D: the Signals panel says why", "View: classic 2D (3D unavailable: Could not load three.js)" in readout, readout)
    check("D: ... and lists the view events", "hard-failure" in readout, readout)
    check("D: a warning was logged", any(l.startswith("[warning]") and "3D view unavailable" in l for l in logs), [l for l in logs if "3D" in l][:3])
    storage_checks(page, "D")
    errs = errors_of(logs, allow=("ERR_FAILED",))
    check("D: no console or page errors besides the aborted requests", not errs, errs[:5])
    # the Reload button reloads the page (which, with the CDN still unreachable, fails the same way)
    with page.expect_navigation():
        page.click("#btnReload")
    check("D: Reload reloads the page, and it fails the same loud way again", wait_js(page, "() => window.laneFour && window.laneFour.view.status === 'failed'", 30) and vinfo(page)["noticeKind"] == "failed", vinfo(page))
    b.close()


# two more ways to be unable to start 3D, both on an otherwise healthy page
NO_WEBGL2_API = "delete window.WebGL2RenderingContext;"
NULL_CONTEXT = """(() => { const o = HTMLCanvasElement.prototype.getContext; window.__gcNull = 0;
  HTMLCanvasElement.prototype.getContext = function (t) { if (t === 'webgl2') { window.__gcNull++; return null; } return o.apply(this, arguments); }; })();"""


def test_d2(p):
    CURRENT[0] = "D2"
    print("=== D2: WebGL2 cannot start ===")
    b = launch(p)
    page, logs, reqs = new_page(b, {"width": 390, "height": 844}, scale=2, touch=True, init=[NO_WEBGL2_API], fake=True)
    page.goto(URL)
    ok = wait_js(page, "() => window.laneFour.view.status === 'failed'", 10)
    check("D2: no WebGL2 at all is an immediate hard failure", ok, vinfo(page))
    hard_failure_checks(page, "D2", "WebGL2 is not available in this browser")
    check("D2: ... without even fetching three.js", not reqs, reqs)
    page.screenshot(path=os.path.join(OUT, "D2_no_webgl2_phone.png"))
    b.close()
    # a context that never comes: a few automatic attempts over a few seconds, then the same hard failure
    b = launch(p)
    page, logs, reqs = new_page(b, {"width": 1280, "height": 800}, init=[NULL_CONTEXT], fake=True)
    page.goto(URL)
    t0 = time.time()
    check("D2: not a failure yet a second in: the page is still trying", wait_js(page, "() => window.__gcNull >= 1", 20) and vinfo(page)["status"] == "loading", vinfo(page))
    ok = wait_js(page, "() => window.laneFour.view.status === 'failed'", 20)
    took = time.time() - t0
    v = vinfo(page)
    check("D2: a context that never comes is a hard failure after the automatic attempts (a few seconds, not at once)", ok and 3.5 < took < 12, f"{took:.1f}s")
    hard_failure_checks(page, "D2", "WebGL2 is not available")
    check("D2: getContext was tried four times (the first, then three automatic attempts)", page.evaluate("() => window.__gcNull") == 4, page.evaluate("() => window.__gcNull"))
    check("D2: the events show the retries", v["events"].count("retry") == 3 and v["events"].count("scene-failed") == 4, v["events"])
    page.screenshot(path=os.path.join(OUT, "D2_null_context.png"))
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(300)
    page.keyboard.press("Enter")
    t0 = time.time()
    while state(page)["phase"] != "running" and time.time() - t0 < 8:
        time.sleep(0.05)
    x0 = state(page)["x"]
    for _ in range(12):
        page.keyboard.press("f")
        page.keyboard.press("j")
        time.sleep(0.15)
    check("D2: the race is playable in 2D", state(page)["x"] > x0 + 3, state(page)["x"])
    b.close()


# --------------------------------------------------------------------------- E
def wait_status(page, status, timeout=15.0):
    return wait_js(page, f"() => window.laneFour.view.status === '{status}'", timeout)


def wait_phase(page, phase, timeout=10.0):
    return wait_js(page, f"() => window.laneFour.state.phase === '{phase}'", timeout)


def keys_to_ready(page, dist="200"):
    page.click(f".pick button[data-dist='{dist}']")
    page.click("#btnManual")
    page.wait_for_timeout(500)


def jog(page, n=8, gap=0.12):
    for k in range(n):
        page.keyboard.press("f" if k % 2 == 0 else "j")
        time.sleep(gap)


def start_race(page):
    page.keyboard.press("Enter")
    return wait_phase(page, "running", 10)


def probe_ok(page, label):
    pr = page.evaluate("() => window.laneFour.view.scene.probe()")
    ok = check(f"{label}: the restored scene draws (probe: >= 4 colours, red track pixel)", pr is not None and pr["distinct"] >= 4 and pr["redDominant"], pr and (pr["distinct"], pr["at"]))
    clear = page.evaluate("() => { const r = window.laneFour.view.scene.parts.renderer, c = new (window.laneFour.view.scene.parts.scene.fog.color.constructor)(); r.getClearColor(c); return c.getHexString(); }")
    return check(f"{label}: ... and its clear colour is still the stadium night (three.js resets it on a restore)", clear == "1b2f5c", clear) and ok


def e_page(p, viewport=None, url=Q3D, init=(), touch=False, scale=1):
    b = launch(p)
    page, logs, reqs = new_page(b, viewport or {"width": 1280, "height": 800}, scale=scale, touch=touch, init=init, fake=True)
    page.goto(URL + url)
    return b, page, logs


def teleport(page):
    page.evaluate("() => { const r = window.laneFour.state.race; if (window.laneFour.state.phase === 'running' && !r.finished) r.x = r.distance - 3; }")


def test_e(p):
    """Every page here stays under 5 context losses in 30 s: more than that is, by design, re-created
    (and, past three automatic attempts, a hard failure), which E repeated tests on purpose."""
    e_in_place(p)
    e_recreate(p)
    e_hidden(p)
    e_speed(p)
    e_transient(p)
    e_repeated(p)


def e_in_place(p):
    CURRENT[0] = "E in place"
    print("=== E: the browser restores a lost context: recovered in place, in every phase ===")
    b, page, logs = e_page(p)
    if not check("E: the 3D view is up", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    v0 = vinfo(page)

    # ---- at the intro
    lose(page)
    check("E: a lost context at the intro is noticed (status restoring)", wait_status(page, "restoring", 5) and vinfo(page)["lost"], vinfo(page))
    v = vinfo(page)
    check("E: ... the scene stays, the picture is never swapped for 2D", v["mode"] == "3d" and v["hasScene"] and v["sceneId"] == v0["sceneId"] and v["hidden2d"], v)
    check("E: ... a Restoring graphics notice is shown and Start says so", v["noticeKind"] == "restoring" and "Restoring graphics" in v["noticeText"] and v["startDisabled"] == [True, True] and all(t.startswith("Restoring graphics") for t in v["startText"]), (v["noticeText"], v["startText"]))
    check("E: ... the notice has no Reload button (it is not a failure)", not v["reloadShown"])
    page.screenshot(path=os.path.join(OUT, "E_restoring_intro.png"))
    page.wait_for_timeout(700)
    restore(page)
    check("E: the browser restores it: back to ready in place, same scene, no re-creation", wait_status(page, "ready", 10), vinfo(page))
    v = vinfo(page)
    check("E: ... the notice is gone and Start is back", v["noticeKind"] == "" and v["startDisabled"] == [False, False] and v["sceneId"] == v0["sceneId"] and v["attempts"] == 0, v)
    check("E: ... and it keeps drawing", wait_js(page, f"() => window.laneFour.view.scene.drawn > {v['drawn']} + 3", 10))
    probe_ok(page, "E")

    # ---- in ready
    keys_to_ready(page)
    check("E: waiting in ready", state(page)["phase"] == "ready", state(page)["phase"])
    lose(page)
    check("E: lost in ready: restoring", wait_status(page, "restoring", 5), vinfo(page))
    restore(page)
    check("E: ... restored in place", wait_status(page, "ready", 10) and vinfo(page)["sceneId"] == v0["sceneId"], vinfo(page))
    probe_ok(page, "E")

    # ---- during a race: paused, frozen, resumed by itself
    check("E: the race starts", start_race(page), state(page)["phase"])
    page.wait_for_timeout(300)
    jog(page, 10)
    lose(page)
    check("E: lost mid-race: the race pauses and says Restoring graphics", wait_status(page, "restoring", 5) and wait_phase(page, "paused", 5), (vinfo(page)["status"], state(page)["phase"]))
    v = vinfo(page)
    check("E: ... a visible Restoring graphics notice that says the race is paused", v["noticeKind"] == "restoring" and "The race is paused" in v["noticeText"], v["noticeText"])
    check("E: ... the pause is for the graphics", page.evaluate("() => window.laneFour.state.pausedReason") == "graphics")
    page.screenshot(path=os.path.join(OUT, "E_restoring_race.png"))
    x0 = state(page)["x"]
    jog(page, 8)
    check("E: ... and the runner does not move while it is paused", abs(state(page)["x"] - x0) < 0.05, (x0, state(page)["x"]))
    restore(page)
    check("E: restored in place: the race resumes by itself", wait_status(page, "ready", 10) and wait_phase(page, "running", 5), (vinfo(page)["status"], state(page)["phase"]))
    check("E: ... on the same scene, no attempt used", vinfo(page)["sceneId"] == v0["sceneId"] and vinfo(page)["attempts"] == 0, vinfo(page))
    probe_ok(page, "E")
    jog(page, 8)
    check("E: ... and the runner runs again", state(page)["x"] > x0 + 0.5, (x0, state(page)["x"]))

    # ---- on the results sheet, then Race again
    teleport(page)
    check("E: the race ends", wait_phase(page, "finished", 15), state(page)["phase"])
    page.wait_for_timeout(2200)
    lose(page)
    check("E: lost on the results sheet: restoring", wait_status(page, "restoring", 5), vinfo(page))
    restore(page)
    check("E: ... restored in place", wait_status(page, "ready", 10) and vinfo(page)["sceneId"] == v0["sceneId"], vinfo(page))
    page.wait_for_timeout(300)
    page.click("#btnAgain")
    check("E: Race again after the loss starts a race in 3D", wait_phase(page, "running", 12) and vinfo(page)["mode"] == "3d", (state(page)["phase"], vinfo(page)["mode"]))
    v = vinfo(page)
    check("E: ... the whole page used one scene and never the classic view", v["sceneId"] == v0["sceneId"] and v["attempts"] == 0 and v["hidden2d"], v)
    no_2d_phase(page, "E")
    storage_checks(page, "E")
    errs = errors_of(logs)
    check("E: no console or page errors (in place)", not errs, errs[:5])
    b.close()


def e_recreate(p):
    CURRENT[0] = "E recreate"
    print("=== E: no restore comes: the scene is re-created on a fresh canvas ===")
    b, page, logs = e_page(p)
    if not check("E: the 3D view is up (recreate)", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    v0 = vinfo(page)
    keys_to_ready(page)

    # ---- lost during the countdown: the gun waits for the graphics
    page.keyboard.press("Enter")
    page.wait_for_timeout(1000)
    check("E: in the countdown", state(page)["phase"] == "countdown", state(page)["phase"])
    page.evaluate("() => { window.__c3 = document.getElementById('world3d'); }")
    lose(page)
    check("E: lost in the countdown: restoring", wait_status(page, "restoring", 5), vinfo(page))
    check("E: ... the race does not start behind a dead picture (it is paused when the countdown ends)", wait_phase(page, "paused", 8) and page.evaluate("() => window.laneFour.state.pausedReason") == "graphics", state(page)["phase"])
    t0 = time.time()
    check("E: ... no restore comes: the scene is re-created (attempt 1) and the race goes", wait_js(page, "() => window.laneFour.view.status === 'ready' && window.laneFour.view.attempts === 1", 15) and wait_phase(page, "running", 5), (vinfo(page)["status"], state(page)["phase"]))
    v = vinfo(page)
    check("E: ... on a fresh canvas and a new scene, still 3D, never 2D", v["sceneId"] != v0["sceneId"] and page.evaluate("() => document.getElementById('world3d') !== window.__c3") and v["on3d"] and v["hidden2d"] and v["mode"] == "3d", v)
    check("E: ... the events tell the story", all(e in v["events"] for e in ("context-lost", "recreate", "retry", "scene-created", "revealed")), v["events"])
    probe_ok(page, "E")
    scene_cur = v["sceneId"]

    # ---- lost mid-race and never restored
    jog(page, 12)
    lose(page)
    check("E: lost mid-race: paused", wait_status(page, "restoring", 5) and wait_phase(page, "paused", 5), vinfo(page))
    t0 = time.time()
    check("E: no restore comes: re-created again (attempt 2), and the race resumes", wait_js(page, "() => window.laneFour.view.status === 'ready' && window.laneFour.view.attempts === 2", 15) and wait_phase(page, "running", 5), vinfo(page))
    took = time.time() - t0
    check("E: ... it waited about 3 s first (not at once, not forever)", 2.5 < took < 8, f"{took:.1f}s")
    v = vinfo(page)
    check("E: ... a new scene again, 3D", v["sceneId"] not in (v0["sceneId"], scene_cur) and v["mode"] == "3d" and v["hidden2d"], v)
    probe_ok(page, "E")
    page.screenshot(path=os.path.join(OUT, "E_recreated_race.png"))
    s = play_keys(page, 90)
    page.wait_for_timeout(2600)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "finishTime", "stats")}))
    page.screenshot(path=os.path.join(OUT, "E_results.png"))
    check("E: the race finished after both re-creations", s["phase"] == "finished", s["phase"])
    v = vinfo(page)
    check("E: ... in 3D all the way (never the classic view)", v["mode"] == "3d" and v["status"] == "ready" and v["hidden2d"], v)
    no_2d_phase(page, "E")
    storage_checks(page, "E")
    errs = errors_of(logs)
    check("E: no console or page errors (recreate)", not errs, errs[:5])
    b.close()


def e_hidden(p):
    CURRENT[0] = "E hidden"
    print("=== E: a loss while the tab is hidden ===")
    b, page, logs = e_page(p)
    if not check("E: the 3D view is up (hidden)", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    scene_before = vinfo(page)["sceneId"]
    keys_to_ready(page)
    set_hidden(page, True)
    page.wait_for_timeout(300)
    lose(page)
    check("E: lost while hidden: restoring", wait_status(page, "restoring", 5), vinfo(page))
    page.wait_for_timeout(4200)
    v = vinfo(page)
    check("E: ... still the same scene after more than the 3 s wait (it waits for the tab to come back)", v["sceneId"] == scene_before and v["attempts"] == 0 and "restore-wait" in v["events"], (v["sceneId"], v["attempts"], v["events"]))
    set_hidden(page, False)
    check("E: ... visible again with a lost context: re-created", wait_js(page, "() => window.laneFour.view.attempts === 1 && window.laneFour.view.status === 'ready'", 15), vinfo(page))
    check("E: ... on a new scene", vinfo(page)["sceneId"] != scene_before, vinfo(page)["sceneId"])
    probe_ok(page, "E")
    errs = errors_of(logs)
    check("E: no console or page errors (hidden)", not errs, errs[:5])
    b.close()


def e_speed(p):
    # A speed fallback of the quality controller, then a loss: the old build swallowed the loss after a fallback
    # and the player saw a blank screen. No ?tier here: a locked tier never asks the controller.
    CURRENT[0] = "E speed"
    print("=== E: a speed fallback, then a loss ===")
    b, page, logs = e_page(p, viewport={"width": 390, "height": 844}, url="", touch=True)
    if not check("E: the 3D view is up (unlocked tier)", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    scene_before = vinfo(page)["sceneId"]
    page.evaluate("() => { window.laneFour.view.scene.parts.ctl.check = () => 'to2d'; }")
    check("E: a speed fallback verdict is noted and ignored: still 3D, same scene, nothing shown", wait_js(page, "() => window.laneFour.view.events.some((e) => e.event === 'speed-fallback-ignored')", 15) and vinfo(page)["mode"] == "3d" and vinfo(page)["sceneId"] == scene_before and vinfo(page)["noticeKind"] == "" and vinfo(page)["hidden2d"], vinfo(page)["events"])
    page.evaluate("() => { delete window.laneFour.view.scene.parts.ctl.check; }")
    lose(page)
    check("E: a loss after a speed fallback is still seen (not swallowed)", wait_status(page, "restoring", 5), vinfo(page))
    restore(page)
    check("E: ... and recovered, drawing, not a blank screen", wait_status(page, "ready", 10), vinfo(page))
    probe_ok(page, "E")
    lose(page)
    check("E: ... and a second loss with no restore is re-created", wait_status(page, "restoring", 5) and wait_js(page, "() => window.laneFour.view.status === 'ready' && window.laneFour.view.attempts === 1", 15), vinfo(page))
    probe_ok(page, "E")
    # a scene whose render() throws, frame after frame, is given up on and made again
    a0 = vinfo(page)["attempts"]
    page.evaluate("() => { window.laneFour.view.scene.parts.renderer.render = () => { throw new Error('boom'); }; }")
    check("E: a scene whose render() throws three frames in a row is re-created", wait_js(page, f"() => window.laneFour.view.status === 'ready' && window.laneFour.view.attempts === {a0} + 1", 15) and "render-error" in vinfo(page)["events"], vinfo(page)["events"])
    probe_ok(page, "E")
    page.screenshot(path=os.path.join(OUT, "E_after_speed_fallback_phone.png"))
    errs = errors_of(logs)
    check("E: no console or page errors (speed)", not errs, errs[:5])
    b.close()


def e_transient(p):
    # One null getContext is transient: the page retries and comes up in 3D
    CURRENT[0] = "E transient"
    print("=== E: a transient getContext failure ===")
    flaky = """(() => { const o = HTMLCanvasElement.prototype.getContext; window.__gcNull = 0;
      HTMLCanvasElement.prototype.getContext = function (t) { if (t === 'webgl2' && window.__gcNull < 1) { window.__gcNull++; return null; } return o.apply(this, arguments); }; })();"""
    b, page, logs = e_page(p, viewport={"width": 390, "height": 844}, init=[flaky], touch=True, scale=2)
    ok = wait_js(page, READY_3D, 45)
    v = vinfo(page)
    check("E: one failed getContext: the 3D view comes up anyway after one automatic retry", ok and v["attempts"] == 1 and v["mode"] == "3d", v)
    check("E: ... the events show it (scene-failed, retry, scene-created) and no failure", "scene-failed" in v["events"] and "retry" in v["events"] and "hard-failure" not in v["events"], v["events"])
    check("E: ... never the classic view", v["hidden2d"] and v["noticeKind"] == "", v)
    no_2d_phase(page, "E")
    page.screenshot(path=os.path.join(OUT, "E_transient_phone.png"))
    errs = errors_of(logs)
    check("E: no console or page errors (transient)", not errs, errs[:5])
    b.close()


def e_repeated(p):
    # Repeated loss: three automatic attempts, then the hard failure with the notice
    CURRENT[0] = "E repeated"
    print("=== E: repeated context loss ends in the hard failure ===")
    b, page, logs = e_page(p)
    if not check("E: the 3D view is up (repeated)", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    for attempt in (1, 2, 3):
        lose(page)
        wait_status(page, "restoring", 5)
        page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")  # visible with a lost context: re-create at once
        ok = wait_js(page, f"() => window.laneFour.view.status === 'ready' && window.laneFour.view.attempts === {attempt}", 15)
        check(f"E: loss {attempt}: automatic attempt {attempt} brings a new scene", ok, vinfo(page))
    lose(page)
    wait_status(page, "restoring", 5)
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    check("E: the fourth failure is a hard failure", wait_status(page, "failed", 15), vinfo(page))
    hard_failure_checks(page, "E", "keeps failing")
    page.screenshot(path=os.path.join(OUT, "E_hard_failure.png"))
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(300)
    page.keyboard.press("Enter")
    check("E: the race can still be played in the classic view", wait_phase(page, "running", 10), state(page)["phase"])
    x0 = state(page)["x"]
    jog(page, 12)
    check("E: ... and it runs", state(page)["x"] > x0 + 2, state(page)["x"])
    errs = errors_of(logs)
    check("E: no console or page errors (repeated)", not errs, errs[:5])
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
            run("C late", test_c, p, "late")
        else:
            print("SKIP C as 3D and with a late three.js: node_modules/three is missing (run npm install)")
        run("C 2d", test_c, p, "2d")
    if "D" in WHICH:
        run("D", test_d, p)
        if HAVE_THREE:
            run("D2", test_d2, p)
        else:
            print("SKIP D2: node_modules/three is missing (run npm install)")
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
