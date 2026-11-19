"""Microphone capture as an async stream of 80 ms PCM chunks."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from dictate.transcribe import CHUNK_SAMPLES, SAMPLE_RATE


class Microphone:
    """Opens the default input device for one dictation and streams its audio.

    The sounddevice callback runs on PortAudio's thread, so chunks cross into
    the asyncio loop with call_soon_threadsafe. stop() ends the stream with a
    None sentinel, which ends the STT request and flushes the last words.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._queue: asyncio.Queue[bytes | None] | None = None
        self._stream = None

    @property
    def recording(self) -> bool:
        return self._stream is not None

    def start(self) -> None:
        import sounddevice as sd  # imported late so tests run without PortAudio

        if self._stream is not None:
            return
        self._queue = asyncio.Queue()
        queue = self._queue

        def on_audio(indata, frames, time, status) -> None:  # noqa: ARG001
            self._loop.call_soon_threadsafe(queue.put_nowait, bytes(indata))

        self._stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=CHUNK_SAMPLES,
            callback=on_audio,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is None:
            return
        self._stream.stop()
        self._stream.close()
        self._stream = None
        if self._queue is not None:
            self._loop.call_soon_threadsafe(self._queue.put_nowait, None)

    async def chunks(self) -> AsyncIterator[bytes]:
        queue = self._queue
        if queue is None:
            return
        while True:
            chunk = await queue.get()
            if chunk is None:
                return
            yield chunk
