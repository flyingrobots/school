// The agent chain: each configured command is tried in order until one returns output that
// matches the schema. Fake agents are small shell scripts written per test; none contacts a model.
import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, runChain, sweepGroup, sweeps, type BridgeConfig } from "./run.ts";

// Bun's own 5 s per-test limit would race process start-up on a loaded machine; every test here
// either finishes on its own or is bounded by the agent timeouts below, so the limit is generous.
setDefaultTimeout(60_000);

const dir = mkdtempSync(join(tmpdir(), "school-bridge-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake agent: an executable script in the test directory. */
function agent(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const schema = {
  type: "object", additionalProperties: false, required: ["answer"],
  properties: { answer: { type: "string", enum: ["yes", "no"] } },
} as const;

const fails = agent("fails", 'echo "boom" >&2; exit 3');
const garbage = agent("garbage", 'echo "I think the answer is yes"');
const wrongShape = agent("wrong-shape", 'echo \'{"answer": "maybe"}\'');
// Starts a background child, then reports its pid to the file named by $1, written whole (via
// rename) so a reader never sees it half-written: the file existing is the agent's readiness signal.
// Both sleeps outlive any test's time limit, so only a kill can end them before the test does.
const hangs = agent("hangs", 'sleep 600 & echo $! > "$1.tmp" && mv "$1.tmp" "$1"; sleep 600');
const fromStdin = agent("from-stdin", `read -r line; printf '%s\\n' "$line" > "${dir}/stdin-saw.txt"; echo '\`\`\`json'; echo '{"answer": "yes"}'; echo '\`\`\`'`);
const fromArg = agent("from-arg", `printf '%s' "$2" > "${dir}/arg-saw.txt"; echo '{"answer": "no"}'`);
const toFile = agent("to-file", `echo "progress chatter"; echo '{"answer": "yes"}' > "$2"`);

// The default agent timeout is for agents that exit on their own: it is not what those tests check,
// so it is long enough that a slow process start cannot trip it. Tests of timeouts pass their own.
const cfg = (agents: { name: string; command: string; output?: string; enabled?: boolean }[], timeout = 60): BridgeConfig =>
  loadConfig({ timeout_seconds: timeout, agents: agents.map((a) => ({ output: "text", ...a })) });

test("falls through failing agents in order and returns the first valid output", async () => {
  const r = await runChain(cfg([
    { name: "a-fails", command: fails },
    { name: "b-garbage", command: garbage },
    { name: "c-wrong-shape", command: wrongShape },
    { name: "d-good", command: `${fromArg} -p {prompt}` },
  ]), { prompt: "Is it?", schema });
  expect(r.status).toBe("succeeded");
  if (r.status === "succeeded") {
    expect(r.agent).toBe("d-good");
    expect(r.output).toEqual({ answer: "no" });
  }
  expect(r.attempts.map((a) => [a.agent, a.status])).toEqual([
    ["a-fails", "failed"], ["b-garbage", "failed"], ["c-wrong-shape", "failed"], ["d-good", "succeeded"],
  ]);
  expect(r.attempts[0]!.error).toMatch(/exit 3/);
  expect(r.attempts[0]!.stderr).toContain("boom");
  expect(r.attempts[1]!.error).toMatch(/JSON/);
  expect(r.attempts[2]!.error).toMatch(/answer/);
});

test("{prompt} arrives as one argument, exactly", async () => {
  const prompt = `line one "quoted" $(touch ${dir}/pwned)\nline two`;
  await runChain(cfg([{ name: "arg", command: `${fromArg} -p {prompt}` }]), { prompt, schema });
  expect(readFileSync(join(dir, "arg-saw.txt"), "utf8")).toBe(prompt);
  expect(existsSync(join(dir, "pwned"))).toBe(false);
});

test("without {prompt}, the prompt arrives on stdin; fenced JSON is accepted", async () => {
  const r = await runChain(cfg([{ name: "stdin", command: fromStdin }]), { prompt: "PROMPT-ON-STDIN", schema });
  expect(r.status).toBe("succeeded");
  expect(readFileSync(join(dir, "stdin-saw.txt"), "utf8").trim()).toBe("PROMPT-ON-STDIN");
});

test("{output_file} is read instead of stdout", async () => {
  const r = await runChain(cfg([{ name: "file", command: `${toFile} {prompt} {output_file}` }]), { prompt: "p", schema });
  expect(r).toMatchObject({ status: "succeeded", output: { answer: "yes" } });
});

test("a hung agent is killed with its whole process tree, then the next agent runs", async () => {
  // The tree kill is only shown if the agent had started its child before the timeout fired. On a
  // loaded machine a shell can take longer than the timeout just to start, so the timeout is
  // derived from the agent's readiness: a run in which the agent never reported its child proves
  // nothing about the tree and is repeated with double the timeout. Each run has its own pid file,
  // so a pid from an earlier run (or another test) can never stand in for this one's.
  for (const seconds of [1, 2, 4, 8, 16]) {
    const pidFile = join(dir, `hangs-child-${seconds}s.pid`);
    const r = await runChain(cfg([{ name: "hangs", command: `${hangs} ${pidFile}` }, { name: "good", command: `${fromArg} x {prompt}` }], seconds), { prompt: "p", schema });
    expect(r.attempts[0]).toMatchObject({ agent: "hangs", status: "failed" });
    expect(r.attempts[0]!.error).toMatch(/timed out/);
    expect(r.status).toBe("succeeded");
    if (!existsSync(pidFile)) continue; // killed before it was ready: inconclusive, not a pass
    const child = Number(readFileSync(pidFile, "utf8"));
    await Bun.sleep(100);
    expect(() => process.kill(child, 0)).toThrow(); // the background child is gone too
    return;
  }
  throw new Error("the hung agent never reported its child, even with a 16 s timeout");
});

test("a missing program or a disabled agent is skipped and recorded, not fatal", async () => {
  const r = await runChain(cfg([
    { name: "missing", command: "definitely-not-a-real-cli-xyz {prompt}" },
    { name: "off", command: fromArg, enabled: false },
    { name: "good", command: `${fromArg} x {prompt}` },
  ]), { prompt: "p", schema });
  expect(r.attempts.map((a) => [a.agent, a.status])).toEqual([["missing", "skipped"], ["good", "succeeded"]]);
  expect(r.attempts[0]!.error).toMatch(/not found/);
});

test("when every agent fails, the chain fails with every attempt kept", async () => {
  const r = await runChain(cfg([{ name: "a", command: fails }, { name: "b", command: garbage }]), { prompt: "p", schema });
  expect(r.status).toBe("failed");
  expect(r.attempts).toHaveLength(2);
});

test("an overall deadline stops the chain rather than running past it", async () => {
  const r = await runChain(cfg([{ name: "hangs", command: `${hangs} ${join(dir, "deadline-child.pid")}` }, { name: "good", command: `${fromArg} x {prompt}` }], 5), { prompt: "p", schema, deadlineMs: 800 });
  expect(r.status).toBe("failed");
  expect(r.attempts.at(-1)!.error).toMatch(/deadline|timed out/);
});

test("the configuration is checked when loaded", () => {
  expect(() => loadConfig({ agents: [] })).toThrow(/at least one agent/);
  expect(() => loadConfig({ agents: [{ name: "x", command: 'a "b' }] })).toThrow(/quote/);
  expect(() => loadConfig({ agents: [{ name: "x", command: "a", output: "telepathy" }] })).toThrow(/output/);
  expect(() => loadConfig({ agents: [{ name: "x", command: "a" }, { name: "x", command: "b" }] })).toThrow(/twice/);
  expect(() => loadConfig({ timeout_seconds: 0, agents: [{ name: "x", command: "a" }] })).toThrow(/timeout/);
});

// An attempt's error is logged (bridge.attempt), and the log never holds an answer. A JSON parser's
// own message quotes the text it choked on, so it must not become the error.
test("a claude-json agent whose output is not JSON fails with an error that quotes none of it", async () => {
  const prose = agent("prose", "echo 'SECRETWORD is what I would say'");
  const r = await runChain(cfg([{ name: "prose", command: prose, output: "claude-json" }]), { prompt: "p", schema });
  expect(r.attempts[0]).toMatchObject({ status: "failed", error: "claude-json output was not JSON" });
});

// flyingrobots/school#290: when no agent can be started (missing, or a file that is not executable),
// the chain still ends with every attempt, and no error holds the prompt.
test("when no agent can be started, the chain fails with each attempt failed and no prompt in any error", async () => {
  const notExecutable = join(dir, "not-executable");
  writeFileSync(notExecutable, "#!/bin/sh\necho '{\"answer\": \"yes\"}'\n");
  const r = await runChain(cfg([{ name: "gone", command: `${join(dir, "no-such-folder", "agent")} {prompt}` }, { name: "denied", command: `${notExecutable} {prompt}` }]), { prompt: "SECRET-PROMPT", schema });
  expect(r).toEqual({ status: "failed", error: "every agent failed", attempts: [
    { agent: "gone", status: "failed", error: `could not start ${join(dir, "no-such-folder", "agent")} (ENOENT)`, exitCode: null, ms: expect.any(Number) },
    { agent: "denied", status: "failed", error: `could not start ${notExecutable} (EACCES)`, exitCode: null, ms: expect.any(Number) },
  ] });
});

// flyingrobots/school#285. A child an agent forks just as the group kill lands can miss the signal,
// still in the agent's process group, and hold the pipes open, so the chain (and the bridge's one
// grading slot) waits for it. This agent forks without pause in four loops, so a kill nearly always
// lands mid-fork: on this test's machine one kill of its group left a child running in 15 of 20
// tries. Every child sleeps 600 s, longer than any test here, so only a kill ends one in time.
const forks = agent("forks", 'for i in 1 2 3 4; do (while :; do sleep 600 & kill $! 2>/dev/null; done) & done\necho $$ > "$1.tmp" && mv "$1.tmp" "$1"\nwait');
const groups: number[] = [];
afterEach(() => {
  // Whatever a failed test left running is killed here, so none outlives the test.
  for (const g of groups.splice(0)) try { process.kill(-g, "SIGKILL"); } catch {}
});

/**
 * The processes still running in process group `group` (a zombie has ended, and waits only to be
 * reaped). A SIGKILL takes effect when the kernel next schedules its target, so the group is read
 * until it is empty or `withinMs` has passed; a child no kill reached is still there then.
 */
async function inGroup(group: number, withinMs = 2000): Promise<number[]> {
  const until = Date.now() + withinMs;
  for (;;) {
    const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,pgid=,stat="], { stdout: "pipe" });
    const running = ps.stdout.toString().split("\n").map((l) => l.trim().split(/\s+/))
      .filter(([pid, pgid, stat]) => pid !== "" && Number(pgid) === group && !stat!.startsWith("Z")).map(([pid]) => Number(pid));
    if (running.length === 0 || Date.now() >= until) return running;
    await Bun.sleep(20);
  }
}

/**
 * One chain of the forking agent, then a good one, timed out after `seconds`. Its result, or
 * "still waiting" if it has not returned 10 s after the timeout (a missed child sleeps 600 s), and
 * the forking agent's process group, or null when the agent was killed before it was ready.
 */
async function forkingRun(tag: string, seconds: number) {
  const pidFile = join(dir, `forks-${tag}-${seconds}s.pid`);
  const chain = runChain(cfg([{ name: "forks", command: `${forks} ${pidFile}` }, { name: "good", command: `${fromArg} x {prompt}` }], seconds), { prompt: "p", schema });
  const r = await Promise.race([chain, Bun.sleep(seconds * 1000 + 10_000).then(() => "still waiting" as const)]);
  const group = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : null;
  if (group !== null) groups.push(group);
  return { r, group };
}

test("a grading agent that forks as its kill lands leaves no child running, and the next agent runs", async () => {
  // Three conclusive runs: one kill alone misses a child in about three runs of four.
  let conclusive = 0;
  for (const seconds of [1, 1, 1, 2, 2, 4, 8]) {
    const { r, group } = await forkingRun(`golden-${conclusive}`, seconds);
    expect(r).not.toBe("still waiting");
    if (r === "still waiting") return;
    expect(r.attempts[0]).toMatchObject({ agent: "forks", status: "failed", error: `timed out after ${seconds} s` });
    expect(r).toMatchObject({ status: "succeeded", agent: "good" });
    if (group === null) continue; // killed before it was ready: inconclusive, not a pass
    expect(await inGroup(group)).toEqual([]);
    if (++conclusive === 3) return;
  }
  throw new Error(`the forking agent was ready in only ${conclusive} of its runs`);
}, 120_000);

test("an agent that answers and exits is not timed out: its answer stands", async () => {
  const r = await runChain(cfg([{ name: "good", command: `${fromArg} x {prompt}` }], 1), { prompt: "p", schema });
  expect(r).toMatchObject({ status: "succeeded", agent: "good", output: { answer: "no" } });
  expect(r.attempts).toEqual([expect.objectContaining({ agent: "good", status: "succeeded" })]);
});

test("the kill reaches only the agent's own process group: another group running beside it survives", async () => {
  const other = Bun.spawn(["sleep", "600"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  groups.push(other.pid);
  const { r, group } = await forkingRun("beside", 1);
  expect(r).not.toBe("still waiting");
  if (group !== null) expect(await inGroup(group)).toEqual([]);
  expect(() => process.kill(other.pid, 0)).not.toThrow();
}, 60_000);

test("five forking agents killed at once, three rounds over: every chain returns and no child is left", async () => {
  for (let round = 0; round < 3; round++) {
    const runs = await Promise.all(Array.from({ length: 5 }, (_, i) => forkingRun(`load-${round}-${i}`, 1)));
    expect(runs.filter(({ r }) => r === "still waiting")).toHaveLength(0);
    for (const { group } of runs) if (group !== null) expect(await inGroup(group)).toEqual([]);
  }
}, 120_000);

// Review findings on flyingrobots/school#348. sweepGroup(0) would signal the bridge's own group and
// sweepGroup(1) every process the user can signal, so neither number is a group it may sweep. The
// signal function is injected, so these tests send no signal to any group.
test("sweepGroup signals no group that is not a real one, and a real one once", async () => {
  const sent: number[] = [];
  for (const bad of [0, 1, -5, 1.5, Number.NaN, Infinity]) {
    const stop = sweepGroup(bad, (g) => { sent.push(g); });
    expect(typeof stop).toBe("function");
    stop();
  }
  expect(sent).toEqual([]);
  const stop = sweepGroup(4_000_000, (g) => { sent.push(g); });
  stop();
  expect(sent).toEqual([4_000_000]);
});

test("a kill after the agent's pipes closed starts no sweep", async () => {
  // The agent closes both pipes at once and then lives 3 s; the 1 s timeout lands after the pipes
  // closed and before the agent exits, so the kill comes when the sweep has already been stopped.
  const quiet = agent("closes-pipes", "exec >&- 2>&-; sleep 3");
  const before = sweeps.started;
  const r = await runChain(cfg([{ name: "quiet", command: quiet }], 1), { prompt: "p", schema });
  expect(r.attempts[0]).toMatchObject({ status: "failed", error: "timed out after 1 s" });
  expect(sweeps.started - before).toBe(0);
});

// flyingrobots/school#349. A child that leaves the agent's process group (setsid) is outside every
// kill of that group, and while it holds the agent's stdout and stderr the pipes never close. The
// chain must stop reading 500 ms after the kill, as the ask route does, so the next agent runs.
// The child is a perl one-liner (perl is on macOS and on CI's Ubuntu; `setsid(1)` is not on
// macOS). It writes its ready file only after setsid, so a run whose ready file exists had a child
// outside the group when the kill landed. Its command line carries `marker`, unique to this test
// file's run, so the test finds and ends every such child itself, and `ps` can show none is left.
const marker = `school-escaped-${dir.split("/").at(-1)}`;
/**
 * A fake agent: a setsid child that runs perl `before`, writes its ready file, runs `after`, and
 * ends; the agent itself sleeps 600 s. In the perl, `$p` is the agent's pid.
 */
const escapes = (name: string, before: string, after: string) => agent(name, [
  `perl -MPOSIX -e 'my $p = getppid(); POSIX::setsid() > 0 or die "setsid"; ${before}`,
  `open(my $f, ">", "$ARGV[0].tmp") or die; print $f $$; close $f; rename("$ARGV[0].tmp", $ARGV[0]) or die; ${after}' "$1" ${marker} &`,
  "sleep 600",
].join(" "));
// Holds the pipes and sleeps 30 s: only a bridge that stops reading returns sooner.
const holds = escapes("escapes-holding", "", "sleep 30");
// Closes both pipes first: the agent's pipes close with the kill, cut-off or not.
const closes = escapes("escapes-closing", 'open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null");', "sleep 30");
// Holds the pipes until the agent is killed (the child is then re-parented), then exits 200 ms
// later, inside the cut-off. It waits 30 s at most, so none outlives a test that failed.
const exitsLate = escapes("escapes-exits-late", "", "my $until = time + 30; select(undef, undef, undef, 0.02) while getppid() == $p && time < $until; select(undef, undef, undef, 0.2)");

/** The pids of every escaped child this file started that is still running, by `marker`. */
function escaped(): number[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,stat=,args="], { stdout: "pipe" });
  return ps.stdout.toString().split("\n").map((l) => l.trim().split(/\s+/))
    .filter(([pid, stat, ...args]) => pid !== "" && !stat!.startsWith("Z") && args.includes(marker)).map(([pid]) => Number(pid));
}
afterEach(() => { for (const pid of escaped()) try { process.kill(pid, "SIGKILL"); } catch {} });

/**
 * One chain of `escaper`, then a good agent, timed out after `seconds`: its result, or "still
 * waiting" if it has not returned 5 s after the timeout (the held pipes close only in 30 s), how
 * long it took, and whether the setsid child was ready (false: killed before setsid, inconclusive).
 */
async function escapingRun(escaper: string, tag: string, seconds: number) {
  const ready = join(dir, `escapes-${tag}-${seconds}s.ready`);
  const t0 = Date.now();
  const chain = runChain(cfg([{ name: "escapes", command: `${escaper} ${ready}` }, { name: "good", command: `${fromArg} x {prompt}` }], seconds), { prompt: "p", schema });
  const r = await Promise.race([chain, Bun.sleep(seconds * 1000 + 5_000).then(() => "still waiting" as const)]);
  return { r, ms: Date.now() - t0, ready: existsSync(ready) };
}

/** Run `escaper` with timeouts of 1, 2, 4 and 8 s until its child was ready; that run's result. */
async function conclusiveEscapingRun(escaper: string, tag: string) {
  for (const seconds of [1, 2, 4, 8]) {
    const run = await escapingRun(escaper, tag, seconds);
    if (run.ready || run.r === "still waiting") return { ...run, seconds };
  }
  throw new Error(`the ${tag} agent's child was never ready, even with an 8 s timeout`);
}

/** Every escaped child is ended by the test, and `ps` then shows none running. */
async function noEscapedChildLeft() {
  for (const pid of escaped()) try { process.kill(pid, "SIGKILL"); } catch {}
  const until = Date.now() + 2000;
  while (escaped().length > 0 && Date.now() < until) await Bun.sleep(20);
  expect(escaped()).toEqual([]);
}

test("a grading agent whose setsid child holds the pipes is cut off about 1 s after its timeout, and the next agent answers", async () => {
  const { r, ms, seconds } = await conclusiveEscapingRun(holds, "golden");
  expect(r).not.toBe("still waiting");
  if (r === "still waiting") return;
  expect(r.attempts[0]).toMatchObject({ agent: "escapes", status: "failed", error: `timed out after ${seconds} s` });
  expect(r).toMatchObject({ status: "succeeded", agent: "good", output: { answer: "no" } });
  // About 1 s (#349): the 500 ms cut-off, with slack for starting the next agent on a loaded machine.
  expect(ms - seconds * 1000).toBeLessThan(1_500);
  expect(escaped()).toHaveLength(1); // the child did escape: no kill of the group reached it
  await noEscapedChildLeft();
}, 60_000);

test("a setsid child that closes the pipes does not hold the chain, and the next agent answers", async () => {
  const { r, ms, seconds } = await conclusiveEscapingRun(closes, "closes");
  expect(r).toMatchObject({ status: "succeeded", agent: "good" });
  expect(ms - seconds * 1000).toBeLessThan(1_500);
  await noEscapedChildLeft();
}, 60_000);

test("a setsid child that exits during the cut-off does not hold the chain, and the next agent answers", async () => {
  const { r, ms, seconds } = await conclusiveEscapingRun(exitsLate, "exits-late");
  expect(r).toMatchObject({ status: "succeeded", agent: "good" });
  expect(ms - seconds * 1000).toBeLessThan(1_500);
  await noEscapedChildLeft();
}, 60_000);

test("an agent still writing its answer when 500 ms have passed is not cut off: its answer stands", async () => {
  // Without a kill there is no cut-off: an answer written over 1.2 s, in three parts, is read whole.
  const slow = agent("writes-slowly", `printf '{"answer":'; sleep 0.6; printf ' "y'; sleep 0.6; echo 'es"}'`);
  const r = await runChain(cfg([{ name: "slow", command: slow }]), { prompt: "p", schema });
  expect(r).toMatchObject({ status: "succeeded", agent: "slow", output: { answer: "yes" } });
});

test("five grading agents whose setsid children hold the pipes, all at once: every chain is cut off and the next agent answers", async () => {
  const runs = await Promise.all(Array.from({ length: 5 }, (_, i) => escapingRun(holds, `load-${i}`, 2)));
  expect(runs.filter(({ r }) => r === "still waiting")).toHaveLength(0);
  for (const { r, ms } of runs) {
    expect(r).toMatchObject({ status: "succeeded", agent: "good" });
    expect(ms - 2000).toBeLessThan(1_500);
  }
  expect(runs.filter(({ ready }) => ready).length).toBeGreaterThan(0); // at least one child escaped
  await noEscapedChildLeft();
}, 60_000);
