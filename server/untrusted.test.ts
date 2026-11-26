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
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const root = mkdtempSync(join(tmpdir(), "school-untrusted-"));
let base = "";
let server: Started | null = null;

const HOSTILE_HTML = "<!doctype html><title>Hostile</title><script>fetch('/api/settings/bridge')</script><p>hi</p>";
const HOSTILE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><circle r="4"/></svg>';
const lesson = (id: string) => JSON.stringify({
  type: "page", id, title: "One", subtitle: "",
  children: [{ type: "prose", id: "p1", html: "<img src=x onerror=alert(1)><a href=\"javascript:alert(2)\">x</a>" }],
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
