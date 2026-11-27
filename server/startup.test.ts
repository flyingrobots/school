// The config checks, exercised through the real server process and Bun's actual database
// creation rather than parseConfig alone (review of #8, P2), and the refusal to start on a SQLite
// progress.db that holds learner work (RFC 3 v0.4.0 §3.3; flyingrobots/school#47). Every start
// here passes record: "server", so the server, not the test helper's migrated template, makes the
// record (server/testing/processes.ts, flyingrobots/school#129).
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "./blocks.ts";
import { NotStarted, probePort, startSchool, timeout } from "./testing/processes.ts";
import { ownerQuery } from "./testing/record.ts";

async function boot(env: Record<string, string | undefined>): Promise<{ code: number | null; up: boolean; err: string }> {
  try {
    const s = await startSchool({ ...process.env, HOST: "127.0.0.1", ...env }, { record: "server" });
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

test("without SCHOOL_DATABASE_URL the server refuses to start, saying what to set, and creates nothing", () => inRoot(async (root) => {
  // No silent default: PGlite is not crash-durable, so a record is only ever where it was asked to be.
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "fresh", "state"), SCHOOL_DATABASE_URL: undefined });
  expect(r.up).toBe(false);
  expect(r.code).toBe(2);
  expect(r.err).toContain("SCHOOL_DATABASE_URL is not set");
  expect(r.err).toContain("postgres://");
  expect(r.err).toContain("pglite:");
  expect(existsSync(join(root, "fresh"))).toBe(false);
}), timeout(1));

test("a first run on an explicit pglite: record creates it outside the course, and warns that it is not crash-durable", () => inRoot(async (root) => {
  const port = probePort();
  const s = await startSchool({ ...process.env, HOST: "127.0.0.1", PORT: String(port), SCHOOL_COURSES: `c=${join(root, "course")}`,
    SCHOOL_STATE: join(root, "fresh", "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "fresh", "state", "db")}` }, { record: "server" });
  s.proc.kill();
  const { stdout, stderr } = await s.output();
  expect(existsSync(join(root, "fresh", "state", "db", "PG_VERSION"))).toBe(true);
  // The server no longer writes SQLite; it only reads a progress.db that is already there.
  expect(existsSync(join(root, "fresh", "state", "progress.db"))).toBe(false);
  expect(stdout + stderr).toContain("not crash-durable");
  expect(stdout + stderr).toContain("development and tests");
}), timeout(1));

test("a second server on the same pglite: record refuses to start before serving, and the first keeps every answer", () => inRoot(async (root) => {
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify(page));
  const env = { SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}` };
  const first = await startSchool({ ...process.env, HOST: "127.0.0.1", ...env }, { record: "server" });
  try {
    const answer = async () => {
      const { encounterId } = await (await fetch(`${first.url}/api/courses/c/lessons/l1`)).json();
      const submissionId = crypto.randomUUID();
      const r = await fetch(`${first.url}/api/answer`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId, encounterId, blockId: "q1", choiceId: "a", ms: 5 }) });
      expect((await r.json()).status).toBe("stored");
      return submissionId;
    };
    const before = await answer();
    const second = await boot(env);
    expect(second.up).toBe(false);
    expect(second.code).toBe(2);
    expect(second.err).toContain(join(root, "record"));
    expect(second.err).toContain("in use");
    const after = await answer();
    first.proc.kill("SIGKILL");
    await first.proc.exited;
    const ids = (await ownerQuery<{ s: string }>(join(root, "record"), "SELECT submission_id::text AS s FROM school.answers ORDER BY seq")).map((r) => r.s);
    expect(ids).toEqual([before, after]);
  } finally {
    first.proc.kill("SIGKILL");
    await first.proc.exited;
  }
}), timeout(3));

test("the startup log names the Postgres server without its user, password or query string", () => inRoot(async (root) => {
  // Nothing listens on the port, so the open fails; the line naming the record comes first.
  const port = probePort();
  for (const url of [`postgres://school:SECRET-USERINFO@127.0.0.1:${port}/school`, `postgres://127.0.0.1:${port}/school?user=school&password=SECRET-QUERY`]) {
    const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: url });
    expect(r.up).toBe(false);
    expect(r.err).toContain(`postgres://127.0.0.1:${port}/school`);
    expect(r.err).not.toContain("SECRET");
    expect(r.err).not.toContain("user=");
    expect(r.err).not.toContain("school@");
  }
}), timeout(2));

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

/**
 * The tables of the last SQLite schema (version 6), as server/migrate.ts created them before
 * SQLite was deleted (flyingrobots/school#49). Abridged: no indexes or append-only triggers, which
 * the refusal does not read. This fixture, and the refusal it feeds, are the only SQLite left.
 */
const SCHEMA_V6 = `
CREATE TABLE snapshots (hash TEXT PRIMARY KEY, content TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE encounters (id TEXT PRIMARY KEY, course TEXT NOT NULL, lesson TEXT NOT NULL, view TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL REFERENCES snapshots (hash), at TEXT NOT NULL);
CREATE TABLE answers (id INTEGER PRIMARY KEY, origin TEXT NOT NULL CHECK (origin IN ('block', 'legacy')), course TEXT,
  block_id TEXT, lesson TEXT NOT NULL, question INTEGER, prompt TEXT, choice TEXT NOT NULL, correct INTEGER NOT NULL,
  first_try INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL, encounter_id TEXT REFERENCES encounters (id),
  choice_id TEXT, submission_id TEXT);
CREATE TABLE views (id INTEGER PRIMARY KEY, course TEXT, lesson TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE explanations (submission_id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL REFERENCES encounters (id),
  block_id TEXT NOT NULL, course TEXT NOT NULL, lesson TEXT NOT NULL, text TEXT NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL);
CREATE TABLE gradings (id INTEGER PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES explanations (submission_id),
  status TEXT NOT NULL, rubric_version TEXT NOT NULL, prompt_version TEXT NOT NULL, adapter TEXT NOT NULL, model TEXT,
  sources TEXT NOT NULL, raw_response TEXT, findings TEXT, error TEXT, supersedes INTEGER REFERENCES gradings (id), at TEXT NOT NULL);
PRAGMA user_version = 6;`;

type Work = (db: Database, encounterId: string) => void;

/** A SQLite progress.db as the old server left it: one encounter of `page`, and whatever `work` records. */
function legacy(path: string, work: Work): void {
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(SCHEMA_V6);
    const content = JSON.stringify(page);
    const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    const encounterId = crypto.randomUUID();
    db.query("INSERT INTO snapshots (hash, content, at) VALUES (?, ?, ?)").run(hash, content, NOW);
    db.query("INSERT INTO encounters (id, course, lesson, view, snapshot_hash, at) VALUES (?, 'c', 'l1', 'web', ?, ?)").run(encounterId, hash, NOW);
    work(db, encounterId);
  } finally {
    db.close();
  }
}

const WORK: [string, Work][] = [
  ["an answer", (db, e) => db.query(`INSERT INTO answers (origin, course, block_id, lesson, choice, correct, first_try, ms, at, encounter_id, choice_id, submission_id)
    VALUES ('block', 'c', 'q1', 'l1', 'A', 1, 1, 5, ?, ?, 'a', ?)`).run(NOW, e, crypto.randomUUID())],
  ["an explanation", (db, e) => db.query(`INSERT INTO explanations (submission_id, encounter_id, block_id, course, lesson, text, ms, at)
    VALUES (?, ?, 'e1', 'c', 'l1', 'Because so.', 5, ?)`).run(crypto.randomUUID(), e, NOW)],
  ["a view", (db) => db.query("INSERT INTO views (course, lesson, at) VALUES ('c', 'l1', ?)").run(NOW)],
];

test.each(WORK)("a SQLite progress.db holding %s stops startup with a clear message, before Postgres is touched", (what, work) => inRoot(async (root) => {
  mkdirSync(join(root, "state"));
  legacy(join(root, "state", "progress.db"), work);
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
  legacy(join(root, "state", "progress.db"), () => undefined); // an encounter and its snapshot only
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

// flyingrobots/school#210: a course both trusted and untrusted is a configuration error, refused
// before anything is served or created.
test("a course both trusted and untrusted stops startup, naming both variables", () => inRoot(async (root) => {
  const r = await boot({ SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_UNTRUSTED_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "db")}` });
  expect([r.up, r.code]).toEqual([false, 2]);
  expect(r.err).toContain('"c" is in both SCHOOL_COURSES and SCHOOL_UNTRUSTED_COURSES');
  expect(existsSync(join(root, "state", "db"))).toBe(false);
}), timeout(1));

// flyingrobots/school#210: a mount or web folder over an untrusted course would serve its files
// with no sandbox, so it stops startup with exit 2, naming both variables and both folders.
test.each([
  ["SCHOOL_MOUNTS", (root: string) => ({ SCHOOL_MOUNTS: `lib=${root}` }), (root: string) => `SCHOOL_MOUNTS mount "lib" (${root})`],
  ["SCHOOL_WEB", (root: string) => ({ SCHOOL_WEB: root }), (root: string) => `SCHOOL_WEB (${root})`],
])("%s holding an untrusted course stops startup, naming both variables and folders", (_, env, named) => inRoot(async (root) => {
  const r = await boot({ ...env(root), SCHOOL_UNTRUSTED_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "state", "db")}` });
  expect([r.up, r.code]).toEqual([false, 2]);
  expect(r.err).toContain(`${named(root)} overlaps untrusted course "c" (${join(root, "course")}) from SCHOOL_UNTRUSTED_COURSES`);
  expect(existsSync(join(root, "state", "db"))).toBe(false);
}), timeout(1));
