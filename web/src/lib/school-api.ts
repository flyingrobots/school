// School's lesson API, as the lesson page uses it (server/server.ts). Every response is parsed
// with Zod before the page reads it, so a reply of the wrong shape is a failure, never a verdict.
// Correctness is the server's: a quiz choice's `correct` flag is in the lesson JSON, and the page
// never reads it.
import { z } from "zod"

import type { NestNode } from "@/components/nest"

const nestNode: z.ZodType<NestNode> = z.lazy(() =>
  z.object({ label: z.string(), atoms: z.array(z.string()), edge: z.string().optional(), children: z.array(nestNode) })
)

export type Block =
  | { type: "page"; id: string; title: string; subtitle: string; children: Block[] }
  | { type: "section"; id: string; title: string; children: Block[] }
  | { type: "prose" | "card" | "quote" | "aside"; id: string; html: string }
  | { type: "quiz"; id: string; q: string; choices: { id: string; text: string }[]; why: string }
  | { type: "explain"; id: string; prompt: string; model: string; sources: { id: string; title: string; text: string }[] }
  | { type: "nest"; id: string; root: NestNode }

const block: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("page"), id: z.string(), title: z.string(), subtitle: z.string(), children: z.array(block) }),
    z.object({ type: z.literal("section"), id: z.string(), title: z.string(), children: z.array(block) }),
    z.object({ type: z.enum(["prose", "card", "quote", "aside"]), id: z.string(), html: z.string() }),
    // The choices' `correct` flags are dropped here, so nothing past this line can read them.
    z.object({ type: z.literal("quiz"), id: z.string(), q: z.string(), choices: z.array(z.object({ id: z.string(), text: z.string() })), why: z.string() }),
    z.object({
      type: z.literal("explain"),
      id: z.string(),
      prompt: z.string(),
      model: z.string(),
      sources: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() })),
    }),
    z.object({ type: z.literal("nest"), id: z.string(), root: nestNode }),
  ])
)

const criterion = z.object({ verdict: z.enum(["meets", "partly", "misses"]), note: z.string() })
const gradingBase = { id: z.number().int(), model: z.string().nullable(), supersedes: z.number().int().nullable(), at: z.string() }
const grading = z.discriminatedUnion("status", [
  z.object({
    ...gradingBase,
    status: z.literal("succeeded"),
    findings: z.object({
      insufficient_evidence: z.boolean(),
      fidelity: criterion,
      completeness: criterion,
      accessibility: criterion,
      contradictions: z.array(z.object({ source_id: z.string(), quote: z.string(), note: z.string(), quote_verified: z.boolean() })),
      summary: z.string(),
    }),
  }),
  z.object({ ...gradingBase, status: z.literal("failed"), error: z.string() }),
])

export const Explanation = z.object({ submissionId: z.string(), blockId: z.string(), text: z.string(), at: z.string(), grading: grading.nullable() })
export type Explanation = z.infer<typeof Explanation>

const Answer = z.object({ blockId: z.string(), choiceId: z.string(), correct: z.boolean() })
export type Answer = z.infer<typeof Answer>

const Neighbour = z.object({ id: z.string(), title: z.string(), subtitle: z.string() }).nullable()

export const LessonReply = z.object({
  course: z.string(),
  lesson: block,
  prev: Neighbour,
  next: Neighbour,
  encounterId: z.string(),
  answers: z.array(Answer),
  explanations: z.array(Explanation),
})
export type LessonReply = z.infer<typeof LessonReply>

/** Why a lesson is not shown: the server has no such lesson, or it could not be loaded. */
export class LessonUnavailable extends Error {
  readonly reason: "missing" | "failed"
  constructor(reason: "missing" | "failed", message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * The aid capture version the page follows (RFC 2 §3): it records every hint, model answer,
 * feedback and reference it shows. Sent as `?aid=` when it opens a lesson, so the encounter is
 * tracked and School can tell an aided submission from one with no recorded aid.
 */
export const AID_CAPTURE_VERSION = 1

/** Opens the lesson in the web view, which opens or resumes the learner's tracked encounter. */
export async function openLesson(course: string, lesson: string, signal?: AbortSignal): Promise<LessonReply> {
  let res: Response
  try {
    res = await fetch(`/api/courses/${encodeURIComponent(course)}/lessons/${encodeURIComponent(lesson)}?aid=${AID_CAPTURE_VERSION}`, { headers: { accept: "application/json" }, signal })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new LessonUnavailable("failed", "School could not be reached.")
  }
  const body: unknown = await res.json().catch(() => null)
  // School's own 404 names what is missing; any other 404 (a proxy's, say) is a failure to load.
  if (res.status === 404 && z.object({ error: z.string() }).safeParse(body).success) throw new LessonUnavailable("missing", "There is no such lesson in this course.")
  if (!res.ok) throw new LessonUnavailable("failed", `School answered ${res.status}.`)
  const parsed = LessonReply.safeParse(body)
  if (!parsed.success) throw new LessonUnavailable("failed", "School's reply was not a lesson.")
  return parsed.data
}

async function post<T>(path: string, body: unknown, reply: z.ZodType<T>): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return reply.parse(await res.json())
}

const Stored = z.enum(["stored", "duplicate"])

/** A v4 UUID, made here so that a resend carries the same id and is stored once. randomUUID exists only in a secure context, and a tailnet name over http is not one. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** Records one answer; resolves with the server's verdict only once it is committed. */
export async function answer(a: { encounterId: string; blockId: string; choiceId: string; ms: number }): Promise<{ correct: boolean }> {
  const r = await post("/api/answer", { submissionId: uuid(), ...a }, z.object({ status: Stored, correct: z.boolean() }))
  return { correct: r.correct }
}

/** Saves one explanation; resolves with it as stored, before anything grades it. */
export async function saveExplanation(x: { encounterId: string; blockId: string; text: string; ms: number }): Promise<Explanation> {
  const r = await post("/api/explanation", { submissionId: uuid(), ...x }, z.object({ status: Stored, explanation: Explanation }))
  return r.explanation
}

/** One grading attempt for a saved explanation; resolves with the explanation and its new grading. */
export async function grade(submissionId: string): Promise<Explanation> {
  const r = await post("/api/grade", { submissionId }, z.object({ status: z.string(), explanation: Explanation }))
  return r.explanation
}

export type ExposureKind = "hint" | "model-answer" | "feedback" | "reference"
export type Exposure = { exposureId: string; encounterId: string; blockId: string; kind: ExposureKind }

/**
 * Records that the page showed help for a block. Resolves once School has an answer that a resend
 * would not change: stored or a duplicate; 501, from a record that stores no exposures (not the server on Postgres), so
 * the encounter is not tracked; or a refusal (400, 409), which the same body would get again.
 * Rejects when School could not be reached or failed otherwise, so the caller can resend it.
 */
export async function expose(x: Exposure): Promise<"recorded" | "not-tracked" | "refused"> {
  const res = await fetch("/api/exposure", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(x) })
  if (res.ok) return "recorded"
  if (res.status === 501) return "not-tracked"
  if (res.status === 400 || res.status === 409) return "refused"
  throw new Error(`/api/exposure answered ${res.status}`)
}
