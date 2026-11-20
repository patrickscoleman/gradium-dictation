"""Stream audio to Gradium speech-to-text and collect the transcript."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from dictate.text import finish, join_segments

# Gradium's raw PCM input: 24 kHz, 16-bit signed, mono, 80 ms chunks.
SAMPLE_RATE = 24_000
CHUNK_SAMPLES = 1_920
CHUNK_BYTES = CHUNK_SAMPLES * 2


def stt_setup(input_format: str, language: str | None = None) -> dict[str, Any]:
    """The setup message for one STT request."""
    setup: dict[str, Any] = {"model_name": "default", "input_format": input_format}
    if language:
        # Grounds the model in the expected language (en, fr, de, es, pt).
        setup["json_config"] = {"language": language}
    return setup


async def transcribe_stream(
    client: Any,
    audio: AsyncIterator[bytes],
    *,
    input_format: str = "pcm",
    language: str | None = None,
) -> str:
    """Send audio chunks until the iterator ends, then return the transcript."""
    stream = await client.stt_stream(stt_setup(input_format, language), audio)
    segments = [segment.text async for segment in stream.iter_text()]
    return finish(join_segments(segments))


async def transcribe_file(client: Any, path: str | Path, *, language: str | None = None) -> str:
    """Transcribe a WAV file (PCM, 16/24/32-bit). Useful to test without a mic."""
    data = Path(path).read_bytes()

    async def chunks() -> AsyncIterator[bytes]:
        for i in range(0, len(data), 32_000):
            yield data[i : i + 32_000]

    return await transcribe_stream(client, chunks(), input_format="wav", language=language)
