#!/usr/bin/env bun
// The `school` command (flyingrobots/school#123): host/launcher.ts with the real Keychain, terminal
// and `docker compose`. Run it as `./school <command>` from the checkout, or `bun host/school.ts`.
// docs/topics/secrets/README.md.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keychainStore } from "./keychain.ts";
import { main, type Deps, type Spawned } from "./launcher.ts";
import { generateSecret, SecretError } from "./secrets.ts";

/** Lines of a child's stream as they arrive, so progress is shown while compose works. */
async function* linesOf(stream: ReadableStream<Uint8Array>, tag: "stdout" | "stderr") {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffered.search(/\r?\n/)) >= 0) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + (buffered[at] === "\r" ? 2 : 1));
      yield { stream: tag, line };
    }
  }
  buffered += decoder.decode();
  if (buffered !== "") yield { stream: tag, line: buffered };
}

/** Both streams interleaved in arrival order. */
async function* merge<T>(...sources: AsyncIterable<T>[]): AsyncGenerator<T> {
  const its = sources.map((s) => s[Symbol.asyncIterator]());
  const next = (i: number) => its[i]!.next().then((r) => ({ i, r }));
  const pending = new Map(its.map((_, i) => [i, next(i)]));
  while (pending.size > 0) {
    const { i, r } = await Promise.race(pending.values());
    if (r.done) pending.delete(i);
    else {
      pending.set(i, next(i));
      yield r.value;
    }
  }
}

/** One line from the terminal, not echoed. Ctrl-C or Ctrl-D cancels. */
function prompt(): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let typed = "";
    const done = (f: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      f();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(typed));
        if (ch === "\u0003" || ch === "\u0004") return done(() => reject(new SecretError("the prompt was cancelled; nothing was stored")));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const serverDir = join(import.meta.dir, "..", "server");

const deps: Deps = {
  env: process.env,
  store: (account) => keychainStore(account),
  isTTY: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  prompt,
  spawn: (args, { cwd, env, stdin }): Spawned => {
    // The secrets are in `env`, the child's environment; argv is `docker compose ...` only.
    const child = Bun.spawn(args, { cwd, env, stdin, stdout: "pipe", stderr: "pipe" });
    return { lines: merge(linesOf(child.stdout, "stdout"), linesOf(child.stderr, "stderr")), exited: child.exited };
  },
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  readText: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
  writeText: (path, text) => {
    const mode = statSync(path).mode & 0o777;
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode });
    chmodSync(temp, mode);
    renameSync(temp, path);
  },
  generate: generateSecret,
  serverDir,
};

try {
  process.exitCode = await main(process.argv.slice(2), deps);
} catch (e) {
  // main turns every failure into a line; this is the last resort, still a line.
  process.stderr.write(`${JSON.stringify({ kind: "school.error", event: "error", code: 1, message: e instanceof Error ? e.message : String(e) })}\n`);
  process.exitCode = 1;
}
