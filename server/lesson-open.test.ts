// Opening a lesson is the one GET that writes to the record (flyingrobots/school#306): the web view
// opens or resumes the learner's encounter. It must not be opened by another page's request, such
// as an untrusted course page's `<img src="/api/courses/c/lessons/l?view=web">`, over HTTP against
// the real server.
// Oracle: the issue's section 2b, with the request metadata Fetch gives each request ("Fetch
// Metadata Request Headers"): School's own `fetch()` is `Sec-Fetch-Site: same-origin` and
// `Sec-Fetch-Dest: empty`; an image is `Sec-Fetch-Dest: image`, a navigation `document`, and any
// request from a sandboxed page (an opaque origin) or another site is `cross-site`, from another
// port on the same host `same-site`. A client that sends no metadata (curl, a test, a browser too
// old to send it) is not a page School's learner has open, and is answered as before.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchool, timeout, type Started } from "./testing/processes.ts";
import { ownerQuery } from "./testing/record.ts";

const root = mkdtempSync(join(tmpdir(), "school-lesson-open-"));
const record = join(root, "record");
let server: Started | null = null;

const LESSONS = ["refused", "allowed", "each", "slides"];

async function start(): Promise<void> {
  server = await startSchool({
    ...process.env, SCHOOL_COURSES: `c=${join(root, "c")}`,
    SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${record}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1",
  });
}
async function stop(): Promise<void> {
  server?.proc.kill();
  await server?.proc.exited;
  server = null;
}

beforeAll(async () => {
  mkdirSync(join(root, "c", "lessons"), { recursive: true });
  LESSONS.forEach((id, i) => writeFileSync(join(root, "c", "lessons", `000${i + 1}.json`), JSON.stringify({
    type: "page", id, title: id, subtitle: "",
    children: [{ type: "quiz", id: `${id}-q`, q: "Which?", why: "Because.", choices: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }] }],
  })));
  await start();
}, timeout(1));
afterAll(async () => {
  await stop();
  rmSync(root, { recursive: true, force: true });
});

/** How many encounters the record holds for `lesson`, read as its owner with the server stopped (PGlite is one process's). */
async function encounters(lesson: string): Promise<number> {
  await stop();
  try {
    return (await ownerQuery<{ n: number }>(record, "SELECT count(*)::int AS n FROM school.encounters WHERE course = 'c' AND lesson = $1", [lesson]))[0]!.n;
  } finally {
    await start();
  }
}

const open = (lesson: string, headers: Record<string, string>, query = "?view=web&aid=1") =>
  fetch(`${server!.url}/api/courses/c/lessons/${lesson}${query}`, { headers });

/** The metadata Chrome sends with each request that is not School's own fetch of the lesson. */
const REFUSED: [string, Record<string, string>][] = [
  ["an untrusted course page's <img> (opaque origin)", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }],
  ["another site's no-cors fetch()", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" }],
  ["a link followed from another site, or from a sandboxed page", { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" }],
  ["another port's page on the same host, with an <img>", { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }],
  ["another port's page on the same host, with a no-cors fetch()", { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty" }],
  ["a trusted course page's <img> on School's own origin", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }],
  ["a trusted course page's <iframe>", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }],
  ["the address typed into the browser", { "sec-fetch-site": "none", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-user": "?1" }],
];

/** School's own fetch of the lesson (web/src/lib/school-api.ts, openLesson), and a client that sends no metadata. */
const ALLOWED: [string, Record<string, string>][] = [
  ["School's own fetch()", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "application/json" }],
  ["a client that sends no fetch metadata", {}],
];

describe("opening a lesson in the web view", () => {
  test.each(REFUSED)("is refused for %s, with no encounter in the reply", async (_, headers) => {
    const res = await open("each", headers);
    const body = await res.json();
    expect([res.status, body.status, "encounterId" in body]).toEqual([403, "refused", false]);
  });

  test.each(ALLOWED)("is answered for %s, with the encounter", async (_, headers) => {
    const res = await open("each", headers);
    expect([res.status, typeof (await res.json()).encounterId]).toEqual([200, "string"]);
  });

  test("is refused without a view named too, since the web view is the default", async () => {
    expect((await open("each", REFUSED[0]![1], "?aid=1")).status).toBe(403);
  });

  test("a refused request leaves no encounter in the record, and School's own fetch still opens one", async () => {
    for (const [, headers] of REFUSED) expect((await open("refused", headers)).status).toBe(403);
    expect((await open("allowed", ALLOWED[0]![1])).status).toBe(200);
    expect([await encounters("refused"), await encounters("allowed")]).toEqual([0, 1]);
  }, timeout(2) + 10_000);
});

describe("reading a lesson in the slides view, which records nothing", () => {
  test.each([...REFUSED, ...ALLOWED])("is answered for %s", async (_, headers) => {
    const res = await open("slides", headers, "?view=slides");
    const body = await res.json();
    expect([res.status, body.view, "encounterId" in body]).toEqual([200, "slides", false]);
  });
});
