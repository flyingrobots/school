// Explanation grading end to end: the real server, the real bridge, and a fake agent CLI (flyingrobots/school#10).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "school-grading-"));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BRIDGE_PORT = PORT + 1;
const base = `http://127.0.0.1:${PORT}`;
const KEY = "bridge-token-NEVER-STORE-ME";
let server: ReturnType<typeof Bun.spawn> | null = null;
let bridge: ReturnType<typeof Bun.spawn> | null = null;

const verdict = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "Faithful to the source." },
  completeness: { verdict: "partly", note: "Give one <b>example</b>." },
  accessibility: { verdict: "meets", note: "Plain." },
  contradictions: [{ source_id: "readme", quote: "the transformation, not the state", note: "Matches." }],
  summary: "Close. Add an example.",
};
// The one fake in the chain: an agent CLI. It answers unless the file "down" exists.
const agentPath = join(root, "fake-agent");

async function until(url: string, ok: (r: Response) => boolean) {
  for (let i = 0; i < 100; i++) {
    try { if (ok(await fetch(url))) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error(`${url} did not come up`);
}

beforeAll(async () => {
  writeFileSync(join(root, "verdict.json"), JSON.stringify(verdict));
  writeFileSync(agentPath, `#!/bin/sh\nif [ -e "${root}/down" ]; then echo "model overloaded" >&2; exit 1; fi\ncat "${root}/verdict.json"\n`);
  chmodSync(agentPath, 0o755);
  writeFileSync(join(root, "bridge.json"), JSON.stringify({ timeout_seconds: 10, agents: [{ name: "fake-agent", command: `${agentPath} -p {prompt}` }] }));
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify({
    type: "page", id: "l1", title: "One", subtitle: "", children: [{
      type: "explain", id: "e1", prompt: "Explain the inversion.", model: "MODEL-ANSWER-TEXT",
      sources: [{ id: "readme", title: "README", text: "The unit of storage should be the transformation, not the state." }],
    }],
  }));
  bridge = Bun.spawn(["bun", join(import.meta.dir, "..", "bridge", "bridge.ts")], {
    env: { ...process.env, SCHOOL_BRIDGE_TOKEN: KEY, SCHOOL_BRIDGE_CONFIG: join(root, "bridge.json"), SCHOOL_BRIDGE_PORT: String(BRIDGE_PORT) },
    stdout: "pipe", stderr: "pipe",
  });
  await until(`http://127.0.0.1:${BRIDGE_PORT}/health`, (r) => r.status === 401);
  server = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), PORT: String(PORT), HOST: "127.0.0.1",
      SCHOOL_BRIDGE_URL: `http://127.0.0.1:${BRIDGE_PORT}`, SCHOOL_BRIDGE_TOKEN: KEY },
    stdout: "pipe", stderr: "pipe",
  });
  await until(base + "/", (r) => r.ok);
});
afterAll(async () => {
  for (const p of [server, bridge]) { p?.kill(); await p?.exited; }
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type Lesson = { encounterId: string; lesson: { children: { type: string; id: string }[] }; explanations: { text: string; grading: { status: string; findings?: { summary: string } } | null }[] };
const lesson = async (): Promise<Lesson> => (await fetch(base + "/api/courses/c/lessons/l1")).json();

let submissionId = "";

test("before submitting, the lesson has the explain block and no explanation yet", async () => {
  const l = await lesson();
  expect(l.lesson.children.map((b) => [b.type, b.id])).toEqual([["explain", "e1"]]);
  expect(l.explanations).toEqual([]);
});

test("submit saves, then grading returns a verdict rendered as escaped text, with the model answer", async () => {
  const e = (await lesson()).encounterId;
  submissionId = crypto.randomUUID();
  const saved = await post("/api/explanation", { submissionId, encounterId: e, blockId: "e1", text: "You keep the changes; state is a replay. <script>x</script>", ms: 9 });
  expect(saved.status).toBe(200);
  expect((await saved.json()).status).toBe("stored");

  const graded = await post("/api/grade", { submissionId });
  expect(graded.status).toBe(200);
  const body = await graded.json();
  expect(body.status).toBe("succeeded");
  expect(body.explanation.text).toBe("You keep the changes; state is a replay. <script>x</script>");
  expect(body.explanation.grading.findings.completeness).toEqual({ verdict: "partly", note: "Give one <b>example</b>." });
  expect(body.explanation.grading.findings.contradictions[0].quote_verified).toBe(true);
});

test("a reload shows the explanation and its grading from the database", async () => {
  const [x] = (await lesson()).explanations;
  expect(x!.text).toContain("You keep the changes; state is a replay.");
  expect(x!.grading?.findings?.summary).toBe("Close. Add an example.");
});

test("a grader outage keeps the explanation and says so; a retry later succeeds", async () => {
  writeFileSync(join(root, "down"), "");
  const failed = await (await post("/api/grade", { submissionId })).json();
  expect(failed.status).toBe("failed");
  expect(failed.explanation.grading.status).toBe("failed");
  expect(failed.explanation.grading.error).toContain("fake-agent: exit 1");
  expect(failed.explanation.text).toContain("You keep the changes"); // still saved
  unlinkSync(join(root, "down"));
  expect((await (await post("/api/grade", { submissionId })).json()).status).toBe("succeeded");
});

test("grading an unknown submission is a 404, and a malformed one a 400", async () => {
  expect((await post("/api/grade", { submissionId: crypto.randomUUID() })).status).toBe(404);
  expect((await post("/api/grade", { submissionId: "x" })).status).toBe(400);
  expect((await post("/api/explanation", { submissionId: crypto.randomUUID(), encounterId: crypto.randomUUID(), blockId: "e1", text: "", ms: 1 })).status).toBe(400);
});

test("the bridge token appears nowhere: not in the database, a page or the server's output", async () => {
  const dbBytes = readFileSync(join(root, "state", "progress.db")).toString("latin1") +
    (() => { try { return readFileSync(join(root, "state", "progress.db-wal")).toString("latin1"); } catch { return ""; } })();
  expect(dbBytes).not.toContain(KEY);
  expect(JSON.stringify(await lesson())).not.toContain(KEY);
  server!.kill();
  await server!.exited;
  const out = (await new Response(server!.stdout as ReadableStream).text()) + (await new Response(server!.stderr as ReadableStream).text());
  expect(out).not.toContain(KEY);
  server = null;
});

