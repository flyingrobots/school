// CI's proof that the Postgres tests ran (flyingrobots/school#23). The Bun.SQL tests skip on a
// machine without SCHOOL_TEST_POSTGRES_URL, and a skipped test passes: in CI that would drop the
// whole suite on real Postgres without failing the build. So the CI job writes the run's JUnit
// report and this reads it:
//
//   bun run server/testing/postgres-gate.ts <junit.xml>
//
// It fails (exit 1) unless every test that names Bun.SQL ran and passed, and every case that runs
// on PGlite as "postgres (PGlite): <title>" also ran as "postgres (Bun.SQL): <title>": the whole
// LearningRecord contract and the learner-history story, on both drivers. It prints JSON Lines on
// stdout, each naming its published schema in server/schemas/postgres-gate/ (flyingrobots/school#135;
// docs/topics/program-output/README.md): a `problem` line for each thing wrong, then one `verdict`
// line; an `error` line if it cannot read the report. `--help`, `--schema` and `--human` as for the
// migrate job. Not shipped.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonLines, loadSchemas } from "../jsonl.ts";

export type Case = { name: string; classname: string; file: string; outcome: "passed" | "failed" | "skipped" };
export type Problem =
  | { problem: "skipped" | "failed"; name: string; file: string }
  | { problem: "missing"; name: string; counterpart: string }
  | { problem: "none-ran" };

const PGLITE = "postgres (PGlite): ";
const BUNSQL = "postgres (Bun.SQL): ";

const unescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, e: string, d?: string, h?: string) =>
    d !== undefined ? String.fromCodePoint(Number(d)) : h !== undefined ? String.fromCodePoint(parseInt(h, 16))
      : ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[e.toLowerCase()]!);

/** Every <testcase> in a bun JUnit report, with how it ended. */
export function cases(xml: string): Case[] {
  const out: Case[] = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = m[1]!;
    const get = (k: string) => unescape(new RegExp(`\\s${k}="([^"]*)"`).exec(` ${attrs}`)?.[1] ?? "");
    const body = m[3] ?? "";
    out.push({
      name: get("name"), classname: get("classname"), file: get("file"),
      outcome: /<skipped\b/.test(body) ? "skipped" : /<(failure|error)\b/.test(body) ? "failed" : "passed",
    });
  }
  return out;
}

/** What is wrong with a CI run on real Postgres; empty when the Postgres suite ran in full. */
export function problems(all: readonly Case[]): Problem[] {
  const found: Problem[] = [];
  const bun = all.filter((c) => c.name.includes("Bun.SQL") || c.classname.includes("Bun.SQL"));
  if (bun.length === 0) found.push({ problem: "none-ran" });
  for (const c of bun) if (c.outcome !== "passed") found.push({ problem: c.outcome, name: c.name, file: c.file });
  // A case that ran on Bun.SQL but did not pass is reported above; this finds one that never registered.
  for (const c of all) {
    if (!c.name.startsWith(PGLITE)) continue;
    const counterpart = BUNSQL + c.name.slice(PGLITE.length);
    if (!bun.some((b) => b.name === counterpart)) found.push({ problem: "missing", name: c.name, counterpart });
  }
  return found;
}

if (import.meta.main) main();

function main() {
  const KIND = "postgres-gate";
  const schemas = loadSchemas(join(import.meta.dir, "..", "schemas", "postgres-gate"));
  const ids = { help: `school.${KIND}.help`, schema: `school.${KIND}.schema`, problem: `school.${KIND}.problem`, verdict: `school.${KIND}.verdict`,
    usage: `school.${KIND}.error.usage`, failed: `school.${KIND}.error.failed` };
  const USAGE = "bun run server/testing/postgres-gate.ts <junit.xml> | --help | --schema [--human]";
  const args = process.argv.slice(2);
  const human = args.includes("--human") || args.includes("--humanize");

  const prose = (l: Record<string, any>): string => {
    switch (l._schema.id) {
      case ids.help:
        return [`postgres-gate: ${l.summary}`, "", `usage: ${l.usage}`, "", "options:",
          ...l.options.map((o: { flags: string[]; description: string }) => `  ${o.flags.join(", ")}  ${o.description}`), "", "exit codes:",
          ...l.exit.map((e: { code: number; meaning: string }) => `  ${e.code}  ${e.meaning}`), "",
          "output: JSON Lines unless --human is given, each line one of these message types (--schema prints their schemas):",
          ...l.output.map((id: string) => `  ${id}`), "", `(run ${l.run})`].join("\n");
      case ids.schema: return `schema ${l.id} ${l.version}\n${JSON.stringify(l.schema, null, 2)}`;
      case ids.problem:
        return l.problem === "none-ran" ? "problem: no test ran on Bun.SQL"
          : l.problem === "missing" ? `problem: ${l.name} has no counterpart ${l.counterpart}`
          : `problem: ${l.name} (${l.file}) ${l.problem}`;
      case ids.verdict: return `${l.ok ? "ok" : "not ok"}: ${l.ranOnBunSql} Bun.SQL tests passed of ${l.cases} cases`;
      default: return `error (${l.error}): ${l.message}`;
    }
  };

  // Every line on stdout, as before flyingrobots/school#135, so CI's log shows them in order.
  const out = jsonLines({ kind: KIND, schemas, human, prose });
  process.on("uncaughtException", out.crashHandler(ids.failed, { error: "failed", code: 1 }));
  process.on("unhandledRejection", out.crashHandler(ids.failed, { error: "failed", code: 1 }));
  const fail = (kind: "usage" | "failed", message: string): never => {
    out.emit("stdout", ids[kind], { event: "error", error: kind, code: 1, message });
    process.exit(1);
  };
  const printSchemas = () => {
    for (const s of schemas.values()) out.emit("stdout", ids.schema, { event: "schema", id: s.id, version: s.version, schema: s.schema });
  };

  const FLAGS = ["--help", "-h", "--schema", "--human", "--humanize"];
  const unknown = args.filter((a) => a.startsWith("-") && !FLAGS.includes(a));
  if (unknown.length > 0) fail("usage", `unknown option${unknown.length === 1 ? "" : "s"} ${unknown.join(" ")}; usage: ${USAGE}`);
  if (args.includes("--help") || args.includes("-h")) {
    out.emit("stdout", ids.help, { event: "help", command: KIND, usage: USAGE,
      summary: "Fail CI unless every test that names Bun.SQL ran and passed, and every PGlite case also ran on Bun.SQL, reading the run's JUnit report.",
      options: [
        { flags: ["--help", "-h"], description: "Print this help and the schema of every message type, then exit 0. Reads no report." },
        { flags: ["--schema"], description: "Print every published message schema, then exit 0. Reads no report." },
        { flags: ["--human", "--humanize"], description: "Print prose instead of JSON Lines. Nothing else switches the format." },
      ],
      environment: [],
      exit: [
        { code: 0, meaning: "The Postgres suite ran in full; or --help or --schema printed." },
        { code: 1, meaning: "A problem was found, no report was named, or the report could not be read." },
      ],
      output: [...schemas.keys()] });
    if (!human) printSchemas();
    process.exit(0);
  }
  if (args.includes("--schema")) {
    printSchemas();
    process.exit(0);
  }
  const paths = args.filter((a) => !FLAGS.includes(a));
  if (paths.length !== 1) fail("usage", `name one JUnit report; usage: ${USAGE}`);
  let xml: string;
  try {
    xml = readFileSync(paths[0]!, "utf8");
  } catch (e) {
    fail("failed", e instanceof Error ? e.message : String(e));
  }
  const all = cases(xml!);
  const found = problems(all);
  for (const p of found) out.emit("stdout", ids.problem, { event: "problem", ...p });
  const ranOnBunSql = all.filter((c) => c.outcome === "passed" && (c.name.includes("Bun.SQL") || c.classname.includes("Bun.SQL"))).length;
  out.emit("stdout", ids.verdict, { event: "verdict", ok: found.length === 0, ranOnBunSql, cases: all.length });
  process.exit(found.length === 0 ? 0 : 1);
}
