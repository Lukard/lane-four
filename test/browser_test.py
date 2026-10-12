"""Headless browser checks for Lane Four.

A: real MediaPipe + fake camera (a still photo)  -> model loads, landmarks flow
B: scripted bot through the camera code path     -> full race, 200 m
C: keys mode on a phone-sized viewport           -> intro, race, results

Usage:  python3 test/browser_test.py [A][B][C]     (default: BC)

B and C need only Playwright (pip install playwright && python3 -m playwright
install chromium). A also needs local copies of what the page loads from the
network, see README.md. Screenshots go to test/shots/.
"""
import functools
import http.server
import json
import os
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WHICH = (sys.argv[1] if len(sys.argv) > 1 else "BC").upper()
OUT = os.path.join(ROOT, "test", "shots")
os.makedirs(OUT, exist_ok=True)
SITE = os.path.join(ROOT, "docs")
MP = os.path.join(ROOT, "node_modules", "@mediapipe", "tasks-vision")
MODEL = os.path.join(ROOT, "test", "assets", "pose_landmarker_lite.task")
Y4M = os.path.join(ROOT, "test", "assets", "fake-camera.y4m")
FAKE = os.path.join(ROOT, "test", "fake-vision.js")
URL = "http://localhost:8123/index.html"

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


def route_assets(page, fake=False):
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
        return route.continue_()

    page.route("**/*", handle)


def attach_logs(page, logs):
    page.on("console", lambda m: logs.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: logs.append(f"[pageerror] {e}"))


def state(page):
    return page.evaluate(
        """() => { const s = window.laneFour.state, r = s.race; return {
        phase: s.phase, mode: s.mode, framing: s.framing, delegate: s.delegate, fps: Math.round(s.poseFps),
        ms: Math.round(s.inferMs), hasPts: !!s.pts, x: +r.x.toFixed(1), v: +r.v.toFixed(2), y: +r.y.toFixed(2),
        time: +r.time.toFixed(1), stats: r.stats, finished: r.finished, finishTime: r.finishTime,
        banner: document.getElementById('bannerMain').textContent + ' / ' + document.getElementById('bannerSub').textContent,
        baseline: s.baseline, eff: s.eff, cadence: Math.round(s.cadence) }; }"""
    )


def launch(p, video=None):
    args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    if video:
        args.append(f"--use-file-for-fake-video-capture={video}")
    return p.chromium.launch(args=args)


def test_a(p):
    print("=== A: real MediaPipe, still photo as camera ===")
    b = launch(p, Y4M)
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, permissions=["camera"])
    page = ctx.new_page()
    logs = []
    attach_logs(page, logs)
    route_assets(page, fake=False)
    page.goto(URL)
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


def test_b(p):
    print("=== B: scripted bot through the camera path, 200 m ===")
    b = launch(p)
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, permissions=["camera"])
    page = ctx.new_page()
    logs = []
    attach_logs(page, logs)
    route_assets(page, fake=True)
    page.goto(URL)
    page.wait_for_timeout(400)
    page.click(".pick button[data-dist='200']")
    page.click("#btnCamera")
    t0 = time.time()
    seen = []
    shot_mid = shot_cal = shot_squat = False
    while time.time() - t0 < 150:
        s = state(page)
        if not seen or seen[-1] != s["phase"]:
            seen.append(s["phase"])
            print(f"{time.time()-t0:5.1f}s phase={s['phase']} banner='{s['banner']}' eff={s['eff']}")
        if s["phase"] == "setup" and not shot_cal and time.time() - t0 > 0.8:
            page.screenshot(path=os.path.join(OUT, "B_calibrating.png"))
            shot_cal = True
        if s["phase"] == "running" and not shot_mid and s["x"] > 38:
            page.screenshot(path=os.path.join(OUT, "B_approach_hurdle.png"))
            shot_mid = True
        if s["phase"] == "running" and not shot_squat and s["y"] > 0.8:
            page.screenshot(path=os.path.join(OUT, "B_over_hurdle.png"))
            shot_squat = True
        if s["phase"] == "finished" and page.is_visible("#results"):
            break
        time.sleep(0.2)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "time", "finishTime", "stats", "cadence")}))
    print("bot squats:", page.evaluate("() => window.Vision.bot.squats"))
    page.screenshot(path=os.path.join(OUT, "B_results.png"))
    errs = [l for l in logs if "pageerror" in l or "[error]" in l]
    print("errors:", errs[:10])
    b.close()


def test_c(p):
    print("=== C: keys mode, phone portrait ===")
    b = launch(p)
    ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    page = ctx.new_page()
    logs = []
    attach_logs(page, logs)
    route_assets(page, fake=True)
    page.goto(URL)
    page.wait_for_timeout(600)
    page.screenshot(path=os.path.join(OUT, "C_intro_phone.png"), full_page=False)
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(300)
    page.screenshot(path=os.path.join(OUT, "C_ready_phone.png"))
    page.keyboard.press("Enter")
    t0 = time.time()
    while state(page)["phase"] != "running" and time.time() - t0 < 8:
        time.sleep(0.05)
    side = 0
    holding = False
    shot = False
    t0 = time.time()
    while time.time() - t0 < 90:
        s = state(page)
        if s["phase"] == "finished":
            break
        nh = page.evaluate("() => { const r = window.laneFour.state.race, h = r.nextHurdle(); return h ? h.x - r.x : 999 }")
        if not holding and 3.2 < nh < 5.0:
            page.keyboard.down(" ")
            holding = True
        elif holding and (nh <= 2.6 or nh > 20):
            page.keyboard.up(" ")
            holding = False
        if not holding:
            page.keyboard.press("f" if side == 0 else "j")
            side ^= 1
        if not shot and s["x"] > 40:
            page.screenshot(path=os.path.join(OUT, "C_race_phone.png"))
            shot = True
        time.sleep(0.17)
    page.wait_for_timeout(2600)
    s = state(page)
    print(json.dumps({k: s[k] for k in ("phase", "x", "finishTime", "stats")}))
    page.screenshot(path=os.path.join(OUT, "C_results_phone.png"))
    page.set_viewport_size({"width": 844, "height": 390})
    page.wait_for_timeout(400)
    page.click("#btnAgain")
    page.wait_for_timeout(3600)
    for _ in range(14):
        page.keyboard.press("f")
        page.wait_for_timeout(90)
        page.keyboard.press("j")
        page.wait_for_timeout(90)
    page.screenshot(path=os.path.join(OUT, "C_race_landscape.png"))
    page.click("#btnSignals")
    page.wait_for_timeout(500)
    page.screenshot(path=os.path.join(OUT, "C_signals_landscape.png"))
    errs = [l for l in logs if "pageerror" in l or "[error]" in l]
    print("errors:", errs[:10])
    b.close()


with sync_playwright() as p:
    if "A" in WHICH:
        test_a(p)
    if "B" in WHICH:
        test_b(p)
    if "C" in WHICH:
        test_c(p)
srv.shutdown()
