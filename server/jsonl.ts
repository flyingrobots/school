// JSON Lines output for School's commands (flyingrobots/school#120): one JSON object per line, on
// stdout and stderr alike, each naming the published schema it follows (`_schema: {id, version}`)
// and carrying the command's `kind`, the invocation's `run` id and the time (`at`). The schemas are
// the files in server/schemas/, one per message type, versioned on their own; a message type with no
// file is refused rather than printed. With `human` the same messages are written as prose instead.
//
// Lines are written with writeSync, so each is complete before the next statement and before an
// exit. Every string in a line is scrubbed of the given secrets before it is written.
//
// `capture()` routes what a library prints through console or process.stdout/stderr into
// `captured` lines while a command runs; `crashHandler()` is what the command installs for an
// uncaught throw or rejection. What neither can reach (output Bun or a native module writes to the
// file descriptors directly, a hard crash, a signal kill) is in docs/topics/migrate-job/README.md.
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";

export type Stream = "stdout" | "stderr";
export type Write = (stream: Stream, text: string) => void;
export type Published = { id: string; version: string; schema: Record<string, unknown> };
export type Schemas = Map<string, Published>;
export type Fields = Record<string, unknown> & { event: string };

/** The published schemas in `dir` (`<id>.schema.json`), by id, in file order. */
export function loadSchemas(dir: string): Schemas {
  const out: Schemas = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".schema.json")).sort()) {
    const schema = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const id = file.slice(0, -".schema.json".length);
    const version = schema?.properties?._schema?.properties?.version?.const;
    if (typeof version !== "string" || schema.$id !== `${id}/${version}`) throw new Error(`${file}: $id must be ${id}/<version>, matching its _schema`);
    out.set(id, { id, version, schema });
  }
  return out;
}

const fds: Write = (stream, text) => {
  const buf = Buffer.from(text);
  for (let off = 0; off < buf.length;) off += writeSync(stream === "stdout" ? 1 : 2, buf, off);
};

/** Writes whole lines of published message types: `_schema` first, every string scrubbed of `secrets`, prose with `human`. */
export type Writer = {
  /** Write `body` as a message of type `id` to `stream`. Throws, writing nothing, if `id` has no published schema. */
  emit(stream: Stream, id: string, body: Record<string, unknown>): void;
};

/**
 * The part of `jsonLines` that knows nothing of a line's envelope: for a program whose lines carry
 * fields of their own besides `_schema` (the bridge's `kind` is the message type, not the program).
 */
export function lineWriter(o: { schemas: Schemas; human?: boolean; prose?: (line: Record<string, unknown>) => string; secrets?: string[]; write?: Write }): Writer {
  const secrets = (o.secrets ?? []).filter((s) => s !== "");
  const write = o.write ?? fds;
  const scrubText = (t: string) => secrets.reduce((acc, s) => acc.replaceAll(s, "(redacted)"), t);
  const scrub = (v: unknown): unknown => typeof v === "string" ? scrubText(v)
    : Array.isArray(v) ? v.map(scrub)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]))
    : v;
  return {
    emit(stream, id, body) {
      const published = o.schemas.get(id);
      if (published === undefined) throw new Error(`no published schema for ${id}`);
      const line = scrub({ _schema: { id, version: published.version }, ...body }) as Record<string, unknown>;
      write(stream, `${o.human && o.prose ? scrubText(o.prose(line)) : JSON.stringify(line)}\n`);
    },
  };
}

export type Lines = {
  /** This invocation's id, on every line. */
  run: string;
  /** Write one message of type `id` to `stream`. Throws, writing nothing, if `id` has no published schema. */
  emit(stream: Stream, id: string, fields: Fields): void;
  /** Until the returned function is called, console and process.stdout/stderr writes become `id` lines. */
  capture(id: string): () => void;
  /** A handler for an uncaught throw: one `id` error line on stderr, then exit with `fields.code`. */
  crashHandler(id: string, fields: { error: string; code: number }): (e: unknown) => void;
};

export function jsonLines(o: {
  kind: string;
  schemas: Schemas;
  human?: boolean;
  /** The prose for a line, with `human`. */
  prose?: (line: Record<string, unknown>) => string;
  secrets?: string[];
  write?: Write;
  exit?: (code: number) => void;
}): Lines {
  const run = crypto.randomUUID();
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const writer = lineWriter(o);
  const emit = (stream: Stream, id: string, fields: Fields) =>
    writer.emit(stream, id, { kind: o.kind, ...fields, run, at: new Date().toISOString() });

  const capture = (id: string) => {
    const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error, trace: console.trace,
      out: process.stdout.write, err: process.stderr.write };
    const as = (stream: Stream) => (...args: unknown[]) => emit(stream, id, { event: "captured", stream, text: format(...args) });
    const raw = (stream: Stream) => ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      if (text !== "") emit(stream, id, { event: "captured", stream, text: text.replace(/\r?\n$/, "") });
      const done = rest.find((r) => typeof r === "function") as (() => void) | undefined;
      done?.();
      return true;
    }) as typeof process.stdout.write;
    console.log = as("stdout"); console.info = as("stdout"); console.debug = as("stdout");
    console.warn = as("stderr"); console.error = as("stderr"); console.trace = as("stderr");
    process.stdout.write = raw("stdout");
    process.stderr.write = raw("stderr");
    return () => {
      Object.assign(console, { log: saved.log, info: saved.info, debug: saved.debug, warn: saved.warn, error: saved.error, trace: saved.trace });
      process.stdout.write = saved.out;
      process.stderr.write = saved.err;
    };
  };

  const crashHandler = (id: string, fields: { error: string; code: number }) => (e: unknown) => {
    emit("stderr", id, { event: "error", ...fields, message: e instanceof Error ? e.message : String(e) });
    exit(fields.code);
  };

  return { run, emit, capture, crashHandler };
}
