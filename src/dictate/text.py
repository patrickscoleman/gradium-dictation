"""Turn Gradium's streamed text segments into one tidy line of dictation."""

from __future__ import annotations

import re
from collections.abc import Iterable

_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?%)\]}])")
_SPACE_AFTER_OPEN = re.compile(r"([(\[{])\s+")
_MANY_SPACES = re.compile(r"\s{2,}")


def join_segments(segments: Iterable[str]) -> str:
    """Join streamed segments with single spaces and tidy punctuation.

    Gradium's STT stream yields text segments with start and stop times. We
    treat each one as a word or phrase. If a live key shows segments are
    sub-word pieces instead, this is the one function to change.
    """
    parts = [s.strip() for s in segments if s and s.strip()]
    text = " ".join(parts)
    text = _SPACE_BEFORE_PUNCT.sub(r"\1", text)
    text = _SPACE_AFTER_OPEN.sub(r"\1", text)
    return _MANY_SPACES.sub(" ", text).strip()


def finish(text: str, *, capitalize: bool = True) -> str:
    """Light final formatting: trim and capitalize the first letter."""
    text = text.strip()
    if capitalize and text:
        text = text[0].upper() + text[1:]
    return text
