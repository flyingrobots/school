// The config checks, exercised through the real server process and Bun's actual database
// creation rather than parseConfig alone (review of #8, P2), and the refusal to start on a SQLite
// progress.db that holds learner work (RFC 3 v0.4.0 §3.3; flyingrobots/school#47).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "./blocks.ts";
import { migrate as migrateSqlite } from "./migrate.ts";
import { sqliteRecord } from "./adapters/sqlite.ts";
import { NotStarted, startSchool, timeout } from "./testing/processes.ts";

async function boot(env: Record<string, string | undefined>): Promise<{ code: number | null; up: boolean; err: string }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  try {
    const s = await startSchool({ ...process.env, PORT: String(port), HOST: "127.0.0.1", ...env });
    s.proc.kill();
    return { code: null, up: true, err: (await s.output()).stderr };
  } catch (e) {
    if (!(e instanceof NotStarted)) throw e;
    return { code: e.exitCode, up: false, err: e.stderr };
  }
}

/** A temporary root with an empty course, removed after `fn`. */
async function inRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "school-boot-"));
  try {
    mkdirSync(join(root, "course", "lessons"), { recursive: true });
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a dangling DB_PATH symlink into a course stops the server before it creates anything", () => inRoot(async (root) => {
  mkdirSync(join(root, "state"));
  symlinkSync(join(root, "course", "new-progress.db"), join(root, "state", "progress.db"));
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "db")}` });
  expect(r.up).toBe(false);
  expect(r.code).toBe(2);
  expect(r.err).toContain("symlink");
  expect(existsSync(join(root, "course", "new-progress.db"))).toBe(false);
  expect(existsSync(join(root, "state", "db"))).toBe(false);
}), timeout(1));

test("a first run, with SCHOOL_DATABASE_URL unset, creates its state directory and a PGlite record in it, outside the course", () => inRoot(async (root) => {
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "fresh", "state"), SCHOOL_DATABASE_URL: undefined });
  expect(r.up).toBe(true);
  // The default is pglite:<SCHOOL_STATE>/db, so a learner needs no Postgres to run School.
  expect(existsSync(join(root, "fresh", "state", "db", "PG_VERSION"))).toBe(true);
  // The server no longer writes SQLite; it only reads a progress.db that is already there.
  expect(existsSync(join(root, "fresh", "state", "progress.db"))).toBe(false);
}), timeout(1));

test("a pglite: record inside a course is refused before anything is created", () => inRoot(async (root) => {
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "course", "db")}` });
  expect(r.up).toBe(false);
  expect(r.code).toBe(2);
  expect(r.err).toContain("SCHOOL_DATABASE_URL");
  expect(existsSync(join(root, "course", "db"))).toBe(false);
}), timeout(1));

test("a SCHOOL_DATABASE_URL that is neither postgres:// nor pglite: is refused", () => inRoot(async (root) => {
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: "mysql://localhost/school" });
  expect(r.up).toBe(false);
  expect(r.code).toBe(2);
  expect(r.err).toContain("SCHOOL_DATABASE_URL");
}), timeout(1));

// RFC 3 §3.3: nothing migrates from SQLite, so a progress.db holding learner work is a premise
// failure, checked rather than assumed. The server stops and says so before it touches Postgres.
const explain: Block = { type: "explain", id: "e1", prompt: "Say why.", model: "Because.", sources: [] };
const quiz: Block = { type: "quiz", id: "q1", q: "Which?", why: "So.", choices: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }] };
const page: Block = { type: "page", id: "l1", title: "L", subtitle: "", children: [quiz, explain] };
const NOW = "2026-11-22T10:00:00.000Z";

/** A SQLite progress.db as the old server left it, holding whatever `work` records. */
async function legacy(path: string, work: (r: ReturnType<typeof sqliteRecord>, encounterId: string) => Promise<unknown>): Promise<void> {
  const db = new Database(path, { create: true, strict: true });
  try {
    migrateSqlite(db);
    const r = sqliteRecord(db);
    const e = await r.openEncounter({ course: "c", lesson: "l1", page, now: NOW });
    await work(r, e.id);
  } finally {
    db.close();
  }
}

const WORK: [string, (r: ReturnType<typeof sqliteRecord>, encounterId: string) => Promise<unknown>][] = [
  ["an answer", (r, e) => r.submit({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "q1", choiceId: "a", ms: 5 }, NOW)],
  ["an explanation", (r, e) => r.saveExplanation({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "e1", text: "Because so.", ms: 5 }, NOW)],
  ["a view", (r) => r.recordView({ course: "c", lesson: "l1" }, NOW)],
];

test.each(WORK)("a SQLite progress.db holding %s stops startup with a clear message, before Postgres is touched", (what, work) => inRoot(async (root) => {
  mkdirSync(join(root, "state"));
  await legacy(join(root, "state", "progress.db"), work);
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "db")}` });
  expect(r.up).toBe(false);
  expect(r.code).toBe(2);
  expect(r.err).toContain(join(root, "state", "progress.db"));
  expect(r.err).toContain(what === "an answer" ? "1 answer" : what === "an explanation" ? "1 explanation" : "1 view");
  expect(r.err).toContain("not migrated");
  expect(existsSync(join(root, "state", "db"))).toBe(false); // Postgres was never opened
}), timeout(1));

test("a SQLite progress.db with no answer, explanation or view does not stop startup", () => inRoot(async (root) => {
  mkdirSync(join(root, "state"));
  await legacy(join(root, "state", "progress.db"), async () => undefined); // an encounter and its snapshot only
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "db")}` });
  expect(r.up).toBe(true);
}), timeout(1));

test("a progress.db that is not a SQLite database stops startup rather than being guessed empty", () => inRoot(async (root) => {
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "progress.db"), "this is not a database, but it might have been one".repeat(100));
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "db")}` });
  expect(r.up).toBe(false);
  expect(r.code).toBe(2);
  expect(r.err).toContain(join(root, "state", "progress.db"));
  expect(existsSync(join(root, "state", "db"))).toBe(false);
}), timeout(1));
