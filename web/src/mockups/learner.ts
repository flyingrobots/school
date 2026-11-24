// What the learner's record could say on a typical evening, for mockups D, E and F. The lesson
// titles, questions, prompts and the grading's notes are from the real courses and the real record;
// the dates and the review schedule are illustrative.

export type Verdict = "meets" | "partly" | "misses"

export const COURSES = [
  {
    slug: "course",
    title: "AIΩN Foundations",
    lessons: 2,
    finished: 1,
    quizzes: 8,
    answeredCorrectly: 8,
  },
  {
    slug: "bells",
    title: "The Mathematics of Bells",
    lessons: 7,
    finished: 2,
    quizzes: 28,
    answeredCorrectly: 9,
  },
] as const

export const CONTINUE = {
  course: "The Mathematics of Bells",
  lesson: "The plain hunt",
  subtitle:
    "Repeat two changes and every bell starts weaving. It's the simplest method, and it returns to rounds by itself.",
  position: 3,
  of: 7,
  question:
    "In the plain hunt on four bells, which places does the treble ring in, in order?",
  minutes: 12,
}

export type Review = {
  course: string
  lesson: string
  question: string
  answered: string
  reason: string
}

// Only questions the learner has answered can come back (due_review reads answers), so every item
// names a course and lesson they have opened. The reasons use School's real wording.
export const RULES =
  "School brings back a question you've answered before when your first answer was wrong, or right only after help was shown. It waits at least a day, so the answer has to come from memory."

export const REVIEWS: Review[] = [
  {
    course: "AIΩN Foundations",
    lesson: "The Inversion",
    question:
      "A balance of 70 and the list +100, −50, +20. Which one can be rebuilt from the other?",
    answered: "24 November",
    reason:
      "Your first answer on 24 November was wrong, and the right one came after the explanation was shown.",
  },
  {
    course: "AIΩN Foundations",
    lesson: "Graphs of Graphs",
    question: "What is the smallest possible WARP?",
    answered: "24 November",
    reason:
      "On 24 November you answered it right only after a reference was shown.",
  },
]

export const GRADED = {
  course: "AIΩN Foundations",
  lesson: "The Inversion",
  prompt:
    "Explain the inversion to an imaginary engineer in under 30 seconds. Use one example that isn't the bank account.",
  gradedBy: "Claude",
  summary:
    "Good start: you grabbed the core idea of keeping history and found your own example. Next, add the one-way point: from the list of changes you can always get the value back, but from the value alone you can never get the changes back.",
  criteria: [
    {
      name: "Fidelity",
      verdict: "partly" as Verdict,
      note: "Keeping history is the core idea, but the system keeps the transformations, each change and its cause, not a history of values.",
    },
    {
      name: "Completeness",
      verdict: "misses" as Verdict,
      note: "Two connections are missing: 'now' is a replay of the list, and the history can't be rebuilt from the current value.",
    },
    {
      name: "Accessibility",
      verdict: "meets" as Verdict,
      note: "Plain words and your own example. An engineer would follow it.",
    },
  ],
}

export const WAITING = {
  course: "The Mathematics of Bells",
  lesson: "Bells that can't hurry",
  prompt:
    "Explain to a friend who has never heard change ringing why church bells in England play patterns instead of tunes.",
}

// Illustrative study days (offset from today, negative is past) per course, and when review
// items come back (positive offsets).
export const RHYTHM = {
  today: new Date(2026, 10, 24),
  lanes: [
    {
      title: "AIΩN Foundations",
      studied: [-13, -12, -9, -6, -5, -1, 0],
      returns: [
        { day: 2, items: 1 },
        { day: 6, items: 2 },
      ],
    },
    {
      title: "The Mathematics of Bells",
      studied: [-4, -3, 0],
      returns: [
        { day: 1, items: 1 },
        { day: 4, items: 3 },
        { day: 11, items: 2 },
      ],
    },
  ],
}

export const verdictWord: Record<Verdict, string> = {
  meets: "Meets",
  partly: "Partly",
  misses: "Not yet",
}

// Mockup H: what each mark on the timeline opens. Illustrative.
export const STUDY_DAYS: Record<string, string[]> = {
  "AIΩN Foundations": [
    "Read The Inversion and answered its 4 questions, 3 right on the first try.",
    "Opened the reference 'Why replay, not state' for 6 minutes.",
  ],
  "The Mathematics of Bells": [
    "Read Writing changes down and answered its 4 questions, all right on the first try.",
    "Wrote an explanation of why bells play patterns, not tunes.",
  ],
}

export const COMING_BACK: Record<string, Review[]> = {
  "AIΩN Foundations": [
    {
      course: "AIΩN Foundations",
      lesson: "The Inversion",
      question:
        "Which two properties of transformations make replay trustworthy?",
      answered: "21 November",
      reason:
        "Your first answer on 21 November was wrong; you put it right on a later try.",
    },
    {
      course: "AIΩN Foundations",
      lesson: "Graphs of Graphs",
      question: "Why does the paper insist nesting is well-founded?",
      answered: "23 November",
      reason:
        "On 23 November you answered it right only after the model answer was shown.",
    },
  ],
  "The Mathematics of Bells": [
    {
      course: "The Mathematics of Bells",
      lesson: "The plain hunt",
      question:
        "How many changes does the plain hunt on four bells take to come back to rounds?",
      answered: "24 November",
      reason:
        "On 24 November you answered it right only after the explanation was shown.",
    },
    {
      course: "The Mathematics of Bells",
      lesson: "Writing changes down",
      question: "Apply x to 1324.",
      answered: "20 November",
      reason:
        "Your first answer on 20 November was wrong, and it was not put right then.",
    },
    {
      course: "The Mathematics of Bells",
      lesson: "Bells that can't hurry",
      question:
        "On four bells, which of these can follow 1234 as the next row?",
      answered: "20 November",
      reason:
        "Your first answer on 20 November was wrong; you put it right on a later try.",
    },
  ],
}

// Mockup I: every explanation written, each attempt with its three judgments. Illustrative
// except today's attempt at the inversion, which is the real grading.
export type Attempt = { day: number; verdicts: [Verdict, Verdict, Verdict] }
export const CRITERIA = ["Fidelity", "Completeness", "Accessibility"] as const
export const EXPLANATIONS: {
  course: string
  lesson: string
  prompt: string
  attempts: Attempt[]
}[] = [
  {
    course: "AIΩN Foundations",
    lesson: "Graphs of Graphs",
    prompt:
      "Explain a WARP to an imaginary engineer in under 45 seconds, without the words “category”, “algebra” or “recursive”.",
    attempts: [
      { day: -12, verdicts: ["partly", "misses", "misses"] },
      { day: -9, verdicts: ["meets", "partly", "meets"] },
      { day: -5, verdicts: ["meets", "meets", "meets"] },
    ],
  },
  {
    course: "AIΩN Foundations",
    lesson: "The Inversion",
    prompt:
      "Explain the inversion to an imaginary engineer in under 30 seconds. Use one example that isn't the bank account.",
    attempts: [
      { day: -8, verdicts: ["misses", "misses", "partly"] },
      // The real grading in the record.
      { day: 0, verdicts: ["partly", "misses", "meets"] },
    ],
  },
  {
    course: "The Mathematics of Bells",
    lesson: "Bells that can't hurry",
    prompt:
      "Explain to a friend who has never heard change ringing why church bells in England play patterns instead of tunes.",
    attempts: [{ day: -3, verdicts: ["meets", "partly", "meets"] }],
  },
  {
    course: "The Mathematics of Bells",
    lesson: "The plain hunt",
    prompt:
      "Describe the plain hunt so someone could ring it with you: the two changes, the path one bell follows, and when it ends.",
    attempts: [],
  },
]
