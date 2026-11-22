// The grading client (RFC 1 proposal 4; flyingrobots/school#10), against fake model servers.
import { afterAll, expect, test } from "bun:test";
import { RESPONSE_SCHEMA, callGrader, checkQuotes, graderConfig, type GradingInput } from "./grade.ts";

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
  contradictions: [{ source_id: "readme", quote: "should be the transformation, not the state", note: "Fine." }],
  summary: "Good start; add an example.",
};

type Seen = { path: string; headers: Headers; body: any };
const seen: Seen[] = [];
let reply: (s: Seen) => Response = () => Response.json({});
const fake = Bun.serve({
  port: 0,
  async fetch(req) {
    const s = { path: new URL(req.url).pathname, headers: req.headers, body: await req.json() };
    seen.push(s);
    return reply(s);
  },
});
afterAll(() => fake.stop(true));
const base = `http://127.0.0.1:${fake.port}`;

const anthropic = (over: Record<string, string> = {}) =>
  graderConfig({ SCHOOL_GRADER: "anthropic", SCHOOL_GRADER_URL: base, SCHOOL_GRADER_API_KEY: "sk-test-SECRET", ...over })!;
const anthropicReply = (body: object) => () => Response.json({
  model: "claude-opus-5-5", stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(body) }],
});

test("no grader configured is not an error, just no grader", () => {
  expect(graderConfig({})).toBeNull();
  expect(() => graderConfig({ SCHOOL_GRADER: "telepathy" })).toThrow(/SCHOOL_GRADER/);
  expect(() => graderConfig({ SCHOOL_GRADER: "openai-compatible" })).toThrow(/SCHOOL_GRADER_URL/);
});

test("anthropic: the request carries the rubric schema, the key, and the learner text as data", async () => {
  reply = anthropicReply(verdict);
  const out = await callGrader(anthropic(), input);
  expect(out.status).toBe("succeeded");
  const req = seen.at(-1)!;
  expect(req.path).toBe("/v1/messages");
  expect(req.headers.get("x-api-key")).toBe("sk-test-SECRET");
  expect(req.headers.get("anthropic-version")).toBe("2026-10-21");
  expect(req.body.model).toBe("claude-opus-5-5");
  expect(req.body.output_config.format).toEqual({ type: "json_schema", schema: RESPONSE_SCHEMA });
  expect(JSON.stringify(req.body.messages)).toContain(input.explanation);
  expect(JSON.stringify(req.body.messages)).toContain("readme");
  if (out.status === "succeeded") {
    expect(out.findings.completeness.verdict).toBe("partly");
    expect(out.model).toBe("claude-opus-5-5");
    expect(out.raw).not.toContain("SECRET");
  }
});

test("openai-compatible: chat completions with a json_schema response format", async () => {
  reply = () => Response.json({ model: "local-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(verdict) } }] });
  const out = await callGrader(graderConfig({ SCHOOL_GRADER: "openai-compatible", SCHOOL_GRADER_URL: base + "/v1", SCHOOL_GRADER_MODEL: "local-model" })!, input);
  expect(out.status).toBe("succeeded");
  const req = seen.at(-1)!;
  expect(req.path).toBe("/v1/chat/completions");
  expect(req.body.response_format.type).toBe("json_schema");
  expect(req.body.response_format.json_schema.schema).toEqual(RESPONSE_SCHEMA);
  expect(req.headers.get("authorization")).toBeNull(); // no key configured, none sent
});

test.each([
  ["a refusal", () => Response.json({ model: "m", stop_reason: "refusal", content: [] }), /refus/],
  ["running out of tokens", () => Response.json({ model: "m", stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }), /max_tokens/],
  ["malformed JSON", () => Response.json({ model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }), /JSON/],
  ["JSON of the wrong shape", () => Response.json({ model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "{\"fidelity\":1}" }] }), /shape/],
  ["an HTTP 500", () => new Response("upstream broke", { status: 500 }), /500/],
] as const)("%s fails, and is never a verdict", async (_name, r, why) => {
  reply = r;
  const out = await callGrader(anthropic(), input);
  expect(out.status).toBe("failed");
  if (out.status === "failed") expect(out.error).toMatch(why);
});

test("a timeout fails", async () => {
  reply = () => new Response(new ReadableStream({ start() {} })); // never finishes
  const out = await callGrader(anthropic({ SCHOOL_GRADER_TIMEOUT_MS: "200" }), input);
  expect(out.status).toBe("failed");
  if (out.status === "failed") expect(out.error).toMatch(/time/i);
});

test("an unreachable grader fails", async () => {
  const out = await callGrader(graderConfig({ SCHOOL_GRADER: "anthropic", SCHOOL_GRADER_URL: "http://127.0.0.1:9", SCHOOL_GRADER_API_KEY: "k" })!, input);
  expect(out.status).toBe("failed");
});

test("a quote is verified only when it appears in the source it names", () => {
  const checked = checkQuotes([
    { source_id: "readme", quote: "should be the  transformation,\nnot the state", note: "" }, // whitespace differs
    { source_id: "readme", quote: "storage should be a database", note: "" },
    { source_id: "nope", quote: "anything", note: "" },
    { source_id: "model", quote: "AIΩN saves how they got there", note: "" },
  ], input.sources, input.modelAnswer);
  expect(checked.map((c) => c.quote_verified)).toEqual([true, false, false, true]);
});
