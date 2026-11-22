// The agent chain: each configured command is tried in order until one returns output that
// matches the schema. Fake agents are small shell scripts written per test; none contacts a model.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, runChain, type BridgeConfig } from "./run.ts";

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
const hangs = agent("hangs", `sleep 30 & echo $! > "${dir}/hangs-child.pid"; sleep 30`);
const fromStdin = agent("from-stdin", `read -r line; printf '%s\\n' "$line" > "${dir}/stdin-saw.txt"; echo '\`\`\`json'; echo '{"answer": "yes"}'; echo '\`\`\`'`);
const fromArg = agent("from-arg", `printf '%s' "$2" > "${dir}/arg-saw.txt"; echo '{"answer": "no"}'`);
const toFile = agent("to-file", `echo "progress chatter"; echo '{"answer": "yes"}' > "$2"`);

const cfg = (agents: { name: string; command: string; output?: string; enabled?: boolean }[], timeout = 5): BridgeConfig =>
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
  const r = await runChain(cfg([{ name: "hangs", command: hangs }, { name: "good", command: `${fromArg} x {prompt}` }], 1), { prompt: "p", schema });
  expect(r.attempts[0]).toMatchObject({ agent: "hangs", status: "failed" });
  expect(r.attempts[0]!.error).toMatch(/timed out/);
  expect(r.status).toBe("succeeded");
  const child = Number(readFileSync(join(dir, "hangs-child.pid"), "utf8"));
  await Bun.sleep(100);
  expect(() => process.kill(child, 0)).toThrow(); // the background child is gone too
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
  const r = await runChain(cfg([{ name: "hangs", command: hangs }, { name: "good", command: `${fromArg} x {prompt}` }], 5), { prompt: "p", schema, deadlineMs: 800 });
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
