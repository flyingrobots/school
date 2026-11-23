// The CI gate that fails a run in which the Postgres tests did not all run (./postgres-gate.ts).
import { expect, test } from "bun:test";
import { cases, problems } from "./postgres-gate.ts";

const report = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test">\n${body}\n</testsuites>`;
const tc = (name: string, classname = "", inner = "") =>
  `<testcase name="${name}" classname="${classname}" file="f.test.ts" line="1"${inner === "" ? " />" : `>${inner}</testcase>`}`;

test("reads each case's name, its describe and how it ended, unescaping XML", () => {
  expect(cases(report([
    tc("postgres (Bun.SQL): a &quot;quoted&quot; &amp; &lt;tagged&gt; title", "Bun.SQL on a real Postgres"),
    tc("skipped one", "", "\n      <skipped />\n    "),
    tc("failed one", "", `<failure type="AssertionError" message="no" />`),
  ].join("\n")))).toEqual([
    { name: `postgres (Bun.SQL): a "quoted" & <tagged> title`, classname: "Bun.SQL on a real Postgres", file: "f.test.ts", outcome: "passed" },
    { name: "skipped one", classname: "", file: "f.test.ts", outcome: "skipped" },
    { name: "failed one", classname: "", file: "f.test.ts", outcome: "failed" },
  ]);
});

test("a run with every PGlite case also passing on Bun.SQL is clean", () => {
  expect(problems(cases(report([
    tc("postgres (PGlite): a"), tc("postgres (Bun.SQL): a", "Bun.SQL on a real Postgres"),
    tc("opening migrates", "Bun.SQL on a real Postgres"), tc("sqlite: a", "", "<skipped />"),
  ].join("\n"))))).toEqual([]);
});

test("a skipped Bun.SQL test fails the gate, whether its name or its describe names Bun.SQL", () => {
  expect(problems(cases(report([
    tc("postgres (PGlite): a"), tc("postgres (Bun.SQL): a", "", "<skipped />"),
    tc("opening migrates", "Bun.SQL on a real Postgres", "<skipped />"),
  ].join("\n"))))).toEqual([
    { problem: "skipped", name: "postgres (Bun.SQL): a", file: "f.test.ts" },
    { problem: "skipped", name: "opening migrates", file: "f.test.ts" },
  ]);
});

test("a PGlite case with no Bun.SQL counterpart fails the gate: a story registered on one driver only", () => {
  expect(problems(cases(report([
    tc("postgres (PGlite): a"), tc("postgres (Bun.SQL): a"), tc("postgres (PGlite): learner history replays"),
  ].join("\n"))))).toEqual([
    { problem: "missing", name: "postgres (PGlite): learner history replays", counterpart: "postgres (Bun.SQL): learner history replays" },
  ]);
});

test("a run in which nothing touched Bun.SQL fails the gate, even with no PGlite cases to compare", () => {
  expect(problems(cases(report(tc("sqlite: a"))))).toEqual([{ problem: "none-ran" }]);
  expect(problems([])).toEqual([{ problem: "none-ran" }]);
});

// --- The gate as CI runs it: its output contract (flyingrobots/school#135) ----------------------
// Every line it prints validates against its published schema in server/schemas/postgres-gate/.
import { describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishedIn, wellFormed } from "./schemas.ts";

const GATE = join(import.meta.dir, "postgres-gate.ts");
const gateSchemas = publishedIn(join(import.meta.dir, "..", "schemas", "postgres-gate"));
const GATE_IDS = ["school.postgres-gate.error.failed", "school.postgres-gate.error.usage", "school.postgres-gate.help",
  "school.postgres-gate.problem", "school.postgres-gate.schema", "school.postgres-gate.verdict"];

async function gate(args: string[]) {
  const proc = Bun.spawn(["bun", GATE, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** A report file holding `body`, in a folder removed after the test. */
function reportFile(body: string): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "school-gate-"));
  const path = join(dir, "junit.xml");
  writeFileSync(path, report(body));
  return { path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("the gate's output (server/schemas/postgres-gate/)", () => {
  test("gate schemas: one file per message type, each well formed, kind postgres-gate", () => {
    expect(gateSchemas.ids).toEqual(GATE_IDS);
    for (const p of gateSchemas.published) {
      expect({ file: p.file, wrong: wellFormed(p, ["_schema", "kind", "event", "run", "at"]) }).toEqual({ file: p.file, wrong: [] });
      expect(p.schema.properties.kind.const).toBe("postgres-gate");
    }
  });

  test("gate problem schema: each kind of problem carries exactly its own fields", () => {
    const base = { _schema: { id: "school.postgres-gate.problem", version: "1.0.0" }, kind: "postgres-gate", event: "problem", run: crypto.randomUUID(), at: new Date().toISOString() };
    const ok = (l: object) => gateSchemas.valid("school.postgres-gate.problem", { ...base, ...l });
    expect(ok({ problem: "skipped", name: "a", file: "f" })).toBe(true);
    expect(ok({ problem: "missing", name: "a", counterpart: "b" })).toBe(true);
    expect(ok({ problem: "none-ran" })).toBe(true);
    expect(ok({ problem: "failed", name: "a" })).toBe(false);
    expect(ok({ problem: "missing", name: "a", file: "f" })).toBe(false);
    expect(ok({ problem: "none-ran", name: "a" })).toBe(false);
  });

  test("gate, a clean report: problem-free verdict line, exit 0, every line valid, one run id", async () => {
    const r = reportFile([tc("postgres (PGlite): a"), tc("postgres (Bun.SQL): a", "Bun.SQL on a real Postgres")].join("\n"));
    try {
      const ran = await gate([r.path]);
      expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });
      const out = gateSchemas.validated(ran.stdout);
      expect(out.map((l) => l._schema.id)).toEqual(["school.postgres-gate.verdict"]);
      expect(out[0]).toMatchObject({ kind: "postgres-gate", event: "verdict", ok: true, ranOnBunSql: 1, cases: 2 });
    } finally { r.done(); }
  });

  test("gate, a failing report: a problem line for each, then the verdict, exit 1, every line valid, one run id", async () => {
    const r = reportFile([tc("postgres (PGlite): a"), tc("postgres (Bun.SQL): a", "", "<skipped />"), tc("postgres (PGlite): b")].join("\n"));
    try {
      const ran = await gate([r.path]);
      expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 1, stderr: "" });
      const out = gateSchemas.validated(ran.stdout);
      expect(out.map((l) => l.event)).toEqual(["problem", "problem", "verdict"]);
      expect(out.map((l) => l.problem)).toEqual(["skipped", "missing", undefined]);
      expect(out.at(-1)).toMatchObject({ ok: false });
      expect(new Set(out.map((l) => l.run)).size).toBe(1);
    } finally { r.done(); }
  });

  test("gate, a report in which nothing ran on Bun.SQL: a none-ran problem, exit 1", async () => {
    const r = reportFile(tc("sqlite: a"));
    try {
      const ran = await gate([r.path]);
      expect(ran.code).toBe(1);
      expect(gateSchemas.validated(ran.stdout).map((l) => [l.event, l.problem])).toEqual([["problem", "none-ran"], ["verdict", undefined]]);
    } finally { r.done(); }
  });

  test("gate, no report named or an unknown option: one usage error line, exit 1; an unreadable report: one failed error line, exit 1", async () => {
    for (const args of [[], ["--frobnicate"]]) {
      const ran = await gate(args);
      expect({ args, code: ran.code, stderr: ran.stderr }).toEqual({ args, code: 1, stderr: "" });
      const out = gateSchemas.validated(ran.stdout);
      expect(out.map((l) => l._schema.id)).toEqual(["school.postgres-gate.error.usage"]);
      expect(out[0]).toMatchObject({ event: "error", error: "usage", code: 1 });
    }
    const ran = await gate([join(tmpdir(), "no-such-report-qqq.xml")]);
    expect(ran.code).toBe(1);
    expect(gateSchemas.validated(ran.stdout).map((l) => [l._schema.id, l.error])).toEqual([["school.postgres-gate.error.failed", "failed"]]);
  });

  test("gate --help: a help line, then every schema, as JSON Lines, exit 0, reading no report; --schema: every schema", async () => {
    const help = await gate(["--help"]);
    expect({ code: help.code, stderr: help.stderr }).toEqual({ code: 0, stderr: "" });
    const out = gateSchemas.validated(help.stdout);
    expect(out[0]).toMatchObject({ event: "help", command: "postgres-gate" });
    expect((out[0]!.output as string[]).sort()).toEqual(GATE_IDS);
    expect(out.slice(1).map((l) => l.schema)).toEqual(gateSchemas.published.map((p) => p.schema) as never);
    expect(new Set(out.map((l) => l.run)).size).toBe(1);
    const schema = await gate(["--schema"]);
    expect(schema.code).toBe(0);
    expect(gateSchemas.validated(schema.stdout).map((l) => l.id)).toEqual(GATE_IDS);
  });

  test("gate --human: the help and a verdict are prose, no line JSON", async () => {
    const help = await gate(["--help", "--human"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--schema");
    const r = reportFile(tc("sqlite: a"));
    try {
      const ran = await gate([r.path, "--human"]);
      expect(ran.code).toBe(1);
      expect(ran.stdout).toContain("no test ran on Bun.SQL");
      for (const text of [help.stdout, ran.stdout]) for (const l of text.split("\n").filter((x) => x !== "")) expect(() => JSON.parse(l)).toThrow();
    } finally { r.done(); }
  });
});
