// `POST /api/installs` (flyingrobots/school#238, RFC 7 task 8 and §8), on a running School. A server
// installs only a preview it made itself and remembers (server/install-preview.ts), and its preview
// route reaches no repository a test can serve: the fetch tests' local https server
// (server/testing/https-git.ts) is reachable only through a test seam the route never takes. So no
// case here installs over HTTP. A course is installed by the real `previewInstall` and
// `installPreviewed`, run in this process through the server's own record adapter, before School
// starts over that store and record; the cases then check that School serves it untrusted, keeps
// its folder at start, and answers each refusal it can reach over HTTP. A folder in `courses/` that
// no current install names, as a crash between the move and the record leaves one, is deleted when
// School starts. The install's own cases are in install-course.test.ts; its 201 and its 410 for
// an expired preview are not checked over HTTP. docs/topics/architecture/test-plan.md lists these
// by ID. Oracle: the issue's sections 2d and 2e, and RFC 7 §5.1 and §8.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./adapters/database.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import type { Sql } from "./adapters/sql.ts";
import { installFolder } from "./course-registry.ts";
import type { Network } from "./fetch-commit.ts";
import { installPreviewed } from "./install-course.ts";
import { previewInstall, type Previews } from "./install-preview.ts";
import { certificate, git, gitBackend, serveHttps } from "./testing/https-git.ts";
import { scratchPostgres, TEST_POSTGRES_URL } from "./testing/postgres.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const HOST = "course.test";
const root = mkdtempSync(join(tmpdir(), "school-install-route-"));
const home = join(root, "home");
const repos = join(root, "repos");
mkdirSync(home);
mkdirSync(repos);
const EXAMPLE = join(import.meta.dir, "..", ".agents", "skills", "school", "example");
git(home, ["init", "--quiet", "--bare", "--template=", "--initial-branch=main", join(repos, "counting-in-binary.git")]);
git(home, ["--git-dir", join(repos, "counting-in-binary.git"), "--work-tree", EXAMPLE, "add", "-A"]);
git(home, ["--git-dir", join(repos, "counting-in-binary.git"), "--work-tree", EXAMPLE, "commit", "--quiet", "-m", "example"]);
const commit = git(home, ["--git-dir", join(repos, "counting-in-binary.git"), "rev-parse", "HEAD"]);

const tls = certificate(join(root, "tls"), HOST);
const https = serveHttps(tls, gitBackend(repos, home));
const url = `https://${HOST}:${https.port}/counting-in-binary.git`;
const network = (): Partial<Network> =>
  ({ resolve: async (host) => (host === HOST ? ["127.0.0.1"] : []), publicAddress: (a) => a === "127.0.0.1", ports: [https.port!], caFile: tls.cert });

/**
 * A preview of the example course staged in `store` by this process, remembered in `previews`
 * (this process's, not the server's: a running School does not know it); answers its id.
 */
async function stage(store: string, previews: Previews = new Map()): Promise<string> {
  const got = await previewInstall({ url, commit }, {
    store, configured: [], installedNames: async () => [], progress: async () => ({ encounters: 0, answers: 0, explanations: 0, views: 0 }),
    now: () => Date.now(), newId: () => crypto.randomUUID(), previews,
  }, { network: network() });
  if (got.status !== "ok") throw new Error(`the preview was refused: ${JSON.stringify(got)}`);
  return got.preview;
}

/** Previews the example course into `store` and installs it as `name` through the record `sql`, in this process; answers the install id. */
async function installHere(store: string, sql: Sql, name: string): Promise<string> {
  const previews: Previews = new Map();
  const preview = await stage(store, previews);
  const record = postgresRecord(sql);
  const got = await installPreviewed({ preview, name }, {
    store, configured: [], installedNames: async () => (await record.installedCourses()).map((c) => c.course),
    record: (i) => record.installCourse(i, new Date().toISOString()), now: () => Date.now(), newId: () => crypto.randomUUID(), previews,
  });
  if (got.status !== "installed") throw new Error(`the install was refused: ${JSON.stringify(got)}`);
  return got.install;
}

const servers: Started[] = [];
const { fresh } = scratchPostgres();
afterAll(async () => {
  for (const s of servers) {
    s.proc.kill();
    await s.proc.exited;
  }
  https.stop(true);
  rmSync(root, { recursive: true, force: true });
});

/** School over a store at `<root>/<tag>/store`, with one configured course `own`. */
async function launch(tag: string, o: Record<string, string> = {}): Promise<Started> {
  const dir = join(root, tag);
  mkdirSync(join(dir, "own", "lessons"), { recursive: true });
  const e: Record<string, string | undefined> = {
    ...process.env, HOST: "127.0.0.1", SCHOOL_COURSES: `own=${join(dir, "own")}`, SCHOOL_STATE: join(dir, "state"), SCHOOL_WEB: join(dir, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${join(dir, "record")}`, SCHOOL_COURSE_STORE: join(dir, "store"), ...o,
  };
  delete e.SCHOOL_BRIDGE_URL;
  delete e.SCHOOL_BRIDGE_TOKEN;
  if (e.SCHOOL_COURSE_STORE === "") delete e.SCHOOL_COURSE_STORE;
  const s = await startSchool(e);
  servers.push(s);
  return s;
}

const post = (s: Started, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${s.url}/api/installs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
type Listed = { name: string; trusted: boolean; lessons: number | null };
const listed = async (s: Started): Promise<Listed[]> =>
  ((await (await fetch(`${s.url}/api/courses`)).json()) as Listed[]).map(({ name, trusted, lessons }) => ({ name, trusted, lessons }));
// The untrusted policy flyingrobots/school#271 set.
const POLICY = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

// A folder in courses/ no row names, as a crash between the move and the record leaves it.
const STRAY = "33333333-3333-4333-8333-333333333333";
const store = join(root, "pglite", "store");
mkdirSync(join(installFolder(store, STRAY), "lessons"), { recursive: true });
writeFileSync(join(installFolder(store, STRAY), "course.json"), JSON.stringify({ title: "Stray" }));

let school: Started;
let binary = "";
beforeAll(async () => {
  // School's own record, opened as School opens it, then closed before School starts on it.
  const opened = await openDatabase({ driver: "pglite", dir: join(root, "pglite", "record") });
  try {
    binary = await installHere(store, opened.sql, "binary");
  } finally {
    await opened.close();
  }
  school = await launch("pglite");
}, timeout(1) + 30_000);

describe("POST /api/installs (PGlite)", () => {
  test("INSTALL-ROUTE-1: a folder in courses/ that no install names is deleted at start, and is not served; a current install's folder is kept", async () => {
    expect({ courses: existsSync(join(store, "courses")) ? readdirSync(join(store, "courses")) : [], listed: await listed(school) })
      .toEqual({ courses: [binary], listed: [{ name: "binary", trusted: false, lessons: 2 }, { name: "own", trusted: true, lessons: 0 }] });
  });

  test("INSTALL-ROUTE-2: an installed course, opened: it is served untrusted at /courses/<name>", async () => {
    const course = (await (await fetch(`${school.url}/api/courses/binary`)).json()) as { trusted: unknown };
    const lesson = await fetch(`${school.url}/api/courses/binary/lessons/places-worth-twice?view=slides`);
    const page = await fetch(`${school.url}/courses/binary/reference/glossary.html`);
    expect({
      trusted: course.trusted, lesson: lesson.status, lessonCsp: lesson.headers.get("content-security-policy"),
      page: page.status, pageCsp: page.headers.get("content-security-policy"),
    }).toEqual({ trusted: false, lesson: 200, lessonCsp: POLICY, page: 200, pageCsp: POLICY });
  });

  test("INSTALL-ROUTE-3: a name a configured course has is a 409, and the preview is kept", async () => {
    const preview = await stage(store);
    const res = await post(school, { preview, name: "own" });
    expect({ status: res.status, body: await res.json(), kept: existsSync(join(store, "staging", preview, "course")) })
      .toEqual({ status: 409, body: { status: "refused", reason: "name-taken", message: expect.any(String) }, kept: true });
  });

  // The server installs only a preview it made: one another process put in its store is unknown to it.
  test("INSTALL-ROUTE-4: a preview another process staged in School's store is a 404, and nothing is installed", async () => {
    const preview = await stage(store);
    const res = await post(school, { preview, name: "elsewhere" });
    expect({ status: res.status, body: await res.json(), courses: readdirSync(join(store, "courses")), listed: (await listed(school)).map((c) => c.name) })
      .toEqual({ status: 404, body: { status: "refused", reason: "unknown-preview", message: expect.any(String) }, courses: [binary], listed: ["binary", "own"] });
  });

  test("INSTALL-ROUTE-5: a preview School never staged is a 404", async () => {
    const res = await post(school, { preview: "44444444-4444-4444-8444-444444444444", name: "never" });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 404, body: { status: "refused", reason: "unknown-preview", message: expect.any(String) } });
  });

  test("INSTALL-ROUTE-6: a body with any field besides preview and name is a 400", async () => {
    const res = await post(school, { preview: "44444444-4444-4444-8444-444444444444", name: "never", url });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 400, body: { status: "invalid", error: expect.any(String) } });
  });

  test.each(["cross-site", "same-site", "none"])("INSTALL-ROUTE-7: Sec-Fetch-Site %s is refused, and the preview is kept", async (site) => {
    const preview = await stage(store);
    const res = await post(school, { preview, name: `from-${site}` }, { "sec-fetch-site": site });
    expect({ status: res.status, kept: existsSync(join(store, "staging", preview, "course")) }).toEqual({ status: 403, kept: true });
  });

  test("INSTALL-ROUTE-8: a body not declared JSON is refused", async () => {
    const res = await fetch(`${school.url}/api/installs`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  test("INSTALL-ROUTE-9: without a course store, the answer is a 503 that names SCHOOL_COURSE_STORE", async () => {
    const none = await launch("none", { SCHOOL_COURSE_STORE: "" });
    const res = await post(none, { preview: "44444444-4444-4444-8444-444444444444", name: "never" });
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 503, body: { status: "unavailable", error: expect.stringContaining("SCHOOL_COURSE_STORE") } });
  }, timeout(1));
});

describe.skipIf(TEST_POSTGRES_URL === undefined)("POST /api/installs on a real Postgres (Bun.SQL, SCHOOL_TEST_POSTGRES_URL)", () => {
  test("INSTALL-ROUTE-10: a course installed through Bun.SQL is served untrusted, and the row names the URL and commit (Bun.SQL)", async () => {
    const record = await fresh();
    const id = await installHere(join(root, "bunsql", "store"), record.sql, "binary");
    const s = await launch("bunsql", { SCHOOL_DATABASE_URL: record.appUrl });
    const lesson = await fetch(`${s.url}/api/courses/binary/lessons/places-worth-twice?view=slides`);
    const rows = await postgresRecord(record.sql).installedCourses();
    expect({ lesson: lesson.status, csp: lesson.headers.get("content-security-policy"), listed: await listed(s), rows: rows.map(({ id, course, source, url, commit, trusted }) => ({ id, course, source, url, commit, trusted })) })
      .toEqual({ lesson: 200, csp: POLICY, listed: [{ name: "binary", trusted: false, lessons: 2 }, { name: "own", trusted: true, lessons: 0 }], rows: [{ id, course: "binary", source: "git", url, commit, trusted: false }] });
  }, timeout(1) + 30_000);
});
