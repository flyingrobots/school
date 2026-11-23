// The answer outbox (flyingrobots/school#28): a delivery queue, never a record of progress.
// An answer, an explanation or an exposure is put here, under the id it will be stored with,
// before it is sent, and leaves only when School has answered it for good: stored or a duplicate
// (delivered), or refused (400, 409; 501 for an exposure). Until then it is resent, in the order
// it was made, whenever School may be reachable: at once, with backoff, when the browser comes back
// online or the tab is shown again, and when a page of the app is opened again after the tab was
// closed. A resend carries the same id, so School stores it once (ADR 9).
//
// It lives in IndexedDB so that it outlives the tab. Nothing reads it as progress: the page shows
// what School's record holds, plus the submissions still here, marked as not sent yet. When this
// browser cannot keep it (IndexedDB missing, refused or failing, as in some private modes), the
// outbox keeps items in memory only and a submission is send-or-fail: if School cannot be reached
// on the first try, it is dropped from the queue and the page says that it was not recorded and
// could not be kept.
import * as api from "@/lib/school-api"

export type Outgoing =
  | { kind: "answer"; id: string; body: api.AnswerBody }
  | { kind: "explanation"; id: string; body: api.ExplanationBody }
  | { kind: "exposure"; id: string; body: api.Exposure }

/** An item as kept: `seq` is the order it was made in, across every tab of this origin. */
export type Kept = Outgoing & { seq: number }

/** What delivered submissions resolve with. */
type Value<K extends Outgoing["kind"]> = K extends "answer"
  ? { correct: boolean }
  : K extends "explanation"
    ? api.Explanation
    : null

/** School answered for good and said no: the same body would be refused again, so it is not resent. */
export class Refused extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`School refused it (${reason}).`)
    this.name = "Refused"
    this.reason = reason
  }
}

/** School could not be reached, and this browser could not keep the submission to send later. */
export class NotKept extends Error {
  constructor(error: string) {
    super(error)
    this.name = "NotKept"
  }
}

/** Where items wait. `durable` says whether they outlive the tab. */
export interface Store {
  readonly durable: boolean
  add(item: Outgoing): Promise<Kept>
  all(): Promise<Kept[]>
  remove(seq: number): Promise<void>
}

/** Items in this tab's memory only: the fallback when IndexedDB cannot be used. */
export function memoryStore(): Store {
  let next = 1
  const items = new Map<number, Kept>()
  return {
    durable: false,
    async add(item) {
      const kept = { ...item, seq: next++ } as Kept
      items.set(kept.seq, kept)
      return kept
    },
    async all() {
      return [...items.values()]
    },
    async remove(seq) {
      items.delete(seq)
    },
  }
}

const DB = "school-outbox"
const STORE = "items"

const done = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

/**
 * IndexedDB, or null when this browser will not give it. Every access is guarded: the global can be
 * missing or throw (a private mode, blocked site data), and opening can fail or never finish.
 */
export async function indexedDbStore(timeoutMs = 3_000): Promise<Store | null> {
  let db: IDBDatabase
  try {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () =>
      open.result.createObjectStore(STORE, {
        keyPath: "seq",
        autoIncrement: true,
      })
    db = await Promise.race([
      done(open),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("IndexedDB did not open")), timeoutMs)
      ),
    ])
  } catch {
    return null
  }
  // Committed to disk before an item counts as kept, so "not sent yet" means it survives the tab.
  const tx = (mode: IDBTransactionMode) =>
    db.transaction(STORE, mode, { durability: "strict" })
  const committed = (t: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error ?? new Error("aborted"))
    })
  return {
    durable: true,
    async add(item) {
      const t = tx("readwrite")
      const seq = (await done(t.objectStore(STORE).add(item))) as number
      await committed(t)
      return { ...item, seq } as Kept
    },
    async all() {
      return (await done(tx("readonly").objectStore(STORE).getAll())) as Kept[]
    },
    async remove(seq) {
      const t = tx("readwrite")
      t.objectStore(STORE).delete(seq)
      await committed(t)
    },
  }
}

type Settled =
  | { status: "delivered"; value: unknown }
  | { status: "refused"; reason: string }
  | { status: "not-kept"; error: string }

type Send = (item: Outgoing) => Promise<api.Delivery<unknown>>

const sendOne: Send = (item) => {
  switch (item.kind) {
    case "answer":
      return api.sendAnswer(item.body)
    case "explanation":
      return api.sendExplanation(item.body)
    case "exposure":
      return api.sendExposure(item.body)
  }
}

/** A submission still waiting, as the page shows it on load: its body, and what School will say. */
export type Waiting =
  | {
      kind: "answer"
      body: api.AnswerBody
      settled: Promise<{ correct: boolean }>
    }
  | {
      kind: "explanation"
      body: api.ExplanationBody
      settled: Promise<api.Explanation>
    }

export type Outbox = ReturnType<typeof createOutbox>

export function createOutbox({
  store: opening = indexedDbStore().then((s) => s ?? memoryStore()),
  send = sendOne,
  backoff = { first: 500, max: 5_000 },
}: {
  store?: Promise<Store>
  send?: Send
  backoff?: { first: number; max: number }
} = {}) {
  /** Items this tab has kept or seen and not yet settled. Resent even if another tab removed them, to learn the outcome. */
  const known = new Map<string, Kept>()
  /** What each settled item came to, this session, so a late listener still hears it. */
  const outcomes = new Map<string, Settled>()
  const listeners = new Map<string, ((s: Settled) => void)[]>()
  const onQueued = new Map<string, () => void>()
  /** Submissions this tab made: their refusal reaches the page that made them. */
  const mine = new Set<string>()
  /**
   * Submissions from an earlier tab that School refused before a page here could show them: kept
   * (in memory) until a lesson page reads `waiting`, so the refusal is surfaced, not lost.
   */
  const unshown = new Map<string, Kept>()
  let adding: Promise<unknown> = Promise.resolve()
  let running: Promise<void> | null = null
  let again = false
  let delay = backoff.first
  let timer: ReturnType<typeof setTimeout> | undefined

  const settle = (item: Outgoing, s: Settled) => {
    const id = item.id
    // Not one a page is showing (it has no listener yet), so the next page to read `waiting` shows it.
    if (
      s.status !== "delivered" &&
      item.kind !== "exposure" &&
      !mine.has(id) &&
      !listeners.has(id) &&
      "seq" in item
    )
      unshown.set(id, item as Kept)
    known.delete(id)
    onQueued.delete(id)
    outcomes.set(id, s)
    for (const l of listeners.get(id) ?? []) l(s)
    listeners.delete(id)
  }

  const outcome = (id: string) =>
    new Promise<Settled>((resolve) => {
      const s = outcomes.get(id)
      if (s) return resolve(s)
      listeners.set(id, [...(listeners.get(id) ?? []), resolve])
    })

  /** The value a submission resolves with, or the error it rejects with. */
  const result = <T>(id: string) =>
    outcome(id).then((s): T => {
      if (s.status === "delivered") return s.value as T
      if (s.status === "refused") throw new Refused(s.reason)
      throw new NotKept(s.error)
    })

  const queue = async (store: Store) => {
    const byId = new Map<string, Kept>()
    for (const k of known.values()) byId.set(k.id, k)
    for (const k of await store.all().catch(() => [])) byId.set(k.id, k)
    return [...byId.values()].sort((a, b) => a.seq - b.seq)
  }

  /** One pass over the queue, in order. It stops at the first item School could not be reached for. */
  const pass = async () => {
    const store = await opening
    for (const item of await queue(store)) {
      const d = await send(item)
      if (d.status === "unreachable") {
        // Everything from here on waits. In memory only, a submission is send-or-fail: it is dropped
        // now, so the learner is told it was not kept rather than finding it gone with the tab.
        for (const rest of await queue(store)) {
          if (rest.seq < item.seq) continue
          if (!store.durable && rest.kind !== "exposure") {
            await store.remove(rest.seq)
            settle(rest, { status: "not-kept", error: d.error })
          } else {
            onQueued.get(rest.id)?.()
            onQueued.delete(rest.id)
          }
        }
        return false
      }
      await store.remove(item.seq).catch(() => {}) // a later resend is a duplicate, which is harmless
      settle(
        item,
        d.status === "delivered"
          ? { status: "delivered", value: d.value }
          : { status: "refused", reason: d.reason }
      )
    }
    return true
  }

  const schedule = (ok: boolean) => {
    clearTimeout(timer)
    timer = undefined
    if (ok) {
      delay = backoff.first
      return
    }
    timer = setTimeout(() => void flush(), delay)
    delay = Math.min(delay * 2, backoff.max)
  }

  /** Sends everything waiting, in order. Resolves when the queue is empty or School stopped answering. */
  function flush(): Promise<void> {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      let ok: boolean
      do {
        again = false
        ok = await pass().catch(() => false)
      } while (again)
      schedule(ok)
    })().finally(() => {
      running = null
    })
    return running
  }

  const keep = (item: Outgoing) => {
    // One add at a time, so `seq` follows the order the page made them in.
    const kept = adding.then(async () => (await opening).add(item))
    adding = kept.catch(() => {})
    return kept
  }

  return {
    /** Whether items outlive the tab. */
    durable: opening.then((s) => s.durable),
    flush,

    /**
     * Keeps a submission and sends it. Resolves with School's answer once it is delivered, which may
     * be after `queued` was called; rejects with `Refused`, or `NotKept` when it could not be kept.
     */
    async submit<K extends "answer" | "explanation">(
      item: Outgoing & { kind: K },
      progress: { queued: () => void }
    ): Promise<Value<K>> {
      const settled = result<Value<K>>(item.id)
      onQueued.set(item.id, progress.queued)
      mine.add(item.id)
      try {
        const kept = await keep(item)
        if (!outcomes.has(kept.id)) known.set(kept.id, kept)
      } catch {
        // This browser would not keep it: send it once, and say so if that fails.
        onQueued.delete(item.id)
        const d = await send(item)
        settle(
          item,
          d.status === "delivered"
            ? { status: "delivered", value: d.value }
            : d.status === "refused"
              ? { status: "refused", reason: d.reason }
              : { status: "not-kept", error: d.error }
        )
        return settled
      }
      void flush()
      return settled
    },

    /** Keeps an exposure and sends it, ahead of anything the page submits after it. Never shown. */
    record(exposure: api.Exposure) {
      void keep({ kind: "exposure", id: exposure.exposureId, body: exposure })
        .then((kept) => {
          if (!outcomes.has(kept.id)) known.set(kept.id, kept)
          return flush()
        })
        .catch(() => {})
    },

    /** The submissions still waiting, oldest first, each with what School will say to it. Read only to mark them pending. */
    async waiting(): Promise<Waiting[]> {
      const store = await opening
      await adding
      const items = [
        ...(await queue(store)).filter((k) => !outcomes.has(k.id)),
        ...unshown.values(),
      ].sort((a, b) => a.seq - b.seq)
      unshown.clear()
      for (const k of items) if (!outcomes.has(k.id)) known.set(k.id, k)
      // Handled here too, so a refusal no page is showing is not an unhandled rejection.
      const handled = <T>(p: Promise<T>) => (p.catch(() => {}), p)
      return items.flatMap((k): Waiting[] =>
        k.kind === "answer"
          ? [
              {
                kind: "answer",
                body: k.body,
                settled: handled(result<{ correct: boolean }>(k.id)),
              },
            ]
          : k.kind === "explanation"
            ? [
                {
                  kind: "explanation",
                  body: k.body,
                  settled: handled(result<api.Explanation>(k.id)),
                },
              ]
            : []
      )
    },

    /** Resends when the browser says it is back, or the tab is shown again. */
    listen() {
      const kick = () => void flush()
      window.addEventListener("online", kick)
      const visible = () => {
        if (document.visibilityState === "visible") kick()
      }
      document.addEventListener("visibilitychange", visible)
      kick()
      return () => {
        window.removeEventListener("online", kick)
        document.removeEventListener("visibilitychange", visible)
        clearTimeout(timer)
      }
    },
  }
}

let shared: Outbox | undefined

/** The app's one outbox, opened on first use. */
export function outbox(): Outbox {
  shared ??= createOutbox()
  return shared
}
