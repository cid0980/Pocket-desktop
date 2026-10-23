#!/usr/bin/env python3
"""
Virtual gamepad + mouse for Pocket Desktop (uinput, no dependencies).

Creates two devices the PC sees as real hardware:

  * an Xbox 360 controller — so games (Genshin, Honkai: Star Rail, Wuthering
    Waves, anything using SDL/Proton/XInput) detect a proper pad with analog
    sticks and triggers;
  * a relative mouse — so phone motion can move the pointer smoothly, which
    matters for menus and for games that ignore the pad.

Commands arrive on stdin, one per line, and are turned into input events.
Batch several with ';' and they are applied under a single SYN_REPORT.

Protocol
    a <axis> <value>       pad axis   (lx ly rx ry lt rt dx dy)
    p <button> <0|1>       pad button (a b x y lb rb back start guide ls rs)
    m <dx> <dy>            mouse move (relative)
    c <button> <0|1>       mouse button (1 left, 2 middle, 3 right)
    w <delta>              mouse wheel
    * cmd;cmd;cmd          batch: apply all, then one sync

Speaks on stdout:  READY <json>  /  ERROR <json>  /  PONG
"""

import fcntl
import json
import os
import struct
import sys
import time

# ── ioctls ────────────────────────────────────────────────────────────
UINPUT_IOCTL_BASE = 0x55  # 'U'
_IOC_WRITE = 1 << 30
_IOC_NRBITS = 8
_IOC_TYPEBITS = 8
_IOC_SIZEBITS = 14


def _IOW(nr, size):
    return _IOC_WRITE | (size << 16) | (UINPUT_IOCTL_BASE << _IOC_NRBITS) | nr


def _IO(nr):
    return (UINPUT_IOCTL_BASE << _IOC_NRBITS) | nr


UI_DEV_CREATE = _IO(1)
UI_DEV_DESTROY = _IO(2)
UI_SET_EVBIT = _IOW(100, 4)
UI_SET_KEYBIT = _IOW(101, 4)
UI_SET_RELBIT = _IOW(102, 4)
UI_SET_ABSBIT = _IOW(103, 4)
UI_SET_PROPBIT = _IOW(110, 4)
UI_DEV_SETUP = _IOW(3, 92)      # struct uinput_setup
UI_ABS_SETUP = _IOW(4, 28)      # struct uinput_abs_setup

# ── event codes ───────────────────────────────────────────────────────
EV_SYN, EV_KEY, EV_REL, EV_ABS = 0x00, 0x01, 0x02, 0x03
SYN_REPORT = 0x00

BTN_A, BTN_B, BTN_X, BTN_Y = 0x130, 0x131, 0x133, 0x134
BTN_TL, BTN_TR = 0x136, 0x137          # LB / RB
BTN_TL2, BTN_TR2 = 0x138, 0x139        # LT / RT as digital buttons
BTN_SELECT, BTN_START, BTN_MODE = 0x13A, 0x13B, 0x13C
BTN_THUMBL, BTN_THUMBR = 0x13D, 0x13E  # stick clicks

BTN_LEFT, BTN_MIDDLE, BTN_RIGHT = 0x110, 0x112, 0x111

ABS_X, ABS_Y, ABS_Z = 0x00, 0x01, 0x02
ABS_RX, ABS_RY, ABS_RZ = 0x03, 0x04, 0x05
ABS_HAT0X, ABS_HAT0Y = 0x10, 0x11

REL_X, REL_Y, REL_WHEEL = 0x00, 0x01, 0x08

BUS_USB = 0x03

PAD_BUTTONS = {
    'a': BTN_A, 'b': BTN_B,
    # Preserve the app's X/Y face-button actions on the virtual Xbox controller.
    'x': BTN_Y, 'y': BTN_X,
    'lb': BTN_TL, 'rb': BTN_TR, 'lt': BTN_TL2, 'rt': BTN_TR2,
    'back': BTN_SELECT, 'start': BTN_START, 'guide': BTN_MODE,
    'ls': BTN_THUMBL, 'rs': BTN_THUMBR,
}

PAD_AXES = {
    'lx': ABS_X, 'ly': ABS_Y, 'rx': ABS_RX, 'ry': ABS_RY,
    'lt': ABS_Z, 'rt': ABS_RZ, 'dx': ABS_HAT0X, 'dy': ABS_HAT0Y,
}

# axis: (min, max, flat, fuzz)
AXIS_RANGES = {
    ABS_X: (-32768, 32767, 128, 16),
    ABS_Y: (-32768, 32767, 128, 16),
    ABS_RX: (-32768, 32767, 128, 16),
    ABS_RY: (-32768, 32767, 128, 16),
    ABS_Z: (0, 255, 0, 0),
    ABS_RZ: (0, 255, 0, 0),
    ABS_HAT0X: (-1, 1, 0, 0),
    ABS_HAT0Y: (-1, 1, 0, 0),
}

MOUSE_BUTTONS = {'1': BTN_LEFT, 'left': BTN_LEFT, '2': BTN_MIDDLE, 'middle': BTN_MIDDLE,
                 '3': BTN_RIGHT, 'right': BTN_RIGHT}

EVENT_FMT = 'qqHHi'          # struct input_event on 64-bit Linux
EVENT_SIZE = struct.calcsize(EVENT_FMT)


class UinputError(Exception):
    pass


class Device:
    def __init__(self, path='/dev/uinput'):
        try:
            self.fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
        except PermissionError:
            raise UinputError('permission-denied')
        except FileNotFoundError:
            raise UinputError('missing')
        except OSError as exc:
            raise UinputError('error:%s' % exc.strerror)

    def ioctl(self, request, arg=0):
        try:
            fcntl.ioctl(self.fd, request, arg)
        except OSError as exc:
            raise UinputError('ioctl failed: %s' % exc.strerror)

    def setup(self, name, vendor, product, version, abs_axes, ev_bits, key_bits, rel_bits=()):
        for bit in ev_bits:
            self.ioctl(UI_SET_EVBIT, bit)
        for code in key_bits:
            self.ioctl(UI_SET_KEYBIT, code)
        for code in rel_bits:
            self.ioctl(UI_SET_RELBIT, code)
        for code in (abs_axes or ()):
            self.ioctl(UI_SET_ABSBIT, code)

        dev_id = struct.pack('HHHH', BUS_USB, vendor, product, version)
        try:
            # New API (kernel >= 4.5)
            setup = dev_id + name.encode()[:80].ljust(80, b'\0') + struct.pack('I', 0)
            self.ioctl(UI_DEV_SETUP, setup)
            for code in (abs_axes or ()):
                lo, hi, flat, fuzz = AXIS_RANGES[code]
                abs_setup = struct.pack('H2xiiiiii', code, 0, lo, hi, fuzz, flat, 0)
                self.ioctl(UI_ABS_SETUP, abs_setup)
        except UinputError:
            # Legacy API: write a uinput_user_dev, then create
            absmax = [0] * 0x40
            absmin = [0] * 0x40
            absfuzz = [0] * 0x40
            absflat = [0] * 0x40
            for code in (abs_axes or ()):
                lo, hi, flat, fuzz = AXIS_RANGES[code]
                absmin[code], absmax[code] = lo, hi
                absfuzz[code], absflat[code] = fuzz, flat
            user_dev = (name.encode()[:80].ljust(80, b'\0') + dev_id
                        + struct.pack('I', 0)
                        + struct.pack('%di' % 0x40, *absmax)
                        + struct.pack('%di' % 0x40, *absmin)
                        + struct.pack('%di' % 0x40, *absfuzz)
                        + struct.pack('%di' % 0x40, *absflat))
            os.write(self.fd, user_dev)
        self.ioctl(UI_DEV_CREATE)

    def emit(self, etype, code, value):
        os.write(self.fd, struct.pack(EVENT_FMT, int(time.time()), int(time.time() * 1e6) % 1000000,
                                      etype, code, int(value)))

    def syn(self):
        self.emit(EV_SYN, SYN_REPORT, 0)

    def close(self):
        try:
            self.ioctl(UI_DEV_DESTROY)
        except Exception:
            pass
        try:
            os.close(self.fd)
        except Exception:
            pass


def say(kind, **payload):
    sys.stdout.write('%s %s\n' % (kind, json.dumps(payload)))
    sys.stdout.flush()


class Pad:
    """Xbox 360 style controller."""

    def __init__(self, dev):
        self.dev = dev
        dev.setup(
            name='Microsoft X-Box 360 pad',
            vendor=0x045E, product=0x028E, version=0x0110,
            abs_axes=list(AXIS_RANGES.keys()),
            ev_bits=(EV_KEY, EV_ABS),
            key_bits=list(PAD_BUTTONS.values()),
        )
        self.state = {}

    def axis(self, name, value):
        code = PAD_AXES.get(name)
        if code is None:
            return
        self.dev.emit(EV_ABS, code, value)

    def button(self, name, down):
        code = PAD_BUTTONS.get(name)
        if code is None:
            return
        self.dev.emit(EV_KEY, code, 1 if down else 0)


class Mouse:
    """Relative pointer, for driving the PC cursor from phone motion."""

    def __init__(self, dev):
        self.dev = dev
        dev.setup(
            name='Pocket Desktop virtual mouse',
            vendor=0x0001, product=0x0001, version=0x0001,
            abs_axes=(),
            ev_bits=(EV_KEY, EV_REL),
            key_bits=[BTN_LEFT, BTN_MIDDLE, BTN_RIGHT],
            rel_bits=[REL_X, REL_Y, REL_WHEEL],
        )

    def move(self, dx, dy):
        if dx:
            self.dev.emit(EV_REL, REL_X, dx)
        if dy:
            self.dev.emit(EV_REL, REL_Y, dy)

    def button(self, name, down):
        code = MOUSE_BUTTONS.get(str(name))
        if code is None:
            return
        self.dev.emit(EV_KEY, code, 1 if down else 0)

    def wheel(self, delta):
        self.dev.emit(EV_REL, REL_WHEEL, delta)


def main():
    if '--check' in sys.argv:
        try:
            d = Device()
            d.close()
            say('READY', ok=True, check=True)
            return 0
        except UinputError as exc:
            say('ERROR', ok=False, error=str(exc))
            return 1

    try:
        pad = Pad(Device())
        mouse = Mouse(Device())
    except UinputError as exc:
        say('ERROR', ok=False, error=str(exc),
            hint='permission-denied: run install.sh (it adds a udev rule), or run with sudo')
        return 1

    say('READY', ok=True, pad='Microsoft X-Box 360 pad', mouse='Pocket Desktop virtual mouse')
    devices = [pad.dev, mouse.dev]

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            if line in ('q', 'quit'):
                break
            if line == 'ping':
                say('PONG')
                continue

            batch = line.startswith('*')
            if batch:
                line = line[1:]
            for cmd in line.split(';'):
                cmd = cmd.strip()
                if not cmd:
                    continue
                apply_command(cmd, pad, mouse)
                if not batch:
                    for dev in devices:
                        dev.syn()
            if batch:
                for dev in devices:
                    dev.syn()
    except KeyboardInterrupt:
        pass
    finally:
        for dev in devices:
            dev.close()
    return 0


def apply_command(cmd, pad, mouse):
    parts = cmd.split()
    if not parts:
        return
    op = parts[0]

    if op == 'a' and len(parts) >= 3:
        pad.axis(parts[1], clamp_axis(parts[1], parts[2]))
    elif op == 'p' and len(parts) >= 3:
        pad.button(parts[1], parts[2] not in ('0', 'false', 'up'))
    elif op == 'm' and len(parts) >= 3:
        mouse.move(to_int(parts[1]), to_int(parts[2]))
    elif op == 'c' and len(parts) >= 3:
        mouse.button(parts[1], parts[2] not in ('0', 'false', 'up'))
    elif op == 'w' and len(parts) >= 2:
        mouse.wheel(to_int(parts[1]))
    # unknown commands are ignored rather than killing the daemon


def clamp_axis(name, raw):
    value = to_int(raw)
    if name in ('lt', 'rt'):
        return max(0, min(255, value))
    if name in ('dx', 'dy'):
        return max(-1, min(1, value))
    return max(-32768, min(32767, value))


def to_int(raw):
    try:
        return int(float(raw))
    except (TypeError, ValueError):
        return 0


if __name__ == '__main__':
    sys.exit(main())
