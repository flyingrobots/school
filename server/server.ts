// School server: a JSON API over courses, lessons and the learner's record in Postgres, plus the
// built web app (web/dist). It renders no HTML of its own; the pages are the shadcn app in web/.
import { join, normalize, sep } from "node:path";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { lastValidLoader, quizIds, quizzes, type Block } from "./blocks.ts";
import { PROMPT_VERSION, RUBRIC_VERSION, bridgeConfig, callBridge } from "./grade.ts";
import { openDatabase, redact, Refused } from "./adapters/database.ts";
import { InUse } from "./adapters/lock.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import { legacyRefusal } from "./legacy.ts";
import { AID_CAPTURE_VERSIONS, AidQuery, AidRequest, Exposure, ExplanationSubmission, GradeRequest, Submission, ViewEvent, type AidTracking } from "./core/model.ts";
import type { Grader } from "./core/ports.ts";
import { createSchool, resumeFrom, type CourseOutline } from "./core/school.ts";
import { bridgeClient, bridgeStatus, effectiveBridge, loadSettings, saveSettings, settingsFile, toBridge, unpaired, UNPAIRED, validToken, validUrl } from "./settings.ts";
import { ConfigError, course, courseNames, mountTable, parseConfig, type Course } from "./config.ts";
import { CourseFileError, readCourseFile, type CourseFile } from "./course-file.ts";
import { allowedHosts, hostAllowed } from "./hosts.ts";
import { withSecretFiles } from "./secrets.ts";
import { agentOrder, agentTest } from "./agents.ts";
import { authoringStatus } from "./skill.ts";
import { feedbackSpeech, lessonSpeech, SEGMENT, SpeakRequest, toSpeech, UTTERANCE } from "./speak.ts";

let config;
let bridgeCfg;
let hosts: string[];
// The environment, with each secret given as a file (`*_FILE`, as compose mounts them under
// /run/secrets/) read in; the file wins over a plain variable (server/secrets.ts). Only this
// process holds the values: nothing writes them back to the environment or passes them on.
let env: Record<string, string | undefined> = {};
try {
  env = withSecretFiles(process.env);
  config = parseConfig(env, join(import.meta.dir, ".."));
  bridgeCfg = bridgeConfig(env);
  hosts = allowedHosts(config, env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`school: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
const courses = courseNames(config);
/** Every configured course, in the order the API lists them. */
const served: Course[] = courses.map((name) => course(config, name)!);
/** Each course's course.json (flyingrobots/school#143, #209), read once here; a course with none declares nothing. */
const declarations = new Map<string, CourseFile>();
for (const c of served) {
  try {
    declarations.set(c.name, readCourseFile(c.root));
  } catch (e) {
    if (!(e instanceof CourseFileError)) throw e;
    console.error(`school: course ${JSON.stringify(c.name)}: ${e.message}`);
    process.exit(2);
  }
}
/** A course's title: its course.json's, else its name. */
const titleOf = (c: Course): string => declarations.get(c.name)?.title ?? c.name;
/** What a course declares about itself beyond its title, each null when it does not (flyingrobots/school#209). */
const manifestOf = (c: Course) => {
  const d = declarations.get(c.name);
  return { summary: d?.summary ?? null, author: d?.author ?? null, license: d?.license ?? null, format: d?.format ?? null };
};

// RFC 3 §3.3: nothing migrates from SQLite. A progress.db holding learner work stops startup
// here, before Postgres is opened, rather than leaving that history behind an empty record.
{
  const refusal = legacyRefusal(config.dbPath);
  if (refusal !== null) {
    console.error(`school: ${refusal}`);
    process.exit(2);
  }
}

// The record (server/adapters/database.ts), served as school_app. On Postgres the server logs in
// as school_app and migrates nothing (the migrate job did, server/migrate.ts); PGlite migrates here.
let database;
try {
  database = await openDatabase(config.database);
} catch (e) {
  // A record held by another server, or a login that fails the login check (loginRefusals in
  // server/adapters/database.ts), is a refusal to start, like a bad configuration: exit 2.
  if (e instanceof InUse || e instanceof Refused) {
    console.error(`school: ${e.message}`);
    process.exit(2);
  }
  console.error(`school: cannot open the record (${config.database.driver === "pglite" ? `PGlite at ${config.database.dir}` : `Postgres at ${redact(config.database.url)}`}): ${(e as Error).message}`);
  process.exit(1);
}
if (config.database.driver === "pglite") {
  console.warn(`school: warning: the record is PGlite at ${config.database.dir}, which does not fsync and so is not crash-durable: ` +
    "a power cut or an operating-system crash can lose acknowledged answers. Use it for development and tests; use a postgres:// SCHOOL_DATABASE_URL for a learner's record.");
}
console.log(`school: record in ${database.where}${database.applied.length > 0 ? `; applied migration(s) ${database.applied.join(", ")}` : ""}`);

// Grading goes through the bridge, a separate host process that runs the learner's agent
// commands. Without one, a grading attempt is stored as failed with that reason. The token
// lives only in this process's environment; it is never logged or stored.
// The connection is resolved at each use, from the environment and then the settings page's
// saved values, so saving settings takes effect without a restart.
const SETTINGS = settingsFile(config.state);
const deadlineMs = bridgeCfg?.deadlineMs ?? 240_000;
const bridgeNow = () => effectiveBridge(env, loadSettings(SETTINGS));
const currentBridge = () => bridgeClient(bridgeNow(), deadlineMs);
const grader: Grader = {
  adapter: "bridge", model: "", rubricVersion: RUBRIC_VERSION, promptVersion: PROMPT_VERSION,
  grade: async (input) => {
    const c = currentBridge();
    if (c !== null) return callBridge(c, input);
    return { status: "failed", error: unpaired(bridgeNow()) ? UNPAIRED : "no bridge is connected yet; connect one in Settings" };
  },
};
{
  const b = bridgeNow();
  console.log(b.url === null ? "school: no bridge connected; explanations are saved but not graded until one is (Settings)"
    : unpaired(b) ? `school: not grading: ${UNPAIRED}`
    : `school: grading through the bridge at ${b.url} (from ${b.urlFrom})`);
}

// Authoring (RFC 9 §5.3, flyingrobots/school#257): the school skill an authoring agent would be
// given, hashed once here. Without it authoring is off and says why; everything else still serves.
const authoring = authoringStatus(config.skill, config.skillDocs);
console.log(authoring.authoring === "on" ? `school: authoring on: the school skill's manifest digest is ${authoring.skill.digest} (${authoring.skill.files} files)`
  : `school: authoring off: ${authoring.reason}`);

// The hexagon (RFC 3, §4): this file is the composition root and the HTTP adapter. It parses
// every request with the core's Zod schemas and reaches the record only through the use cases.
const school = createSchool({ record: postgresRecord(database.sql), grader, clock: { now: () => new Date().toISOString() } });

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

/**
 * The policy on an untrusted course's responses. `sandbox` (flyingrobots/school#210), with no
 * allow-* token, gives a document an opaque origin and no script. The fetch directives
 * (flyingrobots/school#271) let it load only School's own images and stylesheets, inline styles
 * and `data:` images, so a reference page cannot tell another site when the learner opens it:
 * everything else, frames, media and fonts included, falls back to `default-src 'none'`. No
 * `font-src 'self'`: from the sandbox's opaque origin a font request is cross-origin and School
 * sends no CORS header, so a course's own font would not load even if the policy allowed it.
 */
const UNTRUSTED_POLICY = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

/**
 * An untrusted course's response, contained. `UNTRUSTED_POLICY` stops a course's HTML or SVG
 * opened in a tab running script, reading School's API, acting as School or loading anything from
 * another site; `nosniff` stops the browser reading the bytes as a type that would run. Applied to
 * every response that carries the course's bytes: its reference files and its course and lesson
 * JSON. A trusted course's responses are left exactly as they were.
 */
function contained(c: Course, res: Response): Response {
  if (c.trusted) return res;
  res.headers.set("content-security-policy", UNTRUSTED_POLICY);
  res.headers.set("x-content-type-options", "nosniff");
  return res;
}

type View = "web" | "slides";
const isView = (v: string | null): v is View => v === "web" || v === "slides";
const summary = (p: Block | undefined) => (p === undefined || p.type !== "page" ? null : { id: p.id, title: p.title, subtitle: p.subtitle });

/**
 * A course: its lessons, each with how many of its quizzes have been answered correctly, and its
 * reference documents. Lessons that cannot be read do not hide the documents
 * (flyingrobots/school#115): `lessons` is then null and `lessonsError` says why, in a 200.
 */
async function courseJson(c: Course): Promise<Response> {
  const { library, error } = lessons(c);
  const reference = referenceDocs(c);
  if (library === null) return json({ name: c.name, title: titleOf(c), trusted: c.trusted, ...manifestOf(c), reference, lessons: null, lessonsError: error?.message ?? "the lessons could not be loaded" });
  const done = await school.lessonProgress(c.name);
  return json({
    name: c.name,
    title: titleOf(c),
    trusted: c.trusted,
    ...manifestOf(c),
    reference,
    lessons: library.pages.map((p) => {
      const ids = quizIds(p);
      return { ...summary(p), quizzes: ids.size, answeredCorrectly: [...ids].filter((id) => done[p.id]?.includes(id)).length };
    }),
  });
}

/**
 * A course as the home page needs it: each lesson's quizzes in document order, and the quizzes ever
 * answered correctly in each. Null when the course's lessons cannot be read.
 */
async function outline(c: Course): Promise<CourseOutline | null> {
  let pages: Block[];
  try {
    const { library } = lessons(c);
    if (library === null) return null;
    pages = library.pages;
  } catch {
    return null; // for example, a course with no lessons directory
  }
  return {
    name: c.name,
    progress: await school.lessonProgress(c.name),
    lessons: pages.flatMap((p) => (p.type === "page" ? [{ id: p.id, title: p.title, subtitle: p.subtitle, quizzes: quizzes(p) }] : [])),
  };
}

/** Every course for the home page: its lesson and reference counts, and its quizzes and how many are answered correctly. */
async function coursesJson(): Promise<Response> {
  return json(await Promise.all(served.map(async (c) => {
    const o = await outline(c);
    const quizCount = o === null ? null : o.lessons.reduce((n, l) => n + l.quizzes.length, 0);
    const correct = o === null ? null : o.lessons.reduce((n, l) => n + l.quizzes.filter((q) => o.progress[l.id]?.includes(q.id)).length, 0);
    return { name: c.name, title: titleOf(c), trusted: c.trusted, ...manifestOf(c), lessons: o === null ? null : o.lessons.length, reference: referenceDocs(c).length, quizzes: quizCount, answeredCorrectly: correct };
  })));
}

// ---- Since the learner was last here (flyingrobots/school#165) -------------------------------

/** The server's time zone: the fallback when a request names none. */
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The learner's time zone (flyingrobots/school#178): `tz`, which the page sends from its browser,
 * when it is an IANA zone; the server's own when it is absent. Under Docker the server's is UTC, so
 * without it a learner west of Greenwich studies "tomorrow" every evening. `null` when `tz` is
 * given and is not a zone, which the caller answers with 400.
 */
async function zoneParam(params: URLSearchParams): Promise<string | null> {
  const tz = params.get("tz");
  if (tz !== null && validZone(tz) === null) return null;
  // A zone chosen in Settings wins over the browser's (flyingrobots/school#181).
  return (await school.timeZone()) ?? (tz === null ? zone() : validZone(tz));
}

/** `tz` as Intl resolves it, when it is an IANA zone of a sane shape; otherwise null. */
function validZone(tz: string): string | null {
  if (tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+){0,2}$/.test(tz)) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
const BAD_ZONE = { error: "tz must be an IANA time zone, such as America/Los_Angeles" };

/** Each served course's pages that can be read, or none. */
function readablePages(c: Course): Extract<Block, { type: "page" }>[] {
  try {
    const { library } = lessons(c);
    return library === null ? [] : library.pages.flatMap((p) => (p.type === "page" ? [p] : []));
  } catch {
    return [];
  }
}
const lessonOf = (pages: Extract<Block, { type: "page" }>[], blockId: string) => {
  const p = pages.find((q) => quizIds(q).has(blockId));
  return p === undefined ? null : { id: p.id, title: p.title };
};

/**
 * The newest succeeded grading, where its explanation was written, and the prompt it answered, with
 * its course's `trusted` (flyingrobots/school#272). A course no longer served is not trusted.
 */
async function feedbackJson(): Promise<Response> {
  const f = await school.latestFeedback();
  if (f === null) return json(null, 200, { "cache-control": "no-store" });
  const c = served.find((x) => x.name === f.course);
  const page = c === undefined ? undefined : readablePages(c).find((p) => p.id === f.lesson);
  return json({
    course: f.course, courseTitle: c === undefined ? f.course : titleOf(c), trusted: c?.trusted ?? false, lesson: { id: f.lesson, title: page?.title ?? f.lesson },
    blockId: f.blockId, prompt: f.prompt, model: f.model, findings: f.findings, at: f.at,
  }, 200, { "cache-control": "no-store" });
}

// ---- Reading aloud (flyingrobots/school#175) ----------------------------------------------------

/** Why School cannot read aloud without a bridge, in words. */
const noSpeech = () => unpaired(bridgeNow()) ? `School cannot read aloud: ${UNPAIRED}`
  : "Reading aloud goes through the bridge, and no bridge is connected yet; connect one in Settings.";

/** POST /api/speak: the server builds the text, from a lesson as written or the latest feedback, and hands it to the bridge. */
async function speakJson(body: unknown): Promise<Response> {
  const r = SpeakRequest.safeParse(body);
  if (!r.success) return json({ status: "invalid", error: 'send { "course": ..., "lesson": ... } or { "feedback": true }' }, 400);
  let text: string;
  if ("feedback" in r.data) {
    const f = await school.latestFeedback();
    if (f === null) return json({ status: "none", error: "There is no feedback to read yet." }, 404);
    const c = served.find((x) => x.name === f.course);
    const page = c === undefined ? undefined : readablePages(c).find((p) => p.id === f.lesson);
    text = feedbackSpeech({ lessonTitle: page?.title ?? f.lesson, prompt: f.prompt, findings: f.findings });
  } else {
    const { course: name, lesson: id } = r.data;
    const c = served.find((x) => x.name === name);
    const page = c === undefined ? undefined : readablePages(c).find((p) => p.id === id);
    if (page === undefined) return json({ status: "not found", error: "no such lesson" }, 404);
    text = lessonSpeech(page);
  }
  return toSpeech(currentBridge(), noSpeech(), "POST", "/speak", { body: { text } });
}

/**
 * The questions due for review now, across served courses, each with where it lives, why it's back
 * and its course's `trusted` (flyingrobots/school#272).
 */
async function reviewJson(params: URLSearchParams): Promise<Response> {
  const tz = await zoneParam(params);
  if (tz === null) return json(BAD_ZONE, 400);
  const due = await Promise.all(served.map(async (c) => {
    const pages = readablePages(c);
    const quizzesById = new Map(pages.flatMap((p) => quizzes(p).map((q) => [q.id, q] as const)));
    return (await school.dueNow(c.name, [...quizzesById.keys()], tz)).map(({ item, reason }) => ({
      course: c.name, courseTitle: titleOf(c), trusted: c.trusted, lesson: lessonOf(pages, item.blockId), blockId: item.blockId,
      question: quizzesById.get(item.blockId)?.q ?? null, answeredAt: item.answeredAt, rule: item.rule, reason,
    }));
  }));
  return json(due.flat(), 200, { "cache-control": "no-store" });
}

/**
 * Each course's study days in the last `days`, and how many questions come back on each day ahead,
 * with the course's `trusted` (flyingrobots/school#272).
 */
async function activityJson(params: URLSearchParams): Promise<Response> {
  const given = params.get("days");
  const days = given === null ? 14 : /^[0-9]+$/.test(given) ? Number(given) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > 60) return json({ error: "days must be a whole number from 1 to 60" }, 400);
  const tz = await zoneParam(params);
  if (tz === null) return json(BAD_ZONE, 400);
  const courses = served.map((c) => ({ name: c.name, blocks: readablePages(c).flatMap((p) => [...quizIds(p)]) }));
  const a = await school.activity(courses, days, tz);
  return json({
    today: a.today, tz, days,
    courses: a.courses.map((x) => {
      const c = served.find((s) => s.name === x.course)!;
      return { course: x.course, courseTitle: titleOf(c), trusted: c.trusted, studied: x.studied, due: x.due };
    }),
  }, 200, { "cache-control": "no-store" });
}

/**
 * What's ahead in the learner's courses, for the home page (flyingrobots/school#164): every lesson
 * with a quiz not yet answered correctly, in course order, with its hook, or its title and subtitle
 * when it has none. A course is started once any of its quizzes is answered correctly. A lesson with
 * no quizzes is left out, as is a course whose lessons can't be read. Each item gives its course's
 * `trusted`, so the page draws an untrusted course's figure as an image (flyingrobots/school#210).
 */
async function showcaseJson(): Promise<Response> {
  const ahead = await Promise.all(served.map(async (c) => {
    let pages: Block[];
    try {
      const { library } = lessons(c);
      if (library === null) return [];
      pages = library.pages.filter((p) => p.type === "page");
    } catch {
      return [];
    }
    const progress = await school.lessonProgress(c.name);
    const started = Object.values(progress).some((ids) => ids.length > 0);
    return pages.flatMap((p, i) => {
      if (p.type !== "page") return [];
      const ids = [...quizIds(p)];
      if (ids.length === 0 || ids.every((id) => progress[p.id]?.includes(id))) return [];
      return [{
        course: c.name, courseTitle: titleOf(c), trusted: c.trusted, started,
        lesson: { id: p.id, title: p.title, subtitle: p.subtitle, position: i + 1, of: pages.length },
        question: p.hook?.question ?? p.title, teaser: p.hook?.teaser ?? p.subtitle, figure: p.hook?.figure ?? null,
      }];
    });
  }));
  return json(ahead.flat(), 200, { "cache-control": "no-store" });
}

/**
 * What to study now: where the learner left off and the next step from it (core/school.ts,
 * resumeFrom), with its course's `trusted` when it names one (flyingrobots/school#272).
 */
async function resumeJson(): Promise<Response> {
  const outlines = await Promise.all(served.map(outline));
  const readable = outlines.filter((o): o is CourseOutline => o !== null);
  const r = resumeFrom(await school.lastStudied(), readable);
  const body = r.kind === "nothing" ? r : { ...r, trusted: served.find((c) => c.name === r.course)?.trusted ?? false };
  return json(body, 200, { "cache-control": "no-store" });
}

/**
 * The lesson API's `aid`: the capture version the client records exposures under (RFC 2 §3), given
 * once, or null when absent, so the encounter is untracked. Only the client knows what it shows,
 * so only its declaration can make an encounter tracked (flyingrobots/school#29, #51).
 */
function aidParam(params: URLSearchParams): { aid: AidTracking } | null {
  const given = params.getAll("aid");
  if (given.length === 0) return { aid: null };
  const v = given.length === 1 ? AidQuery.safeParse(given[0]) : null;
  return v?.success ? { aid: v.data } : null;
}

/** The lesson `id` of `c` with its neighbours and its course's pages, or the reply that says why not. */
function findLesson(c: Course, id: string) {
  const { library, error } = lessons(c);
  if (library === null) return json({ error: error?.message ?? "the lessons could not be loaded" }, 500);
  const { pages } = library;
  const i = pages.findIndex((p) => p.id === id);
  const page = pages[i];
  if (page === undefined) return json({ error: "no such lesson" }, 404);
  return { library, page, base: { lesson: page, prev: summary(pages[i - 1]), next: summary(pages[i + 1]), hasReference: referenceDocs(c).length > 0 } };
}

/**
 * One lesson, read: in either view it writes nothing to the record, so no page that can make a GET,
 * such as another page's `<img>`, can change it (flyingrobots/school#321). The web view's encounter
 * is opened with a POST (openLessonJson).
 */
function lessonJson(c: Course, id: string, viewParam: string | null): Response {
  const view = isView(viewParam) ? viewParam : "web";
  const found = findLesson(c, id);
  if (found instanceof Response) return found;
  return json({ course: c.name, view, ...found.base });
}

/**
 * Opens one lesson in the web view: opens or resumes the learner's encounter and includes what is
 * already answered in it, and any items due for review. A POST, so the write guard covers it.
 */
async function openLessonJson(c: Course, id: string, aidTracking: AidTracking, tz: string): Promise<Response> {
  const found = findLesson(c, id);
  if (found instanceof Response) return found;
  const { library, page, base } = found;
  const { pages } = library;
  // Any quiz of the course may come back for review at the top of this lesson (RFC 2 §5). `lesson` is
  // then what the encounter snapshotted, review included, and `review` holds each item's reason.
  const opened = await school.openLesson(c.name, page, aidTracking, [...library.byId.values()], tz);
  // Each item names the lesson that holds its quiz now, so the learner can place it (flyingrobots/school#159).
  const home = (blockId: string) => {
    const p = pages.find((q) => q.type === "page" && quizIds(q).has(blockId));
    return p?.type === "page" ? { id: p.id, title: p.title } : null;
  };
  const review = opened.review.map((r) => ({ ...r, from: home(r.blockId) }));
  return json({ course: c.name, view: "web", ...base, lesson: opened.page, encounterId: opened.encounter.id, answers: opened.answers, explanations: opened.explanations, review },
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

const http = Bun.serve({
  hostname: config.host,
  port: config.port,
  // Bun closes a request idle for 10 s by default; a grading call can take a minute or two.
  // 255 s is Bun's maximum, so the grader's own timeout is capped below it (grade.ts).
  idleTimeout: 255,
  async fetch(req) {
    // Before anything else, so that no route, present or future, answers a rebound name (flyingrobots/school#18).
    if (!hostAllowed(req.headers.get("host"), hosts)) {
      return json({ status: "refused", error: "this Host is not one of School's names; add it to SCHOOL_ALLOWED_HOSTS if it should be" }, 403);
    }
    const url = new URL(req.url);
    const { pathname } = url;
    if ((req.method === "POST" || req.method === "PUT") && pathname.startsWith("/api/")) {
      const refused = guardApi(req);
      if (refused !== null) return refused;
    }
    if (req.method === "POST" && pathname === "/api/answer") {
      const s = Submission.safeParse(await readJson(req));
      if (!s.success) return json({ status: "invalid" }, 400);
      // Acknowledged only after the commit, so a 200 means the answer is on disk.
      const r = await school.submitAnswer(s.data);
      if (r.status === "rejected") return json(r, 400);
      if (r.status === "conflict") return json(r, 409);
      return json({ ...r, submissionId: s.data.submissionId });
    }
    if (req.method === "POST" && pathname === "/api/explanation") {
      const s = ExplanationSubmission.safeParse(await readJson(req));
      if (!s.success) return json({ status: "invalid" }, 400);
      const { result: r, explanation } = await school.saveExplanation(s.data);
      if (r.status === "rejected") return json(r, 400);
      if (r.status === "conflict") return json(r, 409);
      return json({ ...r, submissionId: s.data.submissionId, explanation });
    }
    if (req.method === "POST" && pathname === "/api/grade") {
      const body = GradeRequest.safeParse(await readJson(req));
      if (!body.success) return json({ status: "invalid" }, 400);
      const g = await school.gradeExplanation(body.data.submissionId);
      if (g === null) return json({ status: "unknown submission" }, 404);
      return json({ status: g.grading.status, explanation: g.explanation });
    }
    if (req.method === "POST" && pathname === "/api/exposure") {
      const e = Exposure.safeParse(await readJson(req));
      if (!e.success) return json({ status: "invalid" }, 400);
      const r = await school.recordExposure(e.data);
      if (r.status === "rejected") return json(r, 400);
      if (r.status === "conflict") return json(r, 409);
      return json(r);
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
        const url = body.url.replace(/\/+$/, "");
        // School has no login, so whoever posts a URL may not be the learner. The token is only
        // ever sent to the URL it was saved with (flyingrobots/school#60): a token from the
        // environment locks the URL, and a new URL drops a saved token until one is given again.
        if (url !== (saved.bridge?.url ?? "")) {
          if (now.tokenFrom === "environment") return json({ status: "locked", error: "SCHOOL_BRIDGE_TOKEN is set in the environment, so the bridge URL can only be changed there too: set SCHOOL_BRIDGE_URL beside it" }, 409);
          delete next.token;
        }
        next.url = url;
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
      const after = { ...saved, bridge: next };
      saveSettings(SETTINGS, after);
      // tokenSet is the token in effect, from the environment or settings, as the GET reports it
      // (flyingrobots/school#61). A generated token is returned once, so the learner can start
      // the bridge with it. Never again.
      return json({ status: "saved", tokenSet: effectiveBridge(env, after).token !== null, ...(generated === undefined ? {} : { generated }) });
    }
    // Agents are declared, commands and all, only in the bridge's file on its host. From here
    // they can be reordered, switched on and off, and tested; only those fields reach the bridge.
    if (req.method === "POST" && pathname === "/api/settings/agents") {
      const order = agentOrder(await readJson(req));
      if ("error" in order) return json({ status: "invalid", error: order.error }, 400);
      const r = await toBridge(currentBridge(), "PUT", "/config", order);
      return json(r.body, r.status);
    }
    if (req.method === "POST" && pathname === "/api/settings/agents/test") {
      const t = agentTest(await readJson(req));
      if ("error" in t) return json({ status: "invalid", error: t.error }, 400);
      const r = await toBridge(currentBridge(), "POST", "/test", t);
      return json(r.body, r.status);
    }
    if (req.method === "POST" && pathname === "/api/speak") return speakJson(await readJson(req));
    const cancel = /^\/api\/speak\/([^/]+)\/cancel$/.exec(pathname);
    if (req.method === "POST" && cancel !== null) {
      if (!UTTERANCE.test(cancel[1]!)) return json({ status: "invalid", error: "not an utterance id" }, 400);
      return toSpeech(currentBridge(), noSpeech(), "POST", `/speak/${cancel[1]}/cancel`);
    }
    if (pathname === "/api/settings/time-zone") {
      if (req.method === "PUT") {
        const body = (await readJson(req)) as { zone?: unknown } | null;
        const given = body?.zone;
        const chosen = given === null ? null : typeof given === "string" ? validZone(given) : undefined;
        if (chosen === undefined || (given !== null && chosen === null)) return json(BAD_ZONE, 400);
        await school.chooseTimeZone(chosen);
        return json({ zone: chosen }, 200, { "cache-control": "no-store" });
      }
      if (req.method === "GET") return json({ zone: await school.timeZone() }, 200, { "cache-control": "no-store" });
      return json({ error: "use GET or PUT" }, 405);
    }
    if (req.method === "POST" && pathname === "/api/view") {
      const v = ViewEvent.safeParse(await readJson(req));
      if (!v.success) return new Response("Bad view", { status: 400 });
      await school.recordView(v.data);
      return new Response(null, { status: 204 });
    }
    const lessonPath = /^\/api\/courses\/([a-z0-9][a-z0-9-]*)\/lessons\/([\w-]+)$/.exec(pathname);
    if (req.method === "POST" && lessonPath !== null) {
      // Opens the lesson in the web view; its body is not read (flyingrobots/school#321).
      const c = course(config, lessonPath[1]!);
      if (c === null) return json({ error: "no such course" }, 404);
      const view = url.searchParams.get("view");
      if (view !== null && view !== "web") return contained(c, json({ status: "invalid", error: "a lesson is opened in the web view; the slides view is read with a GET" }, 400));
      const aid = aidParam(url.searchParams);
      if (aid === null) return contained(c, json({ status: "invalid", error: `aid must be a known capture version: ${AID_CAPTURE_VERSIONS.join(", ")}` }, 400));
      const tz = await zoneParam(url.searchParams);
      if (tz === null) return contained(c, json(BAD_ZONE, 400));
      return contained(c, await openLessonJson(c, lessonPath[2]!, aid.aid, tz));
    }
    if (req.method === "POST" && pathname.startsWith("/api/")) return notFound();
    if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

    if (pathname === "/api/settings/status") return json(unpaired(bridgeNow()) ? { connection: "none", error: UNPAIRED, agents: [] } : await bridgeStatus(currentBridge()));
    if (pathname === "/api/settings/bridge") {
      // Whether a token is set, never the token itself.
      const b = bridgeNow();
      return json({ url: b.url, urlFrom: b.urlFrom, tokenSet: b.token !== null, tokenFrom: b.tokenFrom }, 200, { "cache-control": "no-store" });
    }
    if (pathname === "/api/settings/authoring") return json(authoring);
    if (pathname === "/api/settings/agents") {
      const r = await toBridge(currentBridge(), "GET", "/config");
      return json(r.body, r.status);
    }
    // Reading aloud's progress and audio, through the bridge, with the server's token (flyingrobots/school#175).
    const speakPath = /^\/api\/speak\/([^/]+)(?:\/segments\/([^/]+))?$/.exec(pathname);
    if (speakPath !== null) {
      const [, id, n] = speakPath;
      if (!UTTERANCE.test(id!) || (n !== undefined && !SEGMENT.test(n))) return json({ status: "invalid", error: "not an utterance or a segment" }, 400);
      return n === undefined ? toSpeech(currentBridge(), noSpeech(), "GET", `/speak/${id}`)
        : toSpeech(currentBridge(), noSpeech(), "GET", `/speak/${id}/segments/${n}`, { range: req.headers.get("range") });
    }
    // A submission's aid, derived by the record's order (RFC 2 §3): what a reader of the record sees.
    const aidPath = /^\/api\/aid\/([^/]+)$/.exec(pathname);
    if (aidPath !== null) {
      const r = AidRequest.safeParse({ submissionId: aidPath[1] });
      if (!r.success) return json({ status: "invalid" }, 400);
      const aid = await school.submissionAid(r.data.submissionId);
      if (aid === null) return json({ status: "unknown submission" }, 404);
      return json({ submissionId: r.data.submissionId, aid }, 200, { "cache-control": "no-store" });
    }
    if (pathname === "/api/courses") return coursesJson();
    if (pathname === "/api/resume") return resumeJson();
    if (pathname === "/api/feedback") return feedbackJson();
    if (pathname === "/api/review") return reviewJson(url.searchParams);
    if (pathname === "/api/activity") return activityJson(url.searchParams);
    if (pathname === "/api/showcase") return showcaseJson();
    const api = /^\/api\/courses\/([a-z0-9][a-z0-9-]*)(?:\/lessons\/([\w-]+))?$/.exec(pathname);
    if (api !== null) {
      const c = course(config, api[1]!);
      if (c === null) return json({ error: "no such course" }, 404);
      if (api[2] === undefined) return contained(c, await courseJson(c));
      return contained(c, lessonJson(c, api[2], url.searchParams.get("view")));
    }
    if (pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

    // A course's reference documents are course-authored files, served as they are; an
    // untrusted course's, sandboxed.
    const ref = /^\/courses\/([a-z0-9][a-z0-9-]*)\/reference\/(.+)$/.exec(pathname);
    if (ref !== null) {
      const c = course(config, ref[1]!);
      const dir = c === null ? null : referenceDir(c);
      return c === null || dir === null ? notFound() : contained(c, await serveFrom(dir, [ref[2]!]));
    }

    const mounted = await serveMount(pathname);
    if (mounted.status !== 404) return mounted;
    return serveApp(pathname);
  },
});
// A stop closes the record cleanly: PGlite checkpoints its directory. A hard kill loses nothing
// either, since every acknowledged answer is committed first; this only makes the next start quick.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await http.stop(true);
    await database.close();
    process.exit(0);
  });
}

console.log(`school: answering to ${hosts.join(", ")}`);
console.log(`school: http://${config.host}:${config.port}  courses=${courses.length > 0 ? courses.join(", ") : "(none)"}  state=${config.state}`);
if (Object.keys(config.mounts).length > 0) console.log(`school: mounts ${Object.keys(config.mounts).map((n) => "/" + n).join(" ")}`);
