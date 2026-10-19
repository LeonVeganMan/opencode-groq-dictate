# opencode-groq-dictate

Dictation inside the OpenCode v2 TUI: press **alt+v**, speak, press **alt+v** again.
The recording goes to Groq (`whisper-large-v3-turbo` by default) and the transcript is
pasted into the prompt, ready to edit. **esc** cancels a take without uploading it.

## Why a plugin and not a global shortcut

The older approach recorded in one process, then pasted with `xdotool ctrl+v` into
whatever window had focus. Here recording, upload and paste all happen inside the TUI,
so the text always lands in the prompt and nothing depends on window focus.

## Install

```sh
git clone https://github.com/LeonVeganMan/opencode-groq-dictate.git \
  ~/.config/opencode/plugins/opencode-groq-dictate
```

Restart the TUI (plugins are loaded at startup, there is no hot reload). The first
`alt+v` asks for the Groq API key; it is kept in the OpenCode plugin storage, never in
this repository.

Requirements: `parec` (pulseaudio-utils) to record, `xclip` to hand the text to
`prompt.paste`. `bun` is only needed to run the tests.

## Usage

| Key | Action |
|-----|--------|
| `alt+v` | start / stop recording |
| `esc` | cancel the take (no upload, no cost) |

A recording stops on its own after 60 seconds. The sidebar panel shows the state, the
model, the language, the spend for today and overall, the last run, and the local
requests-per-minute count; every row is clickable. `/dictate` starts a take from the
command palette, and the `Dictation …` commands open the model, language and quota
dialogs.

Super+V cannot be used here: VTE only enables xterm modifyOtherKeys, which never
reports the Super modifier, so that binding could not fire inside the terminal.

## Notes

- Cost is estimated on the audio length at $0.04/hour and appended to
  `~/.cache/groq-dictate-costs.log`, the same file the shell script used, so
  `/dictate-cost` keeps working.
- The daily request figure comes from the `x-ratelimit-*` headers of the real
  transcription: no request is spent just to probe the quota.
- Language defaults to Italian; set another code, or `auto` for detection, from the
  language dialog.

## Tests

```sh
bun test
```
