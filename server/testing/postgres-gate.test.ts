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
