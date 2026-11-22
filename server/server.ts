// School progress server: renders block lessons and records quiz answers to SQLite.
import { Database } from "bun:sqlite";
import { dirname, join, normalize, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { BlockError, loadLibrary } from "./blocks.ts";
import { isView, renderCourse, renderLanding, renderPage, renderReference } from "./render.ts";
import { migrate, snapshot } from "./migrate.ts";
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
// Learner history is never dropped on upgrade. A snapshot is taken first, and only when
// the migration actually has work to do (RFC 1, rollout increment 1).
const migration = migrate(db, (from) => {
  const backup = `${DB_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  snapshot(db, backup);
  console.log(`school: migrating progress.db from ${from}; backup at ${backup}`);
});
if (migration.copied > 0) console.log(`school: preserved ${migration.copied} answer(s)`);

const insertAnswer = db.prepare(`INSERT INTO answers (origin, course, block_id, lesson, choice, correct, first_try, ms, at)
  VALUES ('block', $course, $block_id, $lesson, $choice, $correct, $first_try, $ms, $at)`);
const insertView = db.prepare(`INSERT INTO views (course, lesson, at) VALUES ($course, $lesson, $at)`);

type Answer = { course: string; blockId: string; lesson: string; choice: string; correct: boolean; firstTry: boolean; ms: number };

const isStr = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => Number.isInteger(v) && typeof v === "number" && v >= 0;

function parseAnswer(v: unknown): Answer | null {
  if (typeof v !== "object" || v === null) return null;
  const o: Record<string, unknown> = { ...v };
  if (!isStr(o.course, 200) || !isStr(o.blockId, 200) || !isStr(o.lesson, 200) || !isStr(o.choice)) return null;
  if (typeof o.correct !== "boolean" || typeof o.firstTry !== "boolean" || !isInt(o.ms)) return null;
  return { course: o.course, blockId: o.blockId, lesson: o.lesson, choice: o.choice, correct: o.correct, firstTry: o.firstTry, ms: o.ms };
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

/** How many lessons a course serves, for the landing page. Never throws on a broken course. */
function lessonCount(c: Course): number | null {
  try {
    return loadLibrary(c.lessons).pages.length;
  } catch {
    return null;
  }
}

async function serveFrom(base: string, rest: string[]): Promise<Response> {
  const full = normalize(join(base, decodeURIComponent(rest.join("/"))));
  if (full !== base && !full.startsWith(base + sep)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(full);
  return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
}

async function serveMount(pathname: string): Promise<Response> {
  const [, top = "", ...rest] = pathname.split("/");
  const base = MOUNTS[top];
  if (base === undefined) return new Response("Not found", { status: 404 });
  return serveFrom(base, rest);
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// Lessons are reloaded on every request so edits show up without a restart.
function lessonResponse(c: Course, id: string | undefined, viewParam: string | null): Response {
  const view = isView(viewParam) ? viewParam : "web";
  try {
    const refs = referenceDocs(c);
    const { pages } = loadLibrary(c.lessons);
    if (id === undefined) return html(renderCourse(c.name, pages, refs));
    const i = pages.findIndex((p) => p.id === id);
    const page = pages[i];
    if (page === undefined) return new Response("Not found", { status: 404 });
    const nav: { prev?: (typeof pages)[number]; next?: (typeof pages)[number] } = {};
    const prev = pages[i - 1];
    const next = pages[i + 1];
    if (prev !== undefined) nav.prev = prev;
    if (next !== undefined) nav.next = next;
    return html(renderPage(c.name, page, view, nav, refs.length > 0));
  } catch (e) {
    if (e instanceof BlockError) return html(`<pre>Lesson error: ${e.message.replace(/</g, "&lt;")}</pre>`, 500);
    throw e;
  }
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
    if (req.method === "POST" && pathname === "/api/answer") {
      const a = parseAnswer(await readJson(req));
      if (a === null) return new Response("Bad answer", { status: 400 });
      insertAnswer.run({ course: a.course, block_id: a.blockId, lesson: a.lesson, choice: a.choice,
        correct: a.correct ? 1 : 0, first_try: a.firstTry ? 1 : 0, ms: a.ms, at });
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && pathname === "/api/view") {
      const v = parseView(await readJson(req));
      if (v === null) return new Response("Bad view", { status: 400 });
      insertView.run({ course: v.course, lesson: v.lesson, at });
      return new Response(null, { status: 204 });
    }
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
