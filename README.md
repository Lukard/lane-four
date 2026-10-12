# Lane Four

Camera-tracked hurdles prototype. Jog in place to run, squat to jump.
MediaPipe Pose Landmarker (lite) runs in the browser, and video never leaves the device.

## Layout

- `src/core.js`: pose signals, step/squat/hands-up detectors, race simulation (no DOM)
- `src/app.js`: camera, MediaPipe, game loop, canvas rendering, UI
- `src/style.css`, `src/page.html`: styles and page template
- `build.js`: inlines everything into `docs/index.html` (the page GitHub Pages serves)
- `test/core.test.js`: detector and race tests on synthetic pose sequences (`test/synth.js`)
- `test/fake-vision.js`: stand-in for MediaPipe that plays the game with a scripted body
- `test/browser_test.py`: headless Chromium runs of the whole page

## Commands

    npm run build          # writes docs/index.html
    npm test               # unit tests, no dependencies needed
    npm run serve          # http://localhost:8000 (camera works on localhost)
    npm run test:browser   # browser runs B and C, needs Playwright

Browser tests need Playwright once: `pip install playwright && python3 -m playwright install chromium`.

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

## How detection works

- **Calibration**: stand still for 1 s. Records leg length relative to shoulder width and the noise
  floor of each signal; thresholds never drop below about 3x that noise.
- **Steps**: `(left ankle + knee height) - (right ankle + knee height)`, in leg lengths. A step counts
  each time the raised side flips. Squats and hops cancel out.
- **Squat depth**: how much hip-to-planted-ankle distance shrinks, normalized by shoulder width, so
  walking toward the camera doesn't read as a squat. 1.0 is roughly thighs parallel.
- **Start gesture**: both hands above the head for 0.5 s.
