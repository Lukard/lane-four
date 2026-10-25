"""Run C: keys mode on a phone-sized viewport: 3D at the intro, a late three.js, ?renderer=2d, rotation."""
import json
import os
import re
import time

from browser_tests.probes import *
from browser_tests.common import *


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
        check("C: the Signals panel shows the 3D view line", re.search(r"View: 3D chase · T3 · \d+ fps \(p95 \d+ ms\) · controller: tier locked · [\d.]+ MP · \d+ calls · [\d.]+k tris · wide", readout) is not None, readout)
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


