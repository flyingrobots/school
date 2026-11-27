// The migrate job (flyingrobots/school#91): the one process that holds the owner's or superuser's
// URL. It applies School's pending migrations as school_owner, makes school_app a login with its
// own password, and exits; the server then logs in as school_app only (server/adapters/database.ts).
// In compose it is the one-shot `migrate` service, which the server waits for
// (service_completed_successfully).
//
//   SCHOOL_MIGRATE_URL=postgres://postgres:...@host:5432/school SCHOOL_APP_PASSWORD=... bun migrate.ts
//   bun migrate.ts --rename-course <from>=<to>   (flyingrobots/school#174; db/rename-course.ts)
//   bun migrate.ts --help | --schema [--human]
//
// Output (flyingrobots/school#120; docs/topics/migrate-job/README.md) is JSON Lines on stdout and
// stderr alike: every line is one object naming its schema (`_schema: {id, version}`), one file per
// message type in server/schemas/, with `kind: "school.migrate"`, an `event`, the invocation's `run`
// id and the time. A run prints `start`, an `applied` line per migration as it commits, then `done`;
// an error is one `error` line on stderr. `--help` and `--schema` read no setting and touch no
// database. `--human` (alias `--humanize`) prints the same messages as prose; nothing else does.
// No line holds either password: the URL is logged by host and database only (`redact`), and every
// string is scrubbed of both passwords. Exit codes: 0 applied (or nothing to apply), 2 a bad
// argument or a missing or invalid setting, 1 any other failure.
//
// Under compose neither password is in the environment (flyingrobots/school#123): the URL names the
// superuser and the host only, SCHOOL_MIGRATE_PASSWORD_FILE names the file holding the superuser's
// password, and SCHOOL_APP_PASSWORD_FILE school_app's; a file wins over the plain variable
// (server/secrets.ts). Every secret is resolved before the output is built, so every line is
// scrubbed of all of them.
import { join } from "node:path";
import { APP, migrateRecord, redact, renameRecordCourse } from "./adapters/database.ts";
import { badCourseName } from "./db/rename-course.ts";
import { jsonLines, loadSchemas } from "./jsonl.ts";
import { withPassword, withSecretFiles } from "./secrets.ts";

const KIND = "school.migrate";
const schemas = loadSchemas(join(import.meta.dir, "schemas"));
const ids = { start: `${KIND}.start`, applied: `${KIND}.applied`, done: `${KIND}.done`, captured: `${KIND}.captured`,
  help: `${KIND}.help`, renamed: `${KIND}.renamed`, renamedInstalls: `${KIND}.renamed.installs`, renamedAuthoring: `${KIND}.renamed.authoring`, schema: `${KIND}.schema`, usage: `${KIND}.error.usage`, settings: `${KIND}.error.settings`, failed: `${KIND}.error.failed` };

const OPTIONS = [
  { flags: ["--help", "-h"], description: "Print this help and the schema of every message type, then exit 0. Reads no setting and touches no database." },
  { flags: ["--schema"], description: "Print every published message schema, then exit 0. Reads no setting and touches no database." },
  { flags: ["--human", "--humanize"], description: "Print prose instead of JSON Lines. Nothing else switches the format." },
  { flags: ["--rename-course <from>=<to>"], description: "After the migrations, rename course <from> to <to> in the record, in one transaction that keeps every row (flyingrobots/school#174). Refused while School is connected, if the record has nothing for <from>, or if it already has <to>. Stop School and take a backup first." },
];
const ENVIRONMENT = [
  { name: "SCHOOL_MIGRATE_URL", description: "The owner's or superuser's postgres:// URL; the role must be able to create roles." },
  { name: "SCHOOL_APP_PASSWORD", description: "The password school_app logs in with, the one in the server's SCHOOL_DATABASE_URL: at least 20 letters and digits." },
  { name: "SCHOOL_MIGRATE_PASSWORD_FILE", description: "A file holding the superuser's password, put into SCHOOL_MIGRATE_URL; how compose passes it (a compose secret). A URL that already has a password is refused." },
  { name: "SCHOOL_APP_PASSWORD_FILE", description: "A file holding SCHOOL_APP_PASSWORD; it wins over the plain variable." },
];
const EXIT = [
  { code: 0, meaning: "Every pending migration applied (or none was pending), and school_app may log in; or --help or --schema printed." },
  { code: 1, meaning: "The database refused, a migration failed (that file was rolled back), or anything else went wrong." },
  { code: 2, meaning: "An unknown argument, or SCHOOL_MIGRATE_URL or SCHOOL_APP_PASSWORD missing or invalid. Nothing was changed." },
];
const USAGE = "bun migrate.ts [--help | --schema] [--rename-course <from>=<to>] [--human]";
const SUMMARY = "Apply School's pending migrations as school_owner, make school_app a login with SCHOOL_APP_PASSWORD, and exit.";

const args = process.argv.slice(2);
const human = args.includes("--human") || args.includes("--humanize");
// Resolved before the output exists; a refusal here is reported as a settings error below.
let env: Record<string, string | undefined> = {};
let url = "";
let unresolved: string | null = null;
try {
  env = withSecretFiles(process.env);
  url = withPassword(env.SCHOOL_MIGRATE_URL, env.SCHOOL_MIGRATE_PASSWORD, "SCHOOL_MIGRATE_URL", "SCHOOL_MIGRATE_PASSWORD") ?? "";
} catch (e) {
  unresolved = e instanceof Error ? e.message : String(e);
}
const password = env.SCHOOL_APP_PASSWORD ?? "";
const superPassword = (() => { try { return decodeURIComponent(new URL(url).password); } catch { return env.SCHOOL_MIGRATE_PASSWORD ?? ""; } })();

/** A line as prose, for --human. */
function prose(l: Record<string, any>): string {
  switch (l._schema.id) {
    case ids.help:
      return [`migrate: ${l.summary}`, "", `usage: ${l.usage}`, "", "options:",
        ...l.options.map((o: { flags: string[]; description: string }) => `  ${o.flags.join(", ")}  ${o.description}`), "", "settings:",
        ...l.environment.map((e: { name: string; description: string }) => `  ${e.name}  ${e.description}`), "", "exit codes:",
        ...l.exit.map((e: { code: number; meaning: string }) => `  ${e.code}  ${e.meaning}`), "",
        "output: JSON Lines unless --human is given, each line one of these message types (--schema prints their schemas):",
        ...l.output.map((id: string) => `  ${id}`), "", `(run ${l.run})`].join("\n");
    case ids.schema: return `schema ${l.id} ${l.version}\n${JSON.stringify(l.schema, null, 2)}`;
    case ids.start: return `migrating ${l.where} for ${l.role} (run ${l.run})`;
    case ids.applied: return `applied ${l.name}`;
    case ids.renamed: return `renamed course ${l.from} to ${l.to}: ${l.rows.encounters} encounters, ${l.rows.views} views, ${l.rows.decision_notes} decision notes`;
    case ids.renamedInstalls: return `  and ${l.course_installs} installs, ${l.course_removals} removals`;
    case ids.renamedAuthoring: return `  and ${l.authoring_requests} authoring requests`;
    case ids.done: return `done: ${l.applied.length === 0 ? "nothing to apply" : `applied ${l.applied.length} migration${l.applied.length === 1 ? "" : "s"}`}; ${l.role} may log in`;
    case ids.captured: return `(${l.stream}) ${l.text}`;
    default: return `error (${l.error}): ${l.message}`;
  }
}

const out = jsonLines({ kind: KIND, schemas, human, prose, secrets: [password, superPassword, env.SCHOOL_MIGRATE_PASSWORD ?? ""] });
process.on("uncaughtException", out.crashHandler(ids.failed, { error: "failed", code: 1 }));
process.on("unhandledRejection", out.crashHandler(ids.failed, { error: "failed", code: 1 }));

function fail(kind: "usage" | "settings" | "failed", code: 1 | 2, message: string): never {
  out.emit("stderr", ids[kind], { event: "error", error: kind, code, message });
  process.exit(code);
}

// `--rename-course <from>=<to>`, at most once; its value is the next argument.
let rename: { from: string; to: string } | null = null;
const rest: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--rename-course") { rest.push(args[i]!); continue; }
  const pair = /^([^=]+)=([^=]+)$/.exec(args[i + 1] ?? "");
  if (rename !== null || pair === null) fail("usage", 2, `--rename-course takes one <from>=<to> pair, once; usage: ${USAGE}`);
  for (const n of [pair![1]!, pair![2]!]) {
    const bad = badCourseName(n);
    if (bad !== null) fail("usage", 2, `--rename-course: ${bad}`);
  }
  rename = { from: pair![1]!, to: pair![2]! };
  i++;
}
const unknown = rest.filter((a) => !["--help", "-h", "--schema", "--human", "--humanize"].includes(a));
if (unknown.length > 0) fail("usage", 2, `unknown argument${unknown.length === 1 ? "" : "s"} ${unknown.join(" ")}; usage: ${USAGE}`);

const printSchemas = () => {
  for (const s of schemas.values()) out.emit("stdout", ids.schema, { event: "schema", id: s.id, version: s.version, schema: s.schema });
};
if (args.includes("--help") || args.includes("-h")) {
  out.emit("stdout", ids.help, { event: "help", command: "migrate", usage: USAGE, summary: SUMMARY, options: OPTIONS,
    environment: ENVIRONMENT, exit: EXIT, output: [...schemas.keys()] });
  // As prose, the help names the message types; their schemas are what --schema --human is for.
  if (!human) printSchemas();
  process.exit(0);
}
if (args.includes("--schema")) {
  printSchemas();
  process.exit(0);
}

if (unresolved !== null) fail("settings", 2, unresolved);
if (!/^postgres(ql)?:\/\//.test(url)) fail("settings", 2, "SCHOOL_MIGRATE_URL must be the owner's or superuser's postgres:// URL (the role must be able to create roles)");
try { new URL(url); } catch { fail("settings", 2, "SCHOOL_MIGRATE_URL is not a valid postgres:// URL"); }
if (password === "") fail("settings", 2, "SCHOOL_APP_PASSWORD is not set: it is the password school_app logs in with, the one in the server's SCHOOL_DATABASE_URL");

// From here a driver could print (a notice, a warning): it becomes a `captured` line, never raw text.
out.capture(ids.captured);
out.emit("stdout", ids.start, { event: "start", where: redact(url), role: APP });
try {
  const { applied } = await migrateRecord(url, password, (m) => out.emit("stdout", ids.applied, { event: "applied", version: m.version, name: m.name }));
  if (rename !== null) {
    const r = await renameRecordCourse(url, rename.from, rename.to);
    // `renamed` and `renamed_installs` are 1.0.0, as consumers know them; each later table's count
    // follows in a line of its own.
    const { encounters, views, decision_notes, course_installs, course_removals, authoring_requests } = r.rows;
    out.emit("stdout", ids.renamed, { event: "renamed", from: r.from, to: r.to, rows: { encounters, views, decision_notes } });
    out.emit("stdout", ids.renamedInstalls, { event: "renamed_installs", course_installs, course_removals });
    out.emit("stdout", ids.renamedAuthoring, { event: "renamed_authoring", authoring_requests });
  }
  out.emit("stdout", ids.done, { event: "done", ok: true, where: redact(url), applied, role: APP });
  process.exit(0);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (message.startsWith("SCHOOL_APP_PASSWORD")) fail("settings", 2, message);
  fail("failed", 1, message);
}
