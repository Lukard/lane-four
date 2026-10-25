"""Run B: a scripted bot through the camera path, 200 m, as 3D and as ?renderer=2d."""
import json
import os
import time

from browser_tests.probes import *
from browser_tests.common import *


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

