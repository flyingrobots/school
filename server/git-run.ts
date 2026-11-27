// The one hardened git runner (flyingrobots/school#314), shared by extracting a commit's tree
// (extract-tree.ts, flyingrobots/school#235) and fetching a commit (fetch-commit.ts,
// flyingrobots/school#236). Both read a repository that is hostile until checked, so both run git
// the same way, and a protection added here reaches both:
//
// - A fresh environment: nothing is inherited but `PATH`. `HOME` is the caller's folder, so no
//   `.netrc` or `~/.gitconfig` is read; the system and global configuration are off
//   (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM`); nothing prompts
//   (`GIT_TERMINAL_PROMPT=0`); replace objects, optional locks and pathspec magic are off. So a
//   `GIT_DIR`, `GIT_CONFIG_COUNT`, `GIT_EXEC_PATH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS` or proxy
//   variable in School's own environment never reaches git.
// - `GIT_CEILING_DIRECTORIES` stops git looking above the caller's ceiling for a repository of its
//   own, and `--git-dir` (when a repository is named) means it need not look at all. Either
//   alone keeps an enclosing repository's configuration out; both are pinned, each by its own test.
// - Three `-c` flags come before everything else, and the caller cannot take them away: hooks go
//   to /dev/null, no filesystem monitor, no submodule recursion. A caller adds its own `-c` flags
//   after them.
// - The process starts in its own process group with a time limit. Stopping it (the time limit, a
//   refused output, a caller's `watch`) kills the whole group, so no helper outlives it.
// - Output is capped: stdout is refused once past `maxStdout` (or handed over chunk by chunk to
//   `onChunk`, which may stop git by throwing), and stderr is truncated at `maxStderr`.
//
// A failure of the runner itself is a `GitRunError`; anything else thrown by `onChunk` or `watch`
// is thrown again, after git has been stopped.

/** How one git process runs. */
export type GitSpec = {
  /** The git executable. */
  bin: string;
  /** git's `HOME`. */
  home: string;
  /** The folder git starts in. */
  cwd: string;
  /** The folder above which git never looks for a repository (`GIT_CEILING_DIRECTORIES`). */
  ceiling: string;
  /** Milliseconds the process may run. */
  ms: number;
  /** Further configuration, as `key=value`, each passed as `-c` after the three that are always passed. */
  config?: readonly string[];
  /** The repository, passed as `--git-dir`; none for a command that makes it (`git init`). */
  repository?: string;
};

export type GitOptions = {
  /** What git reads on stdin; nothing by default. */
  input?: Uint8Array;
  /** Bytes of stdout allowed when it is collected; none by default. Unused with `onChunk`. */
  maxStdout?: number;
  /** Bytes of stderr kept; the rest is read and dropped. 4096 by default. */
  maxStderr?: number;
  /** Receives stdout as it arrives instead of collecting it; throwing from it stops git and is thrown again. */
  onChunk?: (chunk: Uint8Array) => void;
  /** Called every 100 ms while git runs; throwing from it stops git and is thrown again. */
  watch?: () => void;
};

export type GitResult = { code: number; stdout: Uint8Array; stderr: string };

/** The runner's own failures: git did not start, ran too long, or wrote more than allowed. */
export class GitRunError extends Error {
  constructor(readonly kind: "start-failed" | "timeout" | "output-too-large", message: string) {
    super(message);
  }
}

/** The complete environment git gets. */
export function gitEnvironment(spec: Pick<GitSpec, "home" | "ceiling">): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: spec.home, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: spec.ceiling,
  };
}

/** git's arguments: the three always-on `-c` flags, the caller's, `--git-dir` when named, then `args`. */
export function gitArguments(spec: Pick<GitSpec, "config" | "repository">, args: string[]): string[] {
  const config = ["core.hooksPath=/dev/null", "core.fsmonitor=false", "submodule.recurse=false", ...(spec.config ?? [])];
  return [...config.flatMap((c) => ["-c", c]), ...(spec.repository === undefined ? [] : ["--git-dir", spec.repository]), ...args];
}

/**
 * Reads a stream to its end, keeping at most `max` bytes. Past that, a `truncate` stream keeps
 * draining; any other is an error at once, which stops git.
 */
async function capped(stream: ReadableStream<Uint8Array>, max: number, truncate: boolean, what: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for await (const chunk of stream) {
    if (kept + chunk.length > max && !truncate) throw new GitRunError("output-too-large", `git ${what} wrote more than ${max} bytes`);
    const room = Math.max(0, max - kept);
    if (room > 0) chunks.push(chunk.subarray(0, room));
    kept += Math.min(room, chunk.length);
  }
  return Buffer.concat(chunks);
}

/** Runs one git command under the environment and flags above, in its own process group, with a time limit. */
export async function runGit(spec: GitSpec, args: string[], options: GitOptions = {}): Promise<GitResult> {
  const what = args[0] ?? "";
  let proc;
  try {
    proc = Bun.spawn([spec.bin, ...gitArguments(spec, args)], {
      env: gitEnvironment(spec), cwd: spec.cwd, stdin: options.input ?? "ignore", stdout: "pipe", stderr: "pipe", detached: true,
    });
  } catch (e) {
    throw new GitRunError("start-failed", `git could not be started: ${e instanceof Error ? e.message : String(e)}`);
  }
  const p = proc;
  let stopped: { error: unknown } | null = null;
  const stop = (error: unknown) => {
    stopped ??= { error };
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      p.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => stop(new GitRunError("timeout", `git ${what} ran longer than ${spec.ms} ms and was stopped`)), spec.ms);
  const watcher = options.watch
    ? setInterval(() => {
        try {
          options.watch?.();
        } catch (e) {
          stop(e);
        }
      }, 100)
    : null;
  const { onChunk } = options;
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
    for await (const chunk of stream) onChunk?.(chunk);
    return new Uint8Array(0);
  };
  let out: Uint8Array = new Uint8Array(0);
  let err: Uint8Array = new Uint8Array(0);
  try {
    [out, err] = await Promise.all([
      onChunk ? drain(p.stdout) : capped(p.stdout, options.maxStdout ?? 0, false, what),
      capped(p.stderr, options.maxStderr ?? 4096, true, what),
    ]);
  } catch (e) {
    stop(e);
  }
  const code = await p.exited;
  clearTimeout(timer);
  if (watcher) clearInterval(watcher);
  // Anything git started that is still running goes with it.
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
  if (stopped) throw (stopped as { error: unknown }).error;
  return { code, stdout: out, stderr: new TextDecoder().decode(err).trim() };
}
