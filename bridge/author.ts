// Drafting a course (RFC 9 §5.1 and §5.2, flyingrobots/school#259). The agents of the `author`
// list in bridge.json are tried in order, as the other lists' are, each in a working folder made
// for that attempt and deleted after it (RFC 9 Listing 5.1):
//
//   <fresh folder from mkdtemp>/
//     course/   the draft: the files the server sent under `files`
//     guide/    the pinned skill: the files the server sent under `guide`
//
// Two of Table 5.2's layers of confinement are here. Layer 1: every path sent is checked before
// anything is written (`entries`): none is absolute, holds `..`, `.`, an empty part, a backslash
// or a NUL, names a file twice (in any case) or as both a file and a folder, or passes RFC 7's
// limits. Layer 4: once the agent has exited and its process group is killed, `course/` is walked
// with `lstat`, never following a link, and only regular files under `course.json`, `lessons/`,
// `reference/`, `OBJECTIVES.md` and `RESOURCES.md` come back, within RFC 7 Table 6.2's limits
// (`DEFAULT_LIMITS`). A symlink, anything but a regular file or folder, or a limit passed refuses
// the whole draft; anything outside those names, in `course/` or out of it, is not returned. The
// server checks the result again with RFC 7's extractor. Layers 2 and 3, the agent's own tool
// allowlist and deny rules, are the learner's command (RFC 9 task 4).
//
// The guide's digest is taken from the files as written into the folder, so it is the digest of
// exactly what this agent was given (flyingrobots/school#313), in `server/skill.ts`'s manifest form.
//
// An agent with output `claude-stream-json` reports each tool it uses as a step, naming the tool
// and the path it gave, never the content. A retried request (`api_retry`) does not repeat a tool
// already used, and a tool use the stream repeats is one step, so retries need no handling here.
// The next agent is tried only before the first step: once the author has seen one agent at work,
// its failure ends the request. Nothing here logs; the caller logs the attempts, which hold no
// prompt and no file.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_LIMITS, type Limits } from "../server/extract-tree.ts";
import { folderManifest, manifestDigest } from "../server/skill.ts";
import { readLines } from "./ask.ts";
import { answerText, claudeStreamLine, usageOf, type Agent, type AuthorConfig, type Usage } from "./run.ts";
import { expand, usesPlaceholder } from "./template.ts";

export type { AuthorConfig } from "./run.ts";
/** A file of the draft or the guide: its path under `course/` or `guide/`, and its bytes. */
export type CourseFile = { path: string; bytes: Uint8Array };
export type AuthorLimits = Pick<Limits, "files" | "fileBytes" | "totalBytes" | "pathBytes" | "depth">;
/** Why a request's files cannot be written into a working folder. Its message says which and why. */
export class AuthorInputError extends Error {}
/** One tool the agent used: its name and the path it gave, relative to the folder when under it. */
export type AuthorStep = { tool: string; path: string | null };
export type RefusalReason = "no-course" | "symlink" | "not-regular" | "too-many-files" | "file-too-large" | "total-too-large" | "path-too-long" | "too-deep";
/** Why a draft was not returned: the reason, the path under `course/` it concerns (or null), and a sentence. */
export type Refusal = { reason: RefusalReason; path: string | null; message: string };
export type AuthorAttempt = { agent: string; status: "succeeded" | "failed" | "skipped" | "refused"; error: string | null; exitCode: number | null; ms: number; steps: number };
export type AuthorResult =
  | { status: "succeeded"; agent: string; usage: Usage | null; files: CourseFile[]; bytes: number; guideSha256: string; attempts: AuthorAttempt[] }
  | { status: "refused"; agent: string; usage: Usage | null; refusal: Refusal; guideSha256: string; attempts: AuthorAttempt[] }
  | { status: "failed"; agent: string | null; error: string; guideSha256: string | null; attempts: AuthorAttempt[] };
/** The prompt, the draft and the guide; an overall deadline; a signal that the caller has gone; a heartbeat interval. */
export type AuthorJob = { prompt: string; files: CourseFile[]; guide: CourseFile[]; deadlineMs?: number; signal?: AbortSignal; limits?: Partial<AuthorLimits>; heartbeatMs?: number };
export type AuthorEvents = { step(s: AuthorStep): void; heartbeat?(): void };

// The stream repeats every Write's content in its tool use, so the cap is well above a draft's 64 MiB.
const MAX_OUTPUT = 160 * 1024 * 1024;
const PIPE_GRACE_MS = 500;
const GONE = "the caller went away";
const RETURNED_FILES = ["OBJECTIVES.md", "RESOURCES.md", "course.json"];
const RETURNED_FOLDERS = ["lessons", "reference"];
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const fold = (p: string) => p.normalize("NFC").toLowerCase();

/**
 * Layer 1: the request's `files` or `guide`, a list of `{ path, base64 }`, as files to write under
 * `course/` or `guide/`. Throws AuthorInputError on the first path that could leave its folder or
 * collide, on content that is not base64, and past RFC 7's limits. The guide must hold SKILL.md.
 */
export function entries(list: unknown, where: "files" | "guide", limits: Partial<AuthorLimits> = {}): CourseFile[] {
  const l = { ...DEFAULT_LIMITS, ...limits };
  if (!Array.isArray(list) || list.length === 0) throw new AuthorInputError(`"${where}" must be a list of { "path", "base64" }, at least one`);
  if (list.length > l.files) throw new AuthorInputError(`"${where}" may hold at most ${l.files} files`);
  const files = new Set<string>();
  const folders = new Set<string>();
  let total = 0;
  const out = list.map((item: unknown): CourseFile => {
    if (!isObject(item) || typeof item.path !== "string") throw new AuthorInputError(`each of "${where}" is { "path", "base64" }`);
    const path = item.path;
    const name = JSON.stringify(path);
    const refuse = (why: string): never => { throw new AuthorInputError(`"${where}" path ${name} ${why}`); };
    if (path.includes("\u0000")) refuse("holds a NUL");
    if (path === "") refuse("is empty");
    if (path.startsWith("/")) refuse("is absolute");
    if (path.includes("\\")) refuse("holds a \\");
    const parts = path.split("/");
    for (const p of parts) {
      if (p === "") refuse("has an empty part");
      if (p === "." || p === "..") refuse(`has a ${p} part`);
    }
    if (Buffer.byteLength(path) > l.pathBytes) refuse(`is longer than ${l.pathBytes} bytes`);
    if (parts.length - 1 > l.depth) refuse(`is more than ${l.depth} folders deep`);
    if (typeof item.base64 !== "string" || !BASE64.test(item.base64)) refuse("needs its content as base64");
    const key = fold(path);
    if (files.has(key)) refuse("is named twice");
    files.add(key);
    for (let i = 1; i < parts.length; i++) folders.add(fold(parts.slice(0, i).join("/")));
    const bytes = new Uint8Array(Buffer.from(item.base64 as string, "base64"));
    if (bytes.length > l.fileBytes) refuse(`is larger than ${l.fileBytes} bytes`);
    total += bytes.length;
    if (total > l.totalBytes) throw new AuthorInputError(`"${where}" holds more than ${l.totalBytes} bytes in all`);
    return { path, bytes };
  });
  for (const f of files) if (folders.has(f)) throw new AuthorInputError(`"${where}" names ${JSON.stringify(f)} as both a file and a folder`);
  if (where === "guide" && !out.some((f) => f.path === "SKILL.md")) throw new AuthorInputError('"guide" has no SKILL.md');
  return out;
}

/** Try each enabled author agent in order, passing each tool it uses on through `on.step`. */
export async function runAuthor(cfg: AuthorConfig, job: AuthorJob, on: AuthorEvents): Promise<AuthorResult> {
  const attempts: AuthorAttempt[] = [];
  let guideSha256: string | null = null;
  if (job.signal?.aborted) return { status: "failed", agent: null, error: GONE, guideSha256, attempts };
  const limits = { ...DEFAULT_LIMITS, ...job.limits };
  const end = job.deadlineMs === undefined ? Infinity : Date.now() + job.deadlineMs;
  for (const agent of cfg.agents) {
    if (!agent.enabled) continue;
    const left = end - Date.now();
    if (left <= 0) {
      attempts.push({ agent: agent.name, status: "skipped", error: "the overall deadline had passed", exitCode: null, ms: 0, steps: 0 });
      break;
    }
    const d = await draft(agent, job, Math.min(agent.timeoutMs, left), limits, on);
    attempts.push(d.attempt);
    if (d.guide !== null) guideSha256 = d.guide;
    if (d.outcome.kind === "files") return { status: "succeeded", agent: agent.name, usage: d.outcome.usage, files: d.outcome.files, bytes: d.outcome.bytes, guideSha256: d.guide!, attempts };
    if (d.outcome.kind === "refused") return { status: "refused", agent: agent.name, usage: d.outcome.usage, refusal: d.outcome.refusal, guideSha256: d.guide!, attempts };
    if (d.attempt.steps > 0 || job.signal?.aborted) return { status: "failed", agent: d.attempt.steps > 0 ? agent.name : null, error: d.attempt.error ?? "failed", guideSha256, attempts };
  }
  return { status: "failed", agent: null, error: attempts.length === 0 ? "no author agent is enabled" : "every author agent failed", guideSha256, attempts };
}

type Outcome =
  | { kind: "files"; files: CourseFile[]; bytes: number; usage: Usage | null }
  | { kind: "refused"; refusal: Refusal; usage: Usage | null }
  | { kind: "none" };

/** Write `files` under `root`, each created anew: a path that already exists is a collision. */
function place(root: string, files: CourseFile[]): void {
  mkdirSync(root);
  for (const f of files) {
    const path = join(root, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.bytes, { flag: "wx", mode: 0o644 });
  }
}

/** The tool uses in one line of Claude Code's stream-json: each `tool_use` block of an `assistant` line. */
function toolUses(line: string): { id: string; name: string; input: Record<string, unknown> }[] {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObject(o) || o.type !== "assistant" || !isObject(o.message) || !Array.isArray(o.message.content)) return [];
  return o.message.content.flatMap((b: unknown) =>
    isObject(b) && b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string" ? [{ id: b.id, name: b.name, input: isObject(b.input) ? b.input : {} }] : []);
}

/** The path a tool use names, relative to the working folder when it is under it, else as given. */
function stepPath(input: Record<string, unknown>, bases: string[]): string | null {
  const p = [input.file_path, input.notebook_path, input.path].find((v): v is string => typeof v === "string");
  if (p === undefined) return null;
  for (const base of bases) {
    if (p === base) return ".";
    if (p.startsWith(base + "/")) return p.slice(base.length + 1);
  }
  return p;
}

async function draft(agent: Agent, job: AuthorJob, timeoutMs: number, limits: AuthorLimits, on: AuthorEvents): Promise<{ attempt: AuthorAttempt; guide: string | null; outcome: Outcome }> {
  const started = Date.now();
  const program = agent.argv[0]!;
  const resolved = program.includes("/") ? program : Bun.which(program);
  if (resolved === null) return { attempt: { agent: agent.name, status: "skipped", error: `${program}: not found on PATH`, exitCode: null, ms: 0, steps: 0 }, guide: null, outcome: { kind: "none" } };

  const work = mkdtempSync(join(tmpdir(), "school-bridge-author-"));
  let guide: string | null = null;
  let steps = 0;
  try {
    place(join(work, "course"), job.files);
    place(join(work, "guide"), job.guide);
    guide = manifestDigest(folderManifest(join(work, "guide")));
    const bases = [...new Set([work, realpathSync(work)])];
    const seen = new Set<string>();
    const outputFile = join(work, "answer.txt");
    const toFile = usesPlaceholder(agent.argv, "{output_file}");
    const streaming = agent.output === "claude-stream-json";
    const argv = expand(agent.argv, { "{prompt}": job.prompt, "{output_file}": outputFile });
    argv[0] = resolved;

    // detached: the agent leads its own process group, so a kill ends everything it started.
    const proc = Bun.spawn(argv, {
      cwd: work, detached: true, stdout: "pipe", stderr: "pipe",
      stdin: usesPlaceholder(agent.argv, "{prompt}") ? "ignore" : new TextEncoder().encode(job.prompt),
    });
    let why: string | null = null;
    let sweep: ReturnType<typeof setInterval> | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const hit = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} };
    const kill = (reason: string) => {
      why ??= reason;
      hit();
      // As in ask.ts: sweep the group for a child forked as the signal landed, and stop reading
      // pipes a child that left the group holds open once the kill has had its grace.
      sweep ??= setInterval(hit, 50);
      grace ??= setTimeout(() => { for (const r of readers) r.cancel().catch(() => {}); }, PIPE_GRACE_MS);
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const beat = job.heartbeatMs !== undefined && on.heartbeat !== undefined ? setInterval(on.heartbeat, job.heartbeatMs) : null;
    const gone = () => kill(GONE);
    job.signal?.addEventListener("abort", gone);
    let result: { isError: boolean; usage: Usage | null } | null = null;
    const onLine = (line: string) => {
      if (!streaming || why !== null) return;
      for (const t of toolUses(line)) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        steps++;
        on.step({ tool: t.name, path: stepPath(t.input, bases) });
      }
      const l = claudeStreamLine(line);
      if (l.kind === "result") result = { isError: l.isError, usage: l.usage };
    };
    const [stdout] = await Promise.all([
      readLines(proc.stdout, onLine, !streaming, () => kill("produced more than 160 MiB of output"), readers, MAX_OUTPUT),
      readLines(proc.stderr, () => {}, false, () => kill("produced more than 160 MiB of error output"), readers, MAX_OUTPUT),
    ]);
    if (sweep !== null) clearInterval(sweep);
    if (grace !== null) clearTimeout(grace);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (beat !== null) clearInterval(beat);
    job.signal?.removeEventListener("abort", gone);
    hit(); // anything it left running in the background, before its folder is read

    const base = { agent: agent.name, exitCode, ms: Date.now() - started, steps };
    const failed = (error: string) => ({ attempt: { ...base, status: "failed" as const, error }, guide, outcome: { kind: "none" as const } });
    if (why !== null) return failed(why);
    if (exitCode !== 0) return failed(`exit ${exitCode}`);
    let usage: Usage | null = null;
    if (streaming) {
      const r = result as { isError: boolean; usage: Usage | null } | null;
      if (r === null) return failed("claude-stream-json output had no result line");
      if (r.isError) return failed("the CLI reported an error");
      usage = r.usage;
    } else if (agent.output === "claude-json" && !toFile) {
      try {
        answerText("claude-json", stdout);
        usage = usageOf((JSON.parse(stdout) as { usage?: unknown }).usage);
      } catch (e) {
        return failed(e instanceof Error ? e.message : String(e));
      }
    }
    const c = collect(join(work, "course"), limits);
    if (!c.ok) return { attempt: { ...base, status: "refused", error: c.refusal.message }, guide, outcome: { kind: "refused", refusal: c.refusal, usage } };
    return { attempt: { ...base, status: "succeeded", error: null }, guide, outcome: { kind: "files", files: c.files, bytes: c.bytes, usage } };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

type Collected = { ok: true; files: CourseFile[]; bytes: number } | { ok: false; refusal: Refusal };

/** Layer 4: the regular course files under `course`, never following a link, within `limits`. */
function collect(course: string, limits: AuthorLimits): Collected {
  const refused = (reason: RefusalReason, path: string | null, message: string): Collected => ({ ok: false, refusal: { reason, path, message } });
  let top;
  try {
    top = lstatSync(course);
  } catch {
    return refused("no-course", null, "the draft has no course/ folder");
  }
  if (!top.isDirectory()) return refused("no-course", null, "the draft's course/ is not a folder");
  const files: CourseFile[] = [];
  let bytes = 0;
  let folders = 0;
  const lstat = (path: string) => {
    try {
      return lstatSync(path);
    } catch {
      return null;
    }
  };
  /** A refusal, or null once `rel` has been read or walked. */
  const visit = (rel: string, mustBe: "file" | "folder" | "either"): Collected | null => {
    const abs = join(course, rel);
    const s = lstat(abs);
    if (s === null) return null;
    if (s.isSymbolicLink()) return refused("symlink", rel, `the draft's ${rel} is a symlink; School takes back only regular files`);
    if (s.isDirectory() && mustBe !== "file") {
      if (++folders > limits.files * limits.depth) return refused("too-many-files", null, `the draft has more than ${limits.files * limits.depth} folders`);
      for (const name of readdirSync(abs)) {
        const r = visit(`${rel}/${name}`, "either");
        if (r !== null) return r;
      }
      return null;
    }
    if (!s.isFile() || mustBe === "folder") return refused("not-regular", rel, `the draft's ${rel} is not a regular file`);
    if (Buffer.byteLength(rel) > limits.pathBytes) return refused("path-too-long", rel, `the draft's ${rel} is a path longer than ${limits.pathBytes} bytes`);
    if (rel.split("/").length - 1 > limits.depth) return refused("too-deep", rel, `the draft's ${rel} is more than ${limits.depth} folders deep`);
    if (files.length + 1 > limits.files) return refused("too-many-files", null, `the draft has more than ${limits.files} files`);
    // O_NOFOLLOW: a file swapped for a link since the lstat above is refused, not followed.
    let fd: number;
    try {
      fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return refused("symlink", rel, `the draft's ${rel} could not be opened as a regular file`);
    }
    try {
      const f = fstatSync(fd);
      if (!f.isFile()) return refused("not-regular", rel, `the draft's ${rel} is not a regular file`);
      if (f.size > limits.fileBytes) return refused("file-too-large", rel, `the draft's ${rel} is larger than ${limits.fileBytes} bytes`);
      if (bytes + f.size > limits.totalBytes) return refused("total-too-large", null, `the draft holds more than ${limits.totalBytes} bytes in all`);
      const data = new Uint8Array(readFileSync(fd));
      bytes += data.length;
      files.push({ path: rel, bytes: data });
      return null;
    } finally {
      closeSync(fd);
    }
  };
  for (const name of RETURNED_FILES) {
    const r = visit(name, "file");
    if (r !== null) return r;
  }
  for (const name of RETURNED_FOLDERS) {
    const r = visit(name, "folder");
    if (r !== null) return r;
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { ok: true, files, bytes };
}
