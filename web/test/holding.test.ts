// The words for how quizzes are holding (src/lib/holding.ts; flyingrobots/school#221), which the
// course page's lesson cards and the home timeline's lanes share. Oracle: RFC 5 Table 4.7's four
// words, and School's voice (docs/topics/voice/README.md): no "wrong", "fail", "mistake",
// "incorrect", "forgot" or "attempt", and results in words, never a percentage, score or strength.
// Swept over every lesson of up to three quizzes, so no count can slip past a hand-written list.
import { expect, test } from "bun:test"

import { lessonHoldingWords, type Mastery } from "../src/lib/holding.ts"

const PHRASE =
  /^(?:[1-9]\d* of [1-9]\d* quiz(?:zes)? holding|[1-9]\d* still settling|[1-9]\d* ready for another look|[1-9]\d* not started yet|Not started yet)$/

/** Every split of up to three quizzes into the four states. */
const lessons: { quizzes: number; mastery: Mastery }[] = []
for (let notStarted = 0; notStarted <= 3; notStarted++)
  for (let settling = 0; notStarted + settling <= 3; settling++)
    for (let holding = 0; notStarted + settling + holding <= 3; holding++)
      for (let faded = 0; notStarted + settling + holding + faded <= 3; faded++)
        lessons.push({
          quizzes: notStarted + settling + holding + faded,
          mastery: { notStarted, settling, holding, faded },
        })

test("every phrase for every lesson of up to three quizzes is one of RFC 5's four words and passes the voice test", () => {
  const phrases = lessons.flatMap(lessonHoldingWords)
  // 35 lessons (1 + 4 + 10 + 20 splits of 0 to 3 quizzes); each with quizzes says something.
  expect(lessons.length).toBe(35)
  expect(
    lessons.filter((l) => lessonHoldingWords(l).length > 0 !== l.quizzes > 0)
  ).toEqual([])
  expect(phrases.filter((w) => !PHRASE.test(w))).toEqual([])
  expect(
    phrases.filter((w) =>
      /wrong|fail|mistake|incorrect|forgot|attempt|%|score|strength|\d\.\d/i.test(
        w
      )
    )
  ).toEqual([])
})
