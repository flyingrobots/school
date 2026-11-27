// How quizzes are holding, in the words of RFC 5 Table 4.7: the one wording the course page's
// lesson cards (flyingrobots/school#221) and the home timeline's lanes (flyingrobots/school#222)
// share. Each phrase counts quizzes; none is a percentage, a score or a strength (RFC 5 §4.5).

/** The four counts of `school.mastery_rollup` for a group of quizzes; they sum to its quizzes. */
export type Mastery = {
  notStarted: number
  settling: number
  holding: number
  faded: number
}

/**
 * One phrase per state that has any quiz, in the order holding, settling, faded, not started:
 * "2 of 3 quizzes holding", "1 still settling", "1 ready for another look", "1 not started yet".
 */
export function masteryWords(quizzes: number, m: Mastery): string[] {
  const words: string[] = []
  if (m.holding > 0)
    words.push(
      `${m.holding} of ${quizzes} ${quizzes === 1 ? "quiz" : "quizzes"} holding`
    )
  if (m.settling > 0) words.push(`${m.settling} still settling`)
  if (m.faded > 0) words.push(`${m.faded} ready for another look`)
  if (m.notStarted > 0) words.push(`${m.notStarted} not started yet`)
  return words
}

/**
 * A lesson's words: nothing for a lesson with no quizzes, "Not started yet" alone when none of its
 * quizzes is answered, and otherwise its counts.
 */
export function lessonHoldingWords({
  quizzes,
  mastery,
}: {
  quizzes: number
  mastery: Mastery
}): string[] {
  if (quizzes === 0) return []
  if (mastery.notStarted === quizzes) return ["Not started yet"]
  return masteryWords(quizzes, mastery)
}
