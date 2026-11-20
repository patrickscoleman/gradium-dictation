# What a press takes

Measured against production (https://gradium-dictation.vercel.app) with a
scripted press: an 11-second recorded clip streamed in real time from San
Francisco, through the relay in Paris, to Gradium. Each row is one change.

| | Relay ready, after the press | First words, after speech begins | Last words, after release |
|---|---|---|---|
| Live relay, connecting at the press (b208ae7, 2026-11-20) | 549 to 693 ms | 1,574 to 1,575 ms | 521 to 540 ms |

How to read it: "first words" includes saying them. Gradium answers about
0.56 s behind the voice at `delay_in_frames: 7`, and its first message here
is two words ("Bonjour à").
