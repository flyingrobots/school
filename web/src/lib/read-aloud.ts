// Reading aloud (flyingrobots/school#175), as Reader does (~/git/reader/web/src/speech-control.tsx).
// School's server builds the text and hands it to the AI-TTS daemon through the bridge, which only
// synthesizes it (`playback: false`): nothing plays on the host's speakers. This browser fetches
// each segment's WAV from School and plays the segments in order through one <audio> element.
// Pause, next, previous and stop stay here, in this tab; the daemon's own transport is never used.
// Progress is polled every 350 ms while a segment is awaited, backing off to 2 s otherwise.
import * as React from "react"
import { z } from "zod"

/** What the learner asked to hear. The server builds the text; the browser never sends any. */
export type ReadAloudRequest =
  { course: string; lesson: string } | { feedback: true }

export type Segment = {
  index: number
  ready: boolean
  durationMs: number | null
}

export type ReadAloud = {
  /** What is being read, so the control that started it can show the bar. */
  key: string
  id: string | null
  phase: "starting" | "waiting" | "playing" | "paused" | "failed"
  /** The segment being read, from 0. */
  index: number
  count: number
  segments: Segment[]
  error: string | null
}

const Submitted = z.object({
  id: z.string().regex(/^utt_[0-9a-f]{32}$/),
  state: z.string().nullable(),
  segments: z.number().int().nonnegative().nullable(),
})
const Progress = z.object({
  id: z.string(),
  state: z.string().nullable(),
  error: z.string().nullable(),
  segments: z.array(
    z.object({
      index: z.number().int(),
      ready: z.boolean(),
      durationMs: z.number().nullable(),
    })
  ),
})
const Reason = z.object({ error: z.string() })

export const FIRST_POLL_MS = 350
export const LONGEST_POLL_MS = 2000
const ENDED = new Set(["Played", "Skipped", "Cancelled"])

let current: ReadAloud | null = null
let audio: HTMLAudioElement | null = null
let loaded = ""
let timer: ReturnType<typeof setTimeout> | undefined
let delay = FIRST_POLL_MS
let failures = 0
/** Bumped on every start and stop, so a reply for an earlier reading is dropped. */
let generation = 0
const listeners = new Set<() => void>()

const set = (next: ReadAloud | null) => {
  current = next
  listeners.forEach((l) => l())
}
const update = (patch: Partial<ReadAloud>) => {
  if (current !== null) set({ ...current, ...patch })
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** Why a reply is not what was asked for, in the server's words when it gave some. */
async function reasonOf(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null)
  const r = Reason.safeParse(body)
  return r.success
    ? r.data.error
    : `School answered ${res.status} and gave no reason.`
}

const segmentUrl = (id: string, n: number) =>
  `/api/speak/${encodeURIComponent(id)}/segments/${n}`

function player(): HTMLAudioElement {
  if (audio !== null) return audio
  audio = new Audio()
  audio.preload = "auto"
  audio.addEventListener("playing", () => {
    if (current !== null && current.phase !== "paused")
      update({ phase: "playing" })
  })
  audio.addEventListener("ended", () => {
    const s = current
    if (s === null || s.id === null) return
    if (s.index + 1 >= s.count) {
      stop()
      return
    }
    goTo(s.index + 1)
  })
  audio.addEventListener("error", () => {
    if (current !== null && loaded !== "")
      update({ phase: "failed", error: "This part could not be played." })
  })
  return audio
}

function failed(error: string) {
  clearTimeout(timer)
  audio?.pause()
  update({ phase: "failed", error })
}

/** Plays the current segment if its audio is ready; otherwise waits for it. */
function sync() {
  const s = current
  if (s === null || s.id === null || s.phase === "failed") return
  const seg = s.segments.find((x) => x.index === s.index)
  if (seg?.ready !== true) {
    if (s.phase !== "paused") update({ phase: "waiting" })
    return
  }
  const url = segmentUrl(s.id, s.index)
  const p = player()
  if (loaded === url) return
  loaded = url
  p.src = url
  if (s.phase === "paused") return
  update({ phase: "waiting" })
  p.play().catch(() => {
    // A browser that will not play without a gesture: the learner can press resume.
    if (current?.id === s.id && loaded === url) update({ phase: "paused" })
  })
}

function schedule(ms: number) {
  clearTimeout(timer)
  const mine = generation
  timer = setTimeout(() => {
    if (mine === generation) void poll()
  }, ms)
}

async function poll() {
  const s = current
  if (s === null || s.id === null) return
  const mine = generation
  try {
    const res = await fetch(`/api/speak/${encodeURIComponent(s.id)}`, {
      cache: "no-store",
    })
    if (mine !== generation) return
    if (!res.ok) return failed(await reasonOf(res))
    const p = Progress.parse(await res.json())
    if (mine !== generation) return
    failures = 0
    if (p.state === "Failed")
      return failed(p.error ?? "AI-TTS could not read this.")
    if (p.state !== null && ENDED.has(p.state)) return stop()
    const before = current!.segments.filter((x) => x.ready).length
    const ready = p.segments.filter((x) => x.ready).length
    update({
      segments: p.segments,
      count: Math.max(current!.count, p.segments.length),
    })
    sync()
    const all = p.segments.length > 0 && ready === p.segments.length
    if (all) return
    const awaited = current!.segments.find((x) => x.index === current!.index)
    // Waiting on the segment that is next to play: ask often. Otherwise back off, to 2 s.
    delay =
      awaited?.ready !== true || ready > before
        ? FIRST_POLL_MS
        : Math.min(LONGEST_POLL_MS, Math.round(delay * 1.6))
    schedule(delay)
  } catch {
    if (mine !== generation) return
    if (++failures >= 3)
      return failed("School stopped answering, so reading aloud has stopped.")
    schedule(LONGEST_POLL_MS)
  }
}

function goTo(index: number) {
  const s = current
  if (s === null || index < 0 || index >= s.count) return
  loaded = ""
  audio?.pause()
  update({ index, phase: s.phase === "paused" ? "paused" : "waiting" })
  sync()
  if (current?.segments.find((x) => x.index === index)?.ready !== true) {
    delay = FIRST_POLL_MS
    schedule(delay)
  }
}

/** Starts reading `request` aloud, in place of anything already being read. */
export async function start(
  key: string,
  request: ReadAloudRequest
): Promise<void> {
  stop()
  const mine = generation
  set({
    key,
    id: null,
    phase: "starting",
    index: 0,
    count: 0,
    segments: [],
    error: null,
  })
  // Made inside the learner's key press or click, so the browser lets it play.
  player()
  try {
    const res = await fetch("/api/speak", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
    if (mine !== generation) return
    if (!res.ok) return failed(await reasonOf(res))
    const r = Submitted.parse(await res.json())
    if (mine !== generation) return
    failures = 0
    delay = FIRST_POLL_MS
    update({ id: r.id, count: r.segments ?? 0, phase: "waiting" })
    schedule(0)
  } catch {
    if (mine === generation)
      failed("School could not be reached, so it cannot read aloud right now.")
  }
}

/** Stops reading, here and at the daemon. */
export function stop(): void {
  const id = current?.id ?? null
  generation++
  clearTimeout(timer)
  loaded = ""
  if (audio !== null) {
    audio.pause()
    audio.removeAttribute("src")
    audio.load()
  }
  set(null)
  if (id !== null)
    void fetch(`/api/speak/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {})
}

export function pause(): void {
  if (current === null || current.phase === "failed") return
  audio?.pause()
  update({ phase: "paused" })
}

export function resume(): void {
  const s = current
  if (s === null || s.phase !== "paused") return
  update({ phase: "waiting" })
  if (loaded !== "" && audio !== null) {
    audio.play().catch(() => update({ phase: "paused" }))
  } else sync()
}

export function next(): void {
  if (current !== null) goTo(current.index + 1)
}

export function previous(): void {
  if (current !== null) goTo(current.index - 1)
}

/** What is being read now, or null, outside React. */
export function reading(): ReadAloud | null {
  return current
}

/** What is being read now, or null. */
export function useReadAloud(): ReadAloud | null {
  return React.useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
}
