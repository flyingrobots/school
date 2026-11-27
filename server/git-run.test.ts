// The shared git runner (flyingrobots/school#314): the exact environment and `-c` flags every git
// process gets, one test for each protection, and a check that extraction and fetching both go
// through it. A fake `git` records what it was started with, so nothing here depends on git itself.
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractCommit } from "./extract-tree.ts";
import { fetchCommit } from "./fetch-commit.ts";
import { gitArguments, gitEnvironment, GitRunError, runGit, type GitSpec } from "./git-run.ts";

const root = mkdtempSync(join(tmpdir(), "school-git-run-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
type Call = { cwd: string; args: string[]; env: Record<string, string> };

/** A fake git that appends its working folder, arguments and environment to a log, then exits 0. */
function fakeGit() {
  const dir = join(root, `f${++n}`);
  mkdirSync(dir);
  const log = join(dir, "log.json");
  const bin = join(dir, "git");
  const recorder = join(dir, "record.js");
  writeFileSync(recorder, `require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), env: process.env }) + "\\n");`);
  // `init` must leave a folder behind, as the real one does, because fetching starts in it.
  writeFileSync(bin, `#!/bin/sh\n${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} "$@"\ncase " $* " in *" init "*) for last; do :; done; mkdir -p "$last";; esac\nexit 0\n`);
  chmodSync(bin, 0o755);
  const calls = (): Call[] => {
    try {
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => {
        const call = JSON.parse(l) as Call;
        // The shell that runs the fake adds these three itself; git's parent never sets them.
        for (const k of ["PWD", "SHLVL", "_", "OLDPWD"]) delete call.env[k];
        return call;
      });
    } catch {
      return [];
    }
  };
  return { bin, calls, dir };
}

// Variables a parent could set to redirect git's configuration, repository, helpers or network.
const HOSTILE = {
  GIT_DIR: "/hostile/dir", GIT_WORK_TREE: "/hostile/tree", GIT_INDEX_FILE: "/hostile/index", GIT_OBJECT_DIRECTORY: "/hostile/objects",
  GIT_ALTERNATE_OBJECT_DIRECTORIES: "/hostile/alt", GIT_CONFIG: "/hostile/config", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/hostile/hooks", GIT_CONFIG_PARAMETERS: "'core.hooksPath=/hostile/hooks'", GIT_EXEC_PATH: "/hostile/exec",
  GIT_SSH: "/hostile/ssh", GIT_SSH_COMMAND: "/hostile/ssh", GIT_ASKPASS: "/hostile/askpass", SSH_ASKPASS: "/hostile/askpass",
  GIT_PROXY_COMMAND: "/hostile/proxy", GIT_EXTERNAL_DIFF: "/hostile/diff", GIT_PAGER: "/hostile/pager", GIT_EDITOR: "/hostile/editor",
  GIT_TEMPLATE_DIR: "/hostile/template", GIT_REPLACE_REF_BASE: "refs/hostile/", GIT_NAMESPACE: "hostile", GIT_TRACE: "/hostile/trace",
  GIT_SSL_NO_VERIFY: "1", GIT_SSL_CAINFO: "/hostile/ca", GIT_CURL_VERBOSE: "1", GIT_PROTOCOL_FROM_USER: "1", GIT_ALLOW_PROTOCOL: "file:ext",
  HTTPS_PROXY: "http://hostile:1", https_proxy: "http://hostile:1", ALL_PROXY: "http://hostile:1", CURL_CA_BUNDLE: "/hostile/ca",
  XDG_CONFIG_HOME: "/hostile/xdg", SSH_AUTH_SOCK: "/hostile/sock", LD_PRELOAD: "/hostile/lib.so", LANG: "hostile",
  GIT_CEILING_DIRECTORIES: "/hostile/ceiling", GIT_LITERAL_PATHSPECS: "0", GIT_OPTIONAL_LOCKS: "1",
};

/** Runs `body` with a parent environment full of hostile variables, then restores it. */
async function hostileParent<T>(body: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, HOSTILE);
  try {
    return await body();
  } finally {
    for (const k of Object.keys(HOSTILE)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const spec = (bin: string, extra: Partial<GitSpec> = {}): GitSpec => ({ bin, home: "/home/x", cwd: root, ceiling: "/ceiling", ms: 10_000, ...extra });

// What every git process gets, whoever starts it. HOME and the ceiling are the caller's.
const environment = (home: string, ceiling: string) => ({
  GIT_ATTR_NOSYSTEM: "1", GIT_CEILING_DIRECTORIES: ceiling, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
  HOME: home, LC_ALL: "C", PATH: process.env.PATH ?? "/usr/bin:/bin",
});
const BASE_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "submodule.recurse=false"];

describe("the environment", () => {
  test("is exactly the pinned set, and nothing from the parent", async () => {
    const f = fakeGit();
    await hostileParent(() => runGit(spec(f.bin, { home: "/home/x", ceiling: "/ceiling" }), ["status"]));
    expect(f.calls()[0]?.env).toEqual(environment("/home/x", "/ceiling"));
  });

  test("gitEnvironment names the same set", () => {
    expect(gitEnvironment({ home: "/home/x", ceiling: "/ceiling" })).toEqual(environment("/home/x", "/ceiling"));
  });

  test("GIT_CEILING_DIRECTORIES is the caller's folder, not the parent's", async () => {
    const f = fakeGit();
    await hostileParent(() => runGit(spec(f.bin, { ceiling: "/the/ceiling" }), ["status"]));
    expect(f.calls()[0]?.env.GIT_CEILING_DIRECTORIES).toBe("/the/ceiling");
  });

  test("no GIT_ variable the pinned set does not name reaches git", async () => {
    const f = fakeGit();
    await hostileParent(() => runGit(spec(f.bin), ["status"]));
    const env = f.calls()[0]?.env ?? {};
    for (const k of Object.keys(HOSTILE)) {
      if (!(k in environment("", ""))) expect(env).not.toHaveProperty(k);
    }
    expect(Object.keys(env).filter((k) => k.startsWith("GIT_")).sort()).toEqual(Object.keys(environment("", "")).filter((k) => k.startsWith("GIT_")).sort());
  });
});

describe("the flags", () => {
  test("are the three -c flags, then the arguments, with no --git-dir when there is no repository", async () => {
    const f = fakeGit();
    await runGit(spec(f.bin), ["init", "--quiet"]);
    expect(f.calls()[0]?.args).toEqual([...BASE_FLAGS, "init", "--quiet"]);
  });

  test("the caller's configuration follows the three, each as -c", () => {
    expect(gitArguments({ config: ["a.b=1", "c.d="] }, ["status"])).toEqual([...BASE_FLAGS, "-c", "a.b=1", "-c", "c.d=", "status"]);
  });

  test("hooks always go to /dev/null, whatever configuration the caller adds", () => {
    expect(gitArguments({ config: ["core.hooksPath=/hostile"] }, ["status"]).slice(0, 2)).toEqual(["-c", "core.hooksPath=/dev/null"]);
  });

  test("--git-dir names the repository before the command", async () => {
    const f = fakeGit();
    await runGit(spec(f.bin, { repository: "/some/repo.git" }), ["ls-tree", "HEAD"]);
    expect(f.calls()[0]?.args).toEqual([...BASE_FLAGS, "--git-dir", "/some/repo.git", "ls-tree", "HEAD"]);
  });
});

describe("the two protections against a repository around the working folder", () => {
  test("GIT_CEILING_DIRECTORIES is passed on its own", async () => {
    const f = fakeGit();
    await runGit(spec(f.bin, { ceiling: "/above" }), ["status"]);
    const call = f.calls()[0];
    expect(call?.env.GIT_CEILING_DIRECTORIES).toBe("/above");
    expect(call?.args).not.toContain("--git-dir");
  });

  test("--git-dir and the repository as the working folder are passed on their own", async () => {
    const f = fakeGit();
    const repository = join(f.dir, "repo.git");
    mkdirSync(repository);
    await runGit(spec(f.bin, { repository, cwd: repository }), ["status"]);
    const call = f.calls()[0];
    expect(call?.args.slice(6, 8)).toEqual(["--git-dir", repository]);
    expect(call?.cwd.replace(/^\/private/, "")).toBe(repository.replace(/^\/private/, ""));
  });

  test("a runner given neither has no ceiling to omit: the ceiling is required, as a type", () => {
    // @ts-expect-error a spec without `ceiling` does not type-check
    const bad: GitSpec = { bin: "git", home: "/h", cwd: "/c", ms: 1 };
    expect(bad.ceiling).toBeUndefined();
  });
});

describe("running", () => {
  test("a start failure is a GitRunError", async () => {
    const e = await runGit(spec(join(root, "no-such-git")), ["status"]).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GitRunError);
    expect((e as GitRunError).kind).toBe("start-failed");
  });

  test("a time limit stops git and its children, as a timeout", async () => {
    const f = fakeGit();
    writeFileSync(f.bin, `#!/bin/sh\nsh -c 'echo $$ > "${f.dir}/pid"; exec sleep 30' </dev/null >/dev/null 2>&1 &\nwhile [ ! -s "${f.dir}/pid" ]; do :; done\nsleep 30\n`);
    const e = await runGit(spec(f.bin, { ms: 500 }), ["status"]).catch((x: unknown) => x);
    expect((e as GitRunError).kind).toBe("timeout");
    const pid = Number(readFileSync(join(f.dir, "pid"), "utf8"));
    await Bun.sleep(100);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("output past the cap is refused", async () => {
    const f = fakeGit();
    writeFileSync(f.bin, `#!/bin/sh\nprintf 'hello world'\n`);
    const e = await runGit(spec(f.bin), ["status"], { maxStdout: 4 }).catch((x: unknown) => x);
    expect((e as GitRunError).kind).toBe("output-too-large");
  });

  test("output within the cap is returned, with stderr trimmed and capped", async () => {
    const f = fakeGit();
    writeFileSync(f.bin, `#!/bin/sh\nprintf 'hello'\nprintf '  oops that is long \\n' >&2\n`);
    const r = await runGit(spec(f.bin), ["status"], { maxStdout: 10, maxStderr: 8 });
    expect(new TextDecoder().decode(r.stdout)).toBe("hello");
    expect(r.stderr).toBe("oops tha".trim());
    expect(r.code).toBe(0);
  });
});

describe("both callers use it", () => {
  const hash = "a".repeat(40);

  test("extraction passes the pinned environment and flags", async () => {
    const f = fakeGit();
    const parent = join(root, "extract-parent");
    mkdirSync(parent);
    await hostileParent(() => extractCommit({ repository: join(parent, "repo.git"), commit: hash, into: join(parent, "into"), git: f.bin }));
    const call = f.calls()[0];
    expect(call?.env).toEqual(environment(parent, dirname(parent)));
    expect(call?.args).toEqual([...BASE_FLAGS, "--git-dir", join(parent, "repo.git"), "cat-file", "--batch-check"]);
  });

  test("fetching passes the pinned environment, the three flags among its own, and --git-dir after init", async () => {
    const f = fakeGit();
    const parent = join(root, "fetch-parent");
    mkdirSync(parent);
    const staging = join(parent, "stage");
    await hostileParent(() => fetchCommit({ url: "https://1.1.1.1/x.git", commit: hash, staging }, { git: f.bin }));
    const calls = f.calls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.env).toEqual(environment(staging, parent));
      expect(call.args.slice(0, 6)).toEqual(BASE_FLAGS);
    }
    expect(calls[0]?.args).toContain("init");
    expect(calls[0]?.args).not.toContain("--git-dir");
    for (const call of calls.slice(1)) {
      expect(call.args).toContain("--git-dir");
      expect(call.args[call.args.indexOf("--git-dir") + 1]).toBe(join(staging, "repo.git"));
    }
  });

  test("neither module builds its own environment or spawns git", () => {
    for (const file of ["extract-tree.ts", "fetch-commit.ts"]) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source.includes("Bun.spawn")).toBe(false);
      expect(source.includes("GIT_CONFIG_NOSYSTEM")).toBe(false);
      expect(source.includes('from "./git-run.ts"')).toBe(true);
    }
  });
});
