# Changelog

## 1.1.0

- `esc` cancels a take: no upload, no request, no cost.
- Refuses to record when the default PulseAudio source is a `.monitor`, which is what
  turns a silent capture into a Whisper hallucination.
- Sidebar panel without the border, matching the go-meter plugin; labels in the default
  text colour, same 8-column label field.
- Plugin renamed to `opencode-groq-dictate` (storage keys follow the new name, so the
  API key is asked once more).

## 1.0.0

- First release: `alt+v` toggles recording, Groq transcription, transcript pasted into
  the prompt, 60 second cap, cost log, quota in the sidebar.
