// What the home page reads (flyingrobots/school#166), checked with Zod before anything is shown.
// The server side is server/server.ts: showcaseJson (#164), and feedbackJson, reviewJson and
// activityJson (#165); resume is GET /api/resume (#39).
import { z } from "zod"

const LessonRef = z.object({ id: z.string(), title: z.string() })

export const Ahead = z.object({
  course: z.string(),
  courseTitle: z.string(),
  started: z.boolean(),
  lesson: LessonRef.extend({
    subtitle: z.string(),
    position: z.number().int().positive(),
    of: z.number().int().positive(),
  }),
  question: z.string(),
  teaser: z.string(),
  figure: z.string().nullable(),
})
export type Ahead = z.infer<typeof Ahead>
export const ShowcaseJson = z.array(Ahead)

const Verdict = z.enum(["meets", "partly", "misses"])
export type Verdict = z.infer<typeof Verdict>
const Criterion = z.object({ verdict: Verdict, note: z.string() })

export const FeedbackJson = z
  .object({
    course: z.string(),
    courseTitle: z.string(),
    lesson: LessonRef,
    blockId: z.string(),
    prompt: z.string().nullable(),
    model: z.string().nullable(),
    at: z.string(),
    findings: z.object({
      summary: z.string(),
      insufficient_evidence: z.boolean(),
      fidelity: Criterion,
      completeness: Criterion,
      accessibility: Criterion,
    }),
  })
  .nullable()
export type Feedback = NonNullable<z.infer<typeof FeedbackJson>>

export const ReviewItem = z.object({
  course: z.string(),
  courseTitle: z.string(),
  lesson: LessonRef.nullable(),
  blockId: z.string(),
  question: z.string().nullable(),
  answeredAt: z.string(),
  rule: z.string(),
  reason: z.string(),
})
export type ReviewItem = z.infer<typeof ReviewItem>
export const ReviewJson = z.array(ReviewItem)

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const ActivityJson = z.object({
  today: Day,
  tz: z.string(),
  days: z.number().int().positive(),
  courses: z.array(
    z.object({
      course: z.string(),
      courseTitle: z.string(),
      studied: z.array(Day),
      due: z.array(z.object({ day: Day, items: z.number().int().positive() })),
    })
  ),
})
export type Activity = z.infer<typeof ActivityJson>

const ResumeLesson = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  position: z.number().int().positive(),
  of: z.number().int().positive(),
  quizzes: z.number().int().nonnegative(),
  answeredCorrectly: z.number().int().nonnegative(),
})
export const ResumeJson = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["continue", "next", "start"]),
    course: z.string(),
    lesson: ResumeLesson,
    question: z.string().nullable(),
    lastStudied: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("finished"),
    course: z.string(),
    lastStudied: z.string(),
  }),
  z.object({ kind: z.literal("nothing") }),
])
export type Resume = z.infer<typeof ResumeJson>

export const lessonHref = (course: string, lesson: string) =>
  `/courses/${course}/lessons/${lesson}`

/** Whole days from `from` to `to`, both YYYY-MM-DD. */
export function daysBetween(from: string, to: string): number {
  const utc = (d: string) => {
    const [y, m, day] = d.split("-").map(Number)
    return Date.UTC(y!, m! - 1, day!)
  }
  return Math.round((utc(to) - utc(from)) / 86_400_000)
}
