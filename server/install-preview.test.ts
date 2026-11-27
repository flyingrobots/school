// `previewInstall` (flyingrobots/school#237, RFC 7 task 7): one commit of a course repository
// fetched into staging under the course store, extracted and checked there, and answered as what
// was found, the name RFC 7 §5.2 suggests, and any progress the record already holds under it.
// `courses/` and the record are unchanged either way. Every network case runs against the local
// https server of the fetch tests (server/testing/https-git.ts) on loopback, reached through
// `FetchTesting`, the seam only tests pass; none reaches the internet.
// docs/topics/architecture/test-plan.md lists these by ID.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { postgresRecord } from "./adapters/postgres.ts";
import { pgliteSql } from "./adapters/pglite.ts";
import { checkCourse } from "./check-course.ts";
import { contentDigest } from "./course-registry.ts";
import { migrate } from "./db/migrate.ts";
import type { Network } from "./fetch-commit.ts";
import { PREVIEW_TTL_MS, previewInstall, suggestName, sweepStaging, type PreviewSources, type Previews } from "./install-preview.ts";
import { dir, file, repository, symlink } from "./testing/git-trees.ts";
import { certificate, git, gitBackend, serveHttps } from "./testing/https-git.ts";

setDefaultTimeout(30_000); // PGlite starts a whole Postgres in process.

const HOST = "course.test";
const root = mkdtempSync(join(tmpdir(), "school-install-preview-"));
const home = join(root, "home");
const repos = join(root, "repos");
mkdirSync(home);
mkdirSync(repos);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const EXAMPLE = join(import.meta.dir, "..", ".agents", "skills", "school", "example");

/** A bare repository `<repos>/<name>.git` holding one commit of the folder `src`, as `git add -A` takes it; returns the commit. */
function publish(name: string, src: string): string {
  const bare = join(repos, `${name}.git`);
  git(home, ["init", "--quiet", "--bare", "--template=", "--initial-branch=main", bare]);
  git(home, ["--git-dir", bare, "--work-tree", src, "add", "-A"]);
  git(home, ["--git-dir", bare, "--work-tree", src, "commit", "--quiet", "-m", name]);
  return git(home, ["--git-dir", bare, "rev-parse", "HEAD"]);
}

// The example course, as published; and the same course with a quiz that has no correct choice.
const good = publish("counting-in-binary", EXAMPLE);
const badSource = join(root, "bad-source");
cpSync(EXAMPLE, badSource, { recursive: true });
const badLesson = join(badSource, "lessons", "0001-places-worth-twice.json");
writeFileSync(badLesson, readFileSync(badLesson, "utf8").replaceAll('"correct": true', '"correct": false'));
const bad = publish("bad-quiz", badSource);
// A course whose course.json is not JSON, which the check reports naming the file.
const brokenSource = join(root, "broken-source");
cpSync(EXAMPLE, brokenSource, { recursive: true });
writeFileSync(join(brokenSource, "course.json"), "{ not json");
const broken = publish("broken-manifest", brokenSource);
// A course whose reference/ holds a symlink, which the extraction refuses.
const linked = repository(join(repos, "linked.git"), [
  ["course.json", file('{"title":"Linked"}\n')],
  ["lessons", dir(["0001.json", file(readFileSync(join(EXAMPLE, "lessons", "0001-places-worth-twice.json")))])],
  ["reference", dir(["secret", symlink("/etc/passwd")])],
]);

const tls = certificate(join(root, "tls"), HOST);
let server: ReturnType<typeof serveHttps>;
let url: (repo: string) => string;
beforeAll(() => {
  server = serveHttps(tls, gitBackend(repos, home));
  url = (repo) => `https://${HOST}:${server.port}/${repo}`;
});
afterAll(() => server.stop(true));

/** The test network: HOST resolves to loopback, which alone counts as public, on the server's port. */
const network = (): Partial<Network> =>
  ({ resolve: async (host) => (host === HOST ? ["127.0.0.1"] : []), publicAddress: (a) => a === "127.0.0.1", ports: [server.port!], caFile: tls.cert });

const T0 = Date.parse("2026-11-26T10:00:00Z");
let n = 0;
/** A fresh, empty course store and sources over it, with a fixed clock and counted ids; `o` overrides any source. */
function sources(o: Partial<PreviewSources> = {}): PreviewSources {
  const store = join(root, `store-${++n}`);
  mkdirSync(store);
  let id = 0;
  return {
    store, configured: [], installedNames: async () => [],
    progress: async () => ({ encounters: 0, answers: 0, explanations: 0, views: 0 }),
    now: () => T0, newId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`, previews: new Map(), ...o,
  };
}
/** The content digest of `folder` (RFC 7 §7), which the install compares with what it moves (flyingrobots/school#238). */
const digestOf = (folder: string) => {
  const d = contentDigest(folder);
  return d.ok ? d.digest : d.message;
};
const preview = (body: unknown, s: PreviewSources) => previewInstall(body, s, { network: network() });

/** Every file and folder under `dir`, relative and sorted; empty for a folder that does not exist. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => relative(dir, join(dir, p))).sort();
}

describe("previewInstall: a good course", () => {
  test("PREVIEW-1: the example course answers its title, lessons, quizzes, license and format", async () => {
    const s = sources();
    const got = await preview({ url: url("counting-in-binary.git"), commit: good }, s);
    // Oracle: the example's course.json, and `school check`'s report of it: two lessons, three distinct quizzes, two explain blocks.
    expect(got).toEqual({
      status: "ok", preview: "00000000-0000-4000-8000-000000000001", expires: new Date(T0 + PREVIEW_TTL_MS).toISOString(),
      url: url("counting-in-binary.git"), commit: good,
      course: {
        title: "Counting in Binary", summary: "How two symbols are enough to count anything, and how to read a binary number.",
        author: "The School maintainers", license: "Apache-2.0", format: 1,
        lessons: [
          { file: "0001-places-worth-twice.json", id: expect.any(String), title: "Places worth twice", quizzes: 2, explains: 1 },
          { file: "0002-adding-with-carries.json", id: expect.any(String), title: "Adding with carries", quizzes: 2, explains: 1 },
        ],
        quizzes: 3, explains: 2,
      },
      name: { suggested: "counting-in-binary", taken: null, progress: null },
    });
  });

  test("PREVIEW-2: a branch is answered as the full hash it resolved to", async () => {
    const got = await preview({ url: url("counting-in-binary.git"), commit: "main" }, sources());
    expect(got.status === "ok" ? got.commit : got).toBe(good);
  });

  test("PREVIEW-3: the preview is kept in staging as the course School reads, with no repository and nothing in courses/, and its source in memory", async () => {
    const s = sources();
    await preview({ url: url("counting-in-binary.git"), commit: good }, s);
    const id = "00000000-0000-4000-8000-000000000001";
    // Oracle: RFC 7 Listing 5.1 and §4: only course.json, lessons/*.json and reference/** are written; courses/ waits for the install.
    expect(tree(s.store)).toEqual([
      "staging", `staging/${id}`, `staging/${id}/course`, `staging/${id}/course/course.json`, `staging/${id}/course/lessons`,
      `staging/${id}/course/lessons/0001-places-worth-twice.json`, `staging/${id}/course/lessons/0002-adding-with-carries.json`,
      `staging/${id}/course/reference`, `staging/${id}/course/reference/glossary.html`,
    ]);
    expect(Object.fromEntries(s.previews))
      .toEqual({ [id]: { url: url("counting-in-binary.git"), commit: good, expires: T0 + PREVIEW_TTL_MS, contentSha256: digestOf(join(s.store, "staging", id, "course")) } });
  });
});

describe("previewInstall: a refusal", () => {
  test("PREVIEW-4: a bad course answers the check's own message, and leaves nothing in the store but an empty staging/", async () => {
    const s = sources();
    const got = await preview({ url: url("bad-quiz.git"), commit: bad }, s);
    // Oracle: checkCourse on the same files, as `school check` reports them.
    const check = checkCourse(badSource);
    if (check.ok) throw new Error("the bad fixture passes the check");
    expect(got).toEqual({ status: "refused", stage: "check", reason: "invalid", path: check.file, message: check.message });
    expect(tree(s.store)).toEqual(["staging"]);
  });

  test("PREVIEW-5: a course.json the check refuses is named as course.json, never by its path in the store", async () => {
    const s = sources();
    const got = await preview({ url: url("broken-manifest.git"), commit: broken }, s);
    expect(got).toMatchObject({ status: "refused", stage: "check", reason: "invalid", path: "course.json", message: expect.stringMatching(/^course\.json is not valid JSON/) });
    expect(JSON.stringify(got)).not.toContain(s.store);
  });

  test("PREVIEW-6: a fetch refusal answers its reason, and leaves nothing staged", async () => {
    const s = sources();
    const got = await preview({ url: url("counting-in-binary.git"), commit: "no-such-branch" }, s);
    expect(got).toMatchObject({ status: "refused", stage: "fetch", reason: "no-such-ref", path: null });
    expect(tree(s.store)).toEqual(["staging"]);
  });

  test("PREVIEW-7: an extraction refusal answers its reason and path, and leaves nothing staged", async () => {
    const s = sources();
    const got = await preview({ url: url("linked.git"), commit: linked }, s);
    expect(got).toMatchObject({ status: "refused", stage: "extract", reason: "symlink", path: "reference/secret" });
    expect(tree(s.store)).toEqual(["staging"]);
  });

  test.each([
    ["no body", null], ["an array", [1]], ["no commit", { url: "https://example.com/c.git" }], ["no url", { commit: "main" }],
    ["a number for the url", { url: 1, commit: "main" }],
    ["test seams beside the request", { url: "https://example.com/c.git", commit: "main", git: "/bin/sh", network: { ports: [1] } }],
  ])("PREVIEW-8: a request with %s is invalid, and nothing is fetched or staged", async (_, body) => {
    const s = sources();
    const got = await preview(body, s);
    expect(got).toMatchObject({ status: "invalid" });
    expect(tree(s.store)).toEqual([]);
  });
});

describe("previewInstall: the name", () => {
  test.each([
    ["https://github.com/flyingrobots/school-bells.git", "Bells", "school-bells"],
    ["https://example.com/Some_Course.GIT/", "Bells", "some-course"],
    ["https://example.com/a/caf%C3%A9--notes", "Bells", "caf-notes"],
    ["https://example.com/api.git", "Counting in Binary", "counting-in-binary"],
    ["https://example.com/", "Counting in Binary", "counting-in-binary"],
    ["https://example.com/---.git", null, "course"],
    ["https://example.com/courses", "  ", "course"],
  ])("PREVIEW-9: %s with title %p suggests %s", (u, title, name) => {
    // Oracle: RFC 7 §5.2 step 1, its example first; a name the rule cannot make, or one School reserves, falls back to the title, then to "course".
    expect(suggestName(u, title)).toBe(name);
  });

  test("PREVIEW-10: a suggested name a configured course has is answered as taken by it", async () => {
    const got = await preview({ url: url("counting-in-binary.git"), commit: good }, sources({ configured: ["counting-in-binary"] }));
    expect(got.status === "ok" ? got.name : got).toEqual({ suggested: "counting-in-binary", taken: "configured", progress: null });
  });

  test("PREVIEW-11: a suggested name a current install has is answered as taken by it", async () => {
    const got = await preview({ url: url("counting-in-binary.git"), commit: good }, sources({ installedNames: async () => ["counting-in-binary"] }));
    expect(got.status === "ok" ? got.name : got).toEqual({ suggested: "counting-in-binary", taken: "installed", progress: null });
  });
});

describe("previewInstall: progress already under the name, on a real record", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await migrate(db);
  });
  afterAll(() => db.close());

  /** Every row of every table in schema school, read as the owner, by table. */
  async function everyRow(): Promise<Record<string, unknown[]>> {
    await db.exec("RESET ROLE");
    const tables = (await db.query<{ t: string }>("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'school' AND table_type = 'BASE TABLE' ORDER BY 1")).rows;
    const out: Record<string, unknown[]> = {};
    for (const { t } of tables) out[t] = (await db.query(`SELECT * FROM school."${t}" ORDER BY 1`)).rows;
    await db.exec("SET ROLE school_app");
    return out;
  }

  test("PREVIEW-12: a name the record already has progress under is answered with that progress, and the record is unchanged", async () => {
    await db.exec("SET ROLE school_app");
    const r = postgresRecord(pgliteSql(db));
    const page = JSON.parse(readFileSync(join(EXAMPLE, "lessons", "0001-places-worth-twice.json"), "utf8"));
    const e = await r.openEncounter({ course: "counting-in-binary", lesson: page.id, aidTracking: null, page, now: new Date(T0).toISOString() });
    type Node = { type: string; id: string; children?: Node[]; choices?: { id: string }[] };
    const quizzes = (b: Node): Node[] => (b.type === "quiz" ? [b] : (b.children ?? []).flatMap(quizzes));
    const quiz = quizzes(page)[0]!;
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId: quiz.id, choiceId: quiz.choices![0]!.id, ms: 1 }, new Date(T0 + 1000).toISOString());
    const before = await everyRow();
    // Witness: the record holds rows to compare, so "unchanged" is not vacuous.
    expect(Object.values(before).reduce((k, rows) => k + rows.length, 0)).toBeGreaterThan(0);
    const got = await preview({ url: url("counting-in-binary.git"), commit: good },
      sources({ installedNames: async () => (await r.installedCourses()).map((c) => c.course), progress: (c) => r.courseProgress(c) }));
    expect(got.status === "ok" ? got.name : got)
      .toEqual({ suggested: "counting-in-binary", taken: null, progress: { encounters: 1, answers: 1, explanations: 0, views: 0 } });
    expect(await everyRow()).toEqual(before);
  });
});

describe("sweepStaging", () => {
  /** A preview folder in `store`'s staging, last changed at `mtime`, remembered in `previews` as expiring at `expires`, or not remembered. */
  function staged(store: string, previews: Previews, id: string, expires: number | null, mtime = T0) {
    const folder = join(store, "staging", id);
    mkdirSync(join(folder, "course"), { recursive: true });
    if (expires !== null) previews.set(id, { url: "https://example.com/c.git", commit: "a".repeat(40), expires, contentSha256: "0".repeat(64) });
    utimesSync(folder, mtime / 1000, mtime / 1000);
  }

  test("PREVIEW-13: a preview past its time is deleted and forgotten, and one within it is kept", () => {
    const { store, previews } = sources();
    staged(store, previews, "expired", T0 - 1);
    staged(store, previews, "current", T0 + 1);
    sweepStaging(store, T0, previews);
    expect({ staged: tree(join(store, "staging")), remembered: [...previews.keys()] }).toEqual({ staged: ["current", "current/course"], remembered: ["current"] });
  });

  // School reads no file in staging to learn when a preview expires: a preview.json there is not read.
  test("PREVIEW-14: a staging folder this process does not remember is deleted once it is older than a preview's lifetime, whatever a preview.json in it says, and kept while it may still be in progress", () => {
    const { store, previews } = sources();
    staged(store, previews, "abandoned", null, T0 - PREVIEW_TTL_MS - 1000);
    writeFileSync(join(store, "staging", "abandoned", "preview.json"), JSON.stringify({ expires: new Date(T0 + PREVIEW_TTL_MS).toISOString() }));
    utimesSync(join(store, "staging", "abandoned"), (T0 - PREVIEW_TTL_MS - 1000) / 1000, (T0 - PREVIEW_TTL_MS - 1000) / 1000);
    staged(store, previews, "working", null, T0 - 1000);
    sweepStaging(store, T0, previews);
    expect(tree(join(store, "staging"))).toEqual(["working", "working/course"]);
  });

  test("PREVIEW-15: sweeping everything, as at start, deletes and forgets every preview and keeps courses/", () => {
    const { store, previews } = sources();
    staged(store, previews, "current", T0 + PREVIEW_TTL_MS);
    mkdirSync(join(store, "courses", "kept"), { recursive: true });
    sweepStaging(store, T0, previews, true);
    expect({ tree: tree(store), remembered: previews.size }).toEqual({ tree: ["courses", "courses/kept", "staging"], remembered: 0 });
  });

  test("PREVIEW-16: an expired preview is swept and forgotten by the next preview", async () => {
    const s = sources();
    staged(s.store, s.previews, "expired", T0 - 1);
    await preview({ url: url("counting-in-binary.git"), commit: "no-such-branch" }, s);
    expect({ staged: tree(join(s.store, "staging")), remembered: s.previews.size }).toEqual({ staged: [], remembered: 0 });
  });

  test("PREVIEW-17: staging/ that is a symlink is not swept, and what it points at is left alone", () => {
    const { store, previews } = sources();
    const outside = join(root, `outside-${++n}`);
    mkdirSync(join(outside, "expired", "course"), { recursive: true });
    utimesSync(join(outside, "expired"), (T0 - PREVIEW_TTL_MS - 1000) / 1000, (T0 - PREVIEW_TTL_MS - 1000) / 1000);
    symlinkSync(outside, join(store, "staging"));
    sweepStaging(store, T0, previews);
    sweepStaging(store, T0, previews, true);
    expect(tree(outside)).toEqual(["expired", "expired/course"]);
  });
});

describe("previewInstall: a failure that is not a refusal", () => {
  test("PREVIEW-18: a preview that throws after the course passed its check still deletes its staging, and the error reaches the caller", async () => {
    const s = sources({ progress: async () => { throw new Error("record down"); } });
    await expect(preview({ url: url("counting-in-binary.git"), commit: good }, s)).rejects.toThrow("record down");
    expect({ staged: tree(join(s.store, "staging")), remembered: s.previews.size }).toEqual({ staged: [], remembered: 0 });
  });
});
