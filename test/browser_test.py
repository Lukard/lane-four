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
                                                      canvas when no restore comes, a loss at the lowest
                                                      quality, a transient getContext failure, repeated loss;
                                                      texture canvases emptied (repainted in place, or the
                                                      scene re-created, never a blank picture shown); and a
                                                      real GPU process crash (CDP), at the intro and in a race
F: the quality controller on an unlocked tier       -> the view stays 3D whatever the device does: a camera at
                                                      15 or 20 fps with rAF at full rate, a cadence cap to
                                                      30 fps mid-session, a stalled main thread (single steps;
                                                      a severe stall goes straight to the lowest tier, even in
                                                      a race; one hint at the lowest tier), a stored tier; the
                                                      tier only goes down, one quality line shows once

This file is only the runner (server, drift guard, which runs, the summary). The runs are in
test/browser_tests/: run_a.py .. run_f.py, with common.py (paths, the stand-in network, page set-up, check())
and probes.py (page-side probes of the 3D picture).

Usage:  python3 test/browser_test.py [A][B][C][D][E][F]     (default: BCDEF)

B (as 2D) and D need only Playwright (pip install playwright && python3 -m playwright install
chromium). Every 3D run (B, C, E, F) also needs `npm install`: they serve three.js from
node_modules/three, which stands in for the CDN. Without it they print SKIP and D still runs. A also
needs local copies of what the page loads from the network, see README.md. Screenshots go to
test/shots/ (suffix _3d or _2d for the two views).

B, C and E use ?tier=3: the lowest quality tier on SwiftShader, locked so the quality controller cannot
change it under the test. Run F is the one that does not lock it: it is about the controller.
"""
import functools
import http.server
import json
import os
import re
import subprocess
import sys
import threading
import traceback

from playwright.sync_api import sync_playwright

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:  # pragma: no cover
    pass

from browser_tests.common import CURRENT, FAILURES, HAVE_THREE, MODEL, MP, ROOT, SITE, THREE_BUILD, Y4M, check
from browser_tests.run_a import test_a
from browser_tests.run_b import test_b
from browser_tests.run_c import test_c
from browser_tests.run_d import test_d, test_d2
from browser_tests.run_e import test_e
from browser_tests.run_f import test_f

WHICH = (sys.argv[1] if len(sys.argv) > 1 else "BCDEF").upper()

if "A" in WHICH:
    missing = [p for p in (MP, MODEL, Y4M) if not os.path.exists(p)]
    if missing:
        print("Skipping A, missing: " + ", ".join(os.path.relpath(m, ROOT) for m in missing))
        WHICH = WHICH.replace("A", "")

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=SITE)
handler.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8123), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()


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


def run(name, fn, *args):
    try:
        fn(*args)
    except Exception:  # a crash in one run is a failure, and the others still run
        traceback.print_exc()
        FAILURES.append(f"{name}: crashed, see the traceback above")


with sync_playwright() as p:
    if any(c in WHICH for c in "BCDEF"):
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
    if "F" in WHICH:
        if HAVE_THREE:
            run("F", test_f, p)
        else:
            print("SKIP F: node_modules/three is missing (run npm install)")
srv.shutdown()

print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) FAILED:")
    for f in FAILURES:
        print("  - " + f)
    sys.exit(1)
print("all checks passed")
