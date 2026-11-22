// School progress server: renders block lessons and records quiz answers to SQLite.
import { Database } from "bun:sqlite";
import { join, normalize, sep } from "node:path";
import { BlockError, loadLibrary } from "./blocks.ts";
import { isView, renderIndex, renderPage } from "./render.ts";

const ROOT = process.env.SCHOOL_ROOT ?? join(import.meta.dir, "..");
const AION = process.env.AION_ROOT ?? join(process.env.HOME ?? "/", "git", "aion");
const DB_PATH = process.env.DB_PATH ?? join(ROOT, "progress", "progress.db");
const LESSONS = join(ROOT, "lessons");
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4747);

const db = new Database(DB_PATH, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");
// Schema version 2: answers are keyed by block id rather than question position.
const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
if (version < 2) {
  db.exec(`DROP TABLE IF EXISTS answers;
CREATE TABLE answers (
  id INTEGER PRIMARY KEY, block_id TEXT NOT NULL, lesson TEXT NOT NULL, choice TEXT NOT NULL,
  correct INTEGER NOT NULL, first_try INTEGER NOT NULL, ms INTEGER NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS answers_block ON answers (block_id, at);
CREATE TABLE IF NOT EXISTS views (id INTEGER PRIMARY KEY, lesson TEXT NOT NULL, at TEXT NOT NULL);
PRAGMA user_version = 2;`);
}

const insertAnswer = db.prepare(`INSERT INTO answers (block_id, lesson, choice, correct, first_try, ms, at)
  VALUES ($block_id, $lesson, $choice, $correct, $first_try, $ms, $at)`);
const insertView = db.prepare(`INSERT INTO views (lesson, at) VALUES ($lesson, $at)`);

type Answer = { blockId: string; lesson: string; choice: string; correct: boolean; firstTry: boolean; ms: number };

const isStr = (v: unknown, max = 500): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isInt = (v: unknown): v is number => Number.isInteger(v) && typeof v === "number" && v >= 0;

function parseAnswer(v: unknown): Answer | null {
  if (typeof v !== "object" || v === null) return null;
  const o: Record<string, unknown> = { ...v };
  if (!isStr(o.blockId, 200) || !isStr(o.lesson, 200) || !isStr(o.choice)) return null;
  if (typeof o.correct !== "boolean" || typeof o.firstTry !== "boolean" || !isInt(o.ms)) return null;
  return { blockId: o.blockId, lesson: o.lesson, choice: o.choice, correct: o.correct, firstTry: o.firstTry, ms: o.ms };
}

function parseLesson(v: unknown): string | null {
  if (typeof v !== "object" || v === null) return null;
  const o: Record<string, unknown> = { ...v };
  return isStr(o.lesson, 200) ? o.lesson : null;
}

// Static files come only from these folders; lessons/, progress/ and server/ are not served raw.
const MOUNTS: Record<string, string> = { reference: join(ROOT, "reference"), assets: join(ROOT, "assets"), aion: AION };

async function serveFile(pathname: string): Promise<Response> {
  const [, top = "", ...rest] = pathname.split("/");
  const base = MOUNTS[top];
  if (base === undefined) return new Response("Not found", { status: 404 });
  const full = normalize(join(base, decodeURIComponent(rest.join("/"))));
  if (full !== base && !full.startsWith(base + sep)) return new Response("Forbidden", { status: 403 });
  const file = Bun.file(full);
  return (await file.exists()) ? new Response(file) : new Response("Not found", { status: 404 });
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

// Lessons are reloaded on every request so edits show up without a restart.
function lessonResponse(id: string | undefined, viewParam: string | null): Response {
  const view = isView(viewParam) ? viewParam : "web";
  try {
    const { pages } = loadLibrary(LESSONS);
    if (id === undefined) return html(renderIndex(pages));
    const i = pages.findIndex((p) => p.id === id);
    const page = pages[i];
    if (page === undefined) return new Response("Not found", { status: 404 });
    const nav: { prev?: (typeof pages)[number]; next?: (typeof pages)[number] } = {};
    const prev = pages[i - 1];
    const next = pages[i + 1];
    if (prev !== undefined) nav.prev = prev;
    if (next !== undefined) nav.next = next;
    return html(renderPage(page, view, nav));
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
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;
    const at = new Date().toISOString();
    if (req.method === "POST" && pathname === "/api/answer") {
      const a = parseAnswer(await readJson(req));
      if (a === null) return new Response("Bad answer", { status: 400 });
      insertAnswer.run({ block_id: a.blockId, lesson: a.lesson, choice: a.choice,
        correct: a.correct ? 1 : 0, first_try: a.firstTry ? 1 : 0, ms: a.ms, at });
      return new Response(null, { status: 204 });
    }
    if (req.method === "POST" && pathname === "/api/view") {
      const lesson = parseLesson(await readJson(req));
      if (lesson === null) return new Response("Bad view", { status: 400 });
      insertView.run({ lesson, at });
      return new Response(null, { status: 204 });
    }
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (pathname === "/") return lessonResponse(undefined, null);
    const lesson = /^\/lessons\/([\w-]+)$/.exec(pathname);
    if (lesson !== null) return lessonResponse(lesson[1], url.searchParams.get("view"));
    return serveFile(pathname);
  },
});

console.log(`school: http://${HOST}:${PORT}  db=${DB_PATH}`);
