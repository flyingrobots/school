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
  const path = pathTo(page, blockId);
  if (path === null) return null;
  const block = path.at(-1)!;
  // A section is about its own quizzes; any other block is about the nearest section holding it.
  const about = block.type === "quiz" || block.type === "section" ? block : path.findLast((b) => b.type === "section");
  const own = about === undefined ? [] : quizIdsIn(about);
  return own.length > 0 ? { quizzes: own, from: "block" } : { quizzes: quizIdsIn(page), from: "lesson" };
}

const childrenOf = (b: Block): Block[] => (b.type === "page" || b.type === "section" ? b.children : []);
/** The blocks from `root` down to the first block with id `id`, in document order; null when there is none. */
function pathTo(root: Block, id: string): Block[] | null {
  if (root.id === id) return [root];
  for (const c of childrenOf(root)) {
    const below = pathTo(c, id);
    if (below !== null) return [root, ...below];
  }
  return null;
}
/** Every distinct quiz id in a block and under it, in document order. */
export const quizIdsIn = (b: Block): string[] => [...new Set(b.type === "quiz" ? [b.id] : childrenOf(b).flatMap(quizIdsIn))];

/** The pitch a group's counts choose (RFC 8 Table 4.2): the weakest state present. A group with no quiz gets `first`. */
export function choosePitch(counts: Pick<MasteryRollup, "notStarted" | "settling" | "holding" | "faded">): Pitch {
  if (counts.settling > 0) return "deeper";
  if (counts.notStarted > 0) return "first";
  if (counts.faded > 0) return "refresh";
  return counts.holding > 0 ? "onward" : "first";
}
