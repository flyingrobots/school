// School progress server: renders block lessons and records quiz answers to SQLite.
import { Database } from "bun:sqlite";
import { dirname, join, normalize, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { lastValidLoader } from "./blocks.ts";
import { esc, isView, renderCourse, renderLanding, renderPage, renderReference } from "./render.ts";
import { migrate, snapshot } from "./migrate.ts";
import { encounterAnswers, lessonProgress, openEncounter, submit, type Submission } from "./record.ts";
import { ConfigError, course, courseNames, mountTable, parseConfig, type Course } from "./config.ts";

let config;
try {
  config = parseConfig(process.env, join(import.meta.dir, ".."));
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

const insertView = db.prepare(`INSERT INTO views (course, lesson, at) VALUES ($course, $lesson, $at)`);


const isStr = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => Number.isInteger(v) && typeof v === "number" && v >= 0;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A submission names only what the learner did. Correctness and first try are the database's to decide. */
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

/** A course's reference documents, if it has any. Discovered, not assumed. */
function referenceDocs(c: Course): string[] {
  if (!existsSync(c.reference)) return [];
  return readdirSync(c.reference).filter((f) => f.endsWith(".html")).sort();
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

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const json = (body: unknown, status = 200) => Response.json(body, { status });

function lessonResponse(c: Course, id: string | undefined, viewParam: string | null): Response {
  const view = isView(viewParam) ? viewParam : "web";
  const { library, error } = lessons(c);
  if (library === null) return html(`<pre>Lesson error: ${esc(error?.message ?? "unknown")}</pre>`, 500);
  const refs = referenceDocs(c);
  const { pages } = library;
  if (id === undefined) return html(renderCourse(c.name, pages, refs, lessonProgress(db, c.name)));
  const i = pages.findIndex((p) => p.id === id);
  const page = pages[i];
  if (page === undefined) return new Response("Not found", { status: 404 });
  const nav: { prev?: (typeof pages)[number]; next?: (typeof pages)[number] } = {};
  const prev = pages[i - 1];
  const next = pages[i + 1];
  if (prev !== undefined) nav.prev = prev;
  if (next !== undefined) nav.next = next;
  if (view !== "web") return html(renderPage(c.name, page, view, nav, refs.length > 0));
  // Practice: resume or open the encounter, and show what is already answered in it.
  const e = openEncounter(db, { course: c.name, lesson: page.id, page, now: new Date().toISOString() });
  return html(renderPage(c.name, page, view, nav, refs.length > 0, { encounterId: e.id, answers: encounterAnswers(db, e.id) }),
    200, { "cache-control": "no-store" });
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
    if (req.method === "POST" && pathname === "/api/view") {
      const v = parseView(await readJson(req));
      if (v === null) return new Response("Bad view", { status: 400 });
      insertView.run({ course: v.course, lesson: v.lesson, at });
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && pathname.startsWith("/api/")) return notFound();
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    // The landing page is School's index of installed courses, not one course's lessons.
    if (pathname === "/" || pathname === "/courses" || pathname === "/courses/") {
      return html(renderLanding(courses.map((name) => {
        const c = course(config, name)!;
        return { name, lessons: lessonCount(c), reference: referenceDocs(c).length };
      })));
    }

    const inCourse = /^\/courses\/([a-z0-9][a-z0-9-]*)(\/.*)?$/.exec(pathname);
    if (inCourse !== null) {
      const c = course(config, inCourse[1]!);
      if (c === null) return new Response("No such course", { status: 404 });
      const rest = inCourse[2] ?? "/";

      if (rest === "/" || rest === "") return lessonResponse(c, undefined, null);
      if (rest === "/reference" || rest === "/reference/") return html(renderReference(c.name, referenceDocs(c)));

      const ref = /^\/reference\/(.+)$/.exec(rest);
      if (ref !== null) return serveFrom(c.reference, [ref[1]!]);

      const lesson = /^\/lessons\/([\w-]+)$/.exec(rest);
      if (lesson !== null) return lessonResponse(c, lesson[1], url.searchParams.get("view"));
      return new Response("Not found", { status: 404 });
    }

    return serveMount(pathname);
  },
});

console.log(`school: http://${config.host}:${config.port}  courses=${courses.length > 0 ? courses.join(", ") : "(none)"}  state=${config.state}`);
if (Object.keys(config.mounts).length > 0) console.log(`school: mounts ${Object.keys(config.mounts).map((n) => "/" + n).join(" ")}`);
