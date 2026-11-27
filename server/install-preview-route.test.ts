// `POST /api/installs/preview` (flyingrobots/school#237, RFC 7 task 7 and §8), on a running
// School. The route is a JSON write like every other and a little stricter: it is refused from a
// Host not among School's names, without a JSON body, and from any page that is not School's own
// (`Sec-Fetch-Site` other than `same-origin`). Without a course store it is a 503 that says so.
// Every refusal is a JSON answer with a stable reason. No case here reaches a network: the URLs are
// refused before git runs. The good course and every git-backed refusal are in
// install-preview.test.ts, through the test seam the route never passes.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { startSchool, type Started } from "./testing/processes.ts";

const root = mkdtempSync(join(tmpdir(), "school-install-route-"));
const store = join(root, "store");
// A preview left behind by an earlier run, which start sweeps (RFC 7 §4).
mkdirSync(join(store, "staging", "left-behind", "course"), { recursive: true });
writeFileSync(join(store, "staging", "left-behind", "course", "course.json"), "{}");
mkdirSync(join(root, "course", "lessons"), { recursive: true });

function env(o: Record<string, string>): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = {
    ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, `state-${o.tag}`),
    SCHOOL_DATABASE_URL: `pglite:${join(root, `record-${o.tag}`)}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1", ...o,
  };
  delete e.tag;
  delete e.SCHOOL_BRIDGE_URL;
  delete e.SCHOOL_BRIDGE_TOKEN;
  if (o.SCHOOL_COURSE_STORE === undefined) delete e.SCHOOL_COURSE_STORE;
  return e;
}
const fail = (e: unknown) => { rmSync(root, { recursive: true, force: true }); throw e; };
const withStore: Started = await startSchool(env({ tag: "store", SCHOOL_COURSE_STORE: store })).catch(fail);
const noStore: Started = await startSchool(env({ tag: "none" })).catch(fail);

afterAll(async () => {
  for (const s of [withStore, noStore]) {
    s.proc.kill();
    await s.proc.exited;
  }
  rmSync(root, { recursive: true, force: true });
});

const JSONH = { "content-type": "application/json" };
const post = (s: Started, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${s.url}/api/installs/preview`, { method: "POST", headers: { ...JSONH, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** Every file and folder under `dir`, relative and sorted; empty for a folder that does not exist. */
function tree(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => relative(dir, join(dir, p))).sort();
}

describe("POST /api/installs/preview", () => {
  test("PREVIEW-ROUTE-1: School sweeps staging/ at start, so a preview left behind is gone", () => {
    expect(tree(store)).toEqual(["staging"]);
  });

  test("PREVIEW-ROUTE-2: without a course store, the answer is a 503 that names SCHOOL_COURSE_STORE", async () => {
    const res = await post(noStore, { url: "https://example.com/c.git", commit: "main" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable", error: expect.stringContaining("SCHOOL_COURSE_STORE") });
  });

  test.each([
    ["an http URL", { url: "http://example.com/c.git", commit: "main" }, "not-https"],
    ["a loopback address", { url: "https://127.0.0.1/c.git", commit: "main" }, "private-address"],
    ["credentials in the URL", { url: "https://user:token@example.com/c.git", commit: "main" }, "credentials"],
    ["a commit given as an option", { url: "https://example.com/c.git", commit: "--upload-pack=touch /tmp/x" }, "bad-commit"],
  ])("PREVIEW-ROUTE-3: %s is refused as JSON with its reason, and courses/ is never made", async (_, body, reason) => {
    const res = await post(withStore, body);
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toStartWith("application/json");
    expect(await res.json()).toEqual({ status: "refused", stage: "fetch", reason, path: null, message: expect.any(String) });
    expect(tree(store)).toEqual(["staging"]);
  });

  test.each([
    ["not JSON", "{"], ["no commit", { url: "https://example.com/c.git" }],
    ["a field besides url and commit", { url: "https://example.com/c.git", commit: "main", git: "/bin/sh" }],
  ])("PREVIEW-ROUTE-4: a body that is %s is a 400", async (_, body) => {
    const res = await post(withStore, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ status: "invalid", error: expect.any(String) });
  });

  test("PREVIEW-ROUTE-5: a Host not among School's names is refused before routing, and nothing is staged", async () => {
    const res = await post(withStore, { url: "http://example.com/c.git", commit: "main" }, { host: `evil.example:${withStore.port}` });
    expect(res.status).toBe(403);
    expect(tree(store)).toEqual(["staging"]);
  });

  test.each(["cross-site", "same-site", "none"])("PREVIEW-ROUTE-6: Sec-Fetch-Site %s is refused; only School's own pages may ask", async (site) => {
    const res = await post(withStore, { url: "http://example.com/c.git", commit: "main" }, { "sec-fetch-site": site });
    expect(res.status).toBe(403);
  });

  test("PREVIEW-ROUTE-7: Sec-Fetch-Site same-origin reaches the route", async () => {
    const res = await post(withStore, { url: "http://example.com/c.git", commit: "main" }, { "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(422);
  });

  test("PREVIEW-ROUTE-8: a body that is not declared JSON is refused", async () => {
    const res = await fetch(`${withStore.url}/api/installs/preview`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{"url":"https://example.com/c.git","commit":"main"}' });
    expect(res.status).toBe(415);
  });
});
