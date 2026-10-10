# Mouse gestures and layout repair — v1.3.2

Verified 2026-10-10 in Debian/Linux, Chromium, Xvfb and a separate Xorg dummy display
using the actual virtual mouse through the evdev driver.

## Current targeted results

- **32/32 gestures tests**: actual Linux input events for single/double/triple taps,
  pointer-only swipes, true held-button drags, cancellation, leaving the pad,
  dedicated left/right hold-and-move, switching input sources, desktop mouse drag,
  socket closure and silent-link heartbeat expiry. Layout editing/save/reload/cancel/
  reset runs on an insecure HTTP hostname with `structuredClone` deliberately disabled.
  Saved pad positions fit portrait/landscape bounds; A works after leaving editing.
- **6/6 real text-selection checks**: surface hold and dedicated-button hold both
  selected `Select this te` in headed Chromium on the controlled Xorg desktop.
  Trusted native mouse events showed down → held movement → up. The selection stayed
  highlighted after release and a subsequent pointer-only movement. See
  `test/SELECTION.md` for the rig; this is not a mocked DOM selection.
- Regression: **56/56** pad/kernel input, **41/41** browser controls including JSON
  import/export/fullscreen, **25/25** existing remote UI, **45/45** API,
  **13/13** restart, **12/12** uinput tests.

## Diagnosis and limits

The backend already implemented mouse down/up and relative movement. The frontend
was pointer-only and had no surface tap or hold recognizer. The repair adds one
shared gesture/button state machine rather than another competing event system.

The layout editor existed and persisted data, but was not exposed in the gamepad's
settings panel. It now has a settings entry as well as an explicit header entry.
The editor also assumed `structuredClone` existed, which would abort initialization
on browsers lacking it. JSON-only cloning removes that unnecessary dependency.
Current test Chromium DOES provide structuredClone on insecure HTTP; therefore
HTTP alone is NOT established as the cause of the user's missing settings. The
fallback was separately verified with that API disabled. The exact old-phone or
stale-build failure has not been reproduced on the user's device.

A single tap intentionally waits 280 ms before left-click, so a double tap can
instead send only right-click. Hold still for 350 ms before a one-finger touch drag;
early swipes only move. Desktop pressed movement starts dragging at the movement
threshold. Input expiry after a silent network failure is approximately four
seconds, not instantaneous.

No physical phone/tablet was available. Touch events were Chromium-emulated; real
Android/iOS gestures and ergonomic timing remain to be confirmed on-device. No
claim of physical-device acceptance is made. The older motion/game compatibility
limitations below still apply. The GitHub Actions template has not run as CI.

---

# Portable Linux update — v1.3.1

Tested 2026-10-09. This update adds setup scripts and Git publishing support; it
keeps the existing UI and remote-control backends.

- **14/14** non-mutating installer tests: apt/dnf/pacman/zypper plans, shell syntax,
  arguments, ports, install-only/autostart options, Wayland and headless guards.
- Actual **Debian 13** dependency installation completed successfully.
- `DISPLAY=:99 XDG_SESSION_TYPE=x11 bash setup.sh --skip-deps --install-only --port 8770`
  completed successfully. Foreground `setup.sh` then started v1.3.1 on that port.
- Actual uinput permission setup succeeded: named ACL for the desktop user and
  `other::---`, rather than world-writable input; Python check reported READY.
- Against the setup-launched app: **56/56** pad/input, **41/41** controls/browser,
  and **45/45** API checks passed. Isolated restart tests passed **13/13**.
- Fedora, Arch and openSUSE have **command-plan coverage only**, not actual distro
  installs. The container has no systemd user session for autostart verification
  and cannot verify permission persistence over reboot.
- GitHub Actions was authored as `tools/github-checks.yml.example`, but is not
  enabled and has not run on GitHub. The publication credential lacks workflow-write
  permission. At initial release preparation, source was staged locally and had not yet been
  published. GitHub publication is a separate step, not a completed CI run.

The previous release's detailed UI/input verification is retained below for context;
it is not presented as a fresh full regression run for v1.3.1.

---

# Pocket Desktop 1.3.0 — verification

Tested 2026-10-09 in a Linux sandbox, Node 20, headless Chromium, Xvfb :99,
x11vnc and actual /dev/uinput devices. Chromium used phone touch emulation,
not a physical phone. Tests and scripts ship in this archive.

## Passing suites

| Suite | Passed | Evidence |
|---|---:|---|
| pad-test.js | 56 | Actual kernel input events: LT/RT full 255, partial travel, zero release; all 11 buttons, four D-pad directions, sticks; dedicated touchpad REL_X and both mouse button press/release |
| controls-test.js | 41 | Browser navigation, pointer events, no duplicate clicks, per-page dragging including independent remote click button, save/refresh, JSON download/import, malformed/version/coordinate rejection, reset all, fullscreen enter/exit on all pages, RFB click masks [1,0,4,0], simulated motion scenarios, responsive geometry |
| ui-test.js | 25 | Existing remote view, real desktop pixels/input, navigation, settings and diagnostics |
| api-smoke.js | 45 | Existing authentication, pairing, API, VNC, WebSocket and diagnostics |
| restart-test.js | 13 | Restart and version consistency |
| failure-test.js | 5 | Screen-server interruption and recovery |
| throughput-test.js | 7 | Stream backpressure and disconnect cleanup |
| screen-server-test.js | 10 | Screen handshake and ownership |
| selfheal-test.js | 7 | Automatic screen-server repair |
| password-trap-test.js | 8 | Saved VNC password recovery |
| uinput-test.js | 12 | Real virtual pad/mouse creation and event delivery |
| **Total** | **229** | Final passing runs, not a claim that every possible device was tested |

Browser layouts checked at 360×640, 390×844, 844×390, 1024×768, and 1440×900.
Screenshots of portrait/landscape gamepad and mouse pad were inspected during development.
Custom layouts allow overlap intentionally; positions are bounded but not automatically
collision-resolved. Reset page restores the ergonomic default.

The failure-path test initially raced automatic recovery and failed its “x11vnc is
really stopped” precondition. A subsequent full run passed 5/5. An initial restart
run was mistakenly aimed at the active development server; rerunning on its isolated
port passed 13/13. These were not silently counted as passing runs.

## Important limits

- No physical Android/iOS motion sensor, permission UI, or home-screen installation
  was available here. Motion secure-context, denied-permission, unavailable-API,
  no-data timeout, smoothing/movement and cleanup paths were tested with simulated
  API conditions/events. Physical sensor quality remains unverified.
- Fullscreen enter/exit was verified in Chromium. iOS Safari and embedded browsers
  can reject it; the UI explains failures. PWA installation needs trusted HTTPS.
- Kernel Xbox-style events were verified, **not** actual gameplay or the online
  Gamepad API tester on the user's machine. WuWa/Genshin/HSR detection depends on
  the user's Wine/Proton/Steam configuration and game controller support. No
  anti-cheat workaround is included or implied.
- The HTTP screenshot explains a secure-context restriction, not proof that the
  phone lacks motion hardware. A self-signed-certificate warning bypass is not a
  reliable substitute for phone/browser trust. See README → Motion / HTTPS.

## Re-run

With the app running on port 8765, test PIN 1234, and a test X display:

```bash
sudo node --experimental-websocket test/pad-test.js --port 8765 --pin 1234
node --experimental-websocket test/controls-test.js
node --experimental-websocket test/ui-test.js --port 8765 --pin 1234
node --experimental-websocket test/api-smoke.js --port 8765 --pin 1234
```

Use a disposable test desktop, not an active gaming session: input and recovery tests
move the pointer, press keys/buttons and deliberately stop/restart the screen server.
Leave at least 32 seconds after API authentication-rate-limit tests before browser
login tests. Root is only required by the test reader for /dev/input/event*; the
running app uses direct uinput access after installer setup.

## Packaged release check

The release zip was extracted to a clean directory and every file was byte-compared
with its release source. Against the extracted server on port 8768:

- pad-test: **56/56**
- controls-test: **41/41**
- ui-test: **25/25**

The root-run input test initially created a root-owned screenshot directory, blocking
subsequent non-root screenshot writes. After correcting ownership of test/artifacts,
both non-root browser suites completed successfully. This was test-output ownership,
not an application input or browser failure.
