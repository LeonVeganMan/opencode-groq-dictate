# AGENTS.md — opencode-groq-dictate

TUI plugin for OpenCode v2: `alt+v` toggles a `parec` recording, the WAV goes to Groq
(`whisper-large-v3-turbo`, `language=it`), and the transcription is put in the clipboard
and pasted into the prompt with `prompt.paste`. Nothing is auto-submitted: the text stays
in the composer to be corrected.

## Layout

- `tui.tsx` — the plugin: `Plugin.define({ id: "opencode-groq-dictate", setup(context) })`. Recording,
  Groq call, clipboard, keymap layer, dialogs. Exposed as the package's `./tui` export.
  Layer commands: `toggle` (`alt+v`), `toggleSubmit` (`ctrl+alt+v`, pastes then
  dispatches `prompt.submit`), `cancel` (`escape`), `quota`, `language`, `model`.
  The sidebar rows are clickable too: plain click toggles, ctrl+click submits; the
  `MouseEvent` carries `modifiers.ctrl`.
- `src/voice.ts` — pure logic, no TUI imports: rates, `cost()`, `recentRpm()`, `logLine()`, `parseConfig()`.
- `src/voice.test.ts` — `bun test` (9 tests).
- `src/*.test.ts` must not import `@opencode/plugin/tui`.

## Commands

```bash
bun test                                            # unit tests
bun build tui.tsx --target=node --external '*'      # build check (CI does this too)
~/work/opencode/release.sh patch                    # release: bump, commit, tag, push, wait for npm
~/work/opencode/release.sh --dry-run patch          # show what it would do
```

## Hard requirements (each one cost a broken release)

- **`peerDependencies` are mandatory**: `@opentui/core`, `@opentui/solid` (`>=0.5.8`),
  `solid-js` (`>=1.9.0`). For a `.tsx` plugin the loader injects `@opentui/solid` as the JSX
  runtime, and an npm-installed plugin must resolve its own imports from its own tree.
  Without them: `Cannot find package '@opentui/solid' imported from .../tui.tsx`, while the
  same code works when loaded from a local clone (the host resolves imports differently there).
- **`@opencode/plugin` stays a `devDependency`.** As a runtime dependency it pulls ~300 MB of
  transitive packages; OpenCode resolves `@opencode/plugin/tui` at runtime.
- **`exports` must keep `"./tui": "./tui.tsx"`**, otherwise the TUI never loads.
- **`super+v` is not a usable key bind.** XFCE grabs it globally (`xfconf-query -c
  xfce4-keyboard-shortcuts`), and without XFCE the terminal still strips Super: Tilix/VTE
  delivers it as a plain `v`, because the TUI does not enable the kitty keyboard protocol
  (only `modifyOtherKeys` / `\e[>4;1m`, which reports alt and ctrl but not Super).
  Hence `alt+v`. Do not "improve" this without re-running the probe.
- **Cost log format**: the cost log is `~/.cache/groq-dictate-costs.log`, one line
  per dictation as `YYYY-MM-DD HH:MM:SS <audio seconds> <usd> [model]`. The `/dictate-cost`
  command runs the shell script's awk over that file and reads the first four columns, so the
  model column must stay optional and last.
- **Groq rates are per model and must not be shared**: `whisper-large-v3-turbo` = $0.04 per
  audio hour, `whisper-large-v3` = $0.111, minimum 10 billed seconds per request.
- **Never read the API key from a project `.env`.** It lives in the plugin storage
  (`context.storage.store`), with an env override; on `401` it is cleared and asked again.

## Release and install

Publishing is tag-driven (`.github/workflows/publish.yml`): push a `v*` tag, CI runs
`bun test`, the build check, a tag-vs-`package.json` version guard, then
`npm publish --access public --provenance` and creates the GitHub release.

- Auth is **npm trusted publishing over OIDC only** — no `NPM_TOKEN` secret exists, and none
  must be added. It requires npm >= 11.5.1, which is why the workflow installs `npm@latest`
  on Node 24 (Node 22 ships npm 10 → `ENEEDAUTH`).
- The npm trusted publisher is configured on npmjs.com for repo `LeonVeganMan/opencode-groq-dictate`
  and workflow filename **`publish.yml`** (file name only, empty environment, allow publish).
  A mismatch is reported as `403 ... OIDC permission denied for this action`, not as a config error.
- npm propagation is slow and variable (1 to 8 minutes). `release.sh` polls `npm view` for that reason.
- Users install with `opencode plugin add opencode-groq-dictate`. A clone in
  `~/.config/opencode/plugins/` **loads the plugin a second time** (duplicate palette entries,
  doubled footer, key bind registered twice): dev clones live outside the discovery dir, in
  `~/work/opencode/`.

## Debugging

- A plugin that fails to load shows `TUI plugin error` at startup and in
  `~/.local/share/opencode/log/opencode.log`.
- `opencode plugin list` shows the installed version; `opencode plugin update <name>` accepts
  one package at a time.
- Restart the TUI after installing, updating or editing `cli.json`: a running session keeps
  the code it loaded.
- `opencode plugin add` refuses local tarballs (registry or Git specifiers only). To test a
  package before publishing: `npm pack`, `npm i <tarball>` in a temp dir, then check that
  `@opentui/solid`, `@opentui/core` and `solid-js` resolve from the plugin directory — this is
  the check that would have caught the peer-dependency bug above.
