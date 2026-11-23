// The migrate job (flyingrobots/school#91): the one process that holds the owner's or superuser's
// URL. It applies School's pending migrations as school_owner, makes school_app a login with its
// own password, and exits; the server then logs in as school_app only (server/adapters/database.ts).
// In compose it is the one-shot `migrate` service, which the server waits for
// (service_completed_successfully).
//
//   SCHOOL_MIGRATE_URL=postgres://postgres:...@host:5432/school SCHOOL_APP_PASSWORD=... bun migrate.ts
//
// Under compose neither password is in the environment (flyingrobots/school#123): the URL names the
// superuser and the host only, SCHOOL_MIGRATE_PASSWORD_FILE names the file holding the superuser's
// password, and SCHOOL_APP_PASSWORD_FILE school_app's; a file wins over the plain variable
// (server/secrets.ts).
//
// Output is JSON Lines, one object per line, each with `kind: "school.migrate"` and an `event`:
// `start` and `done` on stdout, `error` on stderr. No line holds either password: the URL is
// logged by host and database only (`redact`), and any message is scrubbed of both passwords.
// Exit codes: 0 applied (or nothing to apply), 2 a missing or invalid setting, 1 any other failure.
import { APP, migrateRecord, redact } from "./adapters/database.ts";
import { withPassword, withSecretFiles } from "./secrets.ts";

const line = (stream: "out" | "err", o: object) =>
  (stream === "out" ? console.log : console.error)(JSON.stringify({ kind: "school.migrate", ...o }));

const secrets: string[] = [];
const scrub = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, "(redacted)"), text);

function refuse(message: string): never {
  line("err", { event: "error", code: 2, message: scrub(message) });
  process.exit(2);
}

let env: Record<string, string | undefined> = {};
let url = "";
try {
  env = withSecretFiles(process.env);
  for (const s of [env.SCHOOL_APP_PASSWORD, env.SCHOOL_MIGRATE_PASSWORD]) if (s !== undefined && s !== "") secrets.push(s);
  url = withPassword(env.SCHOOL_MIGRATE_URL, env.SCHOOL_MIGRATE_PASSWORD, "SCHOOL_MIGRATE_URL", "SCHOOL_MIGRATE_PASSWORD") ?? "";
} catch (e) {
  refuse(e instanceof Error ? e.message : String(e));
}
const password = env.SCHOOL_APP_PASSWORD ?? "";
{
  let inUrl = "";
  try { inUrl = decodeURIComponent(new URL(url).password); } catch { /* refused below */ }
  if (inUrl !== "") secrets.push(inUrl);
}

if (!/^postgres(ql)?:\/\//.test(url)) refuse("SCHOOL_MIGRATE_URL must be the owner's or superuser's postgres:// URL (the role must be able to create roles)");
try { new URL(url); } catch { refuse("SCHOOL_MIGRATE_URL is not a valid postgres:// URL"); }
if (password === "") refuse("SCHOOL_APP_PASSWORD is not set: it is the password school_app logs in with, the one in the server's SCHOOL_DATABASE_URL");

line("out", { event: "start", where: redact(url), role: APP });
try {
  const { applied } = await migrateRecord(url, password);
  line("out", { event: "done", ok: true, where: redact(url), applied, role: APP });
  process.exit(0);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  line("err", { event: "error", code: message.startsWith("SCHOOL_APP_PASSWORD") ? 2 : 1, message: scrub(message) });
  process.exit(message.startsWith("SCHOOL_APP_PASSWORD") ? 2 : 1);
}
