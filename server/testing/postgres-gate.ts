// CI's proof that the Postgres tests ran (flyingrobots/school#23). The Bun.SQL tests skip on a
// machine without SCHOOL_TEST_POSTGRES_URL, and a skipped test passes: in CI that would drop the
// whole suite on real Postgres without failing the build. So the CI job writes the run's JUnit
// report and this reads it:
//
//   bun run server/testing/postgres-gate.ts <junit.xml>
//
// It fails (exit 1) unless every test that names Bun.SQL ran and passed, and every case that runs
// on PGlite as "postgres (PGlite): <title>" also ran as "postgres (Bun.SQL): <title>": the whole
// LearningRecord contract and the learner-history story, on both drivers. It prints one JSON object
// per line: a `problem` line for each thing wrong, then one `verdict` line. Not shipped.
import { readFileSync } from "node:fs";

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

if (import.meta.main) {
  const path = process.argv[2];
  const line = (o: object) => console.log(JSON.stringify({ kind: "postgres-gate", ...o }));
  try {
    if (path === undefined) throw new Error("usage: bun run server/testing/postgres-gate.ts <junit.xml>");
    const all = cases(readFileSync(path, "utf8"));
    const found = problems(all);
    for (const p of found) line({ event: "problem", ...p });
    const ranOnBunSql = all.filter((c) => c.outcome === "passed" && (c.name.includes("Bun.SQL") || c.classname.includes("Bun.SQL"))).length;
    line({ event: "verdict", ok: found.length === 0, ranOnBunSql, cases: all.length });
    process.exit(found.length === 0 ? 0 : 1);
  } catch (e) {
    line({ event: "error", message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  }
}
