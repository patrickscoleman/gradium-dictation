# gradium-dictation

Hold a key, speak, release: your words land in whatever app you're in. It's an
open-source, push-to-talk dictation tool on
[Gradium](https://gradium.ai) speech-to-text, in the spirit of Wispr Flow.

> **Status: first draft.** The unit tests pass. It has not yet been run
> against a live Gradium key or a real microphone. See "Before the demo".

## Try it

```bash
pipx install git+https://github.com/patrickscoleman/gradium-dictation   # or: uv tool install …
export GRADIUM_API_KEY=gd_...       # free key at https://gradium.ai
dictate listen                      # hold right Option, speak, release
```

Other ways to run it:

```bash
dictate --language fr listen --key f8   # French, push-to-talk on F8
dictate listen --print                  # print the text instead of pasting it
dictate file meeting.wav                # transcribe a WAV file
```

**macOS permissions.** The first run asks for Microphone access. Then add your
terminal (or the installed app) under System Settings › Privacy & Security ›
**Accessibility** and **Input Monitoring**, so it can see the hotkey and paste.

Languages: English, French, German, Spanish and Portuguese, the five Gradium
speech-to-text supports.

## How it works

```
hold key ─▶ mic, 24 kHz PCM, 80 ms chunks ─▶ Gradium STT stream
release  ─▶ end of audio ─▶ last words flushed ─▶ tidy text ─▶ paste into the focused app
```

- `audio.py` streams the microphone while the key is held.
- `transcribe.py` sends it to Gradium's realtime STT. The text streams back
  while you speak, so little is left to wait for after you release.
- `text.py` joins the segments and tidies spaces and capitals.
- `insert.py` pastes through the clipboard, then restores what was there.
- `hotkey.py` is the push-to-talk state machine. It ignores key auto-repeat.

Each dictation prints the time from key release to text, so you can see the
latency.

## Before the demo

1. Run `dictate file` on a short WAV recording with a real key. Check how
   segments join: `text.py` assumes each segment is a word or phrase.
2. Run `dictate listen --print` and read the release-to-text time. Try
   `json_config` `delay_in_frames` (7 to 48 frames of 80 ms) to trade
   accuracy for speed.
3. Then try `dictate listen` in Notes, Slack and a browser.

## Next

- **Personal dictionary.** Gradium's keyword boosting (`keyword_boost_id`),
  for names and jargon.
- **Clean-up pass.** Remove filler words, add punctuation and formatting by app
  (email, chat, code), with an optional LLM.
- **Hands-free mode.** Gradium's semantic voice activity detection (an
  `inactivity_prob` every 80 ms) ends a dictation without a key.
- **A menu bar app**, with a sound and a level meter while recording, and a
  signed macOS build.
- **Streaming insert**, typing text live as it arrives.

## License

MIT
