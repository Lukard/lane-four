"""Run E: graphics context loss. Recovered in place in every phase, re-created when no restore comes, never a swap to 2D."""
import json
import os
import time

from browser_tests.common import *


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
    e_blank(p)
    e_gpu_crash(p)


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
    no_blank_checks(page, "E")
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
    no_blank_checks(page, "E")
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
    no_blank_checks(page, "E")
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



# What a lost graphics process does to the 2D canvases behind the textures: empties them. WEBGL_lose_context, which
# forceContextLoss() uses, does not, so the emulated loss alone never showed this.
EMPTY_TEXTURES = """() => { const seen = new Set(); let n = 0;
  window.laneFour.view.scene.parts.scene.traverse((o) => { const m = o.material; if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) for (const k of ['map', 'alphaMap']) { const t = mm[k];
      if (t && t.image && !seen.has(t.uuid)) { seen.add(t.uuid); const c = t.image; c.getContext('2d').clearRect(0, 0, c.width, c.height); n++; } } });
  return n; }"""
TEXTURES_INTACT = "() => window.LaneFour.Assets3D.texturesIntact(window.laneFour.view.scene.parts.world.textures)"


def event_reason(page, name):
    return page.evaluate("(n) => { const e = window.laneFour.view.events.filter((x) => x.event === n).pop(); return e ? e.reason : null; }", name)


def e_blank(p):
    CURRENT[0] = "E blank"
    print("=== E: the context comes back but the texture canvases are empty (what a GPU process crash leaves) ===")
    b, page, logs = e_page(p)
    if not check("E: the 3D view is up (blank)", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    v0 = vinfo(page)
    keys_to_ready(page)

    # 1. the canvases are emptied: the restore paints them again, in place
    n = page.evaluate(EMPTY_TEXTURES)
    check("E: seven texture canvases were emptied, and the scene can tell", n == 7 and page.evaluate(TEXTURES_INTACT) is False, n)
    # a listener added after the scene's own, so it runs after the app has reacted to the restore
    page.evaluate("() => { const c = document.getElementById('world3d'); window.__onAtRestore = null; c.addEventListener('webglcontextrestored', () => { window.__onAtRestore = c.classList.contains('on'); }); }")
    lose(page)
    check("E: lost: restoring, and the 3D canvas is faded out meanwhile", wait_status(page, "restoring", 5) and vinfo(page)["on3d"] is False, vinfo(page))
    restore(page)
    check("E: restored in place with the textures painted again: ready on the same scene, no attempt used", wait_status(page, "ready", 10) and vinfo(page)["sceneId"] == v0["sceneId"] and vinfo(page)["attempts"] == 0, vinfo(page))
    check("E: ... the canvas was not faded back in at the restore event, only once a frame had been drawn", page.evaluate("() => window.__onAtRestore") is False and wait_js(page, "() => document.getElementById('world3d').classList.contains('on')", 5), page.evaluate("() => window.__onAtRestore"))
    check("E: ... every texture canvas holds its picture again", page.evaluate(TEXTURES_INTACT) is True)
    d = vinfo(page)["drawn"]
    check("E: ... and it keeps drawing", wait_js(page, f"() => window.laneFour.view.scene.drawn > {d} + 3", 10))
    probe_ok(page, "E (emptied textures)")

    # 2. painting them again does not take: the blank picture is never shown and the scene is re-created at once
    s1 = vinfo(page)["sceneId"]
    page.evaluate("() => { const A = window.LaneFour.Assets3D; window.__repaint = A.repaintTextures; A.repaintTextures = () => {}; }")  # painting again does not take
    page.evaluate(EMPTY_TEXTURES)
    lose(page)
    wait_status(page, "restoring", 5)
    t0 = time.time()
    restore(page)
    check("E: a restore whose textures stay blank is re-created (a new scene, attempt 1), ready and drawing", wait_js(page, "() => window.laneFour.view.status === 'ready' && window.laneFour.view.attempts === 1 && window.laneFour.view.shown", 15) and vinfo(page)["sceneId"] != s1, vinfo(page))
    check("E: ... because of the blank textures, at once, not by the 3 s no-restore wait", (event_reason(page, "restore-failed") or "").startswith("the textures are blank after the restore") and (event_reason(page, "recreate") or "").startswith("the textures are blank") and time.time() - t0 < 2.9, (event_reason(page, "restore-failed"), event_reason(page, "recreate"), round(time.time() - t0, 1)))
    page.evaluate("() => { window.LaneFour.Assets3D.repaintTextures = window.__repaint; }")
    check("E: ... and the new scene is whole", page.evaluate(TEXTURES_INTACT) is True)
    probe_ok(page, "E (after re-creation)")

    # 3. the textures turn out blank on the first frame after a restore that looked fine
    s2 = vinfo(page)["sceneId"]
    page.evaluate("() => { const A = window.LaneFour.Assets3D; window.__intact = A.texturesIntact; let n = 0; A.texturesIntact = () => n++ === 0; }")
    lose(page)
    wait_status(page, "restoring", 5)
    restore(page)
    check("E: textures found blank on the first frame after a restore are re-created too (attempt 2)", wait_js(page, "() => window.laneFour.view.status === 'ready' && window.laneFour.view.attempts === 2 && window.laneFour.view.shown", 15) and vinfo(page)["sceneId"] != s2, vinfo(page))
    check("E: ... the check on the first frame is what caught it", (event_reason(page, "restore-failed") or "").startswith("the textures are blank on the first frame"), event_reason(page, "restore-failed"))
    page.evaluate("() => { window.LaneFour.Assets3D.texturesIntact = window.__intact; }")
    probe_ok(page, "E (after the second re-creation)")
    no_blank_checks(page, "E")
    no_2d_phase(page, "E")
    errs = errors_of(logs)
    check("E: no console or page errors (blank)", not errs, errs[:5])
    b.close()


def crash_gpu(b):
    """The real thing: the browser's GPU process dies (CDP Browser.crashGpuProcess)."""
    b.new_browser_cdp_session().send("Browser.crashGpuProcess")


def e_gpu_crash(p):
    CURRENT[0] = "E gpu crash"
    print("=== E: a real GPU process crash, at the intro and in a race on a phone ===")
    b, page, logs = e_page(p)
    if not check("E: the 3D view is up (gpu crash)", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    v0 = vinfo(page)
    probe_ok(page, "E (before the crash)")
    crash_gpu(b)
    check("E: the crash is noticed as a lost context", wait_js(page, "() => window.laneFour.view.events.some((e) => e.event === 'context-lost')", 10), vinfo(page)["events"])
    check("E: ... and the texture canvases really are empty now (this is the case the emulated loss cannot make)", page.evaluate(TEXTURES_INTACT) is False)
    check("E: the browser restores it: ready again in place, on the same scene", wait_js(page, "() => window.laneFour.view.status === 'ready' && !window.laneFour.view.lost", 15) and vinfo(page)["sceneId"] == v0["sceneId"], vinfo(page))
    page.wait_for_timeout(1500)
    check("E: ... the textures hold their picture again", page.evaluate(TEXTURES_INTACT) is True)
    probe_ok(page, "E (after a real GPU crash: the track is red, not black)")
    page.screenshot(path=os.path.join(OUT, "E_gpu_crash_desktop.png"))
    no_blank_checks(page, "E")
    errs = errors_of(logs)
    check("E: no console or page errors (gpu crash)", not errs, errs[:5])
    b.close()

    b, page, logs = e_page(p, viewport={"width": 390, "height": 844}, touch=True, scale=2)
    if not check("E: the 3D view is up on a phone (gpu crash)", wait_js(page, READY_3D, 45), vinfo(page)):
        b.close()
        return
    v0 = vinfo(page)
    keys_to_ready(page)
    check("E: a race is running", start_race(page), state(page)["phase"])
    jog(page, 10)
    crash_gpu(b)
    check("E: the crash pauses the race for the graphics", wait_status(page, "restoring", 10) and wait_phase(page, "paused", 5) and page.evaluate("() => window.laneFour.state.pausedReason") == "graphics", (vinfo(page)["status"], state(page)["phase"]))
    check("E: the restore brings the race back by itself, on the same scene", wait_status(page, "ready", 15) and wait_phase(page, "running", 5) and vinfo(page)["sceneId"] == v0["sceneId"], (vinfo(page)["status"], state(page)["phase"]))
    page.wait_for_timeout(1000)
    x0 = state(page)["x"]
    jog(page, 10)
    check("E: ... the runner runs again", state(page)["x"] > x0 + 0.5, (x0, state(page)["x"]))
    check("E: ... on textures that hold their picture", page.evaluate(TEXTURES_INTACT) is True)
    probe_ok(page, "E (phone, after a real GPU crash)")
    page.screenshot(path=os.path.join(OUT, "E_gpu_crash_race_phone.png"))
    no_blank_checks(page, "E")
    no_2d_phase(page, "E")
    errs = errors_of(logs)
    check("E: no console or page errors (gpu crash, phone)", not errs, errs[:5])
    b.close()
