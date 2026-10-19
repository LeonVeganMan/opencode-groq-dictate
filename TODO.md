# TODO

## Auto-stop when the sentence ends (not implemented)

Idea: stop the recording on its own after a pause instead of waiting for `alt+v`.

Why it is parked: the microphone gain is the blocker, not the code. Measured on
2026-10-19 with `amixer -c 1 sget Capture` at 63/63 (+30 dB), the ambient floor
sat at -11 dBFS (p50), min -13.8, max -4.0 over 100 ms windows. Speech has no
headroom above that, so no threshold can tell voice from room.

Prerequisite: lower `Capture` (about 40/63) and turn `Mic Boost` /
`Internal Mic Boost` off, then measure the floor again. Below roughly -35 dBFS
a fixed offset works; above it the thresholds need hand tuning.

Sketch, if it is picked up again:

- `parec --format=s16le --rate=16000 --channels=1` on stdout instead of writing
  the WAV, so the plugin sees the levels live.
- Pure state machine in `src/vad.ts`, unit tested with synthetic PCM:
  floor from the first 300 ms, threshold = floor + 10 dB, arm after 300 ms of
  speech, stop after 800 ms below the threshold, cap at `MAX_SECONDS`.
- The WAV is then built in the plugin: 44 byte header plus the PCM buffer.
- Opt-in command in the palette until it has proven itself on real dictation.

## Smaller ideas

- `Esc` while transcribing: abort the fetch with `AbortController`.
- Trim the pre-roll and the trailing silence before uploading (less cost, fewer
  Whisper hallucinations).
- Regression assertion in the smoke test for the `escape` binding.
