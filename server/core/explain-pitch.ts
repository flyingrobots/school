// What an Explain more request is pitched to (RFC 8 §4.1, §4.2): which quizzes a block is about, and
// the pitch the rollup's counts for them choose. Pure: the counts are read by the use case.
import type { Block, MasteryRollup, Pitch } from "./model.ts";

/**
 * The quizzes a block is about, its scope (RFC 8 Table 4.1), as ids in document order. `from` is
 * `lesson` when the block had no quiz of its own to go by and the lesson's quizzes stand in.
 */
export type ExplainScope = { quizzes: string[]; from: "block" | "lesson" };

/** The scope of the block `blockId` in `page`, the lesson as served; null when the page has no such block. */
export function explainScope(page: Block, blockId: string): ExplainScope | null {
  void page; void blockId;
  throw new Error("not implemented");
}

/** The pitch a group's counts choose (RFC 8 Table 4.2): the weakest state present. A group with no quiz gets `first`. */
export function choosePitch(counts: Pick<MasteryRollup, "notStarted" | "settling" | "holding" | "faded">): Pitch {
  void counts;
  throw new Error("not implemented");
}
