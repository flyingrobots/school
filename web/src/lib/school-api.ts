// School's lesson API, as the lesson page uses it (server/server.ts). Every response is parsed
// with Zod before the page reads it, so a reply of the wrong shape is a failure, never a verdict.
// Correctness is the server's: a quiz choice's `correct` flag is in the lesson JSON, and the page
// never reads it.
import { tzParam } from "./zone"
import { z } from "zod"

import type { NestNode } from "@/components/nest"

const nestNode: z.ZodType<NestNode> = z.lazy(() =>
  z.object({
    label: z.string(),
    atoms: z.array(z.string()),
    edge: z.string().optional(),
    children: z.array(nestNode),
  })
)

export type Block =
  | {
      type: "page"
      id: string
      title: string
      subtitle: string
      children: Block[]
    }
  | { type: "section"; id: string; title: string; children: Block[] }
  | { type: "prose" | "card" | "quote" | "aside"; id: string; html: string }
  | {
      type: "quiz"
      id: string
      q: string
      choices: { id: string; text: string }[]
      why: string
    }
  | {
      type: "explain"
      id: string
      prompt: string
      model: string
      sources: { id: string; title: string; text: string }[]
    }
  | { type: "nest"; id: string; root: NestNode }

const block: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("page"),
      id: z.string(),
      title: z.string(),
      subtitle: z.string(),
      children: z.array(block),
    }),
    z.object({
      type: z.literal("section"),
      id: z.string(),
      title: z.string(),
      children: z.array(block),
    }),
    z.object({
      type: z.enum(["prose", "card", "quote", "aside"]),
      id: z.string(),
      html: z.string(),
    }),
    // The choices' `correct` flags are dropped here, so nothing past this line can read them.
    z.object({
      type: z.literal("quiz"),
      id: z.string(),
      q: z.string(),
      choices: z.array(z.object({ id: z.string(), text: z.string() })),
      why: z.string(),
    }),
    z.object({
      type: z.literal("explain"),
      id: z.string(),
      prompt: z.string(),
      model: z.string(),
      sources: z.array(
        z.object({ id: z.string(), title: z.string(), text: z.string() })
      ),
    }),
    z.object({ type: z.literal("nest"), id: z.string(), root: nestNode }),
  ])
)

const criterion = z.object({
  verdict: z.enum(["meets", "partly", "misses"]),
  note: z.string(),
})
const gradingBase = {
  id: z.number().int(),
  model: z.string().nullable(),
  supersedes: z.number().int().nullable(),
  at: z.string(),
}
const grading = z.discriminatedUnion("status", [
  z.object({
    ...gradingBase,
    status: z.literal("succeeded"),
    findings: z.object({
      insufficient_evidence: z.boolean(),
      fidelity: criterion,
      completeness: criterion,
      accessibility: criterion,
      contradictions: z.array(
        z.object({
          source_id: z.string(),
          quote: z.string(),
          note: z.string(),
          quote_verified: z.boolean(),
        })
      ),
      summary: z.string(),
    }),
  }),
  z.object({ ...gradingBase, status: z.literal("failed"), error: z.string() }),
])

export const Explanation = z.object({
  submissionId: z.string(),
  blockId: z.string(),
  text: z.string(),
  at: z.string(),
  grading: grading.nullable(),
})
export type Explanation = z.infer<typeof Explanation>

const Answer = z.object({
  blockId: z.string(),
  choiceId: z.string(),
  correct: z.boolean(),
})
export type Answer = z.infer<typeof Answer>

/** A block School brought back for review, the rule that chose it, and why, in words (RFC 2 §5). */
const ReviewReason = z.object({
  blockId: z.string(),
  rule: z.string(),
  reason: z.string(),
  /** The lesson that holds the quiz now; null when none does (flyingrobots/school#159). */
  from: z.object({ id: z.string(), title: z.string() }).nullable().optional(),
})
export type ReviewReason = z.infer<typeof ReviewReason>

const Neighbour = z
  .object({ id: z.string(), title: z.string(), subtitle: z.string() })
  .nullable()

export const LessonReply = z.object({
  course: z.string(),
  lesson: block,
  prev: Neighbour,
  next: Neighbour,
  encounterId: z.string(),
  answers: z.array(Answer),
  explanations: z.array(Explanation),
  /** The review items in `lesson` (its section `school:review`), each with its reason. */
  review: z.array(ReviewReason),
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
export async function openLesson(
  course: string,
  lesson: string,
  signal?: AbortSignal
): Promise<LessonReply> {
  return lessonRequest(
    `/api/courses/${encodeURIComponent(course)}/lessons/${encodeURIComponent(lesson)}?aid=${AID_CAPTURE_VERSION}&${tzParam()}`,
    LessonReply,
    signal
  )
}

/** One GET of a lesson, in either view, parsed with `reply`; rejects with LessonUnavailable. */
async function lessonRequest<T>(
  path: string,
  reply: z.ZodType<T>,
  signal?: AbortSignal
): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, { headers: { accept: "application/json" }, signal })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new LessonUnavailable("failed", "School could not be reached.")
  }
  const body: unknown = await res.json().catch(() => null)
  // School's own 404 names what is missing; any other 404 (a proxy's, say) is a failure to load.
  if (
    res.status === 404 &&
    z.object({ error: z.string() }).safeParse(body).success
  )
    throw new LessonUnavailable(
      "missing",
      "There is no such lesson in this course."
    )
  if (!res.ok)
    throw new LessonUnavailable("failed", `School answered ${res.status}.`)
  const parsed = reply.safeParse(body)
  if (!parsed.success)
    throw new LessonUnavailable("failed", "School's reply was not a lesson.")
  return parsed.data
}

/** The slides view's reply (server/server.ts, lessonJson): the lesson and its neighbours, and no encounter. */
export const SlidesReply = z.object({
  course: z.string(),
  view: z.literal("slides"),
  lesson: block,
  prev: Neighbour,
  next: Neighbour,
})
export type SlidesReply = z.infer<typeof SlidesReply>

/**
 * Reads the lesson in the slides view, which opens no encounter and records nothing. It sends no
 * `?aid=`: nothing in the slides view is recorded, so it declares no capture version.
 */
export async function readSlides(
  course: string,
  lesson: string,
  signal?: AbortSignal
): Promise<SlidesReply> {
  return lessonRequest(
    `/api/courses/${encodeURIComponent(course)}/lessons/${encodeURIComponent(lesson)}?view=slides`,
    SlidesReply,
    signal
  )
}

async function post<T>(
  path: string,
  body: unknown,
  reply: z.ZodType<T>
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} answered ${res.status}`)
  return reply.parse(await res.json())
}

/** A v4 UUID, made here so that a resend carries the same id and is stored once. randomUUID exists only in a secure context, and a tailnet name over http is not one. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * What School said to one submission or exposure, as the outbox needs it (web/src/lib/outbox.ts).
 * - `delivered`: stored, or a resend of the same id (`duplicate`); never stored twice.
 * - `refused`: School answered 400 or 409 (and 501 for an exposure), which the same body would get
 *   again, so it is final: `conflict` (that id already names something else), `rejected` (no such
 *   encounter, or the block or choice is not in its snapshot), `invalid`, or `unsupported`.
 * - `unreachable`: School could not be reached, failed otherwise, or replied in a shape the page
 *   cannot read. A resend with the same id is safe (ADR 9), so it is kept and sent again.
 */
export type Delivery<T> =
  | { status: "delivered"; value: T }
  | { status: "refused"; reason: string }
  | { status: "unreachable"; error: string }

async function deliver<T>(
  path: string,
  body: unknown,
  reply: z.ZodType<T>,
  final: number[] = [400, 409]
): Promise<Delivery<T>> {
  let res: Response
  try {
    res = await fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    })
  } catch {
    return { status: "unreachable", error: "School could not be reached." }
  }
  const json: unknown = await res.json().catch(() => null)
  if (res.ok) {
    const parsed = reply.safeParse(json)
    return parsed.success
      ? { status: "delivered", value: parsed.data }
      : { status: "unreachable", error: `${path}'s reply was not understood.` }
  }
  if (final.includes(res.status)) {
    const said = z.object({ status: z.string() }).safeParse(json)
    return {
      status: "refused",
      reason: said.success ? said.data.status : `answered ${res.status}`,
    }
  }
  return { status: "unreachable", error: `${path} answered ${res.status}.` }
}

const Stored = z.enum(["stored", "duplicate"])

export type AnswerBody = {
  submissionId: string
  encounterId: string
  blockId: string
  choiceId: string
  ms: number
}
export type ExplanationBody = {
  submissionId: string
  encounterId: string
  blockId: string
  text: string
  ms: number
}

/** Sends one answer once; delivered with the server's verdict only once it is committed. */
export function sendAnswer(
  body: AnswerBody
): Promise<Delivery<{ correct: boolean }>> {
  return deliver(
    "/api/answer",
    body,
    z
      .object({ status: Stored, correct: z.boolean() })
      .transform((r) => ({ correct: r.correct }))
  )
}

/** Sends one explanation once; delivered with it as stored, before anything grades it. */
export function sendExplanation(
  body: ExplanationBody
): Promise<Delivery<Explanation>> {
  return deliver(
    "/api/explanation",
    body,
    z
      .object({ status: Stored, explanation: Explanation })
      .transform((r) => r.explanation)
  )
}

/** One grading attempt for a saved explanation; resolves with the explanation and its new grading. */
export async function grade(submissionId: string): Promise<Explanation> {
  const r = await post(
    "/api/grade",
    { submissionId },
    z.object({ status: z.string(), explanation: Explanation })
  )
  return r.explanation
}

export type ExposureKind = "hint" | "model-answer" | "feedback" | "reference"
export type Exposure = {
  exposureId: string
  encounterId: string
  blockId: string
  kind: ExposureKind
}

/**
 * Records once that the page showed help for a block. Besides 400 and 409, a 501 is final: a record
 * that stores no exposures (not the server on Postgres) answers it, and the encounter is not tracked.
 */
export function sendExposure(x: Exposure): Promise<Delivery<null>> {
  return deliver(
    "/api/exposure",
    x,
    z.unknown().transform(() => null),
    [400, 409, 501]
  )
}

// What a course's course.json declares about itself beyond its title (flyingrobots/school#209), each
// null when it declares none. Both course endpoints carry it.
const Manifest = {
  summary: z.string().nullable(),
  author: z.string().nullable(),
  /** An SPDX license expression, as declared. */
  license: z.string().nullable(),
  format: z.number().int().positive().nullable(),
}
/** What the pages show of a course's declaration (flyingrobots/school#277). */
export type Declaration = {
  summary: string | null
  author: string | null
  license: string | null
}

// GET /api/courses (server/server.ts, coursesJson): every course, in the server's order (by name).
// `name` is the slug the addresses carry; `title` is what the pages show: the course's course.json
// title, or its name when it declares none (flyingrobots/school#143). Counts are null when a course's
// lessons cannot be read. `trusted` is false for a course School serves in safe mode
// (flyingrobots/school#210), which the sidebar marks (flyingrobots/school#277).
export const CoursesReply = z.array(
  z.object({
    name: z.string(),
    title: z.string(),
    trusted: z.boolean(),
    ...Manifest,
    lessons: z.number().int().nonnegative().nullable(),
    reference: z.number().int().nonnegative(),
    quizzes: z.number().int().nonnegative().nullable(),
    answeredCorrectly: z.number().int().nonnegative().nullable(),
  })
)
export type CourseSummary = z.infer<typeof CoursesReply>[number]

/** Why the course list is not shown. `reason` is School's own, when it gave one. */
export class CoursesUnavailable extends Error {
  readonly reason: string | null
  constructor(reason: string | null) {
    super(reason ?? "School's course list could not be loaded.")
    this.reason = reason
  }
}

/** Every course. Rejects with CoursesUnavailable when School is unreachable, fails, or answers in another shape. */
export async function listCourses(): Promise<CourseSummary[]> {
  let res: Response
  try {
    res = await fetch("/api/courses", {
      headers: { accept: "application/json" },
    })
  } catch {
    throw new CoursesUnavailable(null)
  }
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const said = z.object({ error: z.string() }).safeParse(body)
    throw new CoursesUnavailable(said.success ? said.data.error : null)
  }
  const parsed = CoursesReply.safeParse(body)
  if (!parsed.success) throw new CoursesUnavailable(null)
  return parsed.data
}

// GET /api/courses/:course (server/server.ts, courseJson): its lessons with their progress, and
// the file names of its reference documents, which School serves at /courses/:course/reference/<file>
// only while they stay inside the course.
const CourseLessons = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    subtitle: z.string().nullish(),
    quizzes: z.number().int().nonnegative(),
    answeredCorrectly: z.number().int().nonnegative(),
  })
)
// Lessons that cannot be read are null, with the server's reason beside them; the reference
// documents are listed either way (flyingrobots/school#115).
export const CourseReply = z.union([
  z.object({
    name: z.string(),
    title: z.string(),
    trusted: z.boolean(),
    ...Manifest,
    reference: z.array(z.string()),
    lessons: CourseLessons,
  }),
  z.object({
    name: z.string(),
    title: z.string(),
    trusted: z.boolean(),
    ...Manifest,
    reference: z.array(z.string()),
    lessons: z.null(),
    lessonsError: z.string(),
  }),
])
/** A course whose lessons were read. */
export type Course = {
  name: string
  title: string
  /** False for a course School serves sandboxed: its pages can't run scripts (flyingrobots/school#210). */
  trusted: boolean
  declaration: Declaration
  reference: string[]
  lessons: z.infer<typeof CourseLessons>
}

export type CourseLoad =
  | { kind: "loading" }
  | { kind: "ready"; course: Course }
  | { kind: "missing" }
  // The course's lessons cannot be read, with the server's reason; its reference documents can be.
  | {
      kind: "unreadable"
      title: string
      trusted: boolean
      declaration: Declaration
      reason: string
      reference: string[]
    }
  // No usable answer at all: the server is unreachable or answered something else.
  | { kind: "unloaded" }

/** One course. Never rejects: an unreachable server or a reply of the wrong shape is "unloaded". */
export async function loadCourse(
  name: string,
  signal?: AbortSignal
): Promise<Exclude<CourseLoad, { kind: "loading" }>> {
  try {
    const res = await fetch(`/api/courses/${encodeURIComponent(name)}`, {
      signal,
    })
    if (res.status === 404) return { kind: "missing" }
    if (!res.ok) return { kind: "unloaded" }
    const course = CourseReply.safeParse(await res.json())
    if (!course.success) return { kind: "unloaded" }
    const c = course.data
    const declaration = {
      summary: c.summary,
      author: c.author,
      license: c.license,
    }
    if (c.lessons === null)
      return {
        kind: "unreadable",
        title: c.title,
        trusted: c.trusted,
        declaration,
        reason: c.lessonsError,
        reference: c.reference,
      }
    return {
      kind: "ready",
      course: {
        name: c.name,
        title: c.title,
        trusted: c.trusted,
        declaration,
        reference: c.reference,
        lessons: c.lessons,
      },
    }
  } catch {
    return { kind: "unloaded" }
  }
}

/** Where School serves one of a course's reference documents. */
export const referenceHref = (course: string, file: string) =>
  `/courses/${encodeURIComponent(course)}/reference/${encodeURIComponent(file)}`
