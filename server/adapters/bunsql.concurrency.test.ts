// The record's concurrency cases on a real Postgres (RFC 3 §3.2; flyingrobots/school#50), through
// the Bun.SQL driver and the Postgres adapter, as the server calls them.
//
// Each race is held at a gate inside the database, not in JavaScript. A controller connection
// takes `LOCK TABLE ... IN ACCESS EXCLUSIVE MODE` on the table the function reaches first, then the
// callers start, each on its own pooled connection, in one tick. Every caller blocks inside its
// function call, mid-transaction. The gate opens (the controller commits) only once another
// connection sees, in pg_stat_activity, every caller's backend waiting on a lock in that call:
// that is the proof the calls overlapped, and it is asserted on every repetition. After the gate
// opens they run the function's body at the same moment. Nothing waits on a timer.
//
// Each case repeats REPS times on one database, with fresh ids each time. Like the rest of the
// Bun.SQL tests it needs SCHOOL_TEST_POSTGRES_URL and skips without it; CI provides one, and its
// gate (server/testing/postgres-gate.ts) fails the build if any test here skipped or failed.
import { describe, expect, test } from "bun:test";
import type { Block, CourseInstall, SubmitResult } from "../core/model.ts";
import type { LearningRecord } from "../core/ports.ts";
import { scratchPostgres, TEST_POSTGRES_URL as URL_ } from "../testing/postgres.ts";
import { APP } from "./database.ts";
import { bunSql } from "./bunsql.ts";
import { postgresRecord } from "./postgres.ts";
import type { Sql } from "./sql.ts";

const REPS = 50;
const SLOW = 180_000;
/** How long the gate waits for every caller to arrive before it fails the test. A bound, not a sleep. */
const ARRIVAL = 15_000;

const { fresh, track } = scratchPostgres();

const page: Block = { type: "page", id: "l", title: "l", subtitle: "", children: [
  { type: "quiz", id: "q1", q: "Which?", why: "Because.", choices: [
    { id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true },
  ] },
  { type: "explain", id: "e1", prompt: "Say why.", model: "Because.", sources: [] },
] };
const NOW = "2026-11-22T10:00:00.000Z";
const uuid = () => crypto.randomUUID();

type Pool = InstanceType<typeof Bun.SQL>;

/** Every statement in a REPEATABLE READ transaction, as school_app: what a caller that is not the adapter might do. */
const repeatableRead = (pool: Pool): Sql => ({
  query: async <T>(text: string, params: readonly unknown[]) =>
    pool.begin("isolation level repeatable read", async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${APP}`);
      return [...await tx.unsafe(text, [...params])] as T[];
    }),
});

type Setup = {
  /** Superuser, for the gate, the observer and reading the tables back. */
  admin: Pool;
  /** The callers' pool: one connection per concurrent caller, so each call is on a backend of its own. */
  pool: Pool;
  record: LearningRecord;
};

async function setup(callers: number): Promise<Setup> {
  const { url } = await fresh();
  const admin = track(new Bun.SQL(url));
  const pool = track(new Bun.SQL({ url, max: callers }));
  return { admin, pool, record: postgresRecord(bunSql(pool, APP)) };
}

/**
 * Start every call in `calls` at once behind a lock on `table`, and open the gate only when each
 * one's backend is waiting on a lock inside `school.<fn>`. Returns how each call settled and the
 * backends seen waiting together, one per call.
 */
async function race<T>(s: Setup, table: string, fn: string, calls: (() => Promise<T>)[]) {
  const ctl = await s.admin.reserve();
  let waiting: number[] = [];
  let settled: Promise<PromiseSettledResult<T>[]>;
  try {
    await ctl.unsafe("BEGIN");
    await ctl.unsafe(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    const started = calls.map((c) => c());
    let early: PromiseSettledResult<T> | undefined;
    for (const p of started) p.then((value) => { early ??= { status: "fulfilled", value }; }, (reason) => { early ??= { status: "rejected", reason }; });
    settled = Promise.allSettled(started);
    const deadline = Date.now() + ARRIVAL;
    for (;;) {
      // Outside any transaction, so each read of pg_stat_activity is current.
      const rows = await s.admin.unsafe(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [`%school.${fn}(%`]);
      waiting = rows.map((r: { pid: number }) => r.pid);
      if (waiting.length >= calls.length) break;
      // No call can finish while the gate is shut; one that did failed before reaching it.
      if (early !== undefined) throw new Error(`a call settled before the gate opened: ${JSON.stringify(early, Object.getOwnPropertyNames(early))}`);
      if (Date.now() > deadline) throw new Error(`only ${waiting.length} of ${calls.length} calls reached the gate`);
    }
  } finally {
    await ctl.unsafe("COMMIT").catch(() => {});
    ctl.release();
  }
  return { results: await settled, waiting: new Set(waiting) };
}

const values = <T>(results: PromiseSettledResult<T>[]): T[] => results.map((r) => {
  if (r.status === "rejected") throw r.reason;
  return r.value;
});

async function answers(admin: Pool, encounterId: string) {
  return [...await admin.unsafe(
    "SELECT submission_id, choice_id, correct, first_try FROM school.answers WHERE encounter_id = $1 ORDER BY seq", [encounterId])] as
    { submission_id: string; choice_id: string; correct: boolean; first_try: boolean }[];
}

const open = (r: LearningRecord, lesson: string) => r.openEncounter({ course: "c", lesson, page, now: NOW, aidTracking: 1 });
const submit = (r: LearningRecord, submissionId: string, encounterId: string, choiceId: string) =>
  () => r.submit({ submissionId, encounterId, blockId: "q1", choiceId, ms: 1 }, NOW);

// Installs (RFC 7 §7, flyingrobots/school#232): install_course and remove_installed_course serialise
// on an advisory lock per course name, then read what the lock holder committed. The status each
// caller is told must be the one its place in `seq` order calls for.
const hex = (n: number, c: string) => c.repeat(n);
const install = (course: string, o: Partial<Extract<CourseInstall, { source: "git" }>> = {}): CourseInstall => ({
  id: uuid(), course, source: "git", url: "https://github.com/flyingrobots/school-bells.git", bundleSha256: null,
  commit: hex(40, "a"), contentSha256: hex(64, "c"), title: "Bells", format: 1, ...o,
});
type Told = { status: string };
const doInstall = (r: LearningRecord, i: CourseInstall) => (): Promise<Told> => r.installCourse(i, NOW);
const doRemove = (r: LearningRecord, course: string) => (): Promise<Told> => r.removeInstalledCourse(course, NOW);

/** One name's installs and removals in `seq` order: what the lock holder wrote first comes first. */
async function history(admin: Pool, course: string) {
  return [...await admin.unsafe(
    `SELECT seq, 'install' AS kind, id::text AS id FROM school.course_installs WHERE course = $1
     UNION ALL SELECT seq, 'removal', id::text FROM school.course_removals WHERE course = $1
     ORDER BY seq`, [course])] as { seq: string | bigint; kind: "install" | "removal"; id: string }[];
}

// Authoring (RFC 9 §5.5, flyingrobots/school#258): request_authoring, decide_draft and an authored
// install_course serialise on the same advisory lock per course name, so a draft is decided once.
/** `course` installed, a request on it, and a ready draft of that request. Returns the draft's id. */
async function readyDraft(r: LearningRecord, course: string): Promise<string> {
  const base = install(course);
  await r.installCourse(base, NOW);
  const requestId = uuid();
  expect(await r.requestAuthoring({ id: requestId, course, baseInstallId: base.id, text: "Add a lesson.", skillSha256: hex(64, "5"), schoolVersion: "0.1.0" },
    NOW)).toEqual({ status: "stored" });
  const draftId = uuid();
  expect(await r.recordDraft({ id: draftId, requestId, round: 1, status: "ready", agent: "claude", commit: hex(40, "7"), contentSha256: hex(64, "8"),
    checkMessage: null, inputTokens: 1, outputTokens: 1 }, NOW)).toEqual({ status: "stored" });
  return draftId;
}
const doDiscard = (r: LearningRecord, draftId: string) => (): Promise<Told> =>
  r.decideDraft({ id: uuid(), draftId, decision: "discarded", installId: null, patch: null }, NOW);

describe.skipIf(URL_ === undefined)("Bun.SQL concurrency on a real Postgres (SCHOOL_TEST_POSTGRES_URL)", () => {
  test(`two first answers to one block at once: exactly one is first try, the other stored as not first (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const e = await open(s.record, `l${i}`);
      const [w, r] = [uuid(), uuid()];
      const { results, waiting } = await race(s, "school.answers", "submit", [submit(s.record, w, e.id, "wrong"), submit(s.record, r, e.id, "right")]);
      expect(waiting.size).toBe(2);
      const [wrong, right] = values(results);
      expect([wrong!.status, right!.status]).toEqual(["stored", "stored"]);
      // Correctness is the snapshot's whichever wins; first try goes to exactly one.
      expect([wrong, right].map((x) => x!.status === "stored" && x!.correct)).toEqual([false, true]);
      expect([wrong, right].map((x) => x!.status === "stored" && x!.firstTry).sort()).toEqual([false, true]);
      const rows = await answers(s.admin, e.id);
      expect(rows).toHaveLength(2);
      expect(rows.filter((x) => x.first_try)).toHaveLength(1);
      // What each caller was told is what was stored.
      for (const [id, got] of [[w, wrong], [r, right]] as const) {
        expect(rows.find((x) => x.submission_id === id)!.first_try).toBe(got!.status === "stored" && got!.firstTry);
      }
    }
  }, SLOW);

  test(`20 answers to one block at once: one first try among 20 rows (${REPS} times)`, async () => {
    const s = await setup(20);
    for (let i = 0; i < REPS; i++) {
      const e = await open(s.record, `l${i}`);
      const ids = Array.from({ length: 20 }, uuid);
      const { results, waiting } = await race(s, "school.answers", "submit",
        ids.map((id, k) => submit(s.record, id, e.id, k % 2 === 0 ? "right" : "wrong")));
      expect(waiting.size).toBe(20);
      const got = values(results);
      expect(got.every((x) => x.status === "stored")).toBe(true);
      expect(got.filter((x) => x.status === "stored" && x.firstTry)).toHaveLength(1);
      const rows = await answers(s.admin, e.id);
      expect(rows).toHaveLength(20);
      expect(rows.filter((x) => x.first_try)).toHaveLength(1);
      expect(rows.every((x) => x.correct === (x.choice_id === "right"))).toBe(true);
    }
  }, SLOW);

  test(`the same submission twice at once: one row, and both callers get the same result (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const e = await open(s.record, `l${i}`);
      const id = uuid();
      const { results, waiting } = await race(s, "school.answers", "submit", [submit(s.record, id, e.id, "right"), submit(s.record, id, e.id, "right")]);
      expect(waiting.size).toBe(2);
      const got = values(results);
      expect(got.map((x) => x.status).sort()).toEqual(["duplicate", "stored"]);
      const result = (x: SubmitResult) => x.status === "stored" || x.status === "duplicate" ? { correct: x.correct, firstTry: x.firstTry } : x;
      expect(result(got[0]!)).toEqual({ correct: true, firstTry: true });
      expect(result(got[1]!)).toEqual(result(got[0]!));
      expect(await answers(s.admin, e.id)).toEqual([{ submission_id: id, choice_id: "right", correct: true, first_try: true }]);
    }
  }, SLOW);

  test(`one submission id for two different answers at once: one is stored, the other is a conflict (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const e = await open(s.record, `l${i}`);
      const id = uuid();
      const { results, waiting } = await race(s, "school.answers", "submit", [submit(s.record, id, e.id, "wrong"), submit(s.record, id, e.id, "right")]);
      expect(waiting.size).toBe(2);
      const got = values(results);
      expect(got.map((x) => x.status).sort()).toEqual(["conflict", "stored"]);
      const winner = got[0]!.status === "stored" ? "wrong" : "right";
      expect(await answers(s.admin, e.id)).toEqual([{ submission_id: id, choice_id: winner, correct: winner === "right", first_try: true }]);
    }
  }, SLOW);

  test(`two opens of one lesson and snapshot at once: one encounter, opened by one and resumed by the other (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      // The snapshots table is what open_encounter writes first, after its advisory lock.
      const { results, waiting } = await race(s, "school.snapshots", "open_encounter", [() => open(s.record, `l${i}`), () => open(s.record, `l${i}`)]);
      expect(waiting.size).toBe(2);
      const [a, b] = values(results);
      expect(a!.id).toBe(b!.id);
      expect([a!.resumed, b!.resumed].sort()).toEqual([false, true]);
      const n = await s.admin.unsafe("SELECT count(*)::int AS n FROM school.encounters WHERE course = 'c' AND lesson = $1", [`l${i}`]);
      expect(n[0].n).toBe(1);
    }
  }, SLOW);

  // Due review (flyingrobots/school#32): open_lesson_encounter takes the same kind of lock, keyed by the lesson as written.
  test(`two opens of one lesson with review at once: one encounter, one set of notes (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const src = await open(s.record, `src${i}`);
      await s.record.submit({ submissionId: uuid(), encounterId: src.id, blockId: "q1", choiceId: "wrong", ms: 1 }, NOW);
      const evidence = (await s.record.encounterEvidence(src.id)).filter((x) => x.kind === "answer").map((x) => x.seq);
      const written: Block = { type: "page", id: `l${i}`, title: "l", subtitle: "", children: [] };
      const shown: Block = { ...written, children: [{ type: "section", id: "school:review", title: "Review", children: [(page as { children: Block[] }).children[0]!] }] };
      const openReview = () => s.record.openLessonEncounter({
        course: "c", lesson: `l${i}`, lessonPage: written, page: shown, now: NOW, aidTracking: 1,
        notes: [{ blockId: "q1", rule: "due-review/wrong-first-try", reason: "Back.", evidence }],
      });
      // The snapshots table is what open_lesson_encounter writes first, after its advisory lock.
      const { results, waiting } = await race(s, "school.snapshots", "open_lesson_encounter", [openReview, openReview]);
      expect(waiting.size).toBe(2);
      const [a, b] = values(results);
      expect(a!.encounter.id).toBe(b!.encounter.id);
      expect([a!.encounter.resumed, b!.encounter.resumed].sort()).toEqual([false, true]);
      expect(a!.page).toEqual(b!.page);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.encounters WHERE lesson = $1", [`l${i}`]))[0].n).toBe(1);
      expect(await s.record.encounterDecisionNotes(a!.encounter.id)).toHaveLength(1);
    }
  }, SLOW);

  test(`two gradings of one explanation at once: one chain, the second superseding the first (${REPS} times)`, async () => {
    const s = await setup(2);
    const grading = (submissionId: string) => () => s.record.recordGrading({
      submissionId, status: "failed", findings: null, error: "x", rubricVersion: "r", promptVersion: "p",
      adapter: "test", model: null, sources: [], raw: null,
    }, NOW);
    for (let i = 0; i < REPS; i++) {
      const e = await open(s.record, `l${i}`);
      const id = uuid();
      expect(await s.record.saveExplanation({ submissionId: id, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, NOW)).toEqual({ status: "stored" });
      const { results, waiting } = await race(s, "school.gradings", "record_grading", [grading(id), grading(id)]);
      expect(waiting.size).toBe(2);
      const got = values(results).sort((x, y) => x.id - y.id);
      expect(got.map((g) => g.supersedes)).toEqual([null, got[0]!.id]);
    }
  }, SLOW);

  test(`two installs of one name at once: one is installed, the other updated, in seq order, and one is current (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const course = `bells-${i}`;
      // Alternate a name with no install and one that already has one.
      const before = i % 2 === 1;
      if (before) await s.record.installCourse(install(course), NOW);
      const [a, b] = [install(course, { commit: hex(40, "b") }), install(course, { commit: hex(40, "c") })];
      const { results, waiting } = await race(s, "school.course_installs", "install_course", [doInstall(s.record, a), doInstall(s.record, b)]);
      expect(waiting.size).toBe(2);
      const told = values(results);
      const status = new Map([[a.id, told[0]!.status], [b.id, told[1]!.status]]);
      const rows = (await history(s.admin, course)).filter((x) => x.id === a.id || x.id === b.id);
      expect(rows).toHaveLength(2);
      expect(rows.map((x) => status.get(x.id))).toEqual(before ? ["updated", "updated"] : ["installed", "updated"]);
      const listed = await s.record.installedCourses();
      expect(listed.filter((x) => x.course === course).map((x) => x.id)).toEqual([rows[1]!.id]);
    }
  }, SLOW);

  test(`20 installs of one name at once: one installed, 19 updated, one current (${REPS} times)`, async () => {
    const s = await setup(20);
    for (let i = 0; i < REPS; i++) {
      const course = `bells-${i}`;
      const all = Array.from({ length: 20 }, () => install(course));
      const { results, waiting } = await race(s, "school.course_installs", "install_course", all.map((x) => doInstall(s.record, x)));
      expect(waiting.size).toBe(20);
      const told = values(results);
      const status = new Map(all.map((x, k) => [x.id, told[k]!.status]));
      const rows = await history(s.admin, course);
      expect(rows).toHaveLength(20);
      expect(rows.map((x) => status.get(x.id))).toEqual(["installed", ...Array(19).fill("updated")]);
      expect((await s.record.installedCourses()).filter((x) => x.course === course).map((x) => x.id)).toEqual([rows[19]!.id]);
    }
  }, SLOW);

  test(`the same install twice at once: one row, one told installed and the other duplicate (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const course = `bells-${i}`;
      const one = install(course);
      const { results, waiting } = await race(s, "school.course_installs", "install_course", [doInstall(s.record, one), doInstall(s.record, one)]);
      expect(waiting.size).toBe(2);
      expect(values(results).map((x) => x.status).sort()).toEqual(["duplicate", "installed"]);
      expect((await history(s.admin, course)).map((x) => x.id)).toEqual([one.id]);
    }
  }, SLOW);

  test(`two removals of one name at once: one removed, the other not installed, one removal row (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const course = `bells-${i}`;
      await s.record.installCourse(install(course), NOW);
      const { results, waiting } = await race(s, "school.course_installs", "remove_installed_course",
        [doRemove(s.record, course), doRemove(s.record, course)]);
      expect(waiting.size).toBe(2);
      expect(values(results).map((x) => x.status).sort()).toEqual(["not-installed", "removed"]);
      expect((await history(s.admin, course)).map((x) => x.kind)).toEqual(["install", "removal"]);
      expect((await s.record.installedCourses()).filter((x) => x.course === course)).toEqual([]);
    }
  }, SLOW);

  test(`an install and a removal of one name at once: each status and what is current follow seq order (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const course = `bells-${i}`;
      await s.record.installCourse(install(course), NOW);
      const next = install(course, { commit: hex(40, "b") });
      // `%_course` matches both functions: the gate waits for both calls.
      const { results, waiting } = await race(s, "school.course_installs", "%_course",
        [doInstall(s.record, next), doRemove(s.record, course)]);
      expect(waiting.size).toBe(2);
      const [installed, removed] = values(results);
      const rows = await history(s.admin, course);
      expect(rows).toHaveLength(3);
      const removalFirst = rows[1]!.kind === "removal";
      // Either way the name had a current install when each ran, so the removal removes one.
      expect(removed!.status).toBe("removed");
      expect(installed!.status).toBe(removalFirst ? "installed" : "updated");
      const listed = (await s.record.installedCourses()).filter((x) => x.course === course).map((x) => x.id);
      expect(listed).toEqual(removalFirst ? [next.id] : []);
    }
  }, SLOW);

  test(`two decisions on one draft at once: one is stored, the other is told the draft is already decided (${REPS} times)`, async () => {
    const s = await setup(2);
    for (let i = 0; i < REPS; i++) {
      const draftId = await readyDraft(s.record, `bells-${i}`);
      const { results, waiting } = await race(s, "school.authoring_drafts", "decide_draft", [doDiscard(s.record, draftId), doDiscard(s.record, draftId)]);
      expect(waiting.size).toBe(2);
      expect(values(results).map((x) => x.status).sort()).toEqual(["already-decided", "stored"]);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.authoring_decisions WHERE draft_id = $1", [draftId]))[0].n).toBe(1);
    }
  }, SLOW);

  // F-8 of the review of flyingrobots/school#45: open_encounter and record_grading serialise on an
  // advisory lock and then read what the lock holder committed. That needs a snapshot taken after
  // the lock, which READ COMMITTED gives each statement; under REPEATABLE READ the transaction's
  // snapshot is older than the lock, so the second open would not see the first's encounter and
  // would open another. Neither function can set its own isolation level (Postgres allows that
  // only before a transaction's first query), so both refuse any other level, and the adapter pins
  // READ COMMITTED whatever the database's default.
  describe("REPEATABLE READ", () => {
    test("open_encounter and record_grading refuse to run under it, and store nothing", async () => {
      const s = await setup(2);
      const rr = postgresRecord(repeatableRead(s.pool));
      await expect(open(rr, "l")).rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.encounters"))[0].n).toBe(0);
      const e = await open(s.record, "l");
      const id = uuid();
      await s.record.saveExplanation({ submissionId: id, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, NOW);
      await expect(rr.recordGrading({
        submissionId: id, status: "failed", findings: null, error: "x", rubricVersion: "r", promptVersion: "p", adapter: "test", model: null, sources: [], raw: null,
      }, NOW)).rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.gradings"))[0].n).toBe(0);
    }, SLOW);

    test("open_lesson_encounter refuses to run under it, and stores nothing", async () => {
      const s = await setup(1);
      const rr = postgresRecord(repeatableRead(s.pool));
      await expect(rr.openLessonEncounter({ course: "c", lesson: "l", lessonPage: page, page, now: NOW, aidTracking: 1, notes: [] }))
        .rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.encounters"))[0].n).toBe(0);
    }, SLOW);

    test("install_course and remove_installed_course refuse to run under it, and store nothing", async () => {
      const s = await setup(2);
      const rr = postgresRecord(repeatableRead(s.pool));
      await expect(rr.installCourse(install("bells"), NOW)).rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.course_installs"))[0].n).toBe(0);
      await s.record.installCourse(install("bells"), NOW);
      await expect(rr.removeInstalledCourse("bells", NOW)).rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.course_removals"))[0].n).toBe(0);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.course_installs"))[0].n).toBe(1);
    }, SLOW);

    test("request_authoring, record_draft and decide_draft refuse to run under it, and store nothing", async () => {
      const s = await setup(2);
      const rr = postgresRecord(repeatableRead(s.pool));
      const base = install("bells");
      await s.record.installCourse(base, NOW);
      const request = { id: uuid(), course: "bells", baseInstallId: base.id, text: "Add a lesson.", skillSha256: hex(64, "5"), schoolVersion: "0.1.0" };
      await expect(rr.requestAuthoring(request, NOW)).rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.authoring_requests"))[0].n).toBe(0);
      await s.record.requestAuthoring(request, NOW);
      const draft = { id: uuid(), requestId: request.id, round: 1, status: "ready", agent: "claude", commit: hex(40, "7"), contentSha256: hex(64, "8"),
        checkMessage: null, inputTokens: 1, outputTokens: 1 } as const;
      await expect(rr.recordDraft(draft, NOW)).rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.authoring_drafts"))[0].n).toBe(0);
      await s.record.recordDraft(draft, NOW);
      await expect(doDiscard(rr, draft.id)()).rejects.toThrow(/READ COMMITTED/);
      expect((await s.admin.unsafe("SELECT count(*)::int AS n FROM school.authoring_decisions"))[0].n).toBe(0);
    }, SLOW);

    test("the adapter runs every request READ COMMITTED even when the database defaults to REPEATABLE READ", async () => {
      const { url } = await fresh();
      const admin = track(new Bun.SQL(url));
      await admin.unsafe(`ALTER DATABASE ${new URL(url).pathname.slice(1)} SET default_transaction_isolation = 'repeatable read'`);
      const pool = track(new Bun.SQL(url)); // new connections, so they take the new default
      expect((await pool.unsafe("SELECT current_setting('transaction_isolation') AS i"))[0].i).toBe("repeatable read");
      const got = await bunSql(pool, APP).query<{ i: string }>("SELECT current_setting('transaction_isolation') AS i", []);
      expect(got[0]!.i).toBe("read committed");
      expect((await postgresRecord(bunSql(pool, APP)).openEncounter({ course: "c", lesson: "l", page, now: NOW, aidTracking: 1 })).resumed).toBe(false);
    }, SLOW);

    // submit needs no pin: its partial unique index decides first try whatever the snapshot saw.
    test(`two first answers at once under it still give exactly one first try (${REPS} times)`, async () => {
      const s = await setup(2);
      const rr = postgresRecord(repeatableRead(s.pool));
      for (let i = 0; i < REPS; i++) {
        const e = await open(s.record, `l${i}`);
        const { results, waiting } = await race(s, "school.answers", "submit", [submit(rr, uuid(), e.id, "wrong"), submit(rr, uuid(), e.id, "right")]);
        expect(waiting.size).toBe(2);
        const got = values(results);
        expect(got.filter((x) => x.status === "stored" && x.firstTry)).toHaveLength(1);
        const rows = await answers(s.admin, e.id);
        expect(rows).toHaveLength(2);
        expect(rows.filter((x) => x.first_try)).toHaveLength(1);
      }
    }, SLOW);
  });
});
