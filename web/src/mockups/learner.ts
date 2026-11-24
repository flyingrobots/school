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

export const REVIEWS = [
  {
    course: "AIΩN Foundations",
    question: "What does AIΩN keep, and what does it compute from it?",
    reason:
      "Returning because your first answer on 24 November was wrong, and you got it right only after reading the reference.",
    from: "The Inversion",
  },
  {
    course: "The Mathematics of Bells",
    question: "Why can't a ringer play a tune on a heavy bell?",
    reason:
      "Returning because you answered it correctly four days ago without help, and it's time to check it stuck.",
    from: "Bells that can't hurry",
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
