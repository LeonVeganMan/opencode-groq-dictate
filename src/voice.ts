// The parts of dictation that do not touch a terminal: config shape, WAV maths,
// the local RPM window, the cost-log line and the totals read back from it.
// Kept here so `bun test` can check them without the TUI.

export const MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const
export type Model = (typeof MODELS)[number]
export const DEFAULT_MODEL: Model = "whisper-large-v3-turbo"
// Groq bills per audio hour: large-v3 is ~2.8x turbo, not the same rate.
export const RATE_PER_HOUR: Record<Model, number> = {
  "whisper-large-v3-turbo": 0.04,
  "whisper-large-v3": 0.111,
}
// Groq bills a minimum of 10 seconds per request, however short the take.
export const MIN_BILLED_SECONDS = 10
export const RPM_LIMIT = 20
// A forgotten recording would upload silence for minutes; cap it.
export const MAX_SECONDS = 60
export const SAMPLE_RATE = 16_000
export const BYTES_PER_SAMPLE = 2
// parec writes a canonical 44-byte header; anything past it is audio.
export const WAV_HEADER = 44

export type Config = {
  apiKey: string
  language: string
  model: Model
  // Empty means "no binding": the command stays in the palette, the key does nothing.
  bindStart: string
  bindSubmit: string
}

export const DEFAULTS: Config = {
  apiKey: "",
  language: "it",
  model: DEFAULT_MODEL,
  bindStart: "alt+v",
  bindSubmit: "ctrl+alt+v",
}

export function parseConfig(raw: unknown): Config {
  const value = (raw ?? {}) as Record<string, unknown>
  const model = MODELS.includes(value.model as Model) ? (value.model as Model) : DEFAULTS.model
  // Binds are free text: an empty string is meaningful (disabled), a missing key is not.
  const bind = (key: "bindStart" | "bindSubmit") =>
    typeof value[key] === "string" ? (value[key] as string) : DEFAULTS[key]
  return {
    apiKey: typeof value.apiKey === "string" ? value.apiKey : DEFAULTS.apiKey,
    language: typeof value.language === "string" && value.language ? value.language : DEFAULTS.language,
    model,
    bindStart: bind("bindStart"),
    bindSubmit: bind("bindSubmit"),
  }
}

// The keymap wants `false` to disable a binding, not an empty string.
export function bindOf(value: string): string | false {
  return value.trim() || false
}

export function audioSeconds(bytes: number): number {
  return Math.max(0, bytes - WAV_HEADER) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
}

// Peak level in dBFS: 0 is full scale, -Infinity is digital silence. Dictation
// goes wrong on the mic gain (clipping or a whisper), not on the room, so the
// plugin warns before uploading a take it cannot read.
export function peakDbfs(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let peak = 0
  for (let i = WAV_HEADER; i + 1 < bytes.length; i += 2) {
    const sample = Math.abs(view.getInt16(i, true))
    if (sample > peak) peak = sample
  }
  return peak === 0 ? -Infinity : 20 * Math.log10(peak / 32768)
}

export function cost(seconds: number, model: Model = DEFAULT_MODEL): number {
  const billable = seconds > 0 ? Math.max(seconds, MIN_BILLED_SECONDS) : 0
  return (billable / 3600) * RATE_PER_HOUR[model]
}

export function recentRpm(stamps: number[], now: number): number[] {
  return stamps.filter((at) => now - at < 60_000)
}

// Same columns the shell script wrote: `date time seconds cost`, which is what
// the /dictate-cost command's awk still reads. The model is appended as a fifth
// column so a rate change stays attributable; older lines simply lack it.
export function logLine(at: Date, seconds: number, usd: number, model?: Model): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  const line = `${date} ${time} ${seconds.toFixed(1)} ${usd.toFixed(6)}`
  return model ? `${line} ${model}` : line
}

export type Totals = { today: number; total: number; todayCount: number }

// Reads back the same four columns, ignoring anything malformed so a hand-edited
// log line cannot break the sidebar.
export function summarize(text: string, now: Date): Totals {
  const pad = (n: number) => String(n).padStart(2, "0")
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const totals: Totals = { today: 0, total: 0, todayCount: 0 }
  for (const line of text.split("\n")) {
    const [date, , , rawCost] = line.trim().split(/\s+/)
    const usd = Number(rawCost)
    if (!date || !Number.isFinite(usd)) continue
    totals.total += usd
    if (date === today) {
      totals.today += usd
      totals.todayCount += 1
    }
  }
  return totals
}

// One ticker for the recording counter: the TUI only supplies the signal.
export function startTicker(onTick: () => void, ms = 1000): () => void {
  const id = setInterval(onTick, ms)
  return () => clearInterval(id)
}
