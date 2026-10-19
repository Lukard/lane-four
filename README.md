# Lane Four

Camera-tracked hurdles prototype. Jog in place to run, squat to jump.
MediaPipe Pose Landmarker (lite) runs in the browser, and video never leaves the device.

## Layout

- `src/core.js`: pose signals, step/squat/hands-up detectors, race simulation (no DOM)
- `src/geom.js`: runner pose, chase-camera rigs and projection, quality tiers and controller (no DOM)
- `src/assets3d.js`, `src/world3d.js`: the 3D stadium: procedural textures, track, stands, hurdles, finish
- `src/actors3d.js`, `src/scene3d.js`: the 3D runner, particles and popups; the WebGL renderer, chase camera, quality tiers, context loss
- `src/app.js`: camera, MediaPipe, game loop, the classic 2D canvas view, the three.js loader and view switching, UI
- `src/style.css`, `src/page.html`: styles and page template
- `build.js`: inlines everything into `docs/index.html` (the page GitHub Pages serves); three.js itself loads separately from a CDN
- `test/core.test.js`: detector and race tests on synthetic pose sequences (`test/synth.js`)
- `test/geom.test.js`, `test/assets3d.test.js`, `test/world3d.test.js`, `test/actors3d.test.js`, `test/scene3d.test.js`, `test/build.test.js`: unit tests for the 3D modules and the build (no GPU)
- `test/fake-vision.js`: stand-in for MediaPipe that plays the game with a scripted body
- `test/browser_test.py`: headless Chromium runs of the whole page, as 3D and as 2D

## Commands

    npm run build          # writes docs/index.html
    npm test               # unit tests; the three.js geometry tests skip themselves without npm install
    npm run serve          # http://localhost:8000 (camera works on localhost)
    npm run test:browser   # browser runs B, C, D and E, needs Playwright and npm install

Browser tests need Playwright once: `pip install playwright && python3 -m playwright install chromium`.
Runs B, C and E also need `npm install` (three.js is pinned in `package.json`; the tests serve it from
`node_modules/three` in place of the CDN). Without it the 3D runs print SKIP and run D still checks the
fallback. The runs are strict: any failed check makes the command exit 1. They test `docs/index.html`, so
run `npm run build` first (the test says so if it is stale). Screenshots go to `test/shots/`, suffixed
`_3d` or `_2d`.

Run A loads the real tracking model against a still photo used as the camera. It needs local copies of
what the page normally fetches:

    npm install            # @mediapipe/tasks-vision 1.0.1
    mkdir -p test/assets
    curl -L -o test/assets/pose_landmarker_lite.task \
      https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task
    ffmpeg -loop 1 -i person.jpg -t 1 -r 30 -pix_fmt yuv420p \
      -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2" \
      test/assets/fake-camera.y4m
    python3 test/browser_test.py A

Use a full-body photo for `person.jpg` so tracking sees feet as well as the upper body.

## Playing it

The camera needs a secure page: `localhost` or `https://`. Claude's in-app artifact preview blocks
the camera. GitHub Pages works for phones: serve from the `main` branch, `/docs` folder.

## Views: 3D chase and classic side view

The default is a 3D chase camera behind the runner (three.js, loaded from a CDN on demand). The classic
side view is the fallback and a choice:

- Switch with the `3D` chip in the HUD, the View buttons on the intro card, or the `V` key. It is
  disabled during the countdown and the race, and the choice is saved.
- `?renderer=2d` or `?renderer=3d` overrides the saved choice for one page load. `?renderer=3d` also
  accepts a software renderer. `?tier=0..3` locks the 3D quality tier (3 is the lowest).
- 3D needs WebGL2. If it cannot load or start (offline, no WebGL2, the graphics context is lost) or the
  device cannot keep up, the game says so and carries on in the classic view. Desktops with a mouse
  fetch three.js in idle time when the page loads; phones fetch it on the first Start press. Neither
  fetches it on Save-Data or a 2G connection unless you choose 3D.
- The Signals panel (`D`) shows which view is running, its quality tier and frame rate.

Performance on real phones has not been measured yet.

## How detection works

- **Calibration**: stand still for 1 s. Records leg length relative to shoulder width and the noise
  floor of each signal; thresholds never drop below about 3x that noise.
- **Steps**: `(left ankle + knee height) - (right ankle + knee height)`, in leg lengths. A step counts
  each time the raised side flips. Squats and hops cancel out.
- **Squat depth**: how much hip-to-planted-ankle distance shrinks, normalized by shoulder width, so
  walking toward the camera doesn't read as a squat. 1.0 is roughly thighs parallel.
- **Start gesture**: both hands above the head for 0.5 s.
