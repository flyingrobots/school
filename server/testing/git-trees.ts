// Building git repositories for the extraction tests (server/extract-tree.test.ts,
// flyingrobots/school#235). A hostile tree cannot be made with a checkout or `git add`: git refuses
// names like `..` and `.git`, and a case-insensitive filesystem cannot hold `A.html` beside
// `a.html`. So this helper writes the objects itself, as loose objects in a bare repository that
// `git init --bare` made: each is `<type> <size>\0<content>`, named by its SHA-1 and stored
// zlib-compressed under `objects/`, as git's own object format specifies. The names, modes and
// contents in a tree are exactly the bytes the test gives, sorted the way git sorts tree entries
// unless the test asks for its own order. It is a test helper and is not shipped in the image
// (server/.dockerignore).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** One entry of a tree: a regular file, an executable file, a symlink, a submodule or a folder. */
export type Node =
  | { kind: "file"; content: string | Uint8Array; executable?: boolean }
  | { kind: "symlink"; target: string }
  | { kind: "submodule"; commit: string }
  | { kind: "dir"; entries: Entry[] };
/** A name (a string, or raw bytes for a name that is not UTF-8) and what it holds. */
export type Entry = [name: string | Uint8Array, node: Node];

export const file = (content: string | Uint8Array, executable = false): Node => ({ kind: "file", content, executable });
export const dir = (...entries: Entry[]): Node => ({ kind: "dir", entries });
export const symlink = (target: string): Node => ({ kind: "symlink", target });
export const submodule = (commit: string): Node => ({ kind: "submodule", commit });

/** git with no system or global configuration, so the tests do not depend on the machine's. */
export const GIT_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };

/** Runs git and returns its stdout; throws with its stderr if it fails. */
export function git(args: string[], cwd?: string): string {
  const r = Bun.spawnSync(["git", ...args], { env: GIT_ENV, ...(cwd ? { cwd } : {}), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

const bytes = (s: string | Uint8Array) => (typeof s === "string" ? new TextEncoder().encode(s) : s);
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Writes one loose object and returns its id. */
function writeObject(repo: string, type: "blob" | "tree" | "commit", content: Uint8Array): string {
  const raw = concat([bytes(`${type} ${content.length}\0`), content]);
  const id = createHash("sha1").update(raw).digest("hex");
  const folder = join(repo, "objects", id.slice(0, 2));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, id.slice(2)), deflateSync(raw));
  return id;
}

const MODES = { file: "100644", executable: "100755", symlink: "120000", submodule: "160000", dir: "40000" } as const;

/** git's order: by name bytes, a folder compared as if its name ended in `/`. */
function gitOrder(a: Entry, b: Entry): number {
  const key = ([name, node]: Entry) => concat([bytes(name), node.kind === "dir" ? bytes("/") : new Uint8Array()]);
  return Buffer.compare(key(a), key(b));
}

/** Writes a tree and everything in it; returns the tree's id. `sorted: false` keeps the given order. */
export function writeTree(repo: string, entries: Entry[], sorted = true): string {
  const ordered = sorted ? [...entries].sort(gitOrder) : entries;
  const parts = ordered.map(([name, node]) => {
    let mode: string;
    let id: string;
    switch (node.kind) {
      case "file": mode = node.executable ? MODES.executable : MODES.file; id = writeObject(repo, "blob", bytes(node.content)); break;
      case "symlink": mode = MODES.symlink; id = writeObject(repo, "blob", bytes(node.target)); break;
      case "submodule": mode = MODES.submodule; id = node.commit; break;
      case "dir": mode = MODES.dir; id = writeTree(repo, node.entries, sorted); break;
      default: { const never: never = node; throw new Error(`unknown node ${JSON.stringify(never)}`); }
    }
    return concat([bytes(`${mode} `), bytes(name), bytes("\0"), Buffer.from(id, "hex")]);
  });
  return writeObject(repo, "tree", concat(parts));
}

/** A new bare repository at `repo` holding one commit of `entries`; returns the commit's id. */
export function repository(repo: string, entries: Entry[], sorted = true): string {
  git(["init", "--bare", "--quiet", "--object-format=sha1", repo]);
  return commitTree(repo, writeTree(repo, entries, sorted));
}

/** Writes a commit of the tree `tree`, with a fixed author and time; returns its id. */
export function commitTree(repo: string, tree: string): string {
  const who = "Fixture <fixture@example.com> 0 +0000";
  return writeObject(repo, "commit", bytes(`tree ${tree}\nauthor ${who}\ncommitter ${who}\n\nfixture\n`));
}
