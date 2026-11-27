// Drafting a course (RFC 9 §5.1 and §5.2, flyingrobots/school#259): the `author` list's agents
// run in a fresh working folder holding only `course/` and `guide/`, their tool uses are passed on
// as steps while they work, and only regular course files under `course/` come back, within RFC 7's
// limits. Fake agents are shell scripts (bridge/testing/fake-agent.ts); none contacts a model. The
// oracle for each expectation is RFC 9: Table 5.1 (the route's lines), Listing 5.1 (the folder) and
// Table 5.2 layers 1 and 4 (what goes in and what comes back); RFC 7 Table 6.2 for the limits.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorInputError, entries, runAuthor, type AuthorStep, type CourseFile } from "./author.ts";
import { loadConfig, type AuthorConfig } from "./run.ts";
import { DEFAULT_LIMITS } from "../server/extract-tree.ts";
import { guideManifest, manifestDigest } from "../server/skill.ts";
import { fakeAgent, plainAgent, USAGE, type Step } from "./testing/fake-agent.ts";

// Bun's own 5 s limit would race process start-up on a loaded machine; each test ends on its own
// or by the agent timeouts it sets.
setDefaultTimeout(60_000);

let dir = "";
let gates = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "school-bridge-author-"));
  gates = mkdtempSync(join(tmpdir(), "school-bridge-author-gates-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(gates, { recursive: true, force: true });
});

const open = (name: string) => writeFileSync(join(gates, name), "");
const reached = (name: string) => existsSync(join(gates, name));
const text = (s: string) => new TextEncoder().encode(s);
const file = (path: string, body: string): CourseFile => ({ path, bytes: text(body) });
const read = (f: CourseFile) => [f.path, new TextDecoder().decode(f.bytes)];

const COURSE = [file("course.json", '{"title":"Fixture"}\n'), file("lessons/01.json", '{"id":"one"}\n'), file("reference/notes.md", "Notes\n")];
const GUIDE = [file("SKILL.md", "# The school skill\n"), file("docs/voice/README.md", "Voice\n")];

type Spec = { name: string; steps?: Step[]; command?: string; output?: string; timeout_seconds?: number };
/** An author list of fake agents, each run as `<script> <gate folder> {prompt}` in its working folder. */
function author(agents: Spec[], timeout = 30): AuthorConfig {
  const c = loadConfig({
    agents: [{ name: "grader", command: "true" }],
    author: { timeout_seconds: timeout, agents: agents.map(({ name, steps, command, output, timeout_seconds }) => ({
      name, output: output ?? "claude-stream-json", ...(timeout_seconds === undefined ? {} : { timeout_seconds }),
      command: command ?? `${fakeAgent(dir, name, steps ?? [])} ${gates} {prompt}`,
    })) },
  });
  if (c.author === null) throw new Error("the author list did not load");
  return c.author;
}

const job = (over: Partial<Parameters<typeof runAuthor>[1]> = {}) => ({ prompt: "Fix the quiz in lesson one.", files: COURSE, guide: GUIDE, ...over });
/** The working folder the agent ran in, as it recorded it with `pwd -P` into the gate folder. */
const RECORD_CWD: Step = { sh: `pwd -P > "$1/cwd"` };
const cwd = () => readFileSync(join(gates, "cwd"), "utf8").trim();

test("golden: each step reaches the caller before the agent goes on, and its edits to course files come back", async () => {
  const cfg = author([{ name: "claude", steps: [
    { tool: "Read", input: { file_path: "course/lessons/01.json" } }, { gate: "1" },
    { sh: `printf '{"id":"one","fixed":true}\\n' > course/lessons/01.json` },
    { tool: "Edit", input: { file_path: "course/lessons/01.json", old_string: "{}", new_string: "{}" } }, { gate: "2" },
    { tool: "Glob", input: { pattern: "**/*.json" } }, { gate: "3" },
    { result: "Done." }, { mark: "exited" },
  ] }]);
  const seen: [AuthorStep, boolean][] = [];
  const r = await runAuthor(cfg, job(), { step: (s) => { seen.push([s, reached("exited")]); open(String(seen.length)); } });
  // Each step opens the gate the agent waits at next: a step held until the agent exited would
  // leave it waiting until its timeout, and the run would fail.
  expect(seen).toEqual([
    [{ tool: "Read", path: "course/lessons/01.json" }, false],
    [{ tool: "Edit", path: "course/lessons/01.json" }, false],
    [{ tool: "Glob", path: null }, false],
  ]);
  expect(r.status).toBe("succeeded");
  if (r.status !== "succeeded") return;
  expect(r.agent).toBe("claude");
  expect(r.usage).toEqual(USAGE);
  expect(r.files.map(read)).toEqual([["course.json", '{"title":"Fixture"}\n'], ["lessons/01.json", '{"id":"one","fixed":true}\n'], ["reference/notes.md", "Notes\n"]]);
  expect(r.bytes).toBe(r.files.reduce((n, f) => n + f.bytes.length, 0));
  expect(r.attempts).toEqual([{ agent: "claude", status: "succeeded", error: null, exitCode: 0, ms: expect.any(Number), steps: 3 }]);
});

test("a step's path under the working folder is named relative to it, even when the agent gives it absolute", async () => {
  const cfg = author([{ name: "claude", steps: [
    { sh: `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"tool_use\\",\\"id\\":\\"t1\\",\\"name\\":\\"Write\\",\\"input\\":{\\"file_path\\":\\"$(pwd -P)/course/lessons/02.json\\",\\"content\\":\\"x\\"}}]}}"` },
    { sh: `printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"tool_use\\",\\"id\\":\\"t2\\",\\"name\\":\\"Grep\\",\\"input\\":{\\"pattern\\":\\"q\\",\\"path\\":\\"$(pwd)/guide\\"}}]}}"` },
    { tool: "Read", input: { file_path: "/etc/passwd" } },
    { result: "Done." },
  ] }]);
  const seen: AuthorStep[] = [];
  const r = await runAuthor(cfg, job(), { step: (s) => seen.push(s) });
  expect(r.status).toBe("succeeded");
  // A path outside the folder is named as the agent gave it, so the author can see it tried.
  expect(seen).toEqual([{ tool: "Write", path: "course/lessons/02.json" }, { tool: "Grep", path: "guide" }, { tool: "Read", path: "/etc/passwd" }]);
});

test("a tool use the stream repeats is one step", async () => {
  const cfg = author([{ name: "claude", steps: [
    { tool: "Read", id: "toolu_same", input: { file_path: "course/course.json" } },
    { tool: "Read", id: "toolu_same", input: { file_path: "course/course.json" } },
    { result: "Done." },
  ] }]);
  const seen: AuthorStep[] = [];
  const r = await runAuthor(cfg, job(), { step: (s) => seen.push(s) });
  expect(seen).toEqual([{ tool: "Read", path: "course/course.json" }]);
  expect(r.attempts[0]).toMatchObject({ steps: 1 });
});

test("the working folder holds only course/ and guide/, as sent, and the prompt reaches the agent", async () => {
  const cfg = author([{ name: "claude", steps: [
    { sh: `find . -print | LC_ALL=C sort > "$1/tree"; cat course/course.json guide/SKILL.md > "$1/bodies"; printf '%s' "$2" > "$1/prompt"` },
    { result: "Done." },
  ] }]);
  expect((await runAuthor(cfg, job(), { step: () => {} })).status).toBe("succeeded");
  expect(readFileSync(join(gates, "tree"), "utf8").trim().split("\n")).toEqual([
    ".", "./course", "./course/course.json", "./course/lessons", "./course/lessons/01.json", "./course/reference", "./course/reference/notes.md",
    "./guide", "./guide/SKILL.md", "./guide/docs", "./guide/docs/voice", "./guide/docs/voice/README.md",
  ]);
  expect(readFileSync(join(gates, "bodies"), "utf8")).toBe('{"title":"Fixture"}\n# The school skill\n');
  expect(readFileSync(join(gates, "prompt"), "utf8")).toBe("Fix the quiz in lesson one.");
});

test("only regular files under course.json, lessons/, reference/, OBJECTIVES.md and RESOURCES.md come back; nothing outside course/", async () => {
  const cfg = author([{ name: "claude", steps: [
    { sh: [
      "printf 'top\\n' > outside.txt", "printf 'changed\\n' > guide/SKILL.md", "mkdir -p .claude && printf '{}' > .claude/settings.json",
      "printf 'o\\n' > course/OBJECTIVES.md", "printf 'r\\n' > course/RESOURCES.md", "printf 'x\\n' > course/notes.txt",
      "mkdir -p course/.git course/scripts && printf 'x\\n' > course/.git/config && printf 'x\\n' > course/scripts/run.sh",
      "mkdir -p course/reference/img && printf 'png' > course/reference/img/a.png",
    ].join(" && ") },
    { result: "Done." },
  ] }]);
  const r = await runAuthor(cfg, job(), { step: () => {} });
  expect(r.status).toBe("succeeded");
  if (r.status !== "succeeded") return;
  expect(r.files.map((f) => f.path)).toEqual(["OBJECTIVES.md", "RESOURCES.md", "course.json", "lessons/01.json", "reference/img/a.png", "reference/notes.md"]);
});

test("the working folder is gone afterwards: after a success, a failure, a refusal and a timeout", async () => {
  const cases: [Spec, string][] = [
    [{ name: "ok", steps: [RECORD_CWD, { result: "Done." }] }, "succeeded"],
    [{ name: "fails", steps: [RECORD_CWD, { exit: 3 }] }, "failed"],
    [{ name: "refused", steps: [RECORD_CWD, { sh: "ln -s /etc/hosts course/reference/hosts" }, { result: "Done." }] }, "refused"],
    [{ name: "hangs", steps: [RECORD_CWD, { hang: true }], timeout_seconds: 1 }, "failed"],
  ];
  for (const [spec, status] of cases) {
    rmSync(join(gates, "cwd"), { force: true });
    const r = await runAuthor(author([spec]), job(), { step: () => {} });
    expect([spec.name, r.status, existsSync(cwd())]).toEqual([spec.name, status, false]);
  }
});

test("a caller that goes away stops the agent, the reply fails, and the folder is gone", async () => {
  const caller = new AbortController();
  const cfg = author([{ name: "claude", steps: [RECORD_CWD, { tool: "Read", input: { file_path: "course/course.json" } }, { hang: true }] }]);
  const r = await runAuthor(cfg, job({ signal: caller.signal }), { step: () => caller.abort() });
  expect(r).toMatchObject({ status: "failed", agent: "claude", error: "the caller went away" });
  expect(existsSync(cwd())).toBe(false);
});

test("a symlink under course/, to a file or a folder, refuses the draft and names it", async () => {
  for (const [link, path] of [["ln -s /etc/hosts course/lessons/02.json", "lessons/02.json"], ["ln -s /etc course/reference/etc", "reference/etc"], ["rm -r course/lessons && ln -s /etc course/lessons", "lessons"]] as const) {
    const r = await runAuthor(author([{ name: "claude", steps: [{ sh: link }, { result: "Done." }] }]), job(), { step: () => {} });
    expect(r).toMatchObject({ status: "refused", agent: "claude", refusal: { reason: "symlink", path } });
  }
});

test("course/ replaced by a symlink or a file refuses the draft", async () => {
  for (const sh of ["rm -r course && ln -s guide course", "rm -r course && printf x > course"]) {
    const r = await runAuthor(author([{ name: "claude", steps: [{ sh }, { result: "Done." }] }]), job(), { step: () => {} });
    expect(r).toMatchObject({ status: "refused", refusal: { reason: "no-course", path: null } });
  }
});

test("a file that is neither regular nor a folder, a named pipe, refuses the draft", async () => {
  const r = await runAuthor(author([{ name: "claude", steps: [{ sh: "mkfifo course/reference/pipe" }, { result: "Done." }] }]), job(), { step: () => {} });
  expect(r).toMatchObject({ status: "refused", refusal: { reason: "not-regular", path: "reference/pipe" } });
});

test("an oversized file, too many files, too many bytes in all, too long a path and too deep a path each refuse the draft", async () => {
  const limits = { files: 4, fileBytes: 64, totalBytes: 150, pathBytes: 40, depth: 3 };
  const cases: [string, string, string | null][] = [
    ["head -c 65 /dev/zero > course/reference/big.bin", "file-too-large", "reference/big.bin"],
    ["printf x > course/reference/a && printf x > course/reference/b", "too-many-files", null],
    ["head -c 60 /dev/zero > course/reference/a && head -c 60 /dev/zero > course/reference/b && rm course/reference/notes.md", "total-too-large", null],
    ["printf x > course/reference/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "path-too-long", "reference/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["mkdir -p course/reference/a/b/c && printf x > course/reference/a/b/c/d", "too-deep", "reference/a/b/c/d"],
  ];
  for (const [sh, reason, path] of cases) {
    const r = await runAuthor(author([{ name: "claude", steps: [{ sh }, { result: "Done." }] }]), job({ limits }), { step: () => {} });
    expect([sh, r.status, r.status === "refused" ? r.refusal.reason : null, r.status === "refused" ? r.refusal.path : null]).toEqual([sh, "refused", reason, path]);
  }
  // At each limit exactly, the draft comes back.
  const at = await runAuthor(author([{ name: "claude", steps: [{ sh: "head -c 64 /dev/zero > course/reference/notes.md" }, { result: "Done." }] }]), job({ limits }), { step: () => {} });
  expect(at.status).toBe("succeeded");
});

test("the limits are RFC 7 Table 6.2's: 2,000 files, 8 MiB each, 64 MiB in all, 255-byte paths 8 folders deep", async () => {
  expect(DEFAULT_LIMITS).toMatchObject({ files: 2000, fileBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, pathBytes: 255, depth: 8 });
  const r = await runAuthor(author([{ name: "claude", steps: [{ sh: "head -c 8388609 /dev/zero > course/reference/big.bin" }, { result: "Done." }] }]), job(), { step: () => {} });
  expect(r).toMatchObject({ status: "refused", refusal: { reason: "file-too-large", path: "reference/big.bin" } });
});

test("the guide's digest is the manifest digest of exactly the files written into the folder for this request", async () => {
  // The oracle is the server's own manifest (server/skill.ts), read from a folder the test writes.
  const cfg = author([{ name: "claude", steps: [{ result: "Done." }] }]);
  const digestOf = (guide: CourseFile[]) => {
    const skill = join(dir, `guide-${crypto.randomUUID()}`);
    for (const f of guide) {
      mkdirSync(join(skill, f.path, ".."), { recursive: true });
      writeFileSync(join(skill, f.path), f.bytes);
    }
    for (const name of ["course-format", "voice"]) mkdirSync(join(skill, "docs", name), { recursive: true });
    return manifestDigest(guideManifest(skill, join(skill, "docs")));
  };
  const first = await runAuthor(cfg, job(), { step: () => {} });
  // A skill file edited between two requests: the next one reports the digest of what it sent.
  const edited = [file("SKILL.md", "# The school skill, revised\n"), GUIDE[1]!];
  const second = await runAuthor(cfg, job({ guide: edited }), { step: () => {} });
  expect([first.guideSha256, second.guideSha256]).toEqual([digestOf(GUIDE), digestOf(edited)]);
  expect(first.guideSha256).not.toBe(second.guideSha256);
});

test("the guide's digest of the checkout's own skill and references equals the digest School reports for them", async () => {
  const root = join(import.meta.dir, "..");
  const skill = join(root, ".agents", "skills", "school");
  const docs = join(root, "docs", "topics");
  const walk = (from: string, as: string): CourseFile[] => readdirSync(from).flatMap((name) => {
    const path = join(from, name);
    return statSync(path).isDirectory() ? walk(path, `${as}${name}/`) : [{ path: `${as}${name}`, bytes: readFileSync(path) }];
  });
  const guide = [...walk(skill, ""), ...walk(join(docs, "course-format"), "docs/course-format/"), ...walk(join(docs, "voice"), "docs/voice/")];
  const r = await runAuthor(author([{ name: "claude", steps: [{ result: "Done." }] }]), job({ guide }), { step: () => {} });
  expect(r.guideSha256).toBe(manifestDigest(guideManifest(skill, docs)));
});

test("an agent that fails before any step hands over to the next, in a fresh folder", async () => {
  const cfg = author([
    { name: "first", steps: [{ sh: `pwd -P > "$1/first"; printf 'spoilt\\n' > course/course.json` }, { exit: 1 }] },
    { name: "second", steps: [{ sh: `pwd -P > "$1/second"; cp course/course.json "$1/seen"` }, { result: "Done." }] },
  ]);
  const r = await runAuthor(cfg, job(), { step: () => {} });
  expect(r).toMatchObject({ status: "succeeded", agent: "second" });
  expect(r.attempts.map((a) => [a.agent, a.status, a.error])).toEqual([["first", "failed", "exit 1"], ["second", "succeeded", null]]);
  expect(readFileSync(join(gates, "seen"), "utf8")).toBe('{"title":"Fixture"}\n');
  expect(readFileSync(join(gates, "first"), "utf8")).not.toBe(readFileSync(join(gates, "second"), "utf8"));
});

test("an agent that fails after a step ends the request as failed, naming it, and no other agent runs", async () => {
  const cfg = author([
    { name: "first", steps: [{ tool: "Read", input: { file_path: "course/course.json" } }, { exit: 1 }] },
    { name: "second", steps: [{ mark: "second-ran" }, { result: "Done." }] },
  ]);
  const r = await runAuthor(cfg, job(), { step: () => {} });
  expect(r).toMatchObject({ status: "failed", agent: "first", error: "exit 1" });
  expect(reached("second-ran")).toBe(false);
});

test("a CLI error result, or no result line, is a failure; text and claude-json agents send no steps but their draft comes back", async () => {
  expect(await runAuthor(author([{ name: "e", steps: [{ result: "x", isError: true }] }]), job(), { step: () => {} })).toMatchObject({ status: "failed", error: "every author agent failed" });
  expect(await runAuthor(author([{ name: "n", steps: [] }]), job(), { step: () => {} })).toMatchObject({ status: "failed", attempts: [{ error: "claude-stream-json output had no result line" }] });
  const plain = plainAgent(dir, "plain", `printf 'p\\n' > course/OBJECTIVES.md; echo done`);
  const t = await runAuthor(author([{ name: "plain", command: `${plain} {prompt}`, output: "text" }]), job(), { step: () => { throw new Error("no step expected"); } });
  expect(t).toMatchObject({ status: "succeeded", agent: "plain", usage: null });
  if (t.status === "succeeded") expect(t.files.map((f) => f.path)).toContain("OBJECTIVES.md");
  const json = plainAgent(dir, "json", `printf '%s' '{"type":"result","is_error":false,"result":"ok","usage":${JSON.stringify(USAGE)}}'`);
  expect(await runAuthor(author([{ name: "json", command: `${json} {prompt}`, output: "claude-json" }]), job(), { step: () => {} })).toMatchObject({ status: "succeeded", usage: USAGE });
});

test("a missing program or a disabled agent is skipped; with none left the request fails and names no agent", async () => {
  const c = loadConfig({ agents: [{ name: "g", command: "true" }], author: { agents: [
    { name: "missing", command: "no-such-cli-qqq {prompt}" }, { name: "off", command: "true", enabled: false }] } });
  const r = await runAuthor(c.author!, job(), { step: () => {} });
  expect(r).toEqual({ status: "failed", agent: null, error: "every author agent failed", guideSha256: null,
    attempts: [{ agent: "missing", status: "skipped", error: "no-such-cli-qqq: not found on PATH", exitCode: null, ms: 0, steps: 0 }] });
});

test("an agent that hangs is killed at its timeout; a passed overall deadline skips the rest", async () => {
  const cfg = author([{ name: "hangs", steps: [{ hang: true }], timeout_seconds: 1 }, { name: "next", steps: [{ result: "Done." }] }]);
  const r = await runAuthor(cfg, job({ deadlineMs: 1000 }), { step: () => {} });
  expect(r.attempts.map((a) => [a.agent, a.status, a.error])).toEqual([["hangs", "failed", "timed out after 1 s"], ["next", "skipped", "the overall deadline had passed"]]);
});

test("a heartbeat is sent at the interval asked for while the agent works", async () => {
  const cfg = author([{ name: "claude", steps: [{ gate: "beat" }, { result: "Done." }] }]);
  let beats = 0;
  const r = await runAuthor(cfg, job({ heartbeatMs: 20 }), { step: () => {}, heartbeat: () => { beats++; if (beats === 2) open("beat"); } });
  expect(r.status).toBe("succeeded");
  expect(beats).toBeGreaterThanOrEqual(2);
});

test("layer 1: paths that are absolute, hold .. or a NUL, are empty, or name a folder twice over are refused before anything runs", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  const ok = entries([{ path: "lessons/01.json", base64: b64("{}") }, { path: "course.json", base64: b64("{}") }], "files");
  expect(ok.map(read)).toEqual([["lessons/01.json", "{}"], ["course.json", "{}"]]);
  const bad: [unknown, string][] = [
    [[{ path: "/etc/passwd", base64: "" }], "absolute"],
    [[{ path: "../guide/SKILL.md", base64: "" }], ".."],
    [[{ path: "lessons/../../x", base64: "" }], ".."],
    [[{ path: "lessons/a\u0000b", base64: "" }], "NUL"],
    [[{ path: "", base64: "" }], "empty"],
    [[{ path: "lessons//a", base64: "" }], "empty"],
    [[{ path: "./a", base64: "" }], "."],
    [[{ path: "lessons\\a", base64: "" }], "\\"],
    [[{ path: "a", base64: "" }, { path: "a", base64: "" }], "twice"],
    [[{ path: "Lessons/a", base64: "" }, { path: "lessons/a", base64: "" }], "twice"],
    [[{ path: "a", base64: "" }, { path: "a/b", base64: "" }], "both a file and a folder"],
    [[{ path: "a", base64: "not base64!" }], "base64"],
    [[{ path: "a" }], "base64"],
    ["not a list", "a list"],
    [[], "a list"],
  ];
  for (const [list, words] of bad) {
    let message = "";
    try {
      entries(list, "files");
    } catch (e) {
      if (!(e instanceof AuthorInputError)) throw e;
      message = e.message;
    }
    expect([JSON.stringify(list).slice(0, 60), message]).toEqual([JSON.stringify(list).slice(0, 60), expect.stringContaining(words)]);
  }
  expect(() => entries([{ path: "a.md", base64: "" }], "guide")).toThrow("SKILL.md");
  const limits = { files: 1, fileBytes: 2, totalBytes: 3, pathBytes: 10, depth: 1 };
  expect(() => entries([{ path: "a", base64: b64("x") }, { path: "b", base64: b64("x") }], "files", limits)).toThrow("at most 1");
  expect(() => entries([{ path: "a", base64: b64("xyz") }], "files", limits)).toThrow("2 bytes");
  expect(() => entries([{ path: "aaaaaaaaaaa", base64: "" }], "files", limits)).toThrow("10 bytes");
  expect(() => entries([{ path: "a/b/c", base64: "" }], "files", limits)).toThrow("folders deep");
});

test("the author list is optional, its own timeout defaults to 900 s, and it is checked like the grading list", () => {
  expect(loadConfig({ agents: [{ name: "g", command: "true" }] }).author).toBeNull();
  const c = loadConfig({ agents: [{ name: "g", command: "true" }], author: { agents: [{ name: "claude", command: "claude -p {prompt}", output: "claude-stream-json" }] } });
  expect(c.author).toEqual({ timeoutMs: 900_000, agents: [{ name: "claude", argv: ["claude", "-p", "{prompt}"], output: "claude-stream-json", timeoutMs: 900_000, enabled: true }] });
  for (const [author, words] of [
    [[], '"author" must be an object'], [{ agents: [] }, 'under "author"'], [{ timeout_seconds: 901, agents: [{ name: "a", command: "x" }] }, "author: timeout_seconds"],
    [{ agents: [{ name: "a", command: "x" }, { name: "a", command: "y" }] }, 'author agent "a" is listed twice'],
  ] as const) {
    expect(() => loadConfig({ agents: [{ name: "g", command: "true" }], author })).toThrow(words);
  }
});
