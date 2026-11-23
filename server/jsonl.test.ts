// The JSON Lines writer the migrate command prints through (server/jsonl.ts; flyingrobots/school#120).
// In process, with an in-memory writer: what a line carries, how secrets are scrubbed, how output a
// library prints is captured as lines, and how an uncaught throw becomes an error line.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { jsonLines, lineWriter, loadSchemas, type Stream } from "./jsonl.ts";

const schemas = loadSchemas(join(import.meta.dir, "schemas"));

function memory() {
  const written: { stream: Stream; text: string }[] = [];
  return { written, write: (stream: Stream, text: string) => { written.push({ stream, text }); }, parsed: () => written.map((w) => ({ stream: w.stream, ...JSON.parse(w.text) })) };
}

describe("jsonLines", () => {
  test("a line carries its schema's id and version, the kind, the run id and the time, and ends in one newline", () => {
    const m = memory();
    const out = jsonLines({ kind: "school.migrate", schemas, write: m.write });
    out.emit("stdout", "school.migrate.applied", { event: "applied", version: 1, name: "0001_init.sql" });
    expect(m.written).toHaveLength(1);
    expect(m.written[0]!.text).toEndWith("}\n");
    expect(m.written[0]!.text.indexOf("\n")).toBe(m.written[0]!.text.length - 1);
    const [line] = m.parsed();
    expect(line).toMatchObject({ stream: "stdout", _schema: { id: "school.migrate.applied", version: schemas.get("school.migrate.applied")!.version },
      kind: "school.migrate", event: "applied", run: out.run, version: 1, name: "0001_init.sql" });
    expect(Date.parse(line.at)).not.toBeNaN();
  });

  test("a message type with no published schema is refused, not printed", () => {
    const m = memory();
    const out = jsonLines({ kind: "school.migrate", schemas, write: m.write });
    expect(() => out.emit("stdout", "school.migrate.nonesuch", { event: "x" })).toThrow(/no published schema/);
    expect(m.written).toEqual([]);
  });

  test("every secret is replaced in every string of a line, nested ones too, before it is written", () => {
    const m = memory();
    const out = jsonLines({ kind: "school.migrate", schemas, write: m.write, secrets: ["s3cr\"et", "", "hunter2hunter2"] });
    out.emit("stderr", "school.migrate.error.failed", { event: "error", error: "failed", code: 1, message: 'login s3cr"et and hunter2hunter2 refused' });
    expect(m.written[0]!.text).not.toContain("hunter2");
    expect(m.parsed()[0].message).toBe("login (redacted) and (redacted) refused");
  });

  test("with human, a line is its prose instead, scrubbed the same way", () => {
    const m = memory();
    const out = jsonLines({ kind: "school.migrate", schemas, write: m.write, human: true, secrets: ["hunter2hunter2"],
      prose: (l) => `applied ${String(l.name)} hunter2hunter2` });
    out.emit("stdout", "school.migrate.applied", { event: "applied", version: 1, name: "0001_init.sql" });
    expect(m.written).toEqual([{ stream: "stdout", text: "applied 0001_init.sql (redacted)\n" }]);
  });

  test("captured: what a library prints through console or process.stdout/stderr becomes a captured line on the same stream, until restored", () => {
    const m = memory();
    const out = jsonLines({ kind: "school.migrate", schemas, write: m.write, secrets: ["hunter2hunter2"] });
    const before = [console.log, console.error, process.stdout.write, process.stderr.write];
    const restore = out.capture("school.migrate.captured");
    try {
      console.log("notice:", 42, { a: 1 });
      console.info("info");
      console.debug("debug");
      console.warn("warning hunter2hunter2");
      console.error("oops");
      process.stdout.write("raw out\n");
      process.stderr.write(Buffer.from("raw err"));
    } finally {
      restore();
    }
    expect([console.log, console.error, process.stdout.write, process.stderr.write]).toEqual(before);
    expect(m.parsed().map((l) => [l.stream, l.event, l._schema.id, l.text])).toEqual([
      ["stdout", "captured", "school.migrate.captured", "notice: 42 { a: 1 }"],
      ["stdout", "captured", "school.migrate.captured", "info"],
      ["stdout", "captured", "school.migrate.captured", "debug"],
      ["stderr", "captured", "school.migrate.captured", "warning (redacted)"],
      ["stderr", "captured", "school.migrate.captured", "oops"],
      ["stdout", "captured", "school.migrate.captured", "raw out"],
      ["stderr", "captured", "school.migrate.captured", "raw err"],
    ]);
  });

  test("crash: an uncaught throw or rejection becomes one error line on stderr, then the exit code", () => {
    const m = memory();
    const exits: number[] = [];
    const out = jsonLines({ kind: "school.migrate", schemas, write: m.write, secrets: ["hunter2hunter2"], exit: (c) => { exits.push(c); } });
    const crash = out.crashHandler("school.migrate.error.failed", { error: "failed", code: 1 });
    crash(new Error("boom hunter2hunter2"));
    crash("a string thrown");
    expect(exits).toEqual([1, 1]);
    expect(m.parsed().map((l) => [l.stream, l._schema.id, l.event, l.error, l.code, l.message])).toEqual([
      ["stderr", "school.migrate.error.failed", "error", "failed", 1, "boom (redacted)"],
      ["stderr", "school.migrate.error.failed", "error", "failed", 1, "a string thrown"],
    ]);
  });
});

// flyingrobots/school#135: the bridge's lines carry an envelope of their own (its `kind` is the
// message type), so it writes through the part of jsonLines that adds only `_schema`.
describe("lineWriter", () => {
  test("lineWriter: a line is _schema first, then the body as given, scrubbed; no kind, run or time is added; an unpublished type is refused", () => {
    const m = memory();
    const w = lineWriter({ schemas, write: m.write, secrets: ["hunter2hunter2"] });
    w.emit("stderr", "school.migrate.captured", { kind: "anything", text: "said hunter2hunter2" });
    expect(m.written).toHaveLength(1);
    expect(m.written[0]!.text).toBe(`{"_schema":{"id":"school.migrate.captured","version":"${schemas.get("school.migrate.captured")!.version}"},"kind":"anything","text":"said (redacted)"}\n`);
    expect(() => w.emit("stdout", "school.migrate.nonesuch", {})).toThrow(/no published schema/);
    expect(m.written).toHaveLength(1);
  });
});
