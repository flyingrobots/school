// Stopping the bridge (flyingrobots/school#286). Each agent leads a process group of its own, so the
// signal that stops the bridge never reaches it: on SIGTERM or SIGINT the bridge kills every live
// agent's group, gradings and questions alike, before it exits. The fake agents are shell scripts
// that start background children and hang; none contacts a model.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, timeout, type Started } from "../server/testing/processes.ts";
import { plainAgent } from "./testing/fake-agent.ts";

const TOKEN = "stop-token-0123456789";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let dir = "";
let pids = "";
let bridge: Started | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "school-bridge-stop-"));
  pids = mkdtempSync(join(tmpdir(), "school-bridge-stop-pids-"));
});
afterEach(async () => {
  // Whatever a failed test left running is killed here, so none outlives the test.
  for (const pid of recorded()) try { process.kill(pid, "SIGKILL"); } catch {}
  bridge?.proc.kill("SIGKILL");
  await bridge?.proc.exited;
  bridge = null;
  rmSync(dir, { recursive: true, force: true });
  rmSync(pids, { recursive: true, force: true });
});

/** Every pid a hanging agent wrote: its own and each background child's. */
function recorded(): number[] {
  if (!existsSync(join(pids, "all"))) return [];
  return readFileSync(join(pids, "all"), "utf8").split("\n").filter((l) => l !== "").map(Number);
}

/**
 * An agent that starts `children` background sleeps, records its own pid and theirs, marks itself
 * `<name>.ready`, and hangs. The sleeps outlive any test, so only a kill ends them.
 */
function hanging(name: string, children: number): string {
  const starts = Array.from({ length: children }, () => `sleep 600 & echo $! >> "${pids}/all"`).join("\n");
  return plainAgent(dir, name, `echo $$ >> "${pids}/all"\n${starts}\n: > "${pids}/${name}.ready"\nwait`);
}

async function waitFor(name: string) {
  while (!existsSync(join(pids, name))) await Bun.sleep(10);
}

/**
 * The pids still running (a zombie has ended, and waits only to be reaped). A SIGKILL takes effect
 * when the kernel next schedules its target, so the survivors are read until none is left or
 * `withinMs` has passed; an agent the bridge never killed is still there then.
 */
async function survivors(all: number[], withinMs = 2000): Promise<number[]> {
  const until = Date.now() + withinMs;
  for (;;) {
    const ps = Bun.spawnSync(["ps", "-o", "pid=,stat=", "-p", all.join(",")], { stdout: "pipe" });
    const running = ps.stdout.toString().split("\n").map((l) => l.trim().split(/\s+/)).filter(([pid, stat]) => pid !== "" && !stat!.startsWith("Z")).map(([pid]) => Number(pid));
    if (running.length === 0 || Date.now() >= until) return running;
    await Bun.sleep(20);
  }
}

async function start(config: Record<string, unknown>) {
  writeFileSync(join(dir, "bridge.json"), JSON.stringify(config));
  bridge = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json") });
}
const post = (path: string, body: unknown) => fetch(bridge!.url + path, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
const schema = { type: "object", properties: {} };

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} with one hanging grading agent: no agent process is left once the bridge exits`, async () => {
    await start({ timeout_seconds: 600, agents: [{ name: "grader", command: `${hanging("grader", 1)} {prompt}` }] });
    const reply = post("/run", { prompt: "p", schema });
    await waitFor("grader.ready");
    expect(recorded()).toHaveLength(2);
    bridge!.proc.kill(signal);
    await bridge!.proc.exited;
    await reply;
    expect(await survivors(recorded())).toEqual([]);
  }, timeout(1));
}

// docs/topics/program-output/README.md: exit 0 is "stopped".
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} with no agent running: the bridge exits 0`, async () => {
    await start({ timeout_seconds: 5, agents: [{ name: "grader", command: "true" }] });
    bridge!.proc.kill(signal);
    expect(await bridge!.proc.exited).toBe(0);
  }, timeout(1));
}

// Many agents: a grading and a question at once, each agent with three children of its own.
test("SIGTERM with a hanging grading and a hanging question, each agent with three children: no agent process is left", async () => {
  await start({
    timeout_seconds: 600, agents: [{ name: "grader", command: `${hanging("grader", 3)} {prompt}` }],
    ask: { timeout_seconds: 600, agents: [{ name: "asker", output: "text", command: `${hanging("asker", 3)} {prompt}` }] },
  });
  const replies = [post("/run", { prompt: "p", schema }), post("/ask", { prompt: "q" })];
  await Promise.all([waitFor("grader.ready"), waitFor("asker.ready")]);
  expect(recorded()).toHaveLength(8);
  bridge!.proc.kill("SIGTERM");
  await bridge!.proc.exited;
  await Promise.all(replies);
  expect(await survivors(recorded())).toEqual([]);
}, timeout(1));
