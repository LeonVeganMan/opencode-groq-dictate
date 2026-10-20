import { expect, test } from "bun:test"
import {
  DEFAULT_MODEL,
  audioSeconds,
  bindOf,
  cost,
  logLine,
  parseConfig,
  peakDbfs,
  recentRpm,
  startTicker,
  summarize,
} from "./voice"

test("audio length comes from the bytes past the header", () => {
  expect(audioSeconds(44)).toBe(0)
  expect(audioSeconds(44 + 16_000 * 2 * 3)).toBe(3)
})

test("the peak level comes out in dBFS", () => {
  const take = (samples: number[]) => {
    const bytes = new Uint8Array(44 + samples.length * 2)
    const view = new DataView(bytes.buffer)
    samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true))
    return bytes
  }
  expect(peakDbfs(take([]))).toBe(-Infinity)
  expect(peakDbfs(take([0, 0]))).toBe(-Infinity)
  expect(peakDbfs(take([32767, 1]))).toBeCloseTo(0, 1)
  // Half scale is -6 dB, which is what the "too quiet" warning keys off.
  expect(peakDbfs(take([-16384]))).toBeCloseTo(-6.02, 1)
})

test("cost follows the model's hourly rate", () => {
  expect(cost(3600, "whisper-large-v3-turbo")).toBeCloseTo(0.04, 6)
  expect(cost(3600, "whisper-large-v3")).toBeCloseTo(0.111, 6)
  expect(cost(0)).toBe(0)
})

test("a request bills at least ten seconds", () => {
  expect(cost(4, "whisper-large-v3-turbo")).toBeCloseTo((10 / 3600) * 0.04, 9)
  expect(cost(30, "whisper-large-v3")).toBeCloseTo((30 / 3600) * 0.111, 9)
})

test("the rpm window drops stamps older than a minute", () => {
  const now = 100_000
  expect(recentRpm([now - 61_000, now - 1_000, now], now)).toEqual([now - 1_000, now])
})

test("a config with the wrong types falls back to the defaults", () => {
  expect(parseConfig(null)).toEqual({
    apiKey: "",
    language: "it",
    model: DEFAULT_MODEL,
    bindStart: "alt+v",
    bindSubmit: "ctrl+alt+v",
  })
  expect(parseConfig({ apiKey: 42, language: "", model: "nope" })).toEqual({
    apiKey: "",
    language: "it",
    model: DEFAULT_MODEL,
    bindStart: "alt+v",
    bindSubmit: "ctrl+alt+v",
  })
  expect(
    parseConfig({
      apiKey: "gsk_x",
      language: "auto",
      model: "whisper-large-v3",
      bindStart: "alt+d",
      bindSubmit: "",
    }),
  ).toEqual({
    apiKey: "gsk_x",
    language: "auto",
    model: "whisper-large-v3",
    bindStart: "alt+d",
    // An empty bind is meaningful: the command stays in the palette, the key goes away.
    bindSubmit: "",
  })
})

test("an empty bind becomes false for the keymap", () => {
  expect(bindOf("alt+v")).toBe("alt+v")
  expect(bindOf("  ")).toBe(false)
})

test("the cost line keeps the shell script's four columns", () => {
  expect(logLine(new Date(2026, 9, 19, 8, 5, 3), 12.34, 0.000137)).toBe("2026-10-19 08:05:03 12.3 0.000137")
  expect(logLine(new Date(2026, 9, 19, 8, 5, 3), 12.34, 0.000137, "whisper-large-v3")).toBe(
    "2026-10-19 08:05:03 12.3 0.000137 whisper-large-v3",
  )
})

test("the totals ignore the optional model column", () => {
  const now = new Date(2026, 9, 19, 12, 0, 0)
  const log = ["2026-10-19 08:05:03 12.3 0.000137", "2026-10-19 09:00:00 30.0 0.000333 whisper-large-v3"].join("\n")
  const totals = summarize(log, now)
  expect(totals.today).toBeCloseTo(0.00047, 9)
  expect(totals.todayCount).toBe(2)
})

test("the totals only count today's lines, and ignore junk", () => {
  const now = new Date(2026, 9, 19, 12, 0, 0)
  const log = [
    "2026-10-18 16:30:57 453.7 0.005041",
    "2026-10-19 08:05:03 12.3 0.000137",
    "2026-10-19 09:00:00 30.0 0.000333",
    "garbage line",
    "",
  ].join("\n")
  const totals = summarize(log, now)
  expect(totals.today).toBeCloseTo(0.00047, 9)
  expect(totals.total).toBeCloseTo(0.005511, 9)
  expect(totals.todayCount).toBe(2)
})

test("the ticker runs until its stop function is called", async () => {
  let ticks = 0
  const stop = startTicker(() => ticks++, 5)
  await new Promise((done) => setTimeout(done, 22))
  stop()
  const seen = ticks
  await new Promise((done) => setTimeout(done, 20))
  expect(seen).toBeGreaterThan(0)
  expect(ticks).toBe(seen)
})
