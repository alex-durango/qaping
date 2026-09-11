#!/usr/bin/env python3
# shims/padd.py -- the vgamepad feeder child: stdin JSON-lines -> virtual Xbox 360 pad.
#
# Protocol (one JSON object per line):
#   in : {"op":"connect"}                          -> out {"event":"ready"}
#   in : {"op":"state", "buttons":[...], "lx":.., "ly":.., "rx":.., "ry":.., "lt":.., "rt":..,
#         "seq": n?, "ack": true?}                 -> out {"event":"state_ack","seq":n} iff ack
#   in : {"op":"disconnect"}                       -> exits 0
# Fatal problems emit {"event":"error","message":...} and exit 1.
#
# vgamepad drives ViGEmBus (kernel XUSB device) -- the game sees a real Xbox 360 pad.
# Import happens at connect time, not module load, so a missing driver reports as a
# protocol error the harness can render instead of a stack trace.
import json
import sys

BUTTON_MAP_NAMES = {
    "A": "XUSB_GAMEPAD_A",
    "B": "XUSB_GAMEPAD_B",
    "X": "XUSB_GAMEPAD_X",
    "Y": "XUSB_GAMEPAD_Y",
    "LB": "XUSB_GAMEPAD_LEFT_SHOULDER",
    "RB": "XUSB_GAMEPAD_RIGHT_SHOULDER",
    "BACK": "XUSB_GAMEPAD_BACK",
    "START": "XUSB_GAMEPAD_START",
    "LS": "XUSB_GAMEPAD_LEFT_THUMB",
    "RS": "XUSB_GAMEPAD_RIGHT_THUMB",
    "DPAD_UP": "XUSB_GAMEPAD_DPAD_UP",
    "DPAD_DOWN": "XUSB_GAMEPAD_DPAD_DOWN",
    "DPAD_LEFT": "XUSB_GAMEPAD_DPAD_LEFT",
    "DPAD_RIGHT": "XUSB_GAMEPAD_DPAD_RIGHT",
}


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    pad = None
    buttons = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            emit({"event": "error", "message": "bad json line"})
            return 1
        op = msg.get("op")

        if op == "connect":
            try:
                import vgamepad as vg  # noqa: import here so driver errors are protocol errors
            except Exception as exc:  # ImportError or ViGEmBus load failure
                emit({"event": "error", "message": "vgamepad import failed: %s" % exc})
                return 1
            try:
                pad = vg.VX360Gamepad()
                buttons = {name: getattr(vg.XUSB_BUTTON, xusb) for name, xusb in BUTTON_MAP_NAMES.items()}
            except Exception as exc:
                emit({"event": "error", "message": "virtual pad create failed: %s" % exc})
                return 1
            emit({"event": "ready"})

        elif op == "state":
            if pad is None:
                emit({"event": "error", "message": "state before connect"})
                return 1
            pad.reset()
            for name in msg.get("buttons") or []:
                btn = buttons.get(name)
                if btn is not None:
                    pad.press_button(button=btn)
            pad.left_joystick_float(
                x_value_float=float(msg.get("lx") or 0.0),
                y_value_float=float(msg.get("ly") or 0.0),
            )
            pad.right_joystick_float(
                x_value_float=float(msg.get("rx") or 0.0),
                y_value_float=float(msg.get("ry") or 0.0),
            )
            pad.left_trigger_float(value_float=float(msg.get("lt") or 0.0))
            pad.right_trigger_float(value_float=float(msg.get("rt") or 0.0))
            pad.update()
            if msg.get("ack"):
                emit({"event": "state_ack", "seq": msg.get("seq")})

        elif op == "disconnect":
            if pad is not None:
                pad.reset()
                pad.update()
            return 0

        else:
            emit({"event": "error", "message": "unknown op: %r" % op})
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
