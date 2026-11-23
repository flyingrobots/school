// The terminal prompt `school up` asks the superuser's password at (flyingrobots/school#123), with a
// fake terminal: it reads one line unechoed and writes nothing of its own, so stderr stays JSON Lines
// (the launcher has already written the prompt as a line). docs/topics/secrets/test-plan.md.
import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { readHidden, type Terminal } from "./prompt.ts";
import { SecretError } from "./secrets.ts";

function fakeTerminal() {
  const events = new EventEmitter();
  const log: string[] = [];
  const stdin: Terminal["stdin"] = {
    setRawMode: (on) => { log.push(`raw:${on}`); },
    resume: () => { log.push("resume"); },
    pause: () => { log.push("pause"); },
    on: (_e, f) => { events.on("data", f); },
    off: (_e, f) => { events.off("data", f); },
  };
  return { terminal: { stdin } satisfies Terminal, type: (s: string) => events.emit("data", Buffer.from(s)), log, listeners: () => events.listenerCount("data") };
}

/** What `f` writes to process.stderr and process.stdout while it runs. */
async function writes(f: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const [err, out] = [process.stderr.write, process.stdout.write];
  process.stderr.write = ((s: string | Uint8Array) => { seen.push(String(s)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((s: string | Uint8Array) => { seen.push(String(s)); return true; }) as typeof process.stdout.write;
  try { await f(); } finally { [process.stderr.write, process.stdout.write] = [err, out]; }
  return seen;
}

test("SEC-L22: the prompt reads a line unechoed, restores the terminal, and writes nothing to stderr, not even a newline", async () => {
  const t = fakeTerminal();
  let answer = "";
  expect(await writes(async () => {
    const p = readHidden(t.terminal);
    t.type("Secret0123x\u007f456789\r");
    answer = await p;
  })).toEqual([]);
  expect(answer).toBe("Secret0123456789");
  expect(t.log).toEqual(["raw:true", "resume", "raw:false", "pause"]);
  expect(t.listeners()).toBe(0);

  const c = fakeTerminal();
  let refusal: unknown;
  expect(await writes(async () => {
    const p = readHidden(c.terminal);
    c.type("\u0003");
    await p.catch((e) => { refusal = e; });
  })).toEqual([]);
  expect(refusal).toBeInstanceOf(SecretError);
  expect(c.log).toEqual(["raw:true", "resume", "raw:false", "pause"]);
});
