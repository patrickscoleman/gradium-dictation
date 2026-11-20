"""Put dictated text into whatever app has focus."""

from __future__ import annotations

import sys
import time


def paste(text: str, *, restore_clipboard: bool = True) -> None:
    """Paste through the clipboard, then put the old clipboard back.

    Pasting is faster and more reliable than typing key by key, and works with
    accents and every script Gradium supports.
    """
    import pyperclip
    from pynput.keyboard import Controller, Key

    previous = None
    if restore_clipboard:
        try:
            previous = pyperclip.paste()
        except pyperclip.PyperclipException:
            previous = None
    pyperclip.copy(text)
    keyboard = Controller()
    modifier = Key.cmd if sys.platform == "darwin" else Key.ctrl
    with keyboard.pressed(modifier):
        keyboard.press("v")
        keyboard.release("v")
    if previous is not None:
        time.sleep(0.25)  # let the target app read the clipboard first
        pyperclip.copy(previous)
