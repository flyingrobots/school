// Extracting a course from a git commit's tree (RFC 7 §4 and §6, task 5; flyingrobots/school#235).
//
// `extractCommit` reads one commit of a bare repository with git plumbing and writes only what
// School reads from a course (`course.json`, `lessons/*.json`, `reference/**`) into a new folder.
// The repository is hostile until checked, so:
//
// - Nothing is checked out and no hook, filter or attribute is consulted: the tree is listed with
//   `git ls-tree` and each blob read with `git cat-file --batch`, under a clean environment (no
//   system or global configuration, `core.hooksPath=/dev/null`, no replace objects).
// - The whole listing is checked before anything is written: every name (no `.`, `..`, empty
//   name, `.git` prefix in any case, `/`, `\` or control character, valid UTF-8), every mode (no
//   symlink, no submodule), the limits of Table 6.2 (`DEFAULT_LIMITS`), and names that would
//   collide on a case-insensitive or normalising filesystem. Sizes come from the listing, before
//   any blob is read. The first problem found is the answer.
// - Then the folder is created (its parent must exist; it must not) and each file written with
//   exclusive creation and mode 0644. A Git LFS pointer is found here, by its first line; any
//   refusal at this stage deletes the folder, so a refusal leaves nothing behind.
// - `git fsck --strict` runs after the listing's checks and before anything is written, for what a listing cannot show: a name holding `/` beside a folder
//   (fullPathname, refused as unsafe-name) and a name twice in a tree (duplicateEntries, refused as
//   case-collision). Creation that meets an existing name is a case-collision too, so no problem
//   throws: each is a `{ ok: false }` refusal.
// - Every git process has a time limit and is killed when it passes it.
//
// Only entries under the three installed names are listed and checked. Anything else in the
// repository (a README, `.github/`, a build script, a submodule elsewhere) is never read or
// written, so it cannot be refused either. The file limit counts every file under those names,
// written or not, and their folders may number at most `files × depth` (every folder a real course
// needs lies on some file's path), so a listing cannot grow without end.
// Fetching the commit is a separate step (RFC 7 task 6); this module takes a repository on disk.
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export type Limits = {
  /** Files under the installed names. Folders under them are bounded by `files × depth`. */
  files: number;
  /** Bytes in one installed file. */
  fileBytes: number;
  /** Bytes in all installed files together. */
  totalBytes: number;
  /** Bytes in one path, as UTF-8. */
  pathBytes: number;
  /** Folders a path may pass through. */
  depth: number;
  /** Milliseconds each git process may run. */
  gitMs: number;
};
const MiB = 1024 * 1024;
/** RFC 7 Table 6.2's starting values. */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ files: 2000, fileBytes: 8 * MiB, totalBytes: 64 * MiB, pathBytes: 255, depth: 8, gitMs: 60_000 });

export type RefusalReason =
  | "bad-destination" | "not-a-commit" | "unsafe-name" | "case-collision" | "symlink" | "submodule" | "lfs-pointer"
  | "too-many-files" | "file-too-large" | "total-too-large" | "path-too-long" | "too-deep" | "timeout" | "git-failed";
/** Why a commit was not extracted: the reason, the tree path it concerns (or null), and a sentence for a person. */
export type Refusal = { reason: RefusalReason; path: string | null; message: string };
export type ExtractedFile = { path: string; bytes: number };
export type Extraction =
  | { ok: true; folder: string; commit: string; files: ExtractedFile[]; bytes: number }
  | { ok: false; refusal: Refusal };
export type ExtractRequest = {
  /** A bare repository (its git directory) holding the commit. */
  repository: string;
  /** The commit's full hash: 40 or 64 lowercase hex digits. */
  commit: string;
  /** The folder to create and write into. Its parent must exist; it must not. */
  into: string;
  limits?: Partial<Limits>;
  /** The git executable; `git` from PATH by default. */
  git?: string;
};

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const LFS_POINTER = new TextEncoder().encode("version https://git-lfs.github.com/spec/v1");
const INSTALLED = ["course.json", "lessons", "reference"];
const REGULAR = new Set(["100644", "100755"]);
const ENTRY = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64}) +(\d+|-)$/;
// Control characters, C0 and C1, and DEL.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}
const refuse = (reason: RefusalReason, path: string | null, message: string): never => {
  throw new Refused({ reason, path, message });
};
const quoted = (path: string) => JSON.stringify(path);

/** Why one name in a tree is unsafe to write, or null when it is safe. */
function unsafeName(name: string): string | null {
  if (name === "") return "an empty name";
  if (name === "." || name === "..") return `a name ${quoted(name)}`;
  if (name.toLowerCase().startsWith(".git")) return "a name starting .git";
  if (name.includes("\\")) return "a backslash";
  if (CONTROL.test(name)) return "a control character";
  return null;
}

/**
 * The key two names share when a case-insensitive, normalising filesystem would treat them as one.
 * Upper-casing first applies the full case mappings that `toLowerCase` alone lacks (s and ſ, σ and ς,
 * ss and ß, ff and ﬀ, μ and µ, K and the Kelvin sign).
 */
const folded = (path: string) => path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");

/** What School installs: course.json, a lesson file directly in lessons/, anything in reference/. */
const installed = (path: string) =>
  path === "course.json" || (path.startsWith("lessons/") && !path.slice(8).includes("/") && path.endsWith(".json")) || path.startsWith("reference/");

type Git = { bin: string; repository: string; home: string; ms: number };
type Run = { code: number; stdout: Uint8Array; stderr: string };

/**
 * Runs one git command against the repository under a clean environment and a time limit. With
 * `onChunk`, stdout is handed over as it arrives (a Refused thrown from it kills git); otherwise
 * it is collected, up to `maxStdout` bytes.
 */
async function run(g: Git, args: string[], o: { input?: Uint8Array; maxStdout?: number; maxStderr?: number; onChunk?: (chunk: Uint8Array) => void } = {}): Promise<Run> {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: g.home, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0",
  };
  const argv = [g.bin, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false", "--git-dir", g.repository, ...args];
  let proc;
  try {
    proc = Bun.spawn(argv, { env, cwd: g.home, stdin: o.input ?? "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return refuse("git-failed", null, `git could not be started: ${e instanceof Error ? e.message : String(e)}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, g.ms);
  const stderr = new Response(proc.stderr).text();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  let failure: unknown = null;
  try {
    for await (const chunk of proc.stdout) {
      if (o.onChunk) o.onChunk(chunk);
      else {
        collected += chunk.length;
        if (collected > (o.maxStdout ?? 0)) refuse("git-failed", null, `git ${args[0]} wrote more than expected`);
        chunks.push(chunk);
      }
    }
  } catch (e) {
    failure = e;
    proc.kill("SIGKILL");
  }
  const code = await proc.exited;
  clearTimeout(timer);
  const err = (await stderr).slice(0, o.maxStderr ?? 2000).trim();
  if (timedOut) refuse("timeout", null, `git ${args[0]} ran longer than ${g.ms} ms and was stopped`);
  if (failure !== null) throw failure;
  return { code, stdout: Buffer.concat(chunks), stderr: err };
}

/**
 * Asks git's own strict checker about the commit and its trees, for what the listing cannot show:
 * a name holding `/` (fullPathname) that sits beside a folder of its first part, and a name twice in
 * one tree (duplicateEntries). Any other finding is left to the checks that follow.
 */
async function fsck(g: Git, commit: string): Promise<void> {
  const r = await run(g, ["fsck", "--strict", "--no-dangling", commit], { maxStdout: 1 << 20, maxStderr: 1 << 20 });
  const finding = (kind: string) => r.stderr.split("\n").find((line) => line.includes(`${kind}:`));
  const slash = finding("fullPathname");
  if (slash) refuse("unsafe-name", null, `git's check found a tree entry whose name holds /: ${slash}`);
  const twice = finding("duplicateEntries");
  if (twice) refuse("case-collision", null, `git's check found one name twice in a tree: ${twice}`);
}

type Planned = { path: string; id: string; size: number };

/** Lists the installed names' entries and checks every one; returns the files to write. */
async function plan(g: Git, commit: string, limits: Limits): Promise<Planned[]> {
  const files: Planned[] = [];
  const trees = new Set<string>();
  const keys = new Map<string, string>();
  let fileCount = 0;
  let folderCount = 0;
  let total = 0;
  let pending = new Uint8Array(0);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maxRecord = Math.max(limits.pathBytes, 4096) + 256;

  const entry = (record: Uint8Array) => {
    const tab = record.indexOf(9);
    const meta = tab < 0 ? null : ENTRY.exec(new TextDecoder().decode(record.subarray(0, tab)));
    if (!meta) return refuse("git-failed", null, "git ls-tree printed a line School does not understand");
    const [, mode = "", type = "", id = "", size = ""] = meta;
    const raw = record.subarray(tab + 1);
    let path: string;
    try {
      path = decoder.decode(raw);
    } catch {
      return refuse("unsafe-name", new TextDecoder().decode(raw), `${quoted(new TextDecoder().decode(raw))} is not UTF-8`);
    }
    for (const name of path.split("/")) {
      const why = unsafeName(name);
      if (why) refuse("unsafe-name", path, `${quoted(path)} holds ${why}`);
    }
    const parent = path.includes("/") ? dirname(path) : "";
    if (parent !== "" && !trees.has(parent)) refuse("unsafe-name", path, `${quoted(path)} has a name holding /`);
    if (type === "tree") {
      if (path.includes("/") && ++folderCount > limits.files * limits.depth) refuse("too-many-files", path, `more than ${limits.files * limits.depth} folders under ${INSTALLED.join(", ")}`);
      trees.add(path);
      return;
    }
    if (mode === "120000") refuse("symlink", path, `${quoted(path)} is a symlink; School installs only regular files`);
    if (mode === "160000" || type === "commit") refuse("submodule", path, `${quoted(path)} is a submodule; School does not fetch submodules`);
    if (!REGULAR.has(mode) || type !== "blob" || size === "-") return refuse("git-failed", path, `${quoted(path)} has mode ${mode}, which School does not understand`);
    if (++fileCount > limits.files) refuse("too-many-files", path, `more than ${limits.files} files under ${INSTALLED.join(", ")}`);
    if (Buffer.byteLength(path) > limits.pathBytes) refuse("path-too-long", path, `${quoted(path)} is longer than ${limits.pathBytes} bytes`);
    if (path.split("/").length - 1 > limits.depth) refuse("too-deep", path, `${quoted(path)} is more than ${limits.depth} folders deep`);
    if (!installed(path)) return;
    const bytes = Number(size);
    if (bytes > limits.fileBytes) refuse("file-too-large", path, `${quoted(path)} is ${bytes} bytes, more than ${limits.fileBytes}`);
    total += bytes;
    if (total > limits.totalBytes) refuse("total-too-large", path, `the course's files come to more than ${limits.totalBytes} bytes`);
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      const seen = keys.get(folded(folder));
      if (seen === undefined) keys.set(folded(folder), folder);
      else if (seen !== folder) refuse("case-collision", path, `${quoted(path)} and ${quoted(seen)} name the same folder on a case-insensitive filesystem`);
    }
    const seen = keys.get(folded(path));
    if (seen !== undefined) refuse("case-collision", path, `${quoted(path)} and ${quoted(seen)} name the same file on a case-insensitive filesystem`);
    keys.set(folded(path), path);
    files.push({ path, id, size: bytes });
  };

  const r = await run(g, ["ls-tree", "-r", "-t", "-l", "-z", commit, "--", ...INSTALLED], {
    onChunk: (chunk) => {
      let buf = Buffer.concat([pending, chunk]);
      let nul: number;
      while ((nul = buf.indexOf(0)) >= 0) {
        entry(buf.subarray(0, nul));
        buf = buf.subarray(nul + 1);
      }
      if (buf.length > maxRecord) refuse("path-too-long", null, `a path is longer than ${limits.pathBytes} bytes`);
      pending = buf;
    },
  });
  if (r.code !== 0) refuse("git-failed", null, `git ls-tree failed: ${r.stderr}`);
  if (pending.length > 0) refuse("git-failed", null, "git ls-tree's output ended mid-entry");
  return files;
}

const startsWith = (data: Uint8Array, prefix: Uint8Array) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

/** Runs one creation; a name already taken is a case-collision the checks missed, never an error with a path in it. */
function create(path: string, make: () => void): void {
  try {
    make();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") refuse("case-collision", path, `${quoted(path)} names something already written, so the filesystem treats two names as one`);
    throw e;
  }
}

/** Reads every planned blob in one `git cat-file --batch` and writes it under `into`. */
async function write(g: Git, files: Planned[], into: string): Promise<void> {
  if (files.length === 0) return;
  const headers = files.map((f) => `${f.id} blob ${f.size}\n`);
  const expected = files.reduce((n, f, i) => n + (headers[i] ?? "").length + f.size + 1, 0);
  const r = await run(g, ["cat-file", "--batch"], { input: new TextEncoder().encode(files.map((f) => `${f.id}\n`).join("")), maxStdout: expected });
  if (r.code !== 0) refuse("git-failed", null, `git cat-file failed: ${r.stderr}`);
  const out = r.stdout;
  let at = 0;
  const made = new Set<string>();
  const root = resolve(into);
  for (const [i, f] of files.entries()) {
    const header = headers[i] ?? "";
    const got = new TextDecoder().decode(out.subarray(at, at + header.length));
    if (got !== header) refuse("git-failed", f.path, `git cat-file gave ${quoted(got.trim())} for ${quoted(f.path)}, expected ${quoted(header.trim())}`);
    at += header.length;
    const data = out.subarray(at, at + f.size);
    at += f.size + 1;
    if (startsWith(data, LFS_POINTER)) refuse("lfs-pointer", f.path, `${quoted(f.path)} is a Git LFS pointer; School does not fetch LFS objects`);
    const target = resolve(root, f.path);
    if (!target.startsWith(root + sep)) refuse("unsafe-name", f.path, `${quoted(f.path)} resolves outside the folder`);
    const parts = f.path.split("/");
    for (let k = 1; k < parts.length; k++) {
      const folder = parts.slice(0, k).join("/");
      if (!made.has(folder)) { create(f.path, () => mkdirSync(join(root, folder))); made.add(folder); }
    }
    create(f.path, () => writeFileSync(target, data, { flag: "wx", mode: 0o644 }));
  }
}

/** Extracts `commit`'s course files into a new folder `into`, or says why it will not. */
export async function extractCommit(request: ExtractRequest): Promise<Extraction> {
  const limits: Limits = { ...DEFAULT_LIMITS, ...request.limits };
  const into = resolve(request.into);
  let created = false;
  try {
    if (!HASH.test(request.commit)) refuse("not-a-commit", null, `${quoted(request.commit)} is not a full commit hash`);
    const parent = dirname(into);
    if (!lstatSync(parent, { throwIfNoEntry: false })?.isDirectory()) refuse("bad-destination", null, `${quoted(parent)} is not a folder`);
    if (lstatSync(into, { throwIfNoEntry: false }) !== undefined) refuse("bad-destination", null, `${quoted(into)} already exists`);
    const g: Git = { bin: request.git ?? "git", repository: request.repository, home: parent, ms: limits.gitMs };

    const check = await run(g, ["cat-file", "--batch-check"], { input: new TextEncoder().encode(`${request.commit}\n`), maxStdout: 256 });
    if (check.code !== 0) refuse("git-failed", null, `git could not read ${quoted(request.repository)}: ${check.stderr}`);
    const type = new TextDecoder().decode(check.stdout).trim().split(" ")[1];
    if (type !== "commit") refuse("not-a-commit", null, `${request.commit} is ${type === "missing" ? "not in the repository" : `a ${type}, not a commit`}`);

    const files = await plan(g, request.commit, limits);
    await fsck(g, request.commit);
    try {
      mkdirSync(into);
    } catch (e) {
      return refuse("bad-destination", null, `${quoted(into)} could not be created: ${e instanceof Error ? e.message : String(e)}`);
    }
    created = true;
    await write(g, files, into);
    return { ok: true, folder: into, commit: request.commit, files: files.map((f) => ({ path: f.path, bytes: f.size })), bytes: files.reduce((n, f) => n + f.size, 0) };
  } catch (e) {
    if (created) rmSync(into, { recursive: true, force: true });
    if (e instanceof Refused) return { ok: false, refusal: e.refusal };
    throw e;
  }
}
