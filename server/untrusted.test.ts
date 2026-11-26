// Untrusted courses (flyingrobots/school#210, RFC 4 step 2), over HTTP against the real server.
// A course named in SCHOOL_UNTRUSTED_COURSES must not run script on School's origin: every response
// that carries its bytes is sandboxed and never sniffed, and a course named in SCHOOL_COURSES is
// served exactly as before.
// Oracle: the issue's section 2b. `Content-Security-Policy: sandbox` with no allow-* token gives
// the document an opaque origin and no script (CSP Level 3, "sandbox"; HTML, "sandboxing flag
// set"); `X-Content-Type-Options: nosniff` stops a browser reading the bytes as another type
// (Fetch, "should response to request be blocked due to nosniff").
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotStarted, startSchool, timeout, type Started } from "./testing/processes.ts";

const root = mkdtempSync(join(tmpdir(), "school-untrusted-"));
let base = "";
let server: Started | null = null;

const HOSTILE_HTML = "<!doctype html><title>Hostile</title><script>fetch('/api/settings/bridge')</script><p>hi</p>";
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><circle r="4"/></svg>';
const FIGURE = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="var(--primary)"/></svg>';
const lesson = (id: string) => JSON.stringify({
  type: "page", id, title: "One", subtitle: "",
  hook: { question: "Why?", teaser: "Because.", figure: FIGURE },
  children: [
    { type: "prose", id: "p1", html: "<img src=x onerror=alert(1)><a href=\"javascript:alert(2)\">x</a>" },
    { type: "quiz", id: "q1", q: "Which?", why: "Because.", choices: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }] },
  ],
});

/** A course folder holding one lesson and the same reference files as every other. */
function courseDir(name: string, lessonId: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "lessons"), { recursive: true });
  mkdirSync(join(dir, "reference", "nested"), { recursive: true });
  writeFileSync(join(dir, "lessons", "0001.json"), lesson(lessonId));
  writeFileSync(join(dir, "reference", "page.html"), HOSTILE_HTML);
  writeFileSync(join(dir, "reference", "figure.svg"), HOSTILE_SVG);
  writeFileSync(join(dir, "reference", "nested", "deep.html"), HOSTILE_HTML);
  writeFileSync(join(dir, "reference", "app.js"), "alert(1)");
  writeFileSync(join(dir, "reference", "style.css"), "body { color: red }");
  writeFileSync(join(dir, "reference", "notes.txt"), "<script>alert(1)</script>");
  symlinkSync(join(root, "outside", "secret.html"), join(dir, "reference", "leak.html"));
  return dir;
}

beforeAll(async () => {
  mkdirSync(join(root, "outside"), { recursive: true });
  writeFileSync(join(root, "outside", "secret.html"), "TOP SECRET");
  const trusted = courseDir("own", "o1");
  const untrusted = courseDir("guest", "g1");
  server = await startSchool({
    ...process.env,
    SCHOOL_COURSES: `own=${trusted}`,
    SCHOOL_UNTRUSTED_COURSES: `guest=${untrusted}`,
    // A mount beside the courses, not over one: a mount is served with no sandbox.
    SCHOOL_MOUNTS: `lib=${join(root, "outside")}`,
    SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1",
  });
  base = server.url;
}, timeout(1));
afterAll(async () => {
  server?.proc.kill();
  await server?.proc.exited;
  rmSync(root, { recursive: true, force: true });
});

/** The two headers this issue is about, as a response gives them (null when absent). */
async function guard(path: string): Promise<{ status: number; csp: string | null; nosniff: string | null }> {
  const res = await fetch(base + path);
  await res.arrayBuffer();
  return { status: res.status, csp: res.headers.get("content-security-policy"), nosniff: res.headers.get("x-content-type-options") };
}

const SANDBOXED = { status: 200, csp: "sandbox", nosniff: "nosniff" };
const UNCHANGED = { status: 200, csp: null, nosniff: null };

// Every route that serves an untrusted course's bytes (the issue's known failure mode: a header
// missing on one route). The reference files cover each type a browser could run or render.
const COURSE_ROUTES = [
  "/courses/{c}/reference/page.html",
  "/courses/{c}/reference/nested/deep.html",
  "/courses/{c}/reference/nested%2Fdeep.html",
  "/courses/{c}/reference/figure.svg",
  "/courses/{c}/reference/app.js",
  "/courses/{c}/reference/style.css",
  "/courses/{c}/reference/notes.txt",
  "/api/courses/{c}",
  "/api/courses/{c}/lessons/{l}?view=web",
  "/api/courses/{c}/lessons/{l}?view=slides",
];

describe("an untrusted course", () => {
  test.each(COURSE_ROUTES)("%s is sandboxed and never sniffed", async (route) => {
    expect(await guard(route.replace("{c}", "guest").replace("{l}", "g1"))).toEqual(SANDBOXED);
  });

  test("its reference page carries exactly the sandbox policy, with no allow-scripts or allow-same-origin", async () => {
    const res = await fetch(base + "/courses/guest/reference/page.html");
    expect(await res.text()).toBe(HOSTILE_HTML); // the document itself is served as written
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("content-type")).toStartWith("text/html");
  });

  test("an SVG with script is served as SVG under the same sandbox, never as HTML", async () => {
    const res = await fetch(base + "/courses/guest/reference/figure.svg");
    expect([res.headers.get("content-type")?.split(";")[0], res.headers.get("content-security-policy"), res.headers.get("x-content-type-options")])
      .toEqual(["image/svg+xml", "sandbox", "nosniff"]);
  });

  test("a symlink out of its reference folder is still refused", async () => {
    const res = await fetch(base + "/courses/guest/reference/leak.html");
    expect([res.status, (await res.text()).includes("TOP SECRET")]).toEqual([404, false]);
  });

  test.each(["..%2F..%2Foutside%2Fsecret.html", "%2E%2E%2F%2E%2E%2Foutside%2Fsecret.html", "nested/..%2F..%2F..%2Foutside%2Fsecret.html"])(
    "a path that climbs out of its reference folder (%s) is still refused", async (trick) => {
      const res = await fetch(`${base}/courses/guest/reference/${trick}`);
      expect([res.status, (await res.text()).includes("TOP SECRET")]).toEqual([404, false]);
    });
});

describe("a trusted course", () => {
  test.each(COURSE_ROUTES)("%s is served as before, with neither header", async (route) => {
    expect(await guard(route.replace("{c}", "own").replace("{l}", "o1"))).toEqual(UNCHANGED);
  });
});

describe("the course API reports trust", () => {
  test("GET /api/courses gives each course's trusted", async () => {
    const list = (await (await fetch(base + "/api/courses")).json()) as { name: string; trusted: unknown }[];
    expect(list.map((c) => [c.name, c.trusted])).toEqual([["guest", false], ["own", true]]);
  });

  test.each([["guest", false], ["own", true]] as const)("GET /api/courses/%s gives trusted: %p", async (name, trusted) => {
    expect(((await (await fetch(`${base}/api/courses/${name}`)).json()) as { trusted: unknown }).trusted).toBe(trusted);
  });
});

// A mount is served with no sandbox, so no mount route may reach an untrusted course's files.
describe("a mount", () => {
  test.each(["..%2Fguest%2Freference%2Fpage.html", "%2E%2E%2Fguest%2Freference%2Fpage.html"])(
    "beside an untrusted course cannot climb into it (/lib/%s)", async (trick) => {
      const res = await fetch(`${base}/lib/${trick}`);
      // Refused by the mount, the path falls through to the web app, unbuilt here (503).
      expect({ ok: res.ok, hostile: (await res.text()).includes("Hostile") }).toEqual({ ok: false, hostile: false });
    });

  test("over an untrusted course stops the server before it serves /lib/guest/reference/page.html", async () => {
    // Either it refuses with exit 2, or the outcome shows what it served unsandboxed.
    const outcome = await startSchool({
      ...process.env,
      SCHOOL_UNTRUSTED_COURSES: `guest=${join(root, "guest")}`,
      SCHOOL_MOUNTS: `lib=${root}`,
      SCHOOL_STATE: join(root, "state-mount"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record-mount")}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1",
    }).then(async (s) => {
      const res = await fetch(s.url + "/lib/guest/reference/page.html");
      const served = { status: res.status, csp: res.headers.get("content-security-policy"), body: (await res.text()).slice(0, 30) };
      s.proc.kill();
      await s.proc.exited;
      return { served };
    }, (e: unknown) => ({ refused: e instanceof NotStarted ? e.exitCode : String(e) }));
    expect(outcome).toEqual({ refused: 2 });
  }, timeout(1));
});

describe("the showcase reports trust", () => {
  test("GET /api/showcase gives each lesson's course trusted, so the page can draw an untrusted figure as an image", async () => {
    const ahead = (await (await fetch(base + "/api/showcase")).json()) as { course: string; trusted: unknown; figure: unknown }[];
    expect(ahead.map((a) => [a.course, a.trusted, a.figure])).toEqual([["guest", false, FIGURE], ["own", true, FIGURE]]);
  });
});
