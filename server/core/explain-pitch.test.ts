// Explain more's scope and pitch (RFC 8 §4.1, §4.2; flyingrobots/school#249), at fixed clocks,
// against an in-memory record that counts each group from a fixed state per quiz.
import { describe, expect, test } from "bun:test";
import type { Block, MasteryRollup, MasteryRollupQuery } from "./model.ts";
import type { LearningRecord } from "./ports.ts";
import { choosePitch, explainScope } from "./explain-pitch.ts";
import { REVIEW_DELAY_MS, createSchool } from "./school.ts";

type State = "notStarted" | "settling" | "holding" | "faded";

const quiz = (id: string): Block => ({ type: "quiz", id, q: `${id}?`, why: ".", choices: [{ id: "a", text: "A", correct: true }] });
const prose = (id: string): Block => ({ type: "prose", id, html: "<p>Text.</p>" });
const explainBlock = (id: string): Block => ({ type: "explain", id, prompt: "Say why.", model: "Because.", sources: [] });
const section = (id: string, children: Block[]): Block => ({ type: "section", id, title: id, children });
const page = (children: Block[]): Block => ({ type: "page", id: "l1", title: "Lesson", subtitle: "", children });

// One lesson with every shape Table 4.1 names: a section with quizzes (one nested deeper), a section
// with none, and a block outside any section.
const lesson = page([
  prose("intro"),
  section("s1", [prose("p1"), quiz("q1"), explainBlock("e1"), section("s1a", [quiz("q2")])]),
  section("s2", [prose("p2"), explainBlock("e2")]),
  section("s3", [quiz("q3")]),
]);
const LESSON_QUIZZES = ["q1", "q2", "q3"];
const COURSE_QUIZZES = [...LESSON_QUIZZES, "q9"];

const DAY1 = "2026-11-21T10:00:00.000Z";
const DAY30 = "2026-12-20T10:00:00.000Z";

/**
 * The record, in memory: each quiz's state at a time, from `states`; a quiz it does not name was
 * never answered. It answers the rollup and nothing else, so any write would throw.
 */
function inMemoryRecord(states: (now: string) => Record<string, State>) {
  const asked: MasteryRollupQuery[] = [];
  const masteryRollup = async (q: MasteryRollupQuery): Promise<MasteryRollup[]> => {
    asked.push(q);
    const at = states(q.now);
    return Object.entries(q.groups).map(([key, blocks]) => {
      const ids = [...new Set(blocks)];
      const count = (s: State) => ids.filter((id) => (at[id] ?? "notStarted") === s).length;
      return { key, quizzes: ids.length, notStarted: count("notStarted"), settling: count("settling"), holding: count("holding"), faded: count("faded"), strength: ids.length === 0 ? null : 0 };
    });
  };
  return { record: { masteryRollup } as unknown as LearningRecord, asked };
}
const grader = { adapter: "fake", model: "", rubricVersion: "r", promptVersion: "p", grade: async () => ({ status: "failed" as const, error: "x" }) };
const schoolAt = (now: string, states: (now: string) => Record<string, State>) => {
  const { record, asked } = inMemoryRecord(states);
  return { school: createSchool({ record, grader, clock: { now: () => now } }), asked };
};
const pitchOf = async (blockId: string, states: Record<string, State>) =>
  (await schoolAt(DAY1, () => states).school.explainPitch("c", lesson, COURSE_QUIZZES, blockId))?.pitch;

describe("the pitch a section gets from its quizzes (RFC 8 Table 4.2)", () => {
  test("a section with one Still settling quiz gets deeper", async () => {
    expect(await pitchOf("s1", { q1: "settling", q2: "holding" })).toBe("deeper");
  });

  test("a section with only Not started yet gets first", async () => {
    expect(await pitchOf("s1", {})).toBe("first");
  });

  test("a section with one Ready for another look and the rest Holding gets refresh", async () => {
    expect(await pitchOf("s1", { q1: "faded", q2: "holding" })).toBe("refresh");
  });

  test("a section whose quizzes are all Holding gets onward", async () => {
    expect(await pitchOf("s1", { q1: "holding", q2: "holding" })).toBe("onward");
  });

  test("only the scope's quizzes choose the pitch, not the lesson's or the course's", async () => {
    expect(await pitchOf("s1", { q1: "holding", q2: "holding", q3: "settling", q9: "settling" })).toBe("onward");
  });
});

describe("choosePitch: the weakest state present wins, in Table 4.2's order", () => {
  const counts = (o: Partial<Record<State, number>>) => ({ notStarted: 0, settling: 0, holding: 0, faded: 0, ...o });
  // Oracle: RFC 8 Table 4.2, row by row, with a stronger state always present beside the weaker.
  test.each([
    [counts({ settling: 1, notStarted: 1, faded: 1, holding: 1 }), "deeper"],
    [counts({ notStarted: 1, faded: 1, holding: 1 }), "first"],
    [counts({ faded: 1, holding: 1 }), "refresh"],
    [counts({ holding: 3 }), "onward"],
  ] as const)("%o gets %s", (c, pitch) => {
    expect(choosePitch(c)).toBe(pitch);
  });

  test("a group with no quiz gets first (RFC 8 §4.2)", () => {
    expect(choosePitch(counts({}))).toBe("first");
  });
});

describe("the scope of each kind of block (RFC 8 Table 4.1)", () => {
  test("a section's scope is the quizzes among its descendants, nested sections included", () => {
    expect(explainScope(lesson, "s1")).toEqual({ quizzes: ["q1", "q2"], from: "block" });
  });

  test("a quiz block's scope is itself", () => {
    expect(explainScope(lesson, "q2")).toEqual({ quizzes: ["q2"], from: "block" });
  });

  test("an explain block's scope is the quizzes of the section that holds it", () => {
    expect(explainScope(lesson, "e1")).toEqual({ quizzes: ["q1", "q2"], from: "block" });
  });

  test("a section with no quiz uses the lesson's quizzes", () => {
    expect(explainScope(lesson, "s2")).toEqual({ quizzes: LESSON_QUIZZES, from: "lesson" });
  });

  test("an explain block in a section with no quiz uses the lesson's quizzes", () => {
    expect(explainScope(lesson, "e2")).toEqual({ quizzes: LESSON_QUIZZES, from: "lesson" });
  });

  test("a block outside any section uses the lesson's quizzes", () => {
    expect(explainScope(lesson, "intro")).toEqual({ quizzes: LESSON_QUIZZES, from: "lesson" });
  });

  test("a block the lesson as served does not hold has no scope", () => {
    expect(explainScope(lesson, "q9")).toBeNull();
  });
});

describe("reading mastery for a pitch", () => {
  test("one rollup at the clock's now, with due review's delay, for scope, lesson and course", async () => {
    const { school, asked } = schoolAt(DAY1, () => ({}));
    await school.explainPitch("c", lesson, COURSE_QUIZZES, "e1");
    expect(asked).toEqual([{ course: "c", groups: { scope: ["q1", "q2"], lesson: LESSON_QUIZZES, course: COURSE_QUIZZES }, now: DAY1, delayMs: REVIEW_DELAY_MS }]);
  });

  test("the answer carries the pitch, the time, the scope and the three groups' counts", async () => {
    const { school } = schoolAt(DAY1, () => ({ q1: "settling", q3: "holding" }));
    const r = await school.explainPitch("c", lesson, COURSE_QUIZZES, "q1");
    expect(r).toEqual({
      pitch: "deeper", at: DAY1, scope: { quizzes: ["q1"], from: "block" },
      mastery: {
        scope: { key: "scope", quizzes: 1, notStarted: 0, settling: 1, holding: 0, faded: 0, strength: 0 },
        lesson: { key: "lesson", quizzes: 3, notStarted: 1, settling: 1, holding: 1, faded: 0, strength: 0 },
        course: { key: "course", quizzes: 4, notStarted: 2, settling: 1, holding: 1, faded: 0, strength: 0 },
      },
    });
  });

  test("a section with no quiz is pitched from the lesson's quizzes", async () => {
    expect(await pitchOf("s2", { q1: "holding", q2: "holding", q3: "faded" })).toBe("refresh");
  });

  test("the same block is pitched by the record at each clock: holding on day 1, ready for another look on day 30", async () => {
    const states = (now: string): Record<string, State> => ({ q3: now < DAY30 ? "holding" : "faded" });
    expect((await schoolAt(DAY1, states).school.explainPitch("c", lesson, COURSE_QUIZZES, "s3"))?.pitch).toBe("onward");
    expect((await schoolAt(DAY30, states).school.explainPitch("c", lesson, COURSE_QUIZZES, "s3"))?.pitch).toBe("refresh");
  });

  test("nothing is kept between requests: a change in the record changes the next pitch", async () => {
    let states: Record<string, State> = { q3: "settling" };
    const { school } = schoolAt(DAY1, () => states);
    expect((await school.explainPitch("c", lesson, COURSE_QUIZZES, "s3"))?.pitch).toBe("deeper");
    states = { q3: "holding" };
    expect((await school.explainPitch("c", lesson, COURSE_QUIZZES, "s3"))?.pitch).toBe("onward");
  });

  test("a block the lesson does not hold is refused as null, and the record is not asked", async () => {
    const { school, asked } = schoolAt(DAY1, () => ({}));
    expect(await school.explainPitch("c", lesson, COURSE_QUIZZES, "nowhere")).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a lesson with no quiz gets first (RFC 8 §4.2)", async () => {
    const reading = page([section("s1", [prose("p1")])]);
    const r = await schoolAt(DAY1, () => ({})).school.explainPitch("c", reading, [], "s1");
    expect(r?.pitch).toBe("first");
    expect(r?.scope).toEqual({ quizzes: [], from: "lesson" });
  });
});
