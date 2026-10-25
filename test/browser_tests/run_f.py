"""Run F: the quality controller on an UNLOCKED tier (no ?tier), on a phone-sized viewport (a coarse pointer starts at T1).

Whatever the device does, the picture stays 3D and the tier only ever goes down: a camera that delivers 15 or 20 fps
while rAF runs at full rate, a cadence cap to 30 fps in the middle of a session (Low Power Mode, Energy Saver), a stalled
main thread (a moderate one steps down one tier at a time, a severe one jumps to the lowest tier at once, even in a race),
and a stored tier. The runs press real keys in the page and read its own frame-rate meter (TIERLOG) as the premise of
each check, so a machine that is itself too slow to run the test says so instead of passing or failing for the wrong
reason."""
import re
import time

from browser_tests.common import *

PHONE = {"width": 390, "height": 844}
STATS = "() => window.laneFour.view.scene.stats()"
CTL = "() => window.laneFour.view.scene.stats().controller"
QNOTE = """() => { const all = [...document.querySelectorAll('.qnote')], on = all.find((n) => !n.hidden && n.getClientRects().length > 0), any = all.find((n) => !n.hidden) || all[0];
  return { hidden: all.every((n) => n.hidden), shown: !!on, text: any.hidden ? '' : any.querySelector('.qtext').textContent, kind: any.hidden ? '' : any.dataset.kind || '', where: on ? (on.id || on.closest('section').id) : '' }; }"""
REDUCED = "Reduced graphics for smooth play"


def f_page(p, init=(), url=""):
    b = launch(p)
    page, logs, reqs = new_page(b, PHONE, scale=2, touch=True, permissions=["camera"], init=[STRESS, TIERLOG, *init], fake=True)
    page.goto(URL + url)
    return b, page, logs


def up(page, b, label):
    """The 3D view is up on an unlocked tier. False (and the browser closed) if it never is."""
    ok = check(f"{label}: the 3D view is up (unlocked tier)", wait_js(page, READY_3D, 45), vinfo(page))
    if not ok:
        b.close()
    return ok


def to_ready(page):
    page.click(".pick button[data-dist='200']")
    page.click("#btnManual")
    page.wait_for_timeout(400)


def tier_events(page):
    return page.evaluate("() => window.laneFour.view.events.filter((e) => e.event === 'tier').map((e) => ({ t: e.t, reason: e.reason }))")


def median_fps(page, since_ms=5000):
    f = sorted(x["fps"] for x in page.evaluate("() => window.__fps") if x["t"] > since_ms)
    return f[len(f) // 2] if f else 0


def sane(page, label, start):
    """Never 2D, never a swap, and the tier sequence only goes down (the index up) from where it started."""
    tl = page.evaluate("() => window.__tl")
    tiers = [x["tier"] for x in tl if x["tier"] >= 0]
    steps = [t for i, t in enumerate(tiers) if i == 0 or t != tiers[i - 1]]
    check(f"{label}: every sample of the page's timeline is 3D", {x["mode"] for x in tl} == {"3d"}, sorted({x["mode"] for x in tl}))
    check(f"{label}: the tier only ever goes down in quality, from T{start} to at most T3", steps == sorted(steps) and (steps[0] if steps else start) == start and (steps[-1] if steps else start) <= 3, steps)
    no_swap_checks(page, label)


def signals(page):
    """The text of the Signals panel (opened with the D key: a sheet may cover its button), after it has refreshed."""
    page.keyboard.press("d")
    page.wait_for_timeout(700)
    text = page.inner_text("#readout")
    page.keyboard.press("d")  # and away again: the panel covers the quality line on a phone
    return text


def wait_phase(page, phase, timeout=10.0):
    return wait_js(page, f"() => window.laneFour.state.phase === '{phase}'", timeout)


def jog_until(page, cond, timeout=40.0):
    """Press F and J until cond(state) holds (the first hurdle is at 45 m, so this is for the first stretch)."""
    t0 = time.time()
    k = 0
    while time.time() - t0 < timeout:
        s = state(page)
        if cond(s):
            return s
        page.keyboard.press("f" if k % 2 == 0 else "j")
        k += 1
        time.sleep(0.12)
    return state(page)


def test_f(p):
    f_camera(p, 15, full=True)
    f_camera(p, 20, full=False)
    f_cap(p)
    f_deferred_step(p)
    f_steps_and_hint(p)
    f_emergency_race(p)
    f_stored(p)


def f_camera(p, cam, full):
    """A camera-limited pose rate says nothing about the 3D tier: rAF stays at full rate, and so does the picture."""
    CURRENT[0] = f"F camera {cam}"
    print(f"=== F: the camera delivers {cam} fps, rAF does not ({'whole race' if full else 'first 25 m'}) ===")
    b, page, logs = f_page(p, init=[camera_fps(cam)])
    if not up(page, b, "F"):
        return
    check("F: a phone starts at T1", vinfo(page)["tier"] == 1, vinfo(page)["tier"])
    page.click(".pick button[data-dist='200']")
    page.click("#btnCamera")
    t0 = time.time()
    got = None
    pose = []
    while time.time() - t0 < 120:
        s = state(page)
        if s["phase"] == "running" and s["x"] > 12:
            pose.append(s["fps"])
            got = {"pose": sorted(pose)[len(pose) // 2]}  # the median of the once-a-second readings, not one reading
        if s["phase"] == "running" and s["x"] > 25 and not full:
            break
        if s["phase"] == "finished" and page.is_visible("#results"):
            break
        time.sleep(0.2)
    s = state(page)
    check(f"F: the race ran through the camera path ({'finished' if full else 'running past 25 m'})", s["phase"] == "finished" if full else s["phase"] == "running" and s["x"] > 25, s["phase"])
    check(f"F: premise: the pose rate really is about {cam} fps while the race runs", got is not None and abs(got["pose"] - cam) <= 6, got and got["pose"])
    rate = median_fps(page)
    check("F: premise: rAF stays at full rate (a median of 40 fps or more) while the pose rate is limited", rate >= 40, rate)
    ctl = page.evaluate(CTL)
    check("F: the controller is watching a target of 40 fps or more, not the pose rate", ctl["target"] >= 40 and ctl["name"] in ("watching", "sheet"), ctl)
    r = signals(page)
    check("F: the Signals panel shows the tracking rate on its own line and the controller's target next to the tier",
          (re.search(r"Tracking: \S+ · (\d+) fps", r) is not None and abs(int(re.search(r"Tracking: \S+ · (\d+) fps", r).group(1)) - cam) <= 7) and re.search(r"View: 3D chase · T1 · \d+ fps \(p95 \d+ ms\) · controller: (target \d+ fps, watching, 0 of 10 windows slow|behind a sheet, not measuring) · ", r) is not None, r)
    ev = tier_events(page)
    v = vinfo(page)
    check(f"F: a camera at {cam} fps changes nothing: no tier step, still T1, still 3D", not ev and v["tier"] == 1 and v["mode"] == "3d" and v["status"] == "ready", (ev, v["tier"], v["mode"]))
    q = page.evaluate(QNOTE)
    check("F: no quality line is shown", q["hidden"] and not q["shown"], q)
    sane(page, "F", 1)
    errs = errors_of(logs)
    check(f"F: no console or page errors (camera {cam})", not errs, errs[:5])
    b.close()


def f_cap(p):
    """Low Power Mode or Energy Saver comes on in the middle of a session: the display is 30 fps now, which is not slowness."""
    CURRENT[0] = "F cadence cap"
    print("=== F: rAF is capped to 30 fps in the middle of a session ===")
    b, page, logs = f_page(p)
    if not up(page, b, "F"):
        return
    to_ready(page)
    page.wait_for_timeout(5500)
    c0 = page.evaluate(CTL)
    check("F: premise: the controller has learned a full-rate target before the cap", c0["target"] >= 40 and c0["name"] == "watching", c0)
    page.evaluate("() => { window.__cap = 30; }")
    page.wait_for_timeout(4500)
    c1 = page.evaluate(CTL)
    check("F: the cap is a new display rate: the target follows it (about 30) and nothing steps down", c1["adopted"] and 26 <= c1["target"] <= 33 and c1["tier"] == 1 and not tier_events(page), c1)
    page.keyboard.press("Enter")
    check("F: the race starts", wait_js(page, "() => window.laneFour.state.phase === 'running'", 10))
    play_keys(page, 90)
    page.wait_for_timeout(2600)
    s = state(page)
    check("F: the race ran to the end at 30 fps", s["phase"] == "finished", s["phase"])
    rate = median_fps(page, 12000)
    check("F: premise: rAF really ran near 30 fps during the race", 24 <= rate <= 34, rate)
    c2 = page.evaluate(CTL)
    check("F: no step down in the race or on the results sheet (the controller does not measure behind it)", not tier_events(page) and vinfo(page)["tier"] == 1 and c2["name"] == "sheet", (tier_events(page), c2["name"]))
    # the cap goes away again: the target rises with the display, so a later real slowdown is still seen
    page.evaluate("() => { window.__cap = 0; }")
    page.keyboard.press("Enter")  # race again
    check("F: race again starts", wait_js(page, "() => window.laneFour.state.phase === 'countdown' || window.laneFour.state.phase === 'running'", 10))
    page.wait_for_timeout(8000)
    c3 = page.evaluate(CTL)
    check("F: with the cap gone the target rises again (over 40 fps)", c3["target"] > 40 and not c3["adopted"], c3)
    check("F: still no step, still T1, still 3D", not tier_events(page) and vinfo(page)["tier"] == 1 and vinfo(page)["mode"] == "3d", tier_events(page))
    sane(page, "F", 1)
    errs = errors_of(logs)
    check("F: no console or page errors (cap)", not errs, errs[:5])
    b.close()


def f_deferred_step(p):
    """Ordinary slowness that shows in a race is not acted on in it (a step waits for a calm moment). At the finish it is acted
    on once, at the latest, and never on the results sheet, where nothing is measured: no surprise cascade there."""
    CURRENT[0] = "F deferred step"
    print("=== F: slowness in a race: no step in the race, one at the finish, none behind the results sheet ===")
    b, page, logs = f_page(p)
    if not up(page, b, "F"):
        return
    to_ready(page)
    page.wait_for_timeout(4500)
    page.keyboard.press("Enter")
    check("F: the race starts", wait_js(page, "() => window.laneFour.state.phase === 'running'", 10))
    jog_until(page, lambda s: s["x"] > 12)
    page.evaluate("() => window.__stall(50, 20)")  # about 15 fps: slow against the learned rate, under the floor, not an emergency
    jog_until(page, lambda s: False, 6)
    s = state(page)
    check("F: at about 15 fps in the race nothing steps down while it runs (the step is deferred)", s["phase"] == "running" and not tier_events(page) and vinfo(page)["tier"] == 1, (s["phase"], tier_events(page)))
    check("F: ... and the controller has seen it: a slow ring is waiting for a calm moment", page.evaluate(CTL)["slow"] >= 7 or page.evaluate(CTL)["floor"] >= 7, page.evaluate(CTL))
    page.evaluate("() => { const r = window.laneFour.state.race; if (!r.finished) r.x = r.distance - 3; }")
    check("F: the race finishes", wait_phase(page, "finished", 15), state(page)["phase"])
    check("F: the results sheet comes up", wait_js(page, "() => !document.getElementById('results').hidden", 8))
    page.wait_for_timeout(12000)
    ev = tier_events(page)
    tl = page.evaluate("() => window.__tl")
    first2 = next((x for x in tl if x["tier"] == 2), None)
    check("F: exactly one step, T1 to T2, taken at the finish (never in the race), and nothing more in 12 s on the results sheet", len(ev) == 1 and ev[0]["reason"].startswith("T1 to T2 · ") and first2 is not None and first2["phase"] == "finished", (ev, first2))
    check("F: the controller is not measuring behind the sheet", page.evaluate(CTL)["name"] == "sheet", page.evaluate(CTL)["name"])
    page.evaluate("() => window.__stall(0)")
    sane(page, "F", 1)
    errs = errors_of(logs)
    check("F: no console or page errors (deferred step)", not errs, errs[:5])
    b.close()


def f_steps_and_hint(p):
    """A moderate stall (about 15 fps) steps down one tier at a time, 8 s apart at least; a severe one at the lowest tier
    only earns a hint, once, which can be dismissed."""
    CURRENT[0] = "F stall steps"
    print("=== F: a stalled main thread: single steps, then the hint at the lowest tier ===")
    b, page, logs = f_page(p)
    if not up(page, b, "F"):
        return
    to_ready(page)
    page.wait_for_timeout(5000)
    page.evaluate("() => window.__stall(55, 20)")  # about 15 fps
    check("F: a moderate stall lowers the tier by one", wait_js(page, "() => window.laneFour.view.scene.tier >= 2", 30), vinfo(page))
    q = page.evaluate(QNOTE)
    check("F: ... in silence: a step down shows nothing (no line, no notice)", q["hidden"] and not q["shown"] and vinfo(page)["noticeKind"] == "", q)
    check("F: ... and carries on down to the lowest tier, one tier at a time", wait_js(page, "() => window.laneFour.view.scene.tier === 3", 40), vinfo(page))
    ev = tier_events(page)
    check("F: ... as ordinary steps (floor or slow), T1 to T2 then T2 to T3, 8 s apart at least, no emergency",
          len(ev) == 2 and ev[0]["reason"].startswith("T1 to T2 · ") and ev[1]["reason"].startswith("T2 to T3 · ") and ev[1]["t"] - ev[0]["t"] >= 8000 and not any("emergency" in e["reason"] for e in ev), ev)
    q = page.evaluate(QNOTE)
    check("F: reaching the lowest tier shows the one small line, 'Reduced graphics for smooth play'", q["shown"] and q["text"] == REDUCED and q["kind"] == "reduced", q)
    r = signals(page)
    check("F: the Signals panel says the tier, the measured fps, the controller's target and state (and where it came from)",
          re.search(r"View: 3D chase · T3 \(from T1\) · \d+ fps \(p95 \d+ ms\) · controller: lowest tier, hint after 10 s under 15 fps \(\d+\.\d s\) · ", r) is not None, r)
    check("F: ... and its events say why each tier step happened", re.search(r"tier · T1 to T2 · (slow: 7 of 10 windows under 0\.85 x \d+ fps|floor: \d+ of 10 windows under 18 fps)", r) is not None and re.search(r"tier · T2 to T3 · (slow|floor): ", r) is not None, r)
    page.evaluate("() => window.__stall(150, 20)")
    check("F: still under 15 fps at the lowest tier for 10 s: the hint appears", wait_js(page, "() => window.laneFour.view.unplayable", 40), vinfo(page))
    q = page.evaluate(QNOTE)
    check("F: ... as the same one line, now with tips (close tabs, Low Power Mode, plug in, camera back)", q["shown"] and q["kind"] == "hint" and all(w in q["text"] for w in ("Close other tabs", "Low Power Mode", "plug in", "camera")), q)
    page.screenshot(path=os.path.join(OUT, "F_hint_phone.png"))
    check("F: the lowest tier did not step anywhere, and the view is still 3D", vinfo(page)["tier"] == 3 and vinfo(page)["mode"] == "3d" and vinfo(page)["hidden2d"], vinfo(page))
    page.locator(".qnote .qx:visible").first.click()
    q = page.evaluate(QNOTE)
    check("F: dismissed, the line is gone and stays gone", q["hidden"] and not q["shown"], q)
    page.wait_for_timeout(1500)
    check("F: ... it does not come back, and the hint is said once", page.evaluate(QNOTE)["hidden"] and len([e for e in vinfo(page)["events"] if e == "unplayable"]) == 1, vinfo(page)["events"])
    page.evaluate("() => window.__stall(0)")
    sane(page, "F", 1)
    errs = errors_of(logs)
    check("F: no console or page errors (stall steps)", not errs, errs[:5])
    b.close()


def f_emergency_race(p):
    """A severe stall in the middle of a race goes straight to the lowest tier, in 3D, with the race still running."""
    CURRENT[0] = "F emergency in a race"
    print("=== F: a severe stall in a race: straight to the lowest tier, mid-race ===")
    b, page, logs = f_page(p)
    if not up(page, b, "F"):
        return
    to_ready(page)
    page.wait_for_timeout(4500)
    page.keyboard.press("Enter")
    check("F: the race starts", wait_js(page, "() => window.laneFour.state.phase === 'running'", 10))
    s = jog_until(page, lambda s: s["x"] > 12)
    scene0 = vinfo(page)["sceneId"]
    page.evaluate("() => window.__stall(120, 20)")
    seen = {}

    def tick(s):
        if "jump" not in seen and page.evaluate("() => window.laneFour.view.scene.tier") == 3:
            seen["jump"] = {"phase": s["phase"], "q": page.evaluate(QNOTE)}
            page.evaluate("() => window.__stall(0)")

    t0 = time.time()
    while "jump" not in seen and time.time() - t0 < 30:
        tick(state(page))
        page.keyboard.press("f")
        time.sleep(0.15)
    jump = seen.get("jump")
    check("F: the tier jumped to T3 while the race was running", jump is not None and jump["phase"] == "running", jump and jump["phase"])
    ev = tier_events(page)
    check("F: ... in one move (T1 to T3, an emergency), not three steps", len(ev) == 1 and ev[0]["reason"].startswith("T1 to T3 (emergency) · emergency: "), ev)
    check("F: ... the quality line stays out of the race", jump is not None and not jump["q"]["shown"], jump and jump["q"])
    check("F: ... same scene, still 3D, no swap", vinfo(page)["sceneId"] == scene0 and vinfo(page)["mode"] == "3d" and vinfo(page)["status"] == "ready", vinfo(page))
    page.evaluate("() => window.__stall(0)")
    s = play_keys(page, 90)
    page.wait_for_timeout(2600)
    check("F: the race finished", state(page)["phase"] == "finished", state(page)["phase"])
    q = page.evaluate(QNOTE)
    check("F: on the results sheet the one line says 'Reduced graphics for smooth play'", q["shown"] and q["text"] == REDUCED, q)
    page.screenshot(path=os.path.join(OUT, "F_results_reduced_phone.png"))
    page.locator(".qnote .qx:visible").first.click()
    check("F: dismissed, it is gone", page.evaluate(QNOTE)["hidden"], page.evaluate(QNOTE))
    page.keyboard.press("Enter")  # race again
    check("F: race again, at the lowest tier, in 3D, no line again", wait_js(page, "() => window.laneFour.state.phase === 'running'", 15) and vinfo(page)["tier"] == 3 and vinfo(page)["mode"] == "3d" and page.evaluate(QNOTE)["hidden"], vinfo(page))
    play_keys(page, 14)
    saved = page.evaluate("() => JSON.parse(localStorage.getItem('lanefour.tier3d') || 'null')")
    check("F: after 30 s of racing at the lowest tier it is remembered (key lanefour.tier3d, tier 3)", saved is not None and saved["t"] == 3 and saved["k"] == "2|390", saved)
    check("F: still no further step, never promoted", len(tier_events(page)) == 1 and vinfo(page)["tier"] == 3, tier_events(page))
    sane(page, "F", 1)
    errs = errors_of(logs)
    check("F: no console or page errors (emergency in a race)", not errs, errs[:5])
    b.close()


def f_stored(p):
    """A visit that finds a stored tier starts one step above it and carries on from there, not from the top of the cascade."""
    CURRENT[0] = "F stored tier"
    print("=== F: a stored tier ===")
    seed = "try { localStorage.setItem('lanefour.tier3d', JSON.stringify({ k: '2|390', t: 3, at: Date.now() })); } catch (e) {}"
    b, page, logs = f_page(p, init=[seed])
    if not up(page, b, "F"):
        return
    check("F: a stored T3 starts the visit at T2 (one step above it)", vinfo(page)["tier"] == 2, vinfo(page)["tier"])
    to_ready(page)
    page.wait_for_timeout(9000)
    check("F: ... and a device that is fine there stays: no cascade, no step, 3D", vinfo(page)["tier"] == 2 and not tier_events(page) and vinfo(page)["mode"] == "3d", (vinfo(page)["tier"], tier_events(page)))
    sane(page, "F", 2)
    b.close()
