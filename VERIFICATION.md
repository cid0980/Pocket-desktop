# Mousepad pipeline revision — v1.3.3

Verified 2026-10-10. This is a targeted input-path update, not a UI-only change.

## Investigation before the change

- The touchpad used a fixed 1.5 multiplier. Its visible Sensitivity slider only
  changed DeviceOrientation motion gain, explaining why it did not change swipes.
- The pad explicitly converted multiple contacts and native wheel events to wheel
  messages. Both forwarding paths have now been removed from the pad.
- The tap helper sent down and up immediately. In the baseline headed-desktop test,
  a normal button DID receive one click, but a frame-sampled held-button check
  never observed the press. This is a reproduced timing weakness, **not proof of
  the exact cause of missing taps on the user's physical phone**.
- Sending while a socket was unavailable returned no failure indication. The new
  UI waits for connection readiness, checks frontend/server version agreement,
  reports failed sends, and displays input acknowledgements from the PC.

## What changed

Tap arbitration is still based on Pointer Events, starting coordinates, movement
thresholds, and a delayed single tap—not click/dblclick compatibility events. The
interval is now configurable from 250–350 ms (300 default). Tap clicks use a new
`{t:'click',b:'left'|'right',id}` message; the PC emits down, holds it for 60 ms,
then emits up. Dedicated buttons and drag gestures retain `{t:'btn',d:1|0}` and
relative pointer messages. Pulse timers cooperate with independently held buttons
and are cleared on disconnect/lease expiry. Every output still goes through the
same Python uinput helper, with separate SYN reports.

The right-side one-finger strip sends wheel input only. The pad does not scroll
with multiple contacts or native wheel events. Pointer Speed is 0.20×–2.00×,
default 0.60×, with fractional accumulation. It is applied once to relative deltas,
not to scroll/clicks; both speed and tap interval persist locally. OS-level mouse
acceleration is outside this app's multiplier and may still affect the desktop.

## Current verification

- **51 gesture/kernel checks**: taps, double/triple taps, configurable intervals,
  dedicated buttons, real held drag, cancellation/leave/link-loss release, no
  two-finger scroll, no forwarded pad wheel, strip direction and pointer isolation,
  concurrent pad movement and strip scroll, immediate speed changes and display,
  persistence and restored effective gain, fractional precision, layout editing.
- **16 headed-desktop checks** (`mouse-desktop-test.js`): normal click target
  activated exactly once; double tap generated right-click only; dedicated clicks
  activated the target; frame polling observed the press; actual target event
  timestamps showed **60 ms** between down/up. The strip scrolled real content
  **800 → 560 → 800**, while the pointer stayed at **402,492**. Both drag methods
  selected text and preserved the highlight after release and free movement.
- Regression runs: **56** gamepad/kernel, **41** browser controls/import/export,
  **25** existing remote UI, **45** API, **13** restart, **12** uinput, **14** installer
  checks passed. Geometry was checked at 390×844, 360×640, 844×390 and 568×320;
  a pad/click-row overlap found in the first landscape screenshot was corrected.

One initial desktop scroll check returned unchanged scrollTop. Subsequent tests
added wheel-event observation and waited for the target's rendering after setting
its initial scroll position; repeated runs passed in both directions. No claim is
made that a physical-device problem was diagnosed from that initial test failure.

## Limits and acceptance semantics

No physical Android/iOS touchscreen was available. The phone side used Chromium
CDP touch emulation, including an insecure HTTP origin; the PC side used a real
uinput mouse connected to Xorg's evdev driver and headed Chromium. Native target
input was not synthesized through DOM or target CDP mouse commands. This is real
PC-side integration testing, but not physical-phone acceptance.

“PC accepted” confirms a command was submitted to the input helper, not that every
application/game acted on it. Actual target behavior is separately checked by the
headed test. Silent network loss has an approximately four-second release lease.
The exact original missing-normal-tap symptom on the user's phone remains unverified.
If it persists, collect the phone browser/version, the displayed app version and
whether the input status changes to Sending / PC accepted / a connection error.

The earlier release reports below are historical, not repeated claims for this build.

---

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
