# Pocket Desktop

**See and control your Linux X11 PC from your phone** — over your own Wi-Fi, with no cloud service, no account and no npm dependencies.

Open it on your phone, type a PIN, and you are looking at your real desktop: move the pointer, click, type with your phone's keyboard, scroll, zoom, take screenshots, send text to the PC clipboard, even lock/suspend the machine from bed.

```
  phone  ──Wi-Fi──▶  Pocket Desktop (this app, one port)  ──▶  x11vnc (localhost only)  ──▶  your X11 desktop
```

---

## Clone → setup → run

On the Linux desktop you want to control:

```bash
git clone https://github.com/cid0980/Pocket-desktop.git pocket-desktop
cd pocket-desktop
bash setup.sh
```

Setup detects apt, dnf,
pacman or zypper, configures the app, and runs in the foreground. Use
`bash setup.sh --plan` to inspect its actions first. Run as your normal desktop
user, not with sudo. The phone connects over the same reachable local network.

**X11 is required for desktop sharing; Wayland and Windows are not supported by
this backend.** Non-Debian distro command plans are tested, not complete installs.
See [PORTABLE.md](PORTABLE.md) for GitHub publishing, updates, autostart, supported
environments and security details. No VPN or cloud tunnel is added.

## Why this and not a plain VNC client?

* **One URL, one port.** The raw VNC port never leaves `localhost`; only this app is exposed, and only behind your PIN.
* **Made for thumbs.** Touch = absolute pointer (your finger *is* the mouse), swipe with two fingers to scroll, pinch to zoom, long-press for right-click, plus a trackpad mode and a scroll mode.
* **A real remote-control toolkit.** Raspberry-Pi-style key row (`Ctrl`, `Alt`, `Super`, `Esc`, `Tab`, arrows, `Ctrl+Alt+Del`), screenshot viewer, clipboard bridge, push-to-talk through the PC speakers, power buttons.
* **Installable.** Add it to your home screen and it runs full-screen like a native app.
* **Zero dependencies.** Plain Node.js on the server; noVNC and a QR generator are vendored in the repo.

---

## Requirements

| | |
|---|---|
| PC | Linux with an **X11** session and a supported package manager (see [Wayland](#wayland)) |
| Node.js | 18 or newer (`sudo apt install nodejs`) |
| x11vnc | required — `sudo apt install x11vnc` |
| optional | `xdotool` (key row, push-to-talk key), `alsa-utils` (voice notes), `imagemagick` or `gnome-screenshot` (screenshots) |
| Phone | any modern iOS/Android browser, on the same Wi-Fi |

---

## Install (on the PC)

```bash
cd pocket-desktop
./install.sh --install-deps        # installs x11vnc & friends, sets a PIN, enables auto-start
```

The installer

1. checks Node, your session type and the helper tools,
2. asks for a PIN (or keeps the one you already have),
3. installs two systemd **user** services — the app and a localhost-only x11vnc,
4. prints a **QR code**.

Scan the QR with your phone's camera → the page opens *already signed in* and stays signed in
for 60 days. Add it to your home screen (Safari: Share → *Add to Home Screen*, Chrome: ⋮ → *Add to Home screen*).

Want lock / suspend / restart / shutdown from the phone as well?

```bash
./install.sh --with-sudo
```

That writes a narrow [polkit rule](https://www.freedesktop.org/software/polkit/docs/latest/polkit.8.html)
allowing exactly those four actions for your user — no blanket sudo.

Other installer options: `--port 9000`, `--vnc-password ab12`, `--no-service` (just check the machine), `--uninstall`.

### Or run it by hand

```bash
./run.sh                 # http://<your-pc-ip>:8765
./run.sh --tls           # https://… (see HTTPS below)
node server.js --doctor  # check what is missing
node server.js --pair    # print a pairing QR in the terminal
```

---

## Using it on the phone

| Screen | What you get |
|---|---|
| **Home** | live CPU / RAM / disk / uptime, VNC status, one big *Open remote screen* button, quick tiles for screenshot, power, pairing and settings |
| **Remote** | your desktop. Bottom pill: keyboard, input mode, scroll toggle, ⋯ menu |
| **Settings** | PC name, streaming quality (Sharp / Balanced / Fast), VNC password, push-to-talk key, sign out |

### Gestures

| Gesture | Touch mode | Trackpad mode |
|---|---|---|
| Tap / click | left click | left click |
| Drag | move pointer, drag & drop | move pointer (relative) |
| Hold 0.5 s | right click | right click |
| Two-finger drag | scroll the desktop | scroll the desktop |
| Two-finger tap | right click | right click |
| Pinch | zoom the view | zoom the view |

When zoomed in, two fingers pan the view. **Scroll mode** turns one-finger dragging into scrolling for long pages.

### The ⋯ menu

* **Keyboard** — shows the key chip row; the soft keyboard is bridged to the PC, including letters, symbols, arrow keys, `Enter`, `Tab`, `Esc`, `F5`, `PrtSc`, `Ctrl+Alt+Del`.
* **Clipboard…** — type/paste text and push it to the PC clipboard, and read what the PC has on *its* clipboard.
* **Take screenshot** — grabs the PC screen and shows it here (downloadable).
* **Zoom** — cycle Fit → 1:1 → 2×.
* **Quality** — cycle Sharp → Balanced → Fast (use *Fast* on weak Wi-Fi).
* **View only** — turn the screen into a live monitor with input disabled.
* **Fullscreen / Gestures & help / Disconnect**.
* **🎙 Hold to talk on PC** — while you hold the button, the PC's own microphone records; when you let go it plays through the PC's speakers. Handy for talking through your computer from another room. It can also hold a push-to-talk key (default `space`) in the app that has focus. Needs `alsa-utils`; the key and input device are configurable in Settings.

---

## Security model

* Everything (API **and** the VNC stream) is behind a PIN — 4–10 digits, PBKDF2-SHA256 (210 000 iterations).
* Sessions use signed, `HttpOnly`, `SameSite=Strict` cookies (60 days). The same signed token is also accepted as an `Authorization: Bearer …` header, so the app keeps working where cookies don't — embedded/iframe views, or browsers with cookies disabled. Brute force is throttled with a **progressive lockout** (30 s, doubling up to 1 h).
* x11vnc runs with `-localhost`, so the VNC port is unreachable from the network. Optionally protect it further with a VNC password (Settings → *VNC password*) — that adds a second lock even on the loopback socket.
* The QR pairing link is a single-use-style token valid for **10 minutes**; revoke access by changing the PIN or signing out that device.
* CSP, `nosniff`, `Referrer-Policy` and a `Permissions-Policy` are set on every response.
* Traffic between phone and PC is **plain HTTP by default** (typical for a home LAN). Anyone who can sniff your Wi-Fi *and* read the session cookie could watch the stream. If that matters, run with `--tls` (below) or keep the app off untrusted networks.

### HTTPS (optional)

Some browser features — clipboard read/write and the full PWA install — need a secure context:

```bash
./run.sh --tls
```

On first start the app generates a self-signed certificate next to your config
(`~/.local/share/pocket-desktop/tls/`). Your phone will warn once about the certificate
Trust must be configured on the phone for secure-context features. Merely bypassing a certificate warning is not a reliable way to enable motion or PWA installation; see below.

---

## Controller workspaces (v1.3.0)

**Gamepad**, **Mouse pad**, and the existing **Remote screen** keep their own controls.
Each offers a **Fullscreen** toggle and **Layout** editor. Portrait, landscape, tablet,
and desktop layouts are supported. The gamepad has a direct Mouse pad shortcut.

### Gamepad

The PC creates a Linux uinput Xbox-360-style device. This is not the browser
Gamepad API: phone touches travel through `/wsctl` to Linux input events.
Wine/Proton/Steam and each game's controller settings determine whether this appears
as an XInput controller. Actual WuWa, Genshin and HSR compatibility has **not** been
verified here. Start the controller before launching a game and enable controller
input in that game's settings. No anti-cheat bypass is provided.

LT/RT now use the full **0–255** axis range (the old UI incorrectly sent 1).
Touch presses fully; slide upward up to 100 pixels to feather the trigger. A
pressure-reporting pen uses its pressure. Releasing sends zero. A/B/X/Y, shoulders,
D-pad, Select/Start, Guide and L3/R3 are available. Sticks appear where you touch.
L/R at the bottom are **mouse** buttons, not shoulder buttons.

`install.sh` sets up `/dev/uinput`; an existing installation should rerun it.
The installer uses a uaccess rule and an immediate per-user ACL, rather than
world-writable input. uinput can inject system-wide input; only grant trusted users
access. See PORTABLE.md for the graphical-session and reboot limitations.

### Mouse pad and remote clicks

Swipe immediately to move; tap once for left-click, or tap twice for right-click.
The visible **Double-tap window** slider selects **250–350 ms** (default **300 ms**).
A single tap waits that interval before committing; a valid second tap cancels it.
Tap clicks use a **60 ms press on the PC**, so even frame-polled input can observe
them; drag input still uses independent button-down, movement and button-up events.

**To select text or drag:** hold still on the pad for **400 ms**, then move. The
pad turns green while the real left mouse button is held. Lift to release; the
selection remains. Alternatively, hold the dedicated Left/Right button with one
finger and move on the pad with another. With a desktop mouse, hover movement
moves the pointer; pressing and moving drags. Drags suppress pending taps.

**There is no two-finger scrolling on the mousepad.** Multiple pad contacts are
ignored until lifted. Use the distinct **vertical scroll strip at the right**:
drag upward to scroll up, downward to scroll down. It emits wheel events only,
not pointer movement. It also supports up/down arrow keys and a physical mouse
wheel while over the strip. Native wheel events over the pad are not forwarded,
so a laptop trackpad cannot reintroduce two-finger scrolling there. This change
is specific to the standalone mousepad, not the separate remote-screen gestures.

**Pointer Speed** now controls touchpad movement, not motion sensors. Range:
**0.20×–2.00×**, default **0.60×** (previously hardcoded 1.50×). The displayed value
updates immediately, applies to subsequent movement, and is saved locally with
the double-tap window. Small fractional movements accumulate rather than being
rounded away. There is no app acceleration or second backend speed multiplier;
your Linux desktop can still apply its own system-level mouse acceleration.
Motion sensitivity is a separate setting under Optional motion controls.

Input is disabled until the control channel is ready. Click/button/wheel responses
show **PC accepted** feedback. This confirms that the server submitted the command
to its input helper, not that an arbitrary application acted on it. The integration
tests separately verify actual native events and target application behavior.
Missing acknowledgements and mismatched running-server/frontend versions are
reported, rather than silently dropping taps. After an update, restart the PC
process as well as refreshing the phone page.

Buttons release on cancellation, leaving the pad, backgrounding, layout editing,
navigation and detected connection loss. A server-side heartbeat lease releases
inputs on a silent link failure after approximately 4 seconds. Do not depend on
instant release when the network disappears; the PC needs time to detect it.
Pointer events provide one input path without duplicate touch/mouse handlers.

Remote screen Left/Right clicks go through the existing RFB session at its last
pointer position (centre if none yet), respecting View only. They are separate
from the uinput touchpad buttons. Remote display space is reserved above the dock.

### Layout editor

Choose **Edit layout** in the gamepad header, or **Settings → Customize gamepad
layout**, then drag an outlined control or control group. The other workspaces
retain their Layout buttons. The same editor and saved settings are reused. Normal use
cannot reposition anything. The editor toolbar itself can be moved by its heading
if it covers a control. **Save** stores positions in this browser; **Cancel**
restores the last saved layout. **Reset page** and **Reset all** modify the draft;
click Save to keep those changes.

Positions are normalized to the available viewport and clamped on resize. Gamepad
face buttons and system buttons move as groups; the remote header/dock move as
groups, with the two click buttons also independently movable. Extreme layouts can
still overlap: use Reset page if you make controls awkward to reach.

**Export JSON** downloads the current draft. **Import JSON** validates version 1,
page names, known controls, finite coordinates and range before asking permission
to replace the draft. Save is still required. Invalid JSON leaves settings intact.
Storage failures are reported; unreadable/old saved data falls back to defaults.
Layouts are per browser/origin, not automatically synchronized across devices.

### Motion / HTTPS — important for your phone

The screenshot's `http://192.168.0.170:8765` connection is insecure. Modern browsers
may hide orientation APIs on HTTP. That is **not evidence of missing hardware**.
JavaScript cannot bypass this restriction.

1. Stop the server and run `bash run.sh --tls` to serve HTTPS.
2. Configure a certificate trusted by your phone/browser. For a private LAN,
   a local CA (for example one created with mkcert) can sign a certificate with
   your PC's current LAN IP in its SAN. Install/trust that CA on the phone using
   its OS/browser instructions. Replace the app's `cert.pem` and `key.pem` in
   `~/.local/share/pocket-desktop/tls/` with the signed certificate and its private
   key, then restart. Keep private keys on the PC; never copy a CA private key to
   the phone. The bundled self-signed certificate alone is not automatically trusted.
3. Open the trusted `https://<PC-IP>:8765` URL. Allow Motion & Orientation in site
   permissions. On iOS the Enable motion tap requests permission explicitly.
4. Tap Motion, wait for actual sensor data, and Re-centre while holding comfortably.
   Use the sensitivity slider to adjust speed. Rotate the phone to reset neutral.

The UI distinguishes insecure context, missing API, denied permission, failed
permission requests and no usable readings. Browsers do not reliably distinguish
missing physical hardware from OS-level sensor blocking; the no-data message says
so. Motion never reports active until valid data arrives. It uses smoothed tilt,
a dead zone and bounded, time-scaled movement. Backgrounding or leaving stops it.
The ordinary touchpad remains usable without motion or HTTPS.

A trusted HTTPS origin also enables service workers and browser PWA installation.
Settings shows an Install button only when the browser supplies an install prompt.
On iOS use Share → Add to Home Screen. Fullscreen API availability varies; on
unsupported browsers the app explains the limitation instead of pretending it entered.
Adding a home-screen shortcut on HTTP is not the same as installing a full PWA.

### Verification

See `VERIFICATION.md` for the tested environments, results and remaining physical-
phone/game limitations. `test/controls-test.js` exercises the new browser features;
`test/pad-test.js` checks real Linux input events (run with sudo in the test rig).

## Updating to a newer version

Replace the files, then restart the services so the new code is actually running:

```bash
systemctl --user restart pocket-desktop pocket-desktop-vnc
```

Or use **Settings → Restart server** in the app (works with the installed service; if you
started it by hand with `./run.sh`, the app tells you to start it again).

If the files on disk are newer than the running process, the app notices and shows an
**“Update not active”** banner with a restart button — that state is also logged:

```
WARN version mismatch: the browser has newer files than this process {"client":"1.1.1","server":"1.1.0"}
```

## When the screen won't connect

Press **Diagnostics** (on the error screen, or in Settings). The app runs a self-test *on your
PC* and shows a report you can copy — it names the failing step instead of leaving you guessing:

```
e2b.local 1.1.0 — diagnostics
server   port 8765 · http · pin set
client   192.168.0.170 → host header "192.168.0.170:8765"

[ ok ] X11 session
[ ok ] x11vnc installed (/usr/bin/x11vnc)
[ ok ] VNC listening 127.0.0.1:5900 (systemd)
[ ok ] Full screen handshake: RFB 003.008 · 1920x1080 · security: none (12 ms)
[FAIL] WebSocket proxy upgrade refused with HTTP 401
```

Checks explained:

| line | meaning |
|---|---|
| `X11 session` | a Wayland session cannot be captured by x11vnc |
| `x11vnc installed` | `sudo apt install x11vnc` if missing |
| `VNC listening` | the screen server is up (`systemd` = the installed service, `app` = started by the app) |
| `Full screen handshake` | the PC completes the whole RFB handshake: greeting, screen size, and whether the screen server demands a password |
| `WebSocket proxy` | the full path your phone uses — this is the one that matters |

The self-test always answers: it has a 12-second deadline, and if a probe gets stuck the
report comes back marked `[WARN] partial` with per-step timings, so it can never hang the
app or the server.

The same report is available in the terminal:

```bash
node server.js --report          # one-shot self-test, exit code 1 when something fails
curl -s localhost:8765/api/logs  # recent server activity (also in the app)
journalctl --user -u pocket-desktop -n 50   # service logs
```

The report also prints the screen server's **exact command line** and a step-by-step trace
of the handshake, which is what tells you where a connection actually stopped:

```
[ ok ] Screen server on port 5900: x11vnc (pid 47174, managed by this app)
        running as: /usr/bin/x11vnc -display :0 -rfbport 5900 -localhost -forever -shared -nopw
        phone: the phone can complete the handshake
[ ok ] Full screen handshake: RFB 003.008 · 1920x1080 · security: none (1789 ms)

screen handshake, step by step
  greeting (12/12 bytes)
  server greeting: RFB 003.008
  security types (2/1 bytes)
  server security types: none
  we chose: none (no password)
  security result (4/4 bytes)
  server init (36/24 bytes)
  desktop announced: 1920x1080 "suricata-nids:0"
```

If it ever stops at `server security types: VNC password`, the screen server is asking for
credentials the phone does not have. The app's own server never does this — it is always
started with `-nopw`, because it only listens on 127.0.0.1 behind your PIN.

The server logs every connection with bytes transferred, close code and how often the
phone fell behind, e.g.

```
info ws: client connected  {peer 192.168.0.170:51234, origin http://192.168.0.170:8765}
info ws: closed  {peer 192.168.0.170:51234, code 1006, toClient 24.53 MB, toPc 168, ms 8420, stalls 3, maxBufferedKB 2048}
```

Reading that line:

| field | meaning |
|---|---|
| `code 1006` | the phone vanished without a clean close (Wi-Fi drop, app swiped away) |
| `toClient` | bytes of screen data sent to the phone — near zero means the session died during the handshake |
| `stalls` | times the phone fell behind and the PC was paused (normal for a big screen, must not grow forever) |
| `toPc` | bytes the phone sent — a healthy noVNC session sends ~170+; under ~50 means it died during setup |
| `maxBufferedKB` | deepest the outgoing buffer got |

### “The screen server hung up during the handshake”

*The app fixes this on its own — this section explains what it is doing.*

The screen server answered, then dropped the connection before sending the picture —
almost always because it **demands a password** (a leftover `~/.vnc/passwd` or another
remote-desktop tool), or because it is some other program's server that cannot serve this
display.

The moment the app sees it, it replaces that server with one it controls (started with
`-nopw`, reachable only from the PC itself, still behind your PIN). The phone reconnects a
few seconds later and it works. If the port is held by something that keeps coming back (a
systemd service with `Restart=always`), the app moves its screen server to a free port
(5910+) instead — it does that once a minute at most, never in a loop.

If you want to watch it happen: `journalctl --user -u pocket-desktop -f | grep app:`

### “The screen server hung up during the handshake” (manual)

The screen server answered, then dropped the connection before sending the picture. In
practice this means **another program is holding the screen port** — a leftover x11vnc from
an earlier session, a second remote-desktop tool, or an x11vnc attached to a display that
no longer exists. The app notices and says so, and offers **Restart screen server**, which
takes the port back and starts the app's own server.

To see who owns it:

```bash
node server.js --report     # prints: Screen server on port 5900: x11vnc (pid 1234, managed by this app)
ss -ltnp | grep 5900        # or directly
```

If the line says `NOT managed by this app`, press **Restart screen server** in the app
(Settings → Diagnostics, or on the error screen).

### The screen keeps dropping / “Connection lost”

* The app now **reconnects by itself** (3 attempts) and restarts x11vnc if it died. If it still
  fails, the message names the cause — a `1006` close within a second of connecting almost always
  means the screen server exited (check the log) or Wi-Fi dropped.
* Disable screen blanking on the PC; when the display sleeps, some setups stop updating VNC.
  `Settings → Power` in Ubuntu, or `xset s off -dpms`.
* Use **Settings → quality: Fast** on weak Wi-Fi.

## Troubleshooting

**“Wayland session detected” — the screen stays black / VNC won't start.**
x11vnc can only capture X11. Log out, click the gear ⚙ on the login screen, choose **“Ubuntu on Xorg”**, log in and restart the app. (If you are on Ubuntu 22.04+ with Wayland and want to stay there, tell me — the same app can be pointed at `gnome-remote-desktop`, which is already part of GNOME.)

**Phone can't reach the page.** Phone and PC must be on the same Wi-Fi (guest networks isolate clients). Check that the PC firewall allows the port: `sudo ufw allow 8765/tcp`. Get the URL with `./run.sh`, or scan the QR from `node server.js --pair`.

**“VNC offline.”** Click *Start VNC* on the home screen. If it fails, run `node server.js --doctor` — it names the missing piece. On X11 desktops where `xauth` isn't installed (`sudo apt install xauth`), the app falls back to starting x11vnc without an Xauthority file.

**Screenshots fail on Wayland/×** Install a capture tool: `sudo apt install gnome-screenshot` (or `imagemagick`, `scrot`, `xfce4-screenshooter`).

**Key chips or push-to-talk don't type anything.** `sudo apt install xdotool`.

**“x11vnc cannot read the X authentication file”.** Your session's Xauthority is root-only
(the app now detects and skips those files automatically). If it still happens, run
`xhost +SI:localuser:$USER` in a terminal inside your desktop session, then press *Start VNC*.

**Push-to-talk records nothing.** `sudo apt install alsa-utils`, then test on the PC: `arecord -d 3 test.wav && aplay test.wav`. Change the input device in Settings if you use a non-default one.

**Does it start without logging in?** The services are user services; the installer enables *lingering* so they come up with the machine. The desktop itself still needs to be logged in — the app captures your session, not the login greeter.

**Everything is slow or laggy.** Settings → quality *Fast*, and/or rotate the phone to landscape.

---

## Configuration

`~/.config/pocket-desktop/config.json` (0600):

```jsonc
{
  "name": "Living Room PC",   // shown in the app
  "port": 8765,
  "bind": "0.0.0.0",
  "quality": "balanced",       // sharp | balanced | fast
  "vnc": {
    "host": "127.0.0.1",       // the VNC server stays on loopback
    "port": 5900,
    "display": null,           // e.g. ":0", autodetected
    "password": null,          // optional second lock
    "autostart": true
  },
  "ptt": { "key": "space", "device": "default" }
}
```

### CLI

```
node server.js [options]
  --port <n>          listen port                (default 8765)
  --bind <addr>       interface                  (default 0.0.0.0)
  --tls | --no-tls    serve HTTPS with a self-signed cert
  --set-pin <pin>     set or change the PIN
  --pair              print a pairing URL + QR and exit
  --print-pair        print a QR after the server starts
  --doctor            check Node, session, x11vnc, X display, tools, network
  --report            full self-test including the WebSocket proxy, then exit
  --version | --help
```

### Environment

`POCKET_DESKTOP_PORT`, `POCKET_DESKTOP_BIND`, `POCKET_DESKTOP_CONFIG_DIR` (useful for a second instance / testing), `DISPLAY`, `XAUTHORITY`.

---

## Project layout

```
server.js               HTTP + WebSocket proxy, routing, TLS, banner/QR
lib/ws.js               minimal RFC 6455 WebSocket server (no deps)
lib/auth.js             PIN hashing, signed session cookies, rate limiting
lib/vnc.js              X session detection, x11vnc lifecycle, tool probing
lib/system.js           machine stats, screenshots, power, push-to-talk
lib/config.js           config load/save + defaults
lib/logbuf.js           in-memory log ring buffer (feeds /api/logs)
lib/diagnostics.js      self-test: probes VNC and the WebSocket proxy end to end
public/index.html       app shell: setup, login, home, remote, sheets
public/assets/style.css minimal dark theme, phone-first
public/assets/app.js    screens, sheets, settings, session wiring
public/assets/remote.js noVNC wrapper + touch/keyboard input layer
public/vendor/novnc     vendored noVNC 1.6 (MPL-2.0, one patch: allow HTTP)
public/vendor/qrcode.js qrcode-generator 1.4.4 (MIT)
public/sw.js            service worker (static caching, offline shell)
test/api-smoke.js       45 checks: auth, pairing, VNC, websocket, diagnostics…
test/ui-test.js         25 checks in headless Chromium at phone size
test/first-run-test.js  fresh install over HTTPS: setup → VNC → remote
test/failure-test.js    5 checks: killing x11vnc mid-session and recovering
test/restart-test.js    13 checks: version mismatch detection + the restart button
test/throughput-test.js 7 checks: a big screen update to a deliberately slow phone
test/screen-server-test.js 9 checks: a foreign screen server — detection, clear error, taking the port back
test/selfheal-test.js      7 checks: a password-protected screen server is replaced automatically
test/password-trap-test.js 8 checks: a saved VNC password never locks the phone out of the app's own server
test/uinput-test.js        12 checks: the virtual pad and mouse create real input devices
test/pad-test.js           15 checks: the on-screen controller drives real hardware events
install.sh / run.sh     installer (systemd user services) and launcher
tools/make_icons.py     regenerates the app icons (Pillow)
```

### Tests

```bash
node test/api-smoke.js --port 8765 --pin 1234              # API layer
node --experimental-websocket test/ui-test.js              # browser UI + real VNC input
node --experimental-websocket test/first-run-test.js       # fresh config over HTTPS
node --experimental-websocket test/failure-test.js         # screen-server crash recovery
node test/restart-test.js                                  # update/restart flow
node test/throughput-test.js                               # slow-phone backpressure
node test/screen-server-test.js                            # foreign screen server on the port
DISPLAY=:99 node test/selfheal-test.js                     # password-protected server, then auto-repair
DISPLAY=:99 node test/password-trap-test.js                # a saved VNC password must not break the phone
sudo node test/uinput-test.js                               # virtual gamepad/mouse (needs uinput)
sudo node test/pad-test.js                                  # gamepad UI → real hardware events
```

The UI test drives headless Chromium with touch emulation against a real Xvfb + x11vnc
pair and verifies that taps land on the exact remote pixel — screenshots of every screen
end up in `test/artifacts/`.

---

## Uninstall

```bash
./install.sh --uninstall     # removes the services (your config and PIN are kept)
rm -rf ~/.config/pocket-desktop ~/.local/share/pocket-desktop
```

---

## License

MIT for this project. Bundled components keep their own licenses:
noVNC (MPL-2.0, `public/vendor/novnc/LICENSE.txt`) and qrcode-generator (MIT).
