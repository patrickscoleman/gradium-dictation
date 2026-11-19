"""Push-to-talk: hold a key to record, release to transcribe."""

from __future__ import annotations

from collections.abc import Callable

# Friendly names for the keys people usually pick for push-to-talk.
KEY_NAMES = ("alt_r", "ctrl_r", "cmd_r", "shift_r", "f8", "f9", "f10")


class PushToTalk:
    """Turns raw key events into start/stop calls.

    Key auto-repeat sends many presses while a key is held; only the first
    press starts and the release stops. Kept free of pynput so it is testable.
    """

    def __init__(self, key: object, on_start: Callable[[], None], on_stop: Callable[[], None]) -> None:
        self.key = key
        self._on_start = on_start
        self._on_stop = on_stop
        self.held = False

    def press(self, key: object) -> None:
        if key == self.key and not self.held:
            self.held = True
            self._on_start()

    def release(self, key: object) -> None:
        if key == self.key and self.held:
            self.held = False
            self._on_stop()


def resolve_key(name: str):
    """Map a name like 'alt_r' or 'f8' to a pynput key."""
    from pynput import keyboard

    if name not in KEY_NAMES:
        raise ValueError(f"unsupported key {name!r}; choose one of {', '.join(KEY_NAMES)}")
    return getattr(keyboard.Key, name)


def listen(ptt: PushToTalk):
    """Start a background pynput listener that feeds the push-to-talk machine."""
    from pynput import keyboard

    listener = keyboard.Listener(on_press=ptt.press, on_release=ptt.release)
    listener.start()
    return listener
