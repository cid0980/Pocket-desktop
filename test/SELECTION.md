# Real text-selection integration test

This test is destructive to pointer position. Use a disposable Linux desktop rig,
not your active PC session. It is not part of normal installation or unattended CI.

1. Run the app and open its Mouse pad once so the virtual mouse device exists.
2. Find the matching `/dev/input/eventN` by reading
   `/sys/class/input/event*/device/name` for `Pocket Desktop virtual mouse`.
3. Copy `selection-xorg.conf.example` to a temporary absolute path and replace
   its `Option "Device"` value with that event path. Install Xorg core, the dummy
   video driver and evdev input driver in the test VM/container.
4. Start Xorg with the temporary config:
   `sudo Xorg :98 -config /absolute/path/to/config -noreset -nolisten tcp -ac`.
   This intentionally uses an unauthenticated local **test** display; do not reuse
   this configuration on a shared production machine.
5. Start headed Chromium on that display with a fresh profile:
   `DISPLAY=:98 chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --user-data-dir=/tmp/pd-selection-test --remote-debugging-port=9339 --window-position=0,0 --window-size=1280,800 --kiosk file:///absolute/path/to/test/selection-target.html`
   Disabling Chromium's sandbox is only for this disposable root/container test rig.
6. With the app on port 8765 and test PIN 1234:
   `node --experimental-websocket test/mouse-desktop-test.js`.
   The smaller `selection-test.js` still runs the selection-only checks.

The test drives the phone UI through touch emulation. Its only direct XTEST action
positions the remote pointer at the start of the line before each scenario. All
presses, held movements, and releases travel through the app's WebSocket and real
uinput device into the Xorg evdev driver. No DOM mouse event or CDP mouse injection
is used on the target desktop page. The target must receive trusted native events,
select actual text, and retain the highlight after release and free pointer motion.

`PORT` and `SELECTION_DISPLAY` can override the app port and target display.
A physical phone is still required to verify real-device touch ergonomics.

The expanded test also checks single/double taps, dedicated clicks, a frame-sampled
held-button state, and actual scrolling of the target's scrollable element without
changing pointer position. It waits for rendering after positioning that element.
Run `BASELINE=1 ... test/mouse-desktop-test.js` against an older server/frontend to
print the tap result for comparison; baseline mode deliberately does not assert
that the old implementation passes.
