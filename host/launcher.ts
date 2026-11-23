// `school up`, `school down` and `school import` (flyingrobots/school#123): the host launcher.
// Containers cannot reach the Mac's Keychain, so this process resolves School's secrets on the host
// (the environment first, then the Keychain; host/secrets.ts), and runs `docker compose` with them
// in that child's environment only. Compose copies each into the services that need it as a file
// under /run/secrets/ (server/compose.yaml). Nothing here writes a secret to disk, prints one, or
// puts one in argv.
//
// Output is JSON Lines on stdout and stderr alike: one object per line, `kind` naming the command
// (`school.up`, `school.down`, `school.import`, `school.help`, `school.error`) and `event` the step.
// Errors are lines on stderr. `--human` prints prose instead. Exit codes: 0 done, 2 a missing or
// invalid setting (nothing started), 1 anything else, such as compose failing.
//
// Every effect is a dependency (Deps), so the tests run it with a fake vault and a fake compose
// (host/launcher.test.ts); host/school.ts wires the real ones.
import { join } from "node:path";
import { accountFrom, SECRETS, SecretError, storable, type SecretName, type Source, type Store } from "./secrets.ts";

export type Spawned = {
  /** Every line the child writes, as it writes it, tagged with its stream. */
  lines: AsyncIterable<{ stream: "stdout" | "stderr"; line: string }>;
  exited: Promise<number>;
};

export type Deps = {
  env: Record<string, string | undefined>;
  /** Opens the vault for `account`. Called only when a secret is not in the environment. */
  store: (account: string) => Store;
  /** Whether a person is at a terminal to answer a prompt. */
  isTTY: boolean;
  /** Reads one line from the terminal without echoing it. */
  prompt: (message: string) => Promise<string>;
  spawn: (args: string[], options: { cwd: string; env: Record<string, string | undefined> }) => Spawned;
  out: (line: string) => void;
  err: (line: string) => void;
  /** A file's text, or null if there is none. */
  readText: (path: string) => string | null;
  /** Replaces a file's text atomically, keeping its mode. */
  writeText: (path: string, text: string) => void;
  generate: () => string;
  /** The checkout's server/ directory, where compose.yaml and .env are. */
  serverDir: string;
};

type Command = "up" | "down" | "import";
const COMMANDS: { command: Command; does: string }[] = [
  { command: "up", does: "Resolve School's secrets (environment, then the Keychain; ask for the superuser's password or generate the others when missing, and store them), then `docker compose up --detach --build` with them in compose's environment only" },
  { command: "down", does: "`docker compose down`. Needs no secret; keeps the record's volume" },
  { command: "import", does: "Move every secret still in server/.env into the Keychain, and remove those lines from server/.env" },
];

/** The output of one command: JSON lines, or prose with --human; every string scrubbed of the secrets it knows. */
class Output {
  private readonly secrets = new Set<string>();
  constructor(private readonly deps: Deps, private readonly kind: string, private readonly human: boolean) {}

  know(value: string) { if (value !== "") this.secrets.add(value); }
  scrub(text: string) {
    let t = text;
    for (const s of this.secrets) t = t.replaceAll(s, "(redacted)");
    return t;
  }

  line(stream: "out" | "err", fields: Record<string, unknown>, prose: string) {
    const write = stream === "out" ? this.deps.out : this.deps.err;
    write(this.scrub(this.human ? prose : JSON.stringify({ kind: this.kind, ...fields })));
  }
  error(code: 1 | 2, message: string, extra: Record<string, unknown> = {}) {
    this.line("err", { event: "error", code, message, ...extra }, `error: ${message}`);
    return code;
  }
}

const SOURCE_PROSE: Record<Source, string> = {
  environment: "from the environment",
  keychain: "from the Keychain",
  prompted: "entered and stored in the Keychain",
  generated: "generated and stored in the Keychain",
};

/** The secret keys server/.env still assigns, in file order. Values are never returned. */
function dotenvSecrets(text: string): { name: SecretName; value: string; line: number }[] {
  const names = new Set<string>(SECRETS.map((s) => s.name));
  const found: { name: SecretName; value: string; line: number }[] = [];
  text.split("\n").forEach((raw, line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
    if (m === null || !names.has(m[1]!)) return;
    let value = m[2]!.trim();
    const q = value[0];
    if ((q === "'" || q === '"') && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    found.push({ name: m[1] as SecretName, value, line });
  });
  return found;
}

async function up(deps: Deps, o: Output): Promise<number> {
  const dotenv = join(deps.serverDir, ".env");
  const leaked = dotenvSecrets(deps.readText(dotenv) ?? "");
  for (const l of leaked) o.know(l.value);
  if (leaked.length > 0) {
    const keys = [...new Set(leaked.map((l) => l.name))];
    return o.error(2, `${dotenv} still holds ${keys.join(", ")}: run \`school import\` to move them into the Keychain, then \`school up\` again`, { keys });
  }

  const account = accountFrom(deps.env);
  let opened: Store | null = null;
  const store = () => (opened ??= deps.store(account));
  o.line("out", { event: "keychain", account }, `Keychain account: ${account}`);

  // Resolve every secret before storing any, so a refusal stores nothing.
  const resolved: { name: SecretName; value: string; from: Source }[] = [];
  for (const s of SECRETS) {
    const fromEnv = deps.env[s.name];
    if (fromEnv !== undefined && fromEnv !== "") {
      o.know(fromEnv);
      resolved.push({ name: s.name, value: fromEnv, from: "environment" });
      continue;
    }
    const fromStore = store().get(s.name);
    if (fromStore !== undefined && fromStore !== "") {
      o.know(fromStore);
      resolved.push({ name: s.name, value: fromStore, from: "keychain" });
      continue;
    }
    if (s.missing === "generate") {
      const value = deps.generate();
      o.know(value);
      resolved.push({ name: s.name, value, from: "generated" });
      continue;
    }
    if (!deps.isTTY) {
      return o.error(2, `${s.name} (${s.what}) is in neither the environment nor the Keychain (account ${account}), and there is no terminal to ask at: run \`school up\` at a terminal once, or \`school import\` to move it from server/.env`, { name: s.name });
    }
    const message = `${s.name} is not in the Keychain. If this deployment already has a database, enter the superuser's password it was created with (the old SCHOOL_POSTGRES_PASSWORD); for a new deployment press Enter to generate one`;
    o.line("err", { event: "prompt", name: s.name, message }, `${message}: `);
    const typed = (await deps.prompt(message)).trim();
    o.know(typed);
    if (typed === "") {
      const value = deps.generate();
      o.know(value);
      resolved.push({ name: s.name, value, from: "generated" });
    } else if (!storable(typed)) {
      return o.error(2, `${s.name} must be printable ASCII with no space, double quote or backslash; nothing was stored`, { name: s.name });
    } else {
      resolved.push({ name: s.name, value: typed, from: "prompted" });
    }
  }

  // Stored before compose starts: a new database is initialised with the superuser password it is given.
  for (const r of resolved) {
    if (r.from === "prompted" || r.from === "generated") store().set(r.name, r.value);
    o.line("out", { event: "secret", name: r.name, from: r.from }, `${r.name}: ${SOURCE_PROSE[r.from]}`);
  }

  const env: Record<string, string | undefined> = { ...deps.env };
  for (const r of resolved) env[r.name] = r.value;
  return compose(deps, o, ["up", "--detach", "--build"], env);
}

async function compose(deps: Deps, o: Output, args: string[], env: Record<string, string | undefined>): Promise<number> {
  const argv = ["docker", "compose", ...args];
  const child = deps.spawn(argv, { cwd: deps.serverDir, env });
  for await (const { stream, line } of child.lines) o.line("out", { event: "compose", stream, line }, line);
  const exitCode = await child.exited;
  if (exitCode !== 0) return o.error(1, `docker compose ${args.join(" ")} exited ${exitCode}`, { exitCode });
  o.line("out", { event: "done", ok: true }, "done");
  return 0;
}

async function importDotenv(deps: Deps, o: Output): Promise<number> {
  const dotenv = join(deps.serverDir, ".env");
  const text = deps.readText(dotenv);
  const found = dotenvSecrets(text ?? "");
  for (const f of found) o.know(f.value);
  if (found.length === 0) {
    o.line("out", { event: "done", ok: true, imported: [] }, `${dotenv} holds no secret; nothing to import`);
    return 0;
  }
  const account = accountFrom(deps.env);
  const store = deps.store(account);
  o.line("out", { event: "keychain", account }, `Keychain account: ${account}`);

  // Check everything before changing anything.
  const names = new Set<SecretName>();
  for (const f of found) {
    if (names.has(f.name)) return o.error(2, `${dotenv} sets ${f.name} more than once; keep one line and run \`school import\` again`, { name: f.name });
    names.add(f.name);
    if (!storable(f.value)) return o.error(2, `${f.name} in ${dotenv} must be printable ASCII with no space, double quote or backslash to be stored in the Keychain; nothing was changed`, { name: f.name });
    const there = store.get(f.name);
    if (there !== undefined) o.know(there);
    if (there !== undefined && there !== f.value) {
      return o.error(2, `the Keychain (account ${account}) already holds a different ${f.name}; nothing was changed. Decide which is right, remove the other, and run \`school import\` again`, { name: f.name });
    }
  }
  for (const f of found) {
    if (store.get(f.name) !== f.value) store.set(f.name, f.value);
    o.line("out", { event: "imported", name: f.name, account }, `${f.name}: moved into the Keychain`);
  }
  const drop = new Set(found.map((f) => f.line));
  deps.writeText(dotenv, text!.split("\n").filter((_, i) => !drop.has(i)).join("\n"));
  o.line("out", { event: "done", ok: true, imported: found.map((f) => f.name) }, `removed ${found.length} line(s) from ${dotenv}`);
  return 0;
}

function help(deps: Deps, human: boolean): number {
  const o = new Output(deps, "school.help", human);
  o.line("out", { usage: "school <command> [--human]", does: "Run School under docker compose with its secrets in the macOS Keychain" }, "usage: school <up|down|import> [--human]");
  for (const c of COMMANDS) o.line("out", { command: c.command, does: c.does }, `  ${c.command.padEnd(7)} ${c.does}`);
  o.line("out", { exitCodes: { 0: "done", 1: "a failure, such as compose failing or the Keychain refusing", 2: "a missing or invalid setting; nothing was started" } }, "exit codes: 0 done, 1 failure, 2 missing or invalid setting");
  return 0;
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  const human = argv.includes("--human") || argv.includes("--humanize");
  const rest = argv.filter((a) => a !== "--human" && a !== "--humanize");
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h" || rest[0] === "help") return help(deps, human);
  const command = rest[0] as Command;
  if (!COMMANDS.some((c) => c.command === command) || rest.length > 1) {
    return new Output(deps, "school.error", human).error(2, `unknown command ${JSON.stringify(rest.join(" "))}; run \`school --help\``);
  }
  const o = new Output(deps, `school.${command}`, human);
  try {
    if (command === "up") return await up(deps, o);
    if (command === "down") return await compose(deps, o, ["down"], { ...deps.env });
    return await importDotenv(deps, o);
  } catch (e) {
    // Every throw is a line: a SecretError with its code, anything else as a failure (1).
    const code = e instanceof SecretError ? e.code : 1;
    return o.error(code, e instanceof Error ? e.message : String(e));
  }
}
