// Extracting a course from a git commit's tree (flyingrobots/school#235, RFC 7 §6). Every case
// builds its own bare repository under a scratch folder this file creates, extracts one commit into
// `<staging>/course`, and checks what was written. The hostile corpus is one repository per refusal
// in RFC 7 Table 6.1 and per limit in Table 6.2; each must be refused with its reason and leave
// nothing anywhere under the scratch folder except its own repository. Tree objects are written by
// server/testing/git-trees.ts, since git will not make most of them. docs/topics/course-format/
// test-plan.md lists these cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DEFAULT_LIMITS, extractCommit, type Extraction, type Limits, type RefusalReason } from "./extract-tree.ts";
import { dir, file, git, repository, submodule, symlink, writeTree, type Entry } from "./testing/git-trees.ts";

const root = mkdtempSync(join(tmpdir(), "school-extract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const EXAMPLE = join(import.meta.dir, "..", ".agents", "skills", "school", "example");

let n = 0;
/** A staging folder holding a bare repository of one commit of `entries`. */
function scene(entries: Entry[], sorted = true) {
  const staging = join(root, `s${++n}`);
  mkdirSync(staging);
  const repo = join(staging, "repo.git");
  const commit = repository(repo, entries, sorted);
  return { staging, repo, commit, into: join(staging, "course") };
}

/** Every path under the scratch folder, except inside the bare repositories, which git owns. */
function everything(): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      if (name === "repo.git") continue;
      out.push(relative(root, p));
      if (lstatSync(p).isDirectory()) walk(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Every file under `folder`, relative to it, in sorted order. */
function filesUnder(folder: string): string[] {
  return everything().map((p) => join(root, p)).filter((p) => p.startsWith(`${folder}/`) && lstatSync(p).isFile()).map((p) => relative(folder, p)).sort();
}

const ref = (...entries: Entry[]): Entry => ["reference", dir(...entries)];
const lessons = (...entries: Entry[]): Entry => ["lessons", dir(...entries)];
const LFS = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";

function refused(r: Extraction) {
  if (r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.refusal;
}
function extracted(r: Extraction) {
  if (!r.ok) throw new Error(`expected an extraction, got ${JSON.stringify(r)}`);
  return r;
}

type Hostile = { name: string; entries: Entry[]; reason: RefusalReason; path?: string; limits?: Partial<Limits>; sorted?: boolean };
// Oracle: RFC 7 Table 6.1 (every row extraction owns) and Table 6.2 (every limit on what is installed).
const HOSTILE: Hostile[] = [
  { name: "a symlink in reference/", entries: [ref(["passwd.html", symlink("/etc/passwd")])], reason: "symlink", path: "reference/passwd.html" },
  { name: "lessons/ as a symlink out of the folder", entries: [["lessons", symlink("../../..")]], reason: "symlink", path: "lessons" },
  { name: "course.json as a symlink", entries: [["course.json", symlink("/etc/passwd")]], reason: "symlink", path: "course.json" },
  { name: "a submodule in reference/", entries: [ref(["vendor", submodule("a".repeat(40))])], reason: "submodule", path: "reference/vendor" },
  { name: "a Git LFS pointer", entries: [ref(["big.pdf", file(LFS)])], reason: "lfs-pointer", path: "reference/big.pdf" },
  { name: "folders named .. climbing out of staging", entries: [ref(["..", dir(["..", dir(["..", dir(["escape.html", file("out")])])])])], reason: "unsafe-name", path: "reference/../../../escape.html" },
  { name: "a name holding ../ that climbs out of staging", entries: [ref(["../../../escape.html", file("out")])], reason: "unsafe-name", path: "reference/../../../escape.html" },
  { name: "an absolute path", entries: [ref(["/tmp/escape.html", file("out")])], reason: "unsafe-name", path: "reference//tmp/escape.html" },
  { name: "a folder named .", entries: [ref([".", dir(["x.html", file("x")])])], reason: "unsafe-name", path: "reference/./x.html" },
  { name: "a .git folder", entries: [ref([".git", dir(["config", file("[core]\n")])])], reason: "unsafe-name", path: "reference/.git/config" },
  { name: "a .GIT folder in another case", entries: [lessons([".GIT", dir(["HEAD", file("x")])])], reason: "unsafe-name", path: "lessons/.GIT/HEAD" },
  { name: "a .gitattributes file", entries: [ref([".gitattributes", file("* filter=evil\n")])], reason: "unsafe-name", path: "reference/.gitattributes" },
  { name: "a name holding a backslash", entries: [ref(["..\\escape.html", file("out")])], reason: "unsafe-name", path: "reference/..\\escape.html" },
  { name: "a name holding a control character", entries: [ref(["a\u0001.html", file("x")])], reason: "unsafe-name", path: "reference/a\u0001.html" },
  { name: "a name holding a newline", entries: [ref(["a\n.html", file("x")])], reason: "unsafe-name", path: "reference/a\n.html" },
  { name: "a name holding DEL", entries: [ref(["a\u007f.html", file("x")])], reason: "unsafe-name", path: "reference/a\u007f.html" },
  { name: "a name that is not UTF-8", entries: [ref([new Uint8Array([0x61, 0xff, 0x2e, 0x68]), file("x")])], reason: "unsafe-name" },
  { name: "an empty name", entries: [ref(["", file("x")])], reason: "unsafe-name", path: "reference/" },
  { name: "two files equal after case folding", entries: [ref(["A.html", file("1")], ["a.html", file("2")])], reason: "case-collision", path: "reference/a.html" },
  { name: "two files equal after Unicode NFC", entries: [ref(["é.html", file("1")], ["é.html", file("2")])], reason: "case-collision", path: "reference/é.html" },
  { name: "two folders equal after case folding", entries: [ref(["Docs", dir(["x.html", file("1")])], ["docs", dir(["y.html", file("2")])])], reason: "case-collision", path: "reference/docs/y.html" },
  { name: "two lessons equal after case folding", entries: [lessons(["A.json", file("{}")], ["a.json", file("{}")])], reason: "case-collision", path: "lessons/a.json" },
  { name: "one name twice in a tree", entries: [ref(["a.html", file("1")], ["a.html", file("2")])], reason: "case-collision", path: "reference/a.html", sorted: false },
  { name: "more folders than the limit", entries: [ref(["a", dir()], ["b", dir()], ["c", dir()])], limits: { files: 2 }, reason: "too-many-files", path: "reference/c" },
  { name: "more files than the limit", entries: [ref(["a", file("1")], ["b", file("2")], ["c", file("3")])], limits: { files: 2 }, reason: "too-many-files", path: "reference/c" },
  { name: "a file over the limit", entries: [ref(["a.html", file("12345")])], limits: { fileBytes: 4 }, reason: "file-too-large", path: "reference/a.html" },
  { name: "files whose total is over the limit", entries: [ref(["a", file("123")], ["b", file("456")], ["c", file("789")])], limits: { totalBytes: 8 }, reason: "total-too-large", path: "reference/c" },
  { name: "a path one byte over 255", entries: [ref(["x".repeat(246), file("x")])], reason: "path-too-long", path: `reference/${"x".repeat(246)}` },
  { name: "a file nine folders deep", entries: [ref(["a", dir(["b", dir(["c", dir(["d", dir(["e", dir(["f", dir(["g", dir(["h", dir(["x.html", file("x")])])])])])])])])])], reason: "too-deep", path: "reference/a/b/c/d/e/f/g/h/x.html" },
];

describe("extracting a commit's tree", () => {
  test.each(HOSTILE.map((h) => [h.name, h] as const))("EXTRACT-1: %s is refused with its reason, leaving nothing outside staging", async (_name, h) => {
    const s = scene(h.entries, h.sorted ?? true);
    const before = everything();
    const r = refused(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into, ...(h.limits ? { limits: h.limits } : {}) }));
    expect(r.reason).toBe(h.reason);
    if (h.path !== undefined) expect(r.path).toBe(h.path);
    expect(r.message.length).toBeGreaterThan(0);
    expect(existsSync(s.into)).toBe(false);
    expect(everything()).toEqual(before);
  });

  test("EXTRACT-2: the example course, committed with git, extracts byte-identical files and nothing else", async () => {
    const staging = join(root, `s${++n}`);
    const work = join(staging, "work");
    cpSync(EXAMPLE, work, { recursive: true });
    git(["init", "--quiet", work]);
    git(["add", "--all"], work);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--quiet", "-m", "example"], work);
    const repo = join(staging, "repo.git");
    git(["clone", "--bare", "--quiet", work, repo]);
    const commit = git(["--git-dir", repo, "rev-parse", "HEAD"]).trim();
    rmSync(work, { recursive: true });
    const into = join(staging, "course");
    const r = extracted(await extractCommit({ repository: repo, commit, into }));
    // Oracle: the course-format page's list of what School reads, applied to the example folder.
    const expected = ["course.json", ...readdirSync(join(EXAMPLE, "lessons")).filter((f) => f.endsWith(".json")).map((f) => `lessons/${f}`),
      ...readdirSync(join(EXAMPLE, "reference")).map((f) => `reference/${f}`)].sort();
    expect(filesUnder(into)).toEqual(expected);
    for (const p of expected) expect(Buffer.compare(readFileSync(join(into, p)), readFileSync(join(EXAMPLE, p)))).toBe(0);
    expect(r).toMatchObject({ folder: into, commit });
    expect(r.files.map((f) => f.path).sort()).toEqual(expected);
    expect(r.bytes).toBe(expected.reduce((sum, p) => sum + statSync(join(EXAMPLE, p)).size, 0));
  });

  test("EXTRACT-3: only course.json, lessons/*.json and reference/** are written; everything else is skipped, symlinks included", async () => {
    const s = scene([
      ["README.md", file("# read me\n")], ["README", symlink("/etc/passwd")], [".github", dir(["workflows", dir(["ci.yml", file("on: push\n")])])],
      [".gitattributes", file("* filter=evil\n")], ["build.sh", file("#!/bin/sh\nrm -rf /\n", true)], ["vendor", submodule("b".repeat(40))],
      ["course.json", file('{"title":"T"}')],
      lessons(["0001-a.json", file("{}")], ["notes.md", file("notes")], ["drafts", dir(["0002-b.json", file("{}")])]),
      ref(["a", dir(["b.html", file("<p>b</p>")])]),
    ]);
    extracted(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into }));
    expect(filesUnder(s.into)).toEqual(["course.json", "lessons/0001-a.json", "reference/a/b.html"]);
  });

  test("EXTRACT-4: hooks, filters and attributes are never consulted", async () => {
    const s = scene([[".gitattributes", file("* filter=evil eol=lf\n")], ref(["a.html", file("line one\r\nline two\r\n")])]);
    const marker = join(s.staging, "ran");
    git(["--git-dir", s.repo, "config", "filter.evil.smudge", `touch ${marker}; cat`]);
    git(["--git-dir", s.repo, "config", "filter.evil.textconv", `touch ${marker}; cat`]);
    for (const hook of ["post-checkout", "post-merge", "pre-commit", "reference-transaction"]) {
      writeFileSync(join(s.repo, "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`);
      chmodSync(join(s.repo, "hooks", hook), 0o755);
    }
    extracted(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into }));
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(s.into, "reference", "a.html"), "utf8")).toBe("line one\r\nline two\r\n");
  });

  test("EXTRACT-5: a file marked executable is written as an ordinary file no one can run", async () => {
    const s = scene([ref(["run.html", file("<p>x</p>", true)])]);
    extracted(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into }));
    expect(statSync(join(s.into, "reference", "run.html")).mode & 0o111).toBe(0);
  });

  test("EXTRACT-6: a course exactly at every limit is extracted", async () => {
    const deep = ["a", "b", "c", "d", "e", "f", "g"].reduceRight<Entry>((inner, name) => [name, dir(inner)], ["x", file("1")]);
    const s = scene([ref(["y".repeat(245), file("12")], deep, ["z", file("1")])]);
    const r = extracted(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into, limits: { files: 3, fileBytes: 2, totalBytes: 4 } }));
    // Oracle: Table 6.2. `reference/` + 245 bytes is a 255-byte path; reference/a/.../g is 8 folders.
    expect(filesUnder(s.into)).toEqual(["reference/a/b/c/d/e/f/g/x", `reference/${"y".repeat(245)}`, "reference/z"]);
    expect(r.bytes).toBe(4);
  });

  test("EXTRACT-7: a commit with none of School's files extracts an empty folder", async () => {
    const s = scene([["README.md", file("hello")]]);
    const r = extracted(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into }));
    expect(r.files).toEqual([]);
    expect(readdirSync(s.into)).toEqual([]);
  });

  test.each([
    ["a branch name", (_c: string): string => "HEAD"],
    ["something shaped like an option", (_c: string): string => "--output=/tmp/x"],
    ["an abbreviated hash", (c: string): string => c.slice(0, 12)],
    ["a hash no object has", (_c: string): string => "0".repeat(40)],
  ] as const)("EXTRACT-8: %s is refused as not a commit, before anything is written", async (_name, commitOf) => {
    const s = scene([ref(["a.html", file("x")])]);
    const before = everything();
    const r = refused(await extractCommit({ repository: s.repo, commit: commitOf(s.commit), into: s.into }));
    expect(r.reason).toBe("not-a-commit");
    expect(everything()).toEqual(before);
  });

  test("EXTRACT-8: a tree's hash is refused as not a commit", async () => {
    const s = scene([ref(["a.html", file("x")])]);
    const tree = writeTree(s.repo, [ref(["b.html", file("y")])]);
    const r = refused(await extractCommit({ repository: s.repo, commit: tree, into: s.into }));
    expect(r.reason).toBe("not-a-commit");
    expect(existsSync(s.into)).toBe(false);
  });

  test("EXTRACT-9: a destination that already exists is refused and left as it was", async () => {
    const s = scene([ref(["a.html", file("x")])]);
    mkdirSync(s.into);
    writeFileSync(join(s.into, "keep"), "mine");
    const before = everything();
    const r = refused(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into }));
    expect(r.reason).toBe("bad-destination");
    expect(everything()).toEqual(before);
    expect(readFileSync(join(s.into, "keep"), "utf8")).toBe("mine");
  });

  test("EXTRACT-9: a destination whose parent folder does not exist is refused, creating nothing", async () => {
    const s = scene([ref(["a.html", file("x")])]);
    const before = everything();
    const r = refused(await extractCommit({ repository: s.repo, commit: s.commit, into: join(s.staging, "missing", "course") }));
    expect(r.reason).toBe("bad-destination");
    expect(everything()).toEqual(before);
  });

  test("EXTRACT-10: a git process over the time limit is killed and the extraction refused", async () => {
    const s = scene([ref(["a.html", file("x")])]);
    const slow = join(s.staging, "slow-git");
    writeFileSync(slow, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(slow, 0o755);
    const before = everything();
    const started = performance.now();
    const r = refused(await extractCommit({ repository: s.repo, commit: s.commit, into: s.into, git: slow, limits: { gitMs: 200 } }));
    expect(r.reason).toBe("timeout");
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(everything()).toEqual(before);
  });

  test("EXTRACT-11: a folder that is not a repository is refused as a git failure", async () => {
    const s = scene([ref(["a.html", file("x")])]);
    const empty = join(s.staging, "empty");
    mkdirSync(empty);
    const r = refused(await extractCommit({ repository: empty, commit: s.commit, into: s.into }));
    expect(r.reason).toBe("git-failed");
    expect(existsSync(s.into)).toBe(false);
  });

  test("the default limits are RFC 7 Table 6.2's", () => {
    const MiB = 1024 * 1024;
    expect(DEFAULT_LIMITS).toEqual({ files: 2000, fileBytes: 8 * MiB, totalBytes: 64 * MiB, pathBytes: 255, depth: 8, gitMs: 60_000 });
  });
});

// Generated trees (TESTING_STANDARDS rule 5). A fixed seed in CI; set SCHOOL_FUZZ_SEED to try another.
// Replay one: SCHOOL_FUZZ_SEED=<seed> bun test server/extract-tree.test.ts
const SEED = Number(process.env.SCHOOL_FUZZ_SEED ?? 235);
const CASES = 30;

/** mulberry32: a small seeded generator, so a failing case can be replayed from its seed. */
function generator(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  return { int, pick };
}

/** Nests `path`'s folders into an entry list; the last part is the file. */
function place(entries: Entry[], parts: string[], content: string) {
  const [head, ...rest] = parts as [string, ...string[]];
  if (rest.length === 0) { entries.push([head, file(content)]); return; }
  let sub = entries.find(([name, node]) => name === head && node.kind === "dir");
  if (!sub) { sub = [head, dir()]; entries.push(sub); }
  const node = sub[1];
  if (node.kind === "dir") place(node.entries, rest, content);
}

describe(`generated trees (SCHOOL_FUZZ_SEED=${SEED})`, () => {
  const LIMITS: Limits = { files: 5, fileBytes: 12, totalBytes: 40, pathBytes: 28, depth: 3, gitMs: 60_000 };

  test("EXTRACT-12: a tree of safe names is refused exactly when it passes a limit, and otherwise extracted byte for byte", async () => {
    const g = generator(SEED);
    const outcomes = new Map<string, number>();
    for (let c = 0; c < CASES; c++) {
      const files = new Map<string, string>();
      const count = g.int(0, 7);
      for (let i = 0; i < count; i++) {
        const depth = g.int(0, 4);
        const parts = ["reference", ...Array.from({ length: depth }, () => g.pick(["a", "b", "cc"])), `f${i}${"x".repeat(g.int(0, 8))}`];
        files.set(parts.join("/"), "z".repeat(g.int(0, 15)));
      }
      const entries: Entry[] = [];
      for (const [p, content] of files) place(entries, p.split("/"), content);
      const s = scene(entries);
      const before = everything();
      const r = await extractCommit({ repository: s.repo, commit: s.commit, into: s.into, limits: LIMITS });
      // Oracle: Table 6.2 applied to the generated list directly, not to the tree.
      const over = new Set<RefusalReason>();
      if (files.size > LIMITS.files) over.add("too-many-files");
      let total = 0;
      for (const [p, content] of files) {
        if (content.length > LIMITS.fileBytes) over.add("file-too-large");
        total += content.length;
        if (Buffer.byteLength(p) > LIMITS.pathBytes) over.add("path-too-long");
        if (p.split("/").length - 1 > LIMITS.depth) over.add("too-deep");
      }
      if (total > LIMITS.totalBytes) over.add("total-too-large");
      const label = `seed ${SEED}, case ${c}: ${JSON.stringify([...files.keys()])}`;
      if (r.ok) {
        expect({ label, over: [...over] }).toEqual({ label, over: [] });
        expect(filesUnder(s.into)).toEqual([...files.keys()].map((p) => p).sort());
        for (const [p, content] of files) expect(readFileSync(join(s.into, p), "utf8")).toBe(content);
      } else {
        expect({ label, reason: over.has(r.refusal.reason) }).toEqual({ label, reason: true });
        expect(existsSync(s.into)).toBe(false);
        expect(everything()).toEqual(before);
      }
      const key = r.ok ? "extracted" : r.refusal.reason;
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
    // Both outcomes must occur, or the generator proves nothing.
    expect(outcomes.get("extracted") ?? 0).toBeGreaterThan(0);
    expect(CASES - (outcomes.get("extracted") ?? 0)).toBeGreaterThan(0);
    console.log(`EXTRACT-12 outcomes (seed ${SEED}): ${JSON.stringify(Object.fromEntries(outcomes))}`);
  }, 60_000);

  test("EXTRACT-13: a tree of random names never writes outside its folder, and writes only safe, distinct names", async () => {
    const g = generator(SEED + 1);
    const PIECES = ["a", "A", ".", "..", ".git", ".Git", "\\", "\u0001", "\n", "é", "é", "/", "x.json", "x.JSON", " ", "-", "~"] as const;
    // Oracle, written from Table 6.1 independently of the module: a safe name is not empty, `.` or
    // `..`, does not start with `.git` in any case, and holds no `/`, `\` or control character.
    const safe = (name: string) => name !== "" && name !== "." && name !== ".." && !name.toLowerCase().startsWith(".git") && !/[/\\\u0000-\u001f\u007f-\u009f]/.test(name);
    let extractedCount = 0;
    for (let c = 0; c < CASES; c++) {
      const entries: Entry[] = [];
      const count = g.int(1, 5);
      for (let i = 0; i < count; i++) {
        const name = Array.from({ length: g.int(1, 3) }, () => g.pick(PIECES)).join("");
        const top = g.pick(["reference", "lessons"] as const);
        const sub = entries.find(([n]) => n === top);
        const entry: Entry = [name, file(`c${i}`)];
        if (sub && sub[1].kind === "dir") sub[1].entries.push(entry);
        else entries.push([top, dir(entry)]);
      }
      const s = scene(entries);
      const before = everything();
      const r = await extractCommit({ repository: s.repo, commit: s.commit, into: s.into });
      const label = `seed ${SEED + 1}, case ${c}`;
      if (r.ok) {
        extractedCount++;
        const written = filesUnder(s.into);
        const folded = new Set(written.map((p) => p.normalize("NFC").toLowerCase()));
        expect({ label, unsafe: written.filter((p) => !p.split("/").every(safe)) }).toEqual({ label, unsafe: [] });
        expect({ label, distinct: folded.size }).toEqual({ label, distinct: written.length });
        const after = everything();
        expect({ label, outside: after.filter((p) => !before.includes(p) && !join(root, p).startsWith(`${s.into}`)) }).toEqual({ label, outside: [] });
      } else {
        expect({ label, left: existsSync(s.into) }).toEqual({ label, left: false });
        expect(everything()).toEqual(before);
      }
    }
    expect(extractedCount).toBeGreaterThan(0);
    expect(CASES - extractedCount).toBeGreaterThan(0);
  }, 60_000);
});

