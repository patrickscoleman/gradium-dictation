import asyncio
from dataclasses import dataclass

import pytest

from dictate.cli import build_parser
from dictate.hotkey import PushToTalk
from dictate.text import finish, join_segments
from dictate.transcribe import stt_setup, transcribe_file, transcribe_stream


@dataclass
class Segment:
    text: str


class FakeStream:
    def __init__(self, segments):
        self._segments = segments

    async def iter_text(self):
        for text in self._segments:
            yield Segment(text)


class FakeClient:
    """Records what would go to Gradium and answers with fixed segments."""

    def __init__(self, segments):
        self.segments = segments
        self.setup = None
        self.sent = []

    async def stt_stream(self, setup, audio):
        self.setup = setup
        self.sent = [chunk async for chunk in audio]
        return FakeStream(self.segments)


def test_join_segments_tidies_spaces_and_punctuation():
    assert join_segments([" hello", "world ", ",", "how", "are", "you", "?"]) == "hello world, how are you?"
    assert join_segments(["", "  ", "one"]) == "one"
    assert join_segments(["(", "aside", ")"]) == "(aside)"


def test_finish_capitalizes_first_letter_only():
    assert finish("  hello World ") == "Hello World"
    assert finish("") == ""
    assert finish("éclair", capitalize=True) == "Éclair"


def test_setup_adds_language_only_when_given():
    assert stt_setup("pcm") == {"model_name": "default", "input_format": "pcm"}
    assert stt_setup("pcm", "fr")["json_config"] == {"language": "fr"}


def test_transcribe_stream_sends_every_chunk_and_joins_text():
    client = FakeClient(["send", "the", "report", "to", "Neil", "."])

    async def mic():
        for chunk in (b"\x00\x01" * 10, b"\x02\x03" * 10):
            yield chunk

    text = asyncio.run(transcribe_stream(client, mic(), language="en"))
    assert text == "Send the report to Neil."
    assert len(client.sent) == 2
    assert client.setup["input_format"] == "pcm"


def test_transcribe_file_streams_wav(tmp_path):
    wav = tmp_path / "clip.wav"
    wav.write_bytes(b"RIFF" + b"\x00" * 70_000)
    client = FakeClient(["bonjour"])
    assert asyncio.run(transcribe_file(client, wav)) == "Bonjour"
    assert client.setup["input_format"] == "wav"
    assert b"".join(client.sent) == wav.read_bytes()


def test_push_to_talk_ignores_autorepeat_and_other_keys():
    events = []
    ptt = PushToTalk("K", on_start=lambda: events.append("start"), on_stop=lambda: events.append("stop"))
    for key in ("K", "K", "K", "x"):
        ptt.press(key)
    ptt.release("x")
    ptt.release("K")
    ptt.release("K")
    assert events == ["start", "stop"]


def test_cli_parses_listen_and_file():
    args = build_parser().parse_args(["--language", "es", "listen", "--key", "f8", "--print"])
    assert (args.command, args.language, args.key, args.print_only) == ("listen", "es", "f8", True)
    args = build_parser().parse_args(["file", "x.wav"])
    assert (args.command, args.path) == ("file", "x.wav")
    with pytest.raises(SystemExit):
        build_parser().parse_args(["--language", "it"])
