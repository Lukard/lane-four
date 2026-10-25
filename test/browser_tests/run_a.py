"""Run A: real MediaPipe with a still photo as the camera (not strict)."""
import json
import os
import time

from browser_tests.common import *


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

