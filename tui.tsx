/** @jsxImportSource @opentui/solid */
import { execFile, spawn } from "node:child_process"
import { readFile, appendFile, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Show, createMemo, createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import {
  DEFAULTS,
  MAX_SECONDS,
  MODELS,
  RPM_LIMIT,
  audioSeconds,
  bindOf,
  cost,
  logLine,
  parseConfig,
  recentRpm,
  startTicker,
  summarize,
  type Model,
} from "./src/voice"

const WAV = "/tmp/opencode-groq-dictate.wav"
const COST_LOG = join(homedir(), ".cache/groq-dictate-costs.log")
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
// Same column width as the go-meter panel, so both plugins line up.
const LABEL_WIDTH = 8

// super+v is the key the shell script used; here the recording, the upload and the
// paste all stay inside the TUI, so nothing depends on which window has focus.
export default Plugin.define({
  id: "opencode-groq-dictate",
  setup(context) {
    // The docs show the first element used as a value, other plugins read it as an
    // accessor; accepting both keeps the plugin working whichever it is.
    const read = <T,>(value: T | (() => T)): T =>
      typeof value === "function" ? (value as () => T)() : value

    const [config, updateConfig] = context.storage.store("opencode-groq-dictate", { initial: DEFAULTS })
    const [rpm, updateRpm] = context.storage.memory("opencode-groq-dictate.rpm", { initial: [] as number[] })
    const [quota, updateQuota] = context.storage.memory("opencode-groq-dictate.quota", {
      initial: { remaining: 0, limit: 0 },
    })
    let recorder: ReturnType<typeof spawn> | null = null
    // A signal, not a plain variable: the footer indicator has to re-render when
    // it flips, and a call still reads the current value inside a command.
    const [recording, setRecording] = createSignal(false)
    const [elapsed, setElapsed] = createSignal(0)
    // "busy" covers the gap between stop and paste, so the dot never blinks off.
    const [busy, setBusy] = createSignal(false)
    const [totals, setTotals] = createSignal({ today: 0, total: 0, todayCount: 0 })
    const [last, setLast] = createSignal<{ seconds: number; usd: number } | null>(null)
    let ticker: (() => void) | null = null
    let autoStop: ReturnType<typeof setTimeout> | null = null

    const settings = () => parseConfig(read(config))

    // Seeded from the log the shell script already wrote, so the sidebar shows the
    // real spend from the first run instead of starting at zero.
    void readFile(COST_LOG, "utf8")
      .then((text) => setTotals(summarize(text, new Date())))
      .catch(() => {})

    async function askKey() {
      const apiKey = await context.ui.dialog.prompt({
        title: "Groq API key",
        placeholder: "gsk_...",
      })
      if (!apiKey) return ""
      await updateConfig((draft) => {
        draft.apiKey = apiKey.trim()
      })
      return apiKey.trim()
    }

    async function paste(text: string) {
      // prompt.paste reads the system clipboard, so the text goes there first and
      // the composer receives it exactly as if it had been pasted by hand.
      const clip = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] })
      clip.stdin.end(text)
      await new Promise((done) => clip.on("close", done))
      context.keymap.dispatch("prompt.paste")
    }

    // One round trip to Groq. Returns the text, or why there is none, so the
    // caller does not have to read the response twice.
    async function request(key: string, model: string, language: string) {
      const bytes = await readFile(WAV)
      const form = new FormData()
      form.append("file", new Blob([bytes], { type: "audio/wav" }), "voice.wav")
      form.append("model", model)
      if (language !== "auto") form.append("language", language)

      const response = await fetch(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      })

      // The daily figure only ever arrives as a header, so it is read off the real
      // request instead of spending a transcription on a probe.
      const remaining = Number(response.headers.get("x-ratelimit-remaining-requests"))
      const limit = Number(response.headers.get("x-ratelimit-limit-requests"))
      if (limit > 0)
        await updateQuota((draft) => {
          draft.remaining = remaining
          draft.limit = limit
        })

      if (response.status === 401) {
        await updateConfig((draft) => {
          draft.apiKey = ""
        })
        return { error: "Groq API key rejected" }
      }
      if (!response.ok) return { error: `Groq ${response.status}: ${await response.text()}` }

      const text = ((await response.json()) as { text?: string }).text?.trim()
      return text ? { text } : { warning: "Nothing transcribed" }
    }

    // Cost bookkeeping: the log line is best effort, the totals are in memory.
    async function bookkeep(seconds: number, model: Model) {
      const usd = cost(seconds, model)
      try {
        await appendFile(COST_LOG, logLine(new Date(), seconds, usd, model) + "\n")
      } catch (error) {
        context.ui.toast.show({ message: `Cost log: ${String(error)}`, variant: "warning" })
      }
      setTotals((current) => ({
        today: current.today + usd,
        total: current.total + usd,
        todayCount: current.todayCount + 1,
      }))
      setLast({ seconds, usd })
      return usd
    }

    // A recording started with ctrl+alt+v (or ctrl+click) also submits the prompt
    // once the text lands, so the same gesture can send without reaching for Enter.
    let submitOnStop = false

    async function transcribe(seconds: number, submit: boolean) {
      const { apiKey, language, model } = settings()
      const key = apiKey || (await askKey())
      if (!key) return

      const outcome = await request(key, model, language)
      if (outcome.error) {
        context.ui.toast.show({ message: outcome.error, variant: "error" })
        return
      }
      if (!outcome.text) {
        context.ui.toast.show({ message: outcome.warning ?? "Nothing transcribed", variant: "warning" })
        return
      }

      await paste(outcome.text)
      if (submit) {
        // The TUI applies the paste on the next frame; submitting in the same
        // tick would send the prompt without the dictated text.
        await new Promise((done) => setTimeout(done, 80))
        context.keymap.dispatch("prompt.submit")
      }
      // The recording is only needed until Groq answers; leaving it in /tmp keeps
      // a copy of everything dictated on disk.
      await rm(WAV, { force: true }).catch(() => {})

      const usd = await bookkeep(seconds, model)
      context.ui.toast.show({ message: `Dictated ${seconds.toFixed(1)}s · $${usd.toFixed(4)}`, variant: "success" })
    }

    async function stop() {
      if (!recorder) return
      const submit = submitOnStop
      submitOnStop = false
      const child = recorder
      recorder = null
      setRecording(false)
      setBusy(true)
      ticker?.()
      if (autoStop) clearTimeout(autoStop)
      ticker = null
      autoStop = null
      child.kill("SIGINT")
      await new Promise((done) => child.on("close", done))
      const seconds = audioSeconds((await stat(WAV)).size)
      if (seconds < 0.2) {
        context.ui.toast.show({ message: "Recording too short", variant: "warning" })
        setBusy(false)
        return
      }
      context.ui.toast.show({ message: "Transcribing…", variant: "info" })
      try {
        await transcribe(seconds, submit)
      } catch (error) {
        context.ui.toast.show({ message: String(error), variant: "error" })
      } finally {
        setBusy(false)
      }
    }

    // A monitor source records the speakers, not the room: that silence comes back as
    // an invented sentence ("Grazie a tutti!"), so the take is refused before it starts.
    const hasMicrophone = () =>
      new Promise<boolean>((done) => {
        execFile("pactl", ["get-default-source"], (error, stdout) =>
          done(!!error || !stdout.trim().endsWith(".monitor")),
        )
      })

    async function start(submit = false) {
      const { apiKey } = settings()
      if (!apiKey) {
        context.ui.toast.show({ message: "Set the Groq API key first", variant: "warning" })
        if (!(await askKey())) return
      }
      if (!(await hasMicrophone())) {
        context.ui.toast.show({
          message: "No microphone: the default source is a monitor",
          variant: "error",
        })
        return
      }
      const now = Date.now()
      const recent = recentRpm(read(rpm), now)
      if (recent.length >= RPM_LIMIT) {
        context.ui.toast.show({ message: `Groq free tier: ${RPM_LIMIT}/min reached, wait a moment`, variant: "error" })
        return
      }
      await updateRpm((draft) => {
        draft.splice(0, draft.length, ...recent, now)
      })

      recorder = spawn("parec", ["--rate=16000", "--channels=1", "--file-format=wav", WAV], {
        stdio: "ignore",
      })
      recorder.on("error", (error) => {
        recorder = null
        setRecording(false)
        setBusy(false)
        ticker?.()
        if (autoStop) clearTimeout(autoStop)
        context.ui.toast.show({ message: `parec: ${error.message}`, variant: "error" })
      })
      setRecording(true)
      // Only a take that actually started arms the submit, so a failed start does
      // not make the next alt+v send the prompt.
      submitOnStop = submit
      setElapsed(0)
      ticker = startTicker(() => setElapsed((value) => value + 1))
      // Nobody wants a ten-minute upload because the stop key was forgotten.
      autoStop = setTimeout(() => {
        context.ui.toast.show({ message: `Stopped at ${MAX_SECONDS}s`, variant: "warning" })
        void stop()
      }, MAX_SECONDS * 1000)
      context.ui.toast.show({
        message: submit
          ? `Recording… ${settings().bindSubmit || "the palette"} stops and sends · esc cancels`
          : `Recording… ${settings().bindStart || "the palette"} stops · esc cancels`,
        variant: "info",
        duration: 2000,
      })
    }


    // Esc aborts the take: nothing is uploaded, so no quota and no cost.
    async function cancel() {
      if (!recorder) return
      submitOnStop = false
      const child = recorder
      recorder = null
      setRecording(false)
      setBusy(false)
      ticker?.()
      ticker = null
      if (autoStop) clearTimeout(autoStop)
      autoStop = null
      child.kill("SIGINT")
      await new Promise((done) => child.on("close", done))
      await rm(WAV, { force: true }).catch(() => {})
      context.ui.toast.show({ message: "Recording cancelled", variant: "info" })
    }

    // One entry point for the keybinding and for the click on the panel.
    // submit=true means "record, transcribe, then press Enter".
    const toggle = (submit = false) => {
      if (recording()) return stop()
      return start(submit)
    }

    async function pickModel() {
      const model = await context.ui.dialog.select({
        title: "Transcription model",
        options: MODELS.map((id) => ({ value: id, title: id })),
      })
      if (!model) return
      await updateConfig((draft) => {
        draft.model = model
      })
      context.ui.toast.show({ message: `Model: ${model}`, variant: "success" })
    }

    async function showQuota() {
      const { remaining, limit } = read(quota)
      const used = recentRpm(read(rpm), Date.now()).length
      const { today, total, todayCount } = read(totals)
      await context.ui.dialog.alert({
        title: "Groq dictation",
        message: [
          `Model: ${settings().model}`,
          `Language: ${settings().language}`,
          `Requests today: ${limit > 0 ? `${remaining} / ${limit} left` : "unknown (dictate once)"}`,
          `Local RPM: ${used} / ${RPM_LIMIT}`,
          `Spent today: $${today.toFixed(4)} (${todayCount} runs)`,
          `Spent in total: $${total.toFixed(4)}`,
        ].join("\n"),
      })
    }

    async function pickLanguage() {
      const language = await context.ui.dialog.prompt({
        title: "Language code (blank or 'auto' for detection)",
        placeholder: settings().language,
      })
      if (language === undefined) return
      await updateConfig((draft) => {
        draft.language = language.trim() || "auto"
      })
      context.ui.toast.show({ message: `Language: ${settings().language}`, variant: "success" })
    }

    // One panel for the four things a user changes: the two shortcuts, the model
    // and the language. Each row reopens the panel after writing, because the
    // dialog body renders once and its labels would otherwise stay stale.
    const settingsRow = (label: string, value: string, onClick: () => void) => (
      <box flexDirection="row" onMouseUp={onClick}>
        <text>{(label + "  ").padEnd(18)}</text>
        <text fg={accent()}>{value}</text>
      </box>
    )

    function openSettings() {
      const current = settings()
      context.ui.dialog.clear()
      context.ui.dialog.show(() => (
        <box flexDirection="column" paddingLeft={1} paddingRight={1}>
          <text fg={accent()}>{"Groq dictation"}</text>
          <text fg={muted()}>{"click a row: changes apply at once"}</text>
          {settingsRow("start / stop", current.bindStart || "disabled", () =>
            editBind("bindStart", "Start and stop"),
          )}
          {settingsRow("start and send", current.bindSubmit || "disabled", () =>
            editBind("bindSubmit", "Start, stop and send"),
          )}
          {settingsRow("model", current.model.replace("whisper-", ""), () => change(pickModel))}
          {settingsRow("language", current.language, () => change(pickLanguage))}
        </box>
      ))
      context.ui.dialog.set({ size: "large", centered: true })
    }

    // The panel closes before a prompt can open, then comes back with the new value.
    async function change(action: () => Promise<void>) {
      context.ui.dialog.clear()
      await action()
      openSettings()
    }

    async function editBind(key: "bindStart" | "bindSubmit", title: string) {
      context.ui.dialog.clear()
      const value = await context.ui.dialog.prompt({
        title: `${title} (blank disables the key)`,
        placeholder: settings()[key] || "e.g. alt+v",
        value: settings()[key],
      })
      if (value !== undefined)
        await updateConfig((draft) => {
          draft[key] = value.trim()
        })
      openSettings()
    }

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "opencode-groq-dictate.toggle",
          title: "Dictate (Groq)",
          group: "Voice",
          // Not super+v: VTE only enables xterm modifyOtherKeys, which never
          // reports the Super modifier, so that binding could not fire here.
          // Read from the stored config, so changing it in the panel rebinds now.
          bind: bindOf(settings().bindStart),
          palette: true,
          slash: { name: "dictate" },
          run: () => toggle(),
        },
        {
          id: "opencode-groq-dictate.toggleSubmit",
          title: "Dictate (Groq) and submit",
          group: "Voice",
          // ctrl+alt is what modifyOtherKeys reports, the same path the TUI's own
          // ctrl+alt defaults take. Rebind or disable it in cli.json like any other.
          bind: bindOf(settings().bindSubmit),
          palette: true,
          run: () => toggle(true),
        },
        {
          id: "opencode-groq-dictate.cancel",
          title: "Cancel dictation",
          group: "Voice",
          bind: "escape",
          // Returning false hands Escape back to the TUI when nothing is recording.
          run: () => {
            if (!recorder) return false
            void cancel()
            return true
          },
        },
        {
          id: "opencode-groq-dictate.quota",
          title: "Dictation quota",
          group: "Voice",
          palette: true,
          run: showQuota,
        },
        {
          id: "opencode-groq-dictate.language",
          title: "Dictation language",
          group: "Voice",
          palette: true,
          run: pickLanguage,
        },
        {
          id: "opencode-groq-dictate.model",
          title: "Dictation model",
          group: "Voice",
          palette: true,
          run: pickModel,
        },
        {
          id: "opencode-groq-dictate.settings",
          title: "Dictation settings",
          group: "Voice",
          palette: true,
          run: openSettings,
        },
      ],
      bindings: [
        "opencode-groq-dictate.toggle",
        "opencode-groq-dictate.toggleSubmit",
        "opencode-groq-dictate.cancel",
      ],
    }))

    const red = () => context.theme?.hue?.red?.["400"] ?? "#ff5555"
    const amber = () => context.theme?.hue?.orange ?? "#FF9654"
    const green = () => context.theme?.hue?.green?.["400"] ?? "#7fbf7f"
    const muted = () => context.theme?.text?.muted ?? context.theme?.text?.subdued ?? "#808080"
    // The brand accent, the same one the go-meter panel uses for its figures.
    const accent = () =>
      context.theme?.hue?.accent?.["500"] ?? context.theme?.hue?.interactive?.["300"] ?? "#FF9654"

    // The footer row already carries the model and the other status items, so the
    // dot sits next to them and disappears when there is nothing to report.
    context.ui.slot({
      append: "prompt.footer.status",
      // Always return an element: the host reads .length on what the render
      // returns, and a <Show> that resolves to nothing hands it undefined,
      // which crashes the slot ("evaluating 'e.length'") on v2.1.0.
      render: () => (
        <text fg={recording() ? red() : amber()}>
          {recording() ? `● REC ${elapsed()}s` : busy() ? "● …" : ""}
        </text>
      ),
    })

    // Label column, the same width trick the go-meter rows use so the figures line
    // up under each other instead of drifting.
    // ctrl+click mirrors ctrl+alt+v: the OpenTUI MouseEvent carries the modifiers.
    type Click = { modifiers?: { ctrl?: boolean } } | undefined
    const wantsSubmit = (event: Click) => !!event?.modifiers?.ctrl
    const row = (
      label: string,
      value: string,
      fg: () => string | undefined,
      onClick?: (event: Click) => void,
    ) => (
      <box flexDirection="row" gap={0} onMouseUp={onClick}>
        <text>{label.padEnd(LABEL_WIDTH)}</text>
        <text fg={fg()}>{value}</text>
      </box>
    )

    // Memoised so the six rows do not recompute the log totals on every repaint.
    const spent = createMemo(() => read(totals))
    const lastRun = createMemo(() => last())

    // Same slot the go-meter plugin uses: the sidebar is where a figure can sit
    // without crowding the prompt row.
    context.ui.slot({
      append: "sidebar.content",
      render: () => {
        const figures = spent()
        const used = recentRpm(read(rpm), Date.now()).length
        // Three colours, one meaning each: red while recording, amber while the
        // text is in flight, green when the plugin is idle and ready.
        const state = () => (recording() ? red() : busy() ? amber() : green())
        return (
          <box flexDirection="column">
            <box flexDirection="row" gap={1}>
              {/* Plain glyphs: the emoji did not render in every terminal font. */}
              <text fg={state()}>{"■"}</text>
              <text onMouseUp={(event) => toggle(wantsSubmit(event))}>{"Groq Dictate"}</text>
              <text fg={muted()} onMouseUp={() => openSettings()}>{"settings"}</text>
            </box>
            {row(
              "state",
              recording() ? `● rec ${elapsed()}s` : busy() ? "transcribing…" : "idle",
              state,
              (event) => toggle(wantsSubmit(event)),
            )}
            {row("model", settings().model.replace("whisper-", ""), () => undefined, pickModel)}
            {row("lang", settings().language, () => undefined, pickLanguage)}
            {row("today", `$${figures.today.toFixed(4)} · ${figures.todayCount}`, accent)}
            {row("total", `$${figures.total.toFixed(4)}`, accent)}
            <Show when={lastRun()}>
              {(run) => row("last", `${run().seconds.toFixed(1)}s · $${run().usd.toFixed(4)}`, muted)}
            </Show>
            {row("rpm", `${used}/${RPM_LIMIT}`, used >= RPM_LIMIT ? red : muted, showQuota)}
          </box>
        )
      },
    })

    return () => {
      ticker?.()
      if (autoStop) clearTimeout(autoStop)
      if (recorder) recorder.kill("SIGINT")
    }
  },
})
