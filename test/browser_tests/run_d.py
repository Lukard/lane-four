"""Runs D and D2: three.js unreachable, WebGL2 cannot start. A hard failure is loud, once, and playable in 2D."""
import time
import os
import json

from browser_tests.common import *


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


