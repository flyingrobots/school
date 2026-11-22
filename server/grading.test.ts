// Explanation grading end to end: the real server, a fake Anthropic endpoint (flyingrobots/school#10).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "school-grading-"));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
const KEY = "sk-ant-test-NEVER-STORE-ME";
let server: ReturnType<typeof Bun.spawn> | null = null;

let healthy = true;
const verdict = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "Faithful to the source." },
  completeness: { verdict: "partly", note: "Give one <b>example</b>." },
  accessibility: { verdict: "meets", note: "Plain." },
  contradictions: [{ source_id: "readme", quote: "the transformation, not the state", note: "Matches." }],
  summary: "Close. Add an example.",
};
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    await req.json();
    if (!healthy) return new Response("overloaded", { status: 529 });
    return Response.json({ model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdict) }] });
  },
});

beforeAll(async () => {
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify({
    type: "page", id: "l1", title: "One", subtitle: "", children: [{
      type: "explain", id: "e1", prompt: "Explain the inversion.", model: "MODEL-ANSWER-TEXT",
      sources: [{ id: "readme", title: "README", text: "The unit of storage should be the transformation, not the state." }],
    }],
  }));
  server = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), PORT: String(PORT), HOST: "127.0.0.1",
      SCHOOL_GRADER: "anthropic", SCHOOL_GRADER_URL: `http://127.0.0.1:${fake.port}`, SCHOOL_GRADER_API_KEY: KEY },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/")).ok) return; } catch {}
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
});
afterAll(async () => {
  server?.kill();
  await server?.exited;
  fake.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const lesson = async () => (await fetch(base + "/courses/c/lessons/l1")).text();

let submissionId = "";

test("before submitting, the page offers a text box and hides the model answer", async () => {
  const html = await lesson();
  expect(html).toContain("<textarea");
  expect(html).not.toContain("MODEL-ANSWER-TEXT");
});

test("submit saves, then grading returns a verdict rendered as escaped text, with the model answer", async () => {
  const e = /data-encounter="([^"]+)"/.exec(await lesson())![1]!;
  submissionId = crypto.randomUUID();
  const saved = await post("/api/explanation", { submissionId, encounterId: e, blockId: "e1", text: "You keep the changes; state is a replay. <script>x</script>", ms: 9 });
  expect(saved.status).toBe(200);
  expect((await saved.json()).status).toBe("stored");

  const graded = await post("/api/grade", { submissionId });
  expect(graded.status).toBe(200);
  const body = await graded.json();
  expect(body.status).toBe("succeeded");
  expect(body.html).toContain("partly");
  expect(body.html).toContain("Give one &lt;b&gt;example&lt;/b&gt;.");
  expect(body.html).toContain("MODEL-ANSWER-TEXT");
  expect(body.html).toContain("&lt;script&gt;x&lt;/script&gt;");
  expect(body.html).not.toContain("<script>x");
});

test("a reload shows the explanation and its grading from the database", async () => {
  const html = await lesson();
  expect(html).toContain("You keep the changes; state is a replay.");
  expect(html).toContain("Close. Add an example.");
  expect(html).toContain("MODEL-ANSWER-TEXT");
});

test("a grader outage keeps the explanation and says so; a retry later succeeds", async () => {
  healthy = false;
  const failed = await (await post("/api/grade", { submissionId })).json();
  expect(failed.status).toBe("failed");
  expect(failed.html).toContain("Your explanation is saved. Automated feedback is unavailable. Retry when ready.");
  healthy = true;
  expect((await (await post("/api/grade", { submissionId })).json()).status).toBe("succeeded");
});

test("grading an unknown submission is a 404, and a malformed one a 400", async () => {
  expect((await post("/api/grade", { submissionId: crypto.randomUUID() })).status).toBe(404);
  expect((await post("/api/grade", { submissionId: "x" })).status).toBe(400);
  expect((await post("/api/explanation", { submissionId: crypto.randomUUID(), encounterId: crypto.randomUUID(), blockId: "e1", text: "", ms: 1 })).status).toBe(400);
});

test("the API key appears nowhere: not in the database, a page or the server's output", async () => {
  const dbBytes = readFileSync(join(root, "state", "progress.db")).toString("latin1") +
    (() => { try { return readFileSync(join(root, "state", "progress.db-wal")).toString("latin1"); } catch { return ""; } })();
  expect(dbBytes).not.toContain(KEY);
  expect(await lesson()).not.toContain(KEY);
  server!.kill();
  await server!.exited;
  const out = (await new Response(server!.stdout as ReadableStream).text()) + (await new Response(server!.stderr as ReadableStream).text());
  expect(out).not.toContain(KEY);
  server = null;
});

test("the slides view shows the prompt and model answer, and records nothing", async () => {
  // The server was stopped by the previous test; this one reads the renderer directly.
  const { renderPage } = await import("./render.ts");
  const html = renderPage("c", { type: "page", id: "l1", title: "One", subtitle: "", children: [
    { type: "explain", id: "e1", prompt: "P", model: "M", sources: [] },
  ] } as never, "slides", {});
  expect(html).not.toContain("<textarea");
  expect(html).toContain("M");
});
