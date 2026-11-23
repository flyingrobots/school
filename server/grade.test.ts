// The server's side of grading: what it sends the bridge and how it reads the reply
// (RFC 1 proposal 4; flyingrobots/school#10). A fake bridge stands in for bridge/bridge.ts.
import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pgliteSql } from "./adapters/pglite.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import type { Block } from "./core/model.ts";
import { createSchool } from "./core/school.ts";
import { migrate } from "./db/migrate.ts";
import { PROMPT_VERSION, RESPONSE_SCHEMA, RUBRIC_VERSION, bridgeConfig, callBridge, checkQuotes, type GradingInput } from "./grade.ts";

const input: GradingInput = {
  prompt: "Explain the inversion in under 30 seconds.",
  modelAnswer: "Most systems save what things look like now. AIΩN saves how they got there.",
  sources: [{ id: "readme", title: "AIΩN README", text: "The fundamental unit of computational storage should be the transformation, not the state." }],
  explanation: "You keep every change, and the current state is just a replay of them.",
};
const verdict = {
  insufficient_evidence: false,
  fidelity: { verdict: "meets", note: "Matches the thesis." },
  completeness: { verdict: "partly", note: "No example." },
  accessibility: { verdict: "meets", note: "Plain words." },
  contradictions: [],
  summary: "Good start; add an example.",
};

const TOKEN = "server-side-token-0123";
let seen: { auth: string | null; body: any } | null = null;
let reply: () => Response = () => Response.json({});
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    seen = { auth: req.headers.get("authorization"), body: await req.json() };
    return reply();
  },
});
afterAll(() => fake.stop(true));
const cfg = (over: Record<string, string> = {}) =>
  bridgeConfig({ SCHOOL_BRIDGE_URL: `http://127.0.0.1:${fake.port}`, SCHOOL_BRIDGE_TOKEN: TOKEN, ...over })!;

test("no bridge configured is not an error, just no grading", () => {
  expect(bridgeConfig({})).toBeNull();
  expect(() => bridgeConfig({ SCHOOL_BRIDGE_URL: "http://x" })).toThrow(/SCHOOL_BRIDGE_TOKEN/);
  expect(() => bridgeConfig({ SCHOOL_BRIDGE_URL: "x:1", SCHOOL_BRIDGE_TOKEN: TOKEN })).toThrow(/http/);
  expect(() => bridgeConfig({ SCHOOL_BRIDGE_URL: "http://x", SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_DEADLINE_MS: "999999" })).toThrow(/240000/);
});

test("the server sends one prompt holding the rubric, sources and learner text, the schema, the deadline and the token", async () => {
  reply = () => Response.json({ status: "succeeded", agent: "claude", output: verdict, attempts: [{ agent: "claude", status: "succeeded" }] });
  const out = await callBridge(cfg(), input);
  expect(out).toMatchObject({ status: "succeeded", model: "claude" });
  expect(seen!.auth).toBe(`Bearer ${TOKEN}`);
  expect(seen!.body.schema).toEqual(RESPONSE_SCHEMA);
  expect(seen!.body.deadline_ms).toBe(240000);
  for (const part of [input.explanation, input.modelAnswer, "readme", "fidelity", "<explanation>"]) expect(seen!.body.prompt).toContain(part);
});

test("every agent failing is a failure that names what each one did", async () => {
  reply = () => Response.json({ status: "failed", error: "every agent failed", attempts: [
    { agent: "claude", status: "failed", error: "timed out after 180 s" }, { agent: "local", status: "skipped", error: "llm: not found on PATH" },
  ] });
  const out = await callBridge(cfg(), input);
  expect(out.status).toBe("failed");
  if (out.status === "failed") expect(out.error).toBe("every agent failed (claude: timed out after 180 s; local: llm: not found on PATH)");
});

test.each([
  ["a refused token", () => new Response("no", { status: 401 }), /token/],
  ["an HTTP error", () => new Response("broke", { status: 500 }), /500/],
  ["a reply that is not JSON", () => new Response("<html>"), /not JSON/],
  ["an answer of the wrong shape", () => Response.json({ status: "succeeded", agent: "a", output: { fidelity: 1 }, attempts: [] }), /shape/],
] as const)("%s fails, and is never a verdict", async (_n, r, why) => {
  reply = r;
  const out = await callBridge(cfg(), input);
  expect(out.status).toBe("failed");
  if (out.status === "failed") expect(out.error).toMatch(why);
});

test("a well-formed failure still names each attempt and keeps the raw reply", async () => {
  const body = { status: "failed", error: "every agent failed", attempts: [{ agent: "claude", status: "failed", error: "exit 1", ms: 5 }] };
  reply = () => Response.json(body);
  expect(await callBridge(cfg(), input)).toEqual({ status: "failed", error: "every agent failed (claude: exit 1)", raw: JSON.stringify(body) });
});

// flyingrobots/school#17: an HTTP 200 whose envelope is not the bridge's reply shape is a failure
// that keeps the raw text, never a throw.
const MALFORMED = [
  ["null", null],
  ["an empty object", {}],
  ["an array", []],
  ["a string", "ok"],
  ["an unknown status", { status: "maybe", attempts: [] }],
  ["a failed envelope without attempts", { status: "failed", error: "every agent failed" }],
  ["a failed envelope whose attempts are not a list", { status: "failed", error: "x", attempts: { agent: "a" } }],
  ["a failed envelope with an attempt that names no agent", { status: "failed", error: "x", attempts: [{ status: "failed" }] }],
  ["a succeeded envelope without output", { status: "succeeded", agent: "claude", attempts: [] }],
  ["a succeeded envelope without an agent", { status: "succeeded", output: verdict, attempts: [] }],
] as const;

test.each(MALFORMED)("a 200 reply of %s is a failure that keeps the raw text", async (_n, body) => {
  reply = () => Response.json(body);
  const out = await callBridge(cfg(), input);
  expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/the bridge's reply was not the expected shape/), raw: JSON.stringify(body) });
});

test("a malformed bridge reply stores one failed grading and returns the honest-failure state", async () => {
  reply = () => Response.json({ status: "failed", error: "every agent failed" });
  const db = new PGlite();
  await migrate(db);
  await db.exec("SET ROLE school_app");
  const school = createSchool({
    record: postgresRecord(pgliteSql(db)),
    grader: { adapter: "bridge", model: "", rubricVersion: RUBRIC_VERSION, promptVersion: PROMPT_VERSION, grade: (i) => callBridge(cfg(), i) },
    clock: { now: () => new Date().toISOString() },
  });
  const page: Block = { type: "page", id: "l1", title: "One", subtitle: "", children: [
    { type: "explain", id: "e1", prompt: input.prompt, model: input.modelAnswer, sources: [...input.sources] },
  ] };
  const { encounter } = await school.openLesson("c", page, null);
  const submissionId = crypto.randomUUID();
  expect((await school.saveExplanation({ submissionId, encounterId: encounter.id, blockId: "e1", text: input.explanation, ms: 9 })).result.status).toBe("stored");

  const graded = await school.gradeExplanation(submissionId);
  expect(graded!.grading).toMatchObject({ status: "failed", error: expect.stringMatching(/not the expected shape/) });
  expect(graded!.explanation).toMatchObject({ text: input.explanation, grading: { status: "failed" } });
  await db.exec("RESET ROLE"); // the record as its owner: school_app may read no table
  const { rows } = await db.query<{ status: string; raw: string }>("SELECT status, raw_response AS raw FROM school.gradings");
  expect(rows).toEqual([{ status: "failed", raw: JSON.stringify({ status: "failed", error: "every agent failed" }) }]);
  await db.close();
}, 30_000); // PGlite starts a whole Postgres in process.

test("an unreachable bridge fails", async () => {
  const out = await callBridge(bridgeConfig({ SCHOOL_BRIDGE_URL: "http://127.0.0.1:9", SCHOOL_BRIDGE_TOKEN: TOKEN })!, input);
  expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/could not be reached/) });
});

test("a quote is verified only when it appears in the source it names", () => {
  const checked = checkQuotes([
    { source_id: "readme", quote: "should be the  transformation,\nnot the state", note: "" },
    { source_id: "readme", quote: "storage should be a database", note: "" },
    { source_id: "nope", quote: "anything", note: "" },
    { source_id: "model", quote: "AIΩN saves how they got there", note: "" },
  ], input.sources, input.modelAnswer);
  expect(checked.map((c) => c.quote_verified)).toEqual([true, false, false, true]);
});
