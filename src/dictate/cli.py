"""Command line: `dictate` to listen, `dictate file x.wav` to transcribe a file."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

from dictate import __version__
from dictate.hotkey import KEY_NAMES, PushToTalk, listen, resolve_key
from dictate.transcribe import transcribe_file, transcribe_stream

LANGUAGES = ("en", "fr", "de", "es", "pt")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="dictate",
        description="Hold a key, speak, release: your words land in any app. Powered by Gradium speech-to-text.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--language", choices=LANGUAGES, help="expected language (default: let the model decide)")
    sub = parser.add_subparsers(dest="command")

    run = sub.add_parser("listen", help="push-to-talk dictation (the default)")
    run.add_argument("--key", default="alt_r", choices=KEY_NAMES, help="push-to-talk key (default: right Option/Alt)")
    run.add_argument("--print", dest="print_only", action="store_true", help="print text instead of pasting it")

    file = sub.add_parser("file", help="transcribe a WAV file and print the text")
    file.add_argument("path")
    return parser


def make_client():
    if not os.environ.get("GRADIUM_API_KEY"):
        sys.exit("Set GRADIUM_API_KEY first (free key at https://gradium.ai).")
    from gradium.client import GradiumClient

    return GradiumClient()


async def run_listen(key_name: str, language: str | None, print_only: bool) -> None:
    from dictate.audio import Microphone
    from dictate.insert import paste

    client = make_client()
    loop = asyncio.get_running_loop()
    mic = Microphone(loop)
    session: dict[str, object] = {"task": None, "started": 0.0}

    async def dictate_once() -> None:
        try:
            text = await transcribe_stream(client, mic.chunks(), language=language)
        except Exception as error:  # keep listening after a network or API error
            print(f"\n[dictate] transcription failed: {error}", file=sys.stderr)
            return
        if not text:
            return
        latency = time.monotonic() - float(session["started"])
        if print_only:
            print(text, flush=True)
        else:
            paste(text)
        print(f"[dictate] {len(text.split())} words, {latency:.2f}s after release", file=sys.stderr)

    def on_start() -> None:
        task = session["task"]
        if task is not None and not task.done():  # still finishing the last one
            return
        mic.start()
        session["task"] = loop.create_task(dictate_once())

    def on_stop() -> None:
        session["started"] = time.monotonic()
        mic.stop()

    ptt = PushToTalk(
        resolve_key(key_name),
        on_start=lambda: loop.call_soon_threadsafe(on_start),
        on_stop=lambda: loop.call_soon_threadsafe(on_stop),
    )
    listen(ptt)
    print(f"[dictate] hold {key_name} and speak; release to insert. Ctrl+C to quit.", file=sys.stderr)
    await asyncio.Event().wait()


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "file":
            print(asyncio.run(transcribe_file(make_client(), args.path, language=args.language)))
        else:
            key = getattr(args, "key", "alt_r")
            print_only = getattr(args, "print_only", False)
            asyncio.run(run_listen(key, args.language, print_only))
    except KeyboardInterrupt:
        pass
