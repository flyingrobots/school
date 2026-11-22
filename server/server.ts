// School server: a JSON API over courses, lessons and the learner's record in SQLite, plus the
// built web app (web/dist). It renders no HTML of its own; the pages are the shadcn app in web/.
import { Database } from "bun:sqlite";
import { dirname, join, normalize, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { lastValidLoader, quizIds, type Block } from "./blocks.ts";
import { migrate, snapshot } from "./migrate.ts";
import { encounterAnswers, lessonProgress, openEncounter, submit, type Submission } from "./record.ts";
import { encounterExplanations, explanationState, gradeExplanation, saveExplanation, type ExplanationSubmission, type Grader } from "./explain.ts";
import { bridgeConfig, callBridge } from "./grade.ts";
import { bridgeClient, bridgeStatus, effectiveBridge, loadSettings, saveSettings, settingsFile, toBridge, validToken, validUrl } from "./settings.ts";
import { ConfigError, course, courseNames, mountTable, parseConfig, type Course } from "./config.ts";

let config;
let bridgeCfg;
try {
  config = parseConfig(process.env, join(import.meta.dir, ".."));
  bridgeCfg = bridgeConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`school: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
const courses = courseNames(config);
const DB_PATH = config.dbPath;
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");
// The learner must never lose progress. FULL syncs the WAL on every commit, so an answer the
// server has acknowledged survives a power cut, not just a crash. Foreign keys tie every
// answer to a real encounter and snapshot. Answering is a few writes a minute; the cost is nil.
db.exec("PRAGMA synchronous = FULL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec("PRAGMA busy_timeout = 5000;");
// Learner history is never dropped on upgrade. A snapshot is taken first, and only when
// the migration actually has work to do (RFC 1, rollout increment 1).
const migration = migrate(db, (from) => {
  const backup = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  snapshot(db, backup);
  console.log(`school: migrating progress.db from ${from}; backup at ${backup}`);
});
if (migration.copied > 0) console.log(`school: preserved ${migration.copied} answer(s)`);

// Grading goes through the bridge, a separate host process that runs the learner's agent
// commands. Without one, a grading attempt is stored as failed with that reason. The token
// lives only in this process's environment; it is never logged or stored.
// The connection is resolved at each use, from the environment and then the settings page's
// saved values, so saving settings takes effect without a restart.
const SETTINGS = settingsFile(config.state);
const deadlineMs = bridgeCfg?.deadlineMs ?? 240_000;
const bridgeNow = () => effectiveBridge(process.env, loadSettings(SETTINGS));
const currentBridge = () => bridgeClient(bridgeNow(), deadlineMs);
const grader: Grader = {
  adapter: "bridge", model: "",
  grade: async (input) => {
    const c = currentBridge();
    return c === null ? { status: "failed", error: "no bridge is connected yet; connect one in Settings" } : callBridge(c, input);
  },
};
{
  const b = bridgeNow();
  console.log(b.url === null ? "school: no bridge connected; explanations are saved but not graded until one is (Settings)"
    : `school: grading through the bridge at ${b.url} (from ${b.urlFrom})`);
}

/** Where to go back to from the settings page: a path on this site, never another origin. */

const insertView = db.prepare(`INSERT INTO views (course, lesson, at) VALUES ($course, $lesson, $at)`);


const isStr = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => Number.isInteger(v) && typeof v === "number" && v >= 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A submission names only what the learner did. Correctness and first try are the database's to decide. */
function parseExplanation(v: unknown): ExplanationSubmission | null {
  if (typeof v !== "object" || v === null) return null;
  const o: Record<string, unknown> = { ...v };
  if (typeof o.submissionId !== "string" || !UUID.test(o.submissionId)) return null;
  if (typeof o.encounterId !== "string" || !UUID.test(o.encounterId)) return null;
  if (!isStr(o.blockId, 200) || !isInt(o.ms) || typeof o.text !== "string") return null;
  const text = o.text.trim();
  if (text.length === 0 || text.length > 10_000) return null;
  return { submissionId: o.submissionId.toLowerCase(), encounterId: o.encounterId.toLowerCase(), blockId: o.blockId, text, ms: o.ms };
}

/** A saved explanation and its latest grading, as the app shows it. */
const explanationNow = (submissionId: string) => explanationState(db, submissionId)?.state ?? null;

function parseSubmission(v: unknown): Submission | null {
  if (typeof v !== "object" || v === null) return null;
  const o: Record<string, unknown> = { ...v };
  if (typeof o.submissionId !== "string" || !UUID.test(o.submissionId)) return null;
  if (typeof o.encounterId !== "string" || !UUID.test(o.encounterId)) return null;
  if (!isStr(o.blockId, 200) || !isStr(o.choiceId, 200) || !isInt(o.ms)) return null;
  return { submissionId: o.submissionId.toLowerCase(), encounterId: o.encounterId.toLowerCase(), blockId: o.blockId, choiceId: o.choiceId, ms: o.ms };
}

function parseView(v: unknown): { course: string; lesson: string } | null {
  if (typeof v !== "object" || v === null) return null;
  const o: Record<string, unknown> = { ...v };
  if (!isStr(o.course, 200) || !isStr(o.lesson, 200)) return null;
  return { course: o.course, lesson: o.lesson };
}

// Static files come only from configured mounts; lesson sources and state are never served raw.
const MOUNTS: Record<string, string> = mountTable(config);
const WEB = config.web;

/**
 * The course's reference directory, if it is really inside the course. `reference/` is
 * derived from the course root, so a symlink there could otherwise make anything the server
 * can read (the learner's state included) the serving root, and per-file containment would
 * then be checked against the wrong boundary. Source material outside a course is what
 * SCHOOL_MOUNTS is for. The course root itself may be a symlink; that is configuration.
 */
function referenceDir(c: Course): string | null {
  const root = real(c.root);
  const dir = real(c.reference);
  if (root === null || dir === null) return null;
  if (!dir.startsWith(root + sep)) {
    console.error(`school: ${c.name}: reference/ resolves outside the course (${dir}); not serving it`);
    return null;
  }
  return dir;
}

/** A course's reference documents, if it has any. Discovered, not assumed. */
function referenceDocs(c: Course): string[] {
  const dir = referenceDir(c);
  if (dir === null) return [];
  // Listed only if serving it would succeed: a regular file whose resolved path stays inside.
  return readdirSync(dir).filter((f) => {
    if (!f.endsWith(".html")) return false;
    const target = real(join(dir, f));
    return target !== null && target.startsWith(dir + sep) && statSync(target).isFile();
  }).sort();
}

// Lessons are reloaded on every request so edits show up without a restart. A reload that
// fails validation falls back to the course's last valid set, and the failure is logged.
const loadLessons = lastValidLoader();
function lessons(c: Course) {
  const { library, error } = loadLessons(c.lessons);
  if (error !== null) {
    console.error(`school: ${c.name}: ${error.message}${library !== null ? " (serving the last valid lesson set)" : ""}`);
  }
  return { library, error };
}

/** How many lessons a course serves, for the landing page. Never throws on a broken course. */
function lessonCount(c: Course): number | null {
  try {
    return lessons(c).library?.pages.length ?? null;
  } catch {
    return null; // for example, a course with no lessons directory
  }
}

const notFound = () => new Response("Not found", { status: 404 });

/** `p` with every symlink resolved, or null if it does not exist. */
function real(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Serve one regular file from under `base`. Containment is checked twice: lexically, so `..`
 * cannot climb out, and on the resolved path, so a symlink inside a course or source mount
 * cannot point at the learner's database or anywhere else on the machine. A directory is
 * never served, and a symlink that escapes is reported as missing rather than forbidden.
 */
async function serveFrom(base: string, rest: string[]): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest.join("/"));
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const full = normalize(join(base, decoded));
  if (!full.startsWith(base + sep)) return notFound();
  const realBase = real(base);
  const realFull = real(full);
  if (realBase === null || realFull === null || !realFull.startsWith(realBase + sep)) return notFound();
  if (!statSync(realFull).isFile()) return notFound();
  return new Response(Bun.file(realFull));
}

/**
 * One guard for every state-changing endpoint, present and future. The server has no login,
 * so any page open in the learner's browser could POST to it. Requiring a declared JSON body
 * makes such a request non-simple: the browser must send a CORS preflight, which this server
 * never answers. A browser that says the request is cross-site is refused outright.
 */
function guardApi(req: Request): Response | null {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return new Response("Expected application/json", { status: 415 });
  if (req.headers.get("sec-fetch-site") === "cross-site") return new Response("Cross-site request refused", { status: 403 });
  return null;
}

async function serveMount(pathname: string): Promise<Response> {
  const [, top = "", ...rest] = pathname.split("/");
  const base = MOUNTS[top];
  if (base === undefined) return new Response("Not found", { status: 404 });
  return serveFrom(base, rest);
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

type View = "web" | "slides";
const isView = (v: string | null): v is View => v === "web" || v === "slides";
const summary = (p: Block | undefined) => (p === undefined || p.type !== "page" ? null : { id: p.id, title: p.title, subtitle: p.subtitle });

/** A course: its lessons, each with how many of its quizzes have been answered correctly, and its reference documents. */
function courseJson(c: Course): Response {
  const { library, error } = lessons(c);
  if (library === null) return json({ error: error?.message ?? "the lessons could not be loaded" }, 500);
  const done = lessonProgress(db, c.name);
  return json({
    name: c.name,
    reference: referenceDocs(c),
    lessons: library.pages.map((p) => {
      const ids = quizIds(p);
      return { ...summary(p), quizzes: ids.size, answeredCorrectly: [...ids].filter((id) => done.get(p.id)?.has(id)).length };
    }),
  });
}

/**
 * One lesson. In the web view this opens or resumes the learner's encounter and includes what is
 * already answered in it, which is what opening the page used to do. The slides view records nothing.
 */
function lessonJson(c: Course, id: string, viewParam: string | null): Response {
  const view = isView(viewParam) ? viewParam : "web";
  const { library, error } = lessons(c);
  if (library === null) return json({ error: error?.message ?? "the lessons could not be loaded" }, 500);
  const { pages } = library;
  const i = pages.findIndex((p) => p.id === id);
  const page = pages[i];
  if (page === undefined) return json({ error: "no such lesson" }, 404);
  const base = { course: c.name, view, lesson: page, prev: summary(pages[i - 1]), next: summary(pages[i + 1]), hasReference: referenceDocs(c).length > 0 };
  if (view !== "web") return json(base);
  const e = openEncounter(db, { course: c.name, lesson: page.id, page, now: new Date().toISOString() });
  return json({ ...base, encounterId: e.id, answers: encounterAnswers(db, e.id), explanations: encounterExplanations(db, e.id) },
    200, { "cache-control": "no-store" });
}

/** The built web app: a file from web/dist, or its index.html for any other page path. */
async function serveApp(pathname: string): Promise<Response> {
  // A malformed path is the request's fault whether or not the app is built, so it is checked first.
  if (pathname !== "/" && !pathname.startsWith("/api/")) {
    const asset = await serveFrom(WEB, pathname.split("/").slice(1));
    if (asset.status === 200 || asset.status === 400) return asset;
  }
  const index = Bun.file(join(WEB, "index.html"));
  if (!(await index.exists())) return json({ error: "the web app is not built; run `npm run build` in web/" }, 503);
  return new Response(index, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

Bun.serve({
  hostname: config.host,
  port: config.port,
  // Bun closes a request idle for 10 s by default; a grading call can take a minute or two.
  // 255 s is Bun's maximum, so the grader's own timeout is capped below it (grade.ts).
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const at = new Date().toISOString();
    if (req.method === "POST" && pathname.startsWith("/api/")) {
      const refused = guardApi(req);
      if (refused !== null) return refused;
    }
    if (req.method === "POST" && pathname === "/api/answer") {
      const s = parseSubmission(await readJson(req));
      if (s === null) return json({ status: "invalid" }, 400);
      // Acknowledged only after the commit, so a 200 means the answer is on disk.
      const r = submit(db, s, at);
      if (r.status === "rejected") return json(r, 400);
      if (r.status === "conflict") return json(r, 409);
      return json({ ...r, submissionId: s.submissionId });
    }
    if (req.method === "POST" && pathname === "/api/explanation") {
      const s = parseExplanation(await readJson(req));
      if (s === null) return json({ status: "invalid" }, 400);
      // Saved and committed before any grading is attempted (RFC 1 proposal 4, lifecycle step 1).
      const r = saveExplanation(db, s, at);
      if (r.status === "rejected") return json(r, 400);
      if (r.status === "conflict") return json(r, 409);
      return json({ ...r, submissionId: s.submissionId, explanation: explanationNow(s.submissionId) });
    }
    if (req.method === "POST" && pathname === "/api/grade") {
      const body = await readJson(req);
      const id = typeof body === "object" && body !== null ? (body as Record<string, unknown>).submissionId : undefined;
      if (typeof id !== "string" || !UUID.test(id)) return json({ status: "invalid" }, 400);
      const g = await gradeExplanation(db, id.toLowerCase(), grader, new Date().toISOString());
      if (g === null) return json({ status: "unknown submission" }, 404);
      return json({ status: g.status, explanation: explanationNow(id.toLowerCase()) });
    }
    if (req.method === "POST" && pathname === "/api/settings/bridge") {
      const body = (await readJson(req)) as Record<string, unknown> | null;
      if (body === null || typeof body !== "object") return json({ status: "invalid" }, 400);
      const now = bridgeNow();
      const saved = loadSettings(SETTINGS);
      const next = { ...saved.bridge };
      if (body.url !== undefined) {
        if (now.urlFrom === "environment") return json({ status: "locked", error: "SCHOOL_BRIDGE_URL is set in the environment, which overrides this setting" }, 409);
        if (typeof body.url !== "string" || (body.url !== "" && !validUrl(body.url))) return json({ status: "invalid", error: "the URL must start with http:// or https://" }, 400);
        next.url = body.url.replace(/\/+$/, "");
      }
      let generated: string | undefined;
      if (body.generate === true || body.token !== undefined) {
        if (now.tokenFrom === "environment") return json({ status: "locked", error: "SCHOOL_BRIDGE_TOKEN is set in the environment, which overrides this setting" }, 409);
        if (body.generate === true) {
          generated = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
          next.token = generated;
        } else if (typeof body.token === "string" && validToken(body.token)) {
          next.token = body.token;
        } else {
          return json({ status: "invalid", error: "the token must be at least 16 characters, with no spaces" }, 400);
        }
      }
      saveSettings(SETTINGS, { ...saved, bridge: next });
      // A generated token is returned once, so the learner can start the bridge with it. Never again.
      return json({ status: "saved", tokenSet: Boolean(next.token), ...(generated === undefined ? {} : { generated }) });
    }
    if (req.method === "POST" && pathname === "/api/settings/agents") {
      const r = await toBridge(currentBridge(), "PUT", "/config", await readJson(req));
      return json(r.body, r.status);
    }
    if (req.method === "POST" && pathname === "/api/settings/agents/test") {
      const r = await toBridge(currentBridge(), "POST", "/test", await readJson(req));
      return json(r.body, r.status);
    }
    if (req.method === "POST" && pathname === "/api/view") {
      const v = parseView(await readJson(req));
      if (v === null) return new Response("Bad view", { status: 400 });
      insertView.run({ course: v.course, lesson: v.lesson, at });
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && pathname.startsWith("/api/")) return notFound();
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    if (pathname === "/api/settings/status") return json(await bridgeStatus(currentBridge()));
    if (pathname === "/api/settings/bridge") {
      // Whether a token is set, never the token itself.
      const b = bridgeNow();
      return json({ url: b.url, urlFrom: b.urlFrom, tokenSet: b.token !== null, tokenFrom: b.tokenFrom }, 200, { "cache-control": "no-store" });
    }
    if (pathname === "/api/settings/agents") {
      const r = await toBridge(currentBridge(), "GET", "/config");
      return json(r.body, r.status);
    }
    if (pathname === "/api/courses") {
      return json(courses.map((name) => {
        const c = course(config, name)!;
        return { name, lessons: lessonCount(c), reference: referenceDocs(c).length };
      }));
    }
    const api = /^\/api\/courses\/([a-z0-9][a-z0-9-]*)(?:\/lessons\/([\w-]+))?$/.exec(pathname);
    if (api !== null) {
      const c = course(config, api[1]!);
      if (c === null) return json({ error: "no such course" }, 404);
      return api[2] === undefined ? courseJson(c) : lessonJson(c, api[2], url.searchParams.get("view"));
    }
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    // A course's reference documents are course-authored files, served as they are.
    const ref = /^\/courses\/([a-z0-9][a-z0-9-]*)\/reference\/(.+)$/.exec(pathname);
    if (ref !== null) {
      const c = course(config, ref[1]!);
      const dir = c === null ? null : referenceDir(c);
      return dir === null ? notFound() : serveFrom(dir, [ref[2]!]);
    }

    const mounted = await serveMount(pathname);
    if (mounted.status !== 404) return mounted;
    return serveApp(pathname);
  },
});
console.log(`school: http://${config.host}:${config.port}  courses=${courses.length > 0 ? courses.join(", ") : "(none)"}  state=${config.state}`);
if (Object.keys(config.mounts).length > 0) console.log(`school: mounts ${Object.keys(config.mounts).map((n) => "/" + n).join(" ")}`);
