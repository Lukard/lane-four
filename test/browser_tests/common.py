"""Shared by the browser runs: paths and URLs, the stand-in network (three.js from node_modules), page set-up,
the strict check() counter and the helpers that read the page's state."""
import json
import os
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
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
# while the page is meant to be in 3D (there must be no 2D phase), and for the 3D canvas showing while its context
# is lost or no scene exists (a blank picture reaching the player).
WATCH = """(() => {
  window.__sets = []; window.__bad = []; window.__blank = [];
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
    const c3 = document.getElementById('world3d');
    if (c3 && c3.classList.contains('on') && (lf.view.lost || !lf.view.scene) && window.__blank.length < 10) window.__blank.push('3D canvas shown, lost=' + lf.view.lost + ' scene=' + !!lf.view.scene + ' status ' + lf.view.status);
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


def no_blank_checks(page, label):
    """The 3D canvas was never on screen while its context was lost or its scene gone."""
    blank = page.evaluate("() => window.__blank")
    check(f"{label}: the 3D canvas was never shown while the context was lost or the scene was gone (no blank picture)", not blank, blank[:3])


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


def hard_failure_checks(page, label, why):
    v = vinfo(page)
    check(f"{label}: view.status is failed and the page is in 2D", v["status"] == "failed" and v["mode"] == "2d" and not v["hidden2d"] and v["w2d"] > 1 and v["hidden3d"], v)
    check(f"{label}: a persistent notice says why", v["noticeKind"] == "failed" and "3D view unavailable" in v["noticeText"] and why in v["noticeText"], v["noticeText"])
    check(f"{label}: ... with a Reload button", v["reloadShown"])
    check(f"{label}: Start is enabled, in the classic view", v["startDisabled"] == [False, False] and v["startText"] == ["Start with camera", "Play with keys or touch"], v["startText"])
    check(f"{label}: the view events say hard-failure", "hard-failure" in v["events"], v["events"])

