#!/usr/bin/env python3
"""Type UTF-8 through xdotool with stable temporary X11 Unicode mappings.

xdotool's per-character remap/restore can outrun Chromium's MappingNotify
processing. Reserve currently unused, unpressed keycodes for a whole batch,
let clients learn the map, type, then restore it. No clipboard or files used.
Text arrives on stdin, not command-line arguments. Linux/X11 only.
"""
import ctypes as C
import ctypes.util
import os
import signal
import subprocess
import sys
import time


def main():
    text = sys.stdin.read(4097)
    if not text or len(text) > 1024 or '\0' in text:
        raise ValueError('Invalid text')
    lib = C.CDLL(ctypes.util.find_library('X11') or 'libX11.so.6')
    display_t = C.c_void_p
    key_sym = C.c_ulong
    lib.XOpenDisplay.argtypes = [C.c_char_p]
    lib.XOpenDisplay.restype = display_t
    lib.XDisplayKeycodes.argtypes = [display_t, C.POINTER(C.c_int), C.POINTER(C.c_int)]
    lib.XGetKeyboardMapping.argtypes = [display_t, C.c_ubyte, C.c_int, C.POINTER(C.c_int)]
    lib.XGetKeyboardMapping.restype = C.POINTER(key_sym)
    lib.XChangeKeyboardMapping.argtypes = [display_t, C.c_int, C.c_int, C.POINTER(key_sym), C.c_int]
    lib.XKeysymToKeycode.argtypes = [display_t, key_sym]
    lib.XKeysymToKeycode.restype = C.c_ubyte
    lib.XQueryKeymap.argtypes = [display_t, C.c_void_p]
    lib.XSync.argtypes = [display_t, C.c_int]
    lib.XFree.argtypes = [C.c_void_p]
    lib.XCloseDisplay.argtypes = [display_t]
    display = lib.XOpenDisplay(None)
    if not display:
        raise RuntimeError('No X11 display')
    low, high, width = C.c_int(), C.c_int(), C.c_int()
    lib.XDisplayKeycodes(display, C.byref(low), C.byref(high))
    mapping = lib.XGetKeyboardMapping(display, low.value, high.value-low.value+1, C.byref(width))
    if not mapping:
        lib.XCloseDisplay(display)
        raise RuntimeError('Cannot read keyboard map')
    try:
        pressed = C.create_string_buffer(32)
        lib.XQueryKeymap(display, pressed)
        free = []
        for code in range(low.value, high.value+1):
            original = tuple(mapping[(code-low.value)*width.value+i] for i in range(width.value))
            if not any(original) and not (pressed.raw[code//8] & (1 << (code % 8))):
                free.append((code, original))
        if not free:
            raise RuntimeError('No unused Unicode keycodes')
        def symbol(ch):
            n = ord(ch)
            return n if n < 256 else 0x01000000 | n
        # Chunk only when the set of unmapped symbols exhausts unused keycodes.
        batches, part, needed = [], '', set()
        for ch in text:
            sym = symbol(ch)
            needs = ord(ch) > 127 and not lib.XKeysymToKeycode(display, sym)
            if needs and sym not in needed and len(needed) == len(free):
                batches.append((part, needed))
                part, needed = '', set()
            part += ch
            if needs:
                needed.add(sym)
        if part:
            batches.append((part, needed))
        for part, needed in batches:
            changed = []
            try:
                for (code, original), sym in zip(free, sorted(needed)):
                    changed.append((code, original))
                    values = (key_sym * width.value)(*([sym] * width.value))
                    lib.XChangeKeyboardMapping(display, code, width.value, values, 1)
                lib.XSync(display, 0)
                if changed:
                    time.sleep(.12)
                result = subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '3', '--file', '-'],
                                        input=part.encode('utf-8'), stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, timeout=10,
                                        env={**os.environ, 'LC_ALL': 'C.UTF-8'})
                if result.returncode:
                    raise RuntimeError('Typing failed')
            finally:
                # Keep maps stable while client applications drain queued input.
                time.sleep(.15)
                for code, original in changed:
                    values = (key_sym * width.value)(*original)
                    lib.XChangeKeyboardMapping(display, code, width.value, values, 1)
                lib.XSync(display, 0)
    finally:
        lib.XFree(mapping)
        lib.XCloseDisplay(display)


def interrupted(_signal, _frame):
    raise KeyboardInterrupt()


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except BaseException:
        # Never print submitted text or subprocess arguments.
        sys.stderr.write('X11 text input failed; check the focused desktop before retrying.\n')
        sys.exit(1)
