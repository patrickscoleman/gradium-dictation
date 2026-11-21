# What a press takes

Measured against production (https://gradium-dictation.vercel.app) on
2026-11-20 with a scripted press: a recorded clip streamed in real time
from San Francisco, through the relay in Paris (Vercel `cdg1`), to Gradium.
Each row is three runs.

| | Socket to the relay opens | Relay to Gradium: connect, set up | Counting the press | First words, after speech begins | Last words, after release |
|---|---|---|---|---|---|
| Before: everything at the press (b208ae7) | at the press: 1,060 to 1,330 ms | at the press (inside the 549 to 693 ms the relay took to be ready) | at the press | 1,574 to 1,575 ms | 521 to 540 ms |
| After: connected ahead of the press (6d55d7b) | before the press: 0 ms at the press | before the press: 34 to 55 ms, 17 to 39 ms | 30 to 48 ms | 1,634 to 1,638 ms | 552 to 646 ms |

What the numbers say:

- **The relay costs about 0.1 s, and now none of it is in the press.** From
  the Paris function, Gradium is 34 to 55 ms away to connect and 17 to 39 ms
  to set up; counting the press against the day's allowance takes 30 to
  48 ms. With the socket opened ahead, a press starts streaming at once.
  Before, a first press also waited over a second for its socket to open.
- **"First words" did not move, because it is not the relay's.** The script
  starts speaking at the instant of the press, so its 1.6 s is: saying the
  first two words (about 0.5 s; Gradium's first message is "Bonjour à"),
  Gradium's own delay (0.56 s at `delay_in_frames: 7`, the least it allows),
  and the round trip from San Francisco to Paris and back (about 0.4 s). A
  person in Paris has about 0.03 s of that last part, so about 1.2 s after
  they start speaking, or 0.6 to 0.7 s after the first words are said.
- **An idle socket to Gradium costs nothing:** 70 idle seconds, 3 credits.
  Billing follows the audio sent: 100 seconds, 303 credits.
- The page shows its own numbers for every press: first word, how far
  behind the voice the words are landing (from Gradium's start time for each
  word), and last word after release. `window.lastPress` has every step.

## Second pass, 2026-11-21 (398ec08)

Three more changes: the microphone stays open for two minutes after a press,
so the next one starts at once and begins with the 300 ms before it; a pause
mid-press (260 ms without a voice) asks Gradium to flush without ending the
stream; and the microphone is opened without echo cancelling. Same script,
same route, two or three runs a row.

| | Before (864060e) | After (398ec08) |
|---|---|---|
| Last word before a pause, after the pause begins | 1,060 to 1,079 ms | 813 to 820 ms |
| First words, after speech begins | 1,634 to 1,638 ms | 1,629 to 1,658 ms |
| Last words, after release | 552 to 646 ms | 558 to 592 ms |
| Relay to Gradium: connect, set up | 34 to 55 ms, 17 to 39 ms | 21 to 25 ms, 10 to 41 ms |

- **Only the pause moved**, by about a quarter of a second: each phrase now
  lands as it is finished instead of waiting out Gradium's delay. The flush
  does not shift later words (their `start_s` is the same with and without).
- First words cannot move from here: saying them, Gradium's lowest delay,
  and the Atlantic. In Paris expect about 1.25 s, an estimate.
- Not measured: the effect of no echo cancelling, which needs a real
  microphone, and anything on a phone.

Not possible from here: a US region. Gradium answers from Europe, so a
speaker in the US is about 0.15 s further away each way than one in Paris,
wherever the relay runs.

The deck frames this page on its demo slide: `?embed=1` is the stage alone, and only app.alloglot.com may frame it.
