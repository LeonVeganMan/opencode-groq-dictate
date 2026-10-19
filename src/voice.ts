// The parts of dictation that do not touch a terminal: config shape, WAV maths,
// the local RPM window, the cost-log line and the totals read back from it.
// Kept here so `bun test` can check them without the TUI.

export const MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const
export type Model = (typeof MODELS)[number]
export const DEFAULT_MODEL: Model = "whisper-large-v3-turbo"
// Both models bill the same per audio hour; turbo is only faster.
export const USD_PER_HOUR = 0.04
export const RPM_LIMIT = 20
// A forgotten recording would upload silence for minutes; cap it.
export const MAX_SECONDS = 60
export const SAMPLE_RATE = 16_000
export const BYTES_PER_SAMPLE = 2
// parec writes a canonical 44-byte header; anything past it is audio.
export const WAV_HEADER = 44

export type Config = { apiKey: string; language: string; model: Model }

export const DEFAULTS: Config = { apiKey: "", language: "it", model: DEFAULT_MODEL }

export function parseConfig(raw: unknown): Config {
  const value = (raw ?? {}) as Record<string, unknown>
  const model = MODELS.includes(value.model as Model) ? (value.model as Model) : DEFAULTS.model
  return {
    apiKey: typeof value.apiKey === "string" ? value.apiKey : DEFAULTS.apiKey,
    language: typeof value.language === "string" && value.language ? value.language : DEFAULTS.language,
    model,
  }
}

export function audioSeconds(bytes: number): number {
  return Math.max(0, bytes - WAV_HEADER) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
}

export function cost(seconds: number): number {
  return (seconds / 3600) * USD_PER_HOUR
}

export function recentRpm(stamps: number[], now: number): number[] {
  return stamps.filter((at) => now - at < 60_000)
}

// Same columns the shell script wrote: `date time seconds cost`, which is what
// the /dictate-cost command's awk still reads.
export function logLine(at: Date, seconds: number, usd: number): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  return `${date} ${time} ${seconds.toFixed(1)} ${usd.toFixed(6)}`
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
