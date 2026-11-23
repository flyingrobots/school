// The scheduled backup (flyingrobots/school#48): server/backup/backup.sh, run by the `backup`
// service in server/compose.yaml, and the restore the how-to drills
// (docs/workflows/backup-and-restore/README.md).
//
// The compose cases read compose.yaml and always run. The rest run the real script with the real
// pg_dump and pg_restore, in the same image as compose's database, against the scratch Postgres the
// Bun.SQL tests use (SCHOOL_TEST_POSTGRES_URL; server/testing/postgres.ts) and need Docker. Without
// the URL they skip; CI sets it, and its gate fails a run in which any of them skipped
// (server/testing/postgres-gate.ts), since every one names Bun.SQL.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateRecord, openDatabase } from "../adapters/database.ts";
import { postgresRecord } from "../adapters/postgres.ts";
import { replayLearnerHistory } from "../contract/learner-history.ts";
import type { LearningRecord } from "../core/ports.ts";
import { appUrl, scratchPostgres, TEST_APP_PASSWORD, TEST_POSTGRES_URL } from "../testing/postgres.ts";
import { publishedIn, wellFormed, type Line } from "../testing/schemas.ts";

setDefaultTimeout(120_000); // each case starts containers and copies databases

const SERVER = join(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "backup.sh");
const SCHEMAS = join(import.meta.dir, "schemas");
// Every line the script prints is checked against its published schema (flyingrobots/school#135).
const backupSchemas = publishedIn(SCHEMAS);
const IDS = ["captured", "dumped", "error.refused", "error.usage", "failed", "help", "pruned", "schema", "started", "stopped", "waiting"].map((t) => `school.backup.${t}`);
type Service = { image?: string; entrypoint?: string[]; command?: string[]; environment?: Record<string, string>; volumes?: string[]; depends_on?: Record<string, unknown>; ports?: unknown; restart?: string };
const compose = Bun.YAML.parse(readFileSync(join(SERVER, "compose.yaml"), "utf8")) as { services: Record<string, Service>; volumes: Record<string, unknown> };
const backup = compose.services.backup;
const IMAGE = compose.services.postgres!.image!;

describe("the backup service in compose.yaml", () => {
  test("runs backup.sh on the database's own image, pinned by the same digest", () => {
    expect(backup).toBeDefined();
    expect(IMAGE).toMatch(/^postgres:\d+(\.\d+)?@sha256:[0-9a-f]{64}$/);
    expect(backup!.image).toBe(IMAGE);
    expect(backup!.entrypoint).toEqual(["/bin/sh", "/backup/backup.sh"]);
    expect(backup!.volumes).toContain("./backup/backup.sh:/backup/backup.sh:ro");
    expect(backup!.volumes).toContain("./backup/schemas:/backup/schemas:ro"); // what --help and --schema print
    expect(backup!.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
    expect(backup!.ports).toBeUndefined(); // it listens on nothing
    expect(backup!.restart).toBe("unless-stopped");
  });

  test("writes its dumps to the named volume `backups`, apart from the record's volume", () => {
    expect(backup!.volumes).toContain("backups:/backups");
    expect(Object.keys(compose.volumes)).toContain("backups");
  });

  test("dumps every six hours and keeps 28 dumps by default, both settable from the environment", () => {
    expect(backup!.environment!.SCHOOL_BACKUP_INTERVAL_SECONDS).toBe("${SCHOOL_BACKUP_INTERVAL_SECONDS:-21600}");
    expect(backup!.environment!.SCHOOL_BACKUP_KEEP).toBe("${SCHOOL_BACKUP_KEEP:-28}");
  });

  test("takes the password from the environment only, and names the database without it", () => {
    const env = backup!.environment!;
    expect(env.PGPASSWORD).toMatch(/^\$\{SCHOOL_POSTGRES_PASSWORD:\?/);
    expect(env).toMatchObject({ PGHOST: "postgres", PGUSER: "postgres", PGDATABASE: "school" });
    for (const [k, v] of Object.entries(env)) if (k !== "PGPASSWORD") expect(v).not.toContain("SCHOOL_POSTGRES_PASSWORD");
  });
});

// --- Running the script and the restore in the database's image ---------------------------------

/** Where a container reaches the scratch server, and its connection settings, from SCHOOL_TEST_POSTGRES_URL. */
function connection(database: string): { network: string[]; env: Record<string, string> } {
  const u = new URL(TEST_POSTGRES_URL!);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  // On Linux (CI) a container shares the host's network; Docker Desktop reaches the host by name.
  const linux = process.platform === "linux";
  return {
    network: linux ? ["--network=host"] : ["--add-host=host.docker.internal:host-gateway"],
    env: {
      PGHOST: local && !linux ? "host.docker.internal" : u.hostname,
      PGPORT: u.port || "5432",
      PGUSER: decodeURIComponent(u.username),
      PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: database,
    },
  };
}

type Ran = { code: number; stdout: string; stderr: string };

/**
 * Run `args` in the database's image with `dir` mounted at /backups, the script at
 * /backup/backup.sh and its schemas at /backup/schemas, as compose runs it. The password goes in the environment, never in argv.
 */
type Options = { input?: string; /** more `docker run` arguments, before the image */ docker?: string[] };

async function inImage(dir: string, database: string, args: string[], extra: Record<string, string> = {}, { input, docker = [] }: Options = {}): Promise<Ran> {
  // Docker would mount a missing path as a new, empty directory in its place.
  if (!statSync(SCRIPT, { throwIfNoEntry: false })?.isFile()) throw new Error(`${SCRIPT} is not a file`);
  const { network, env } = connection(database);
  const all = { ...env, ...extra };
  const p = Bun.spawn([
    "docker", "run", "--rm", ...(input === undefined ? [] : ["-i"]), `--user=${process.getuid!()}:${process.getgid!()}`, ...network,
    "-v", `${SCRIPT}:/backup/backup.sh:ro`, "-v", `${SCHEMAS}:/backup/schemas:ro`, "-v", `${dir}:/backups`,
    ...Object.keys(all).flatMap((k) => ["-e", k]), ...docker,
    "--entrypoint", args[0]!, IMAGE, ...args.slice(1),
  ], { env: { ...process.env, ...all }, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** One run of the script, as the service's schedule runs it: one dump, then the retention. */
const backupOnce = (dir: string, database: string, extra: Record<string, string> = {}) =>
  inImage(dir, database, ["/bin/sh", "/backup/backup.sh", "once"], extra);

/**
 * `docker run` arguments that put a `date` first on PATH which always prints `stamp`, so every
 * run names its dump school-<stamp>.dump: two runs "in the same second", on demand.
 */
function frozenClock(stamp: string): string[] {
  const bin = mkdtempSync(join(tmpdir(), "school-backup-bin-"));
  cleanup.push(bin);
  writeFileSync(join(bin, "date"), `#!/bin/sh\necho ${stamp}\n`, { mode: 0o755 });
  return ["-v", `${bin}:/frozen:ro`, "-e", "PATH=/frozen:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
}

/** The restore, as the how-to gives it. */
const restore = (dir: string, database: string, file: string) =>
  inImage(dir, database, ["pg_restore", "--exit-on-error", "--single-transaction", `--dbname=${database}`, `/backups/${file}`]);

/** verify.sql's lines for `database`, as the how-to runs it. */
async function verify(dir: string, database: string): Promise<string[]> {
  const r = await inImage(dir, database, ["psql", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1"], {}, { input: readFileSync(join(import.meta.dir, "verify.sql"), "utf8") });
  expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
  return r.stdout.split("\n").filter((l) => l !== "");
}

/**
 * Every line the script printed, on either stream, each validated against the published schema it
 * names. `own` picks out lines the test itself printed beside the script's, which are not checked.
 */
function lines(r: Ran, own: (l: Record<string, unknown>) => boolean = () => false): Line[] {
  return (r.stdout + r.stderr).split("\n").filter((l) => l !== "").map((raw) => {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return (own(parsed) ? parsed : backupSchemas.check(raw)) as Line;
  });
}

/**
 * `docker run` arguments that put a `pg_dump` first on PATH which runs `body` (sh) and then, unless
 * `body` exits, the real pg_dump with the script's arguments.
 */
function fakePgDump(body: string): string[] {
  const bin = mkdtempSync(join(tmpdir(), "school-backup-pgdump-"));
  cleanup.push(bin);
  writeFileSync(join(bin, "pg_dump"), `#!/bin/sh\n${body}\nPATH=\${PATH#/fake:} exec pg_dump "$@"\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return ["-v", `${bin}:/fake:ro`, "-e", "PATH=/fake:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"];
}

const nameOf = (url: string) => new URL(url).pathname.slice(1);
const dumps = (dir: string) => readdirSync(dir).filter((f) => /^school-\d{8}T\d{6}Z\.dump$/.test(f)).sort();

/** The read methods of the LearningRecord port: the contract suite's reads. */
const READS = [
  "encounterAnswers", "lessonProgress", "lastStudied", "explanation", "encounterExplanations",
  "aid", "encounterEvidence", "decisionNotes", "encounterDecisionNotes", "dueReview",
] as const;
type Call = { method: string; args: unknown[]; result: unknown };

/** `r`, noting every call made through it and what it returned. */
function noting(r: LearningRecord, calls: Call[]): LearningRecord {
  return new Proxy(r, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (typeof v !== "function") return v;
      return async (...args: unknown[]) => {
        const result = await (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        calls.push({ method: String(key), args, result });
        return result;
      };
    },
  });
}

const scratch = scratchPostgres();
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "school-backup-"));
  chmodSync(dir, 0o755); // as a fresh volume or folder may be; the script must close it
  return dir;
};
const cleanup: string[] = [];
afterAll(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

describe.skipIf(TEST_POSTGRES_URL === undefined)("backup and restore on a real Postgres (Bun.SQL, SCHOOL_TEST_POSTGRES_URL)", () => {
  test("Bun.SQL: a dump taken after real writes restores into an empty database, and every read of the record returns the same", async () => {
    // Real writes, through the server's functions as school_app: the learner-history story, then a
    // view and a decision note, which the story does not make.
    const original = await scratch.fresh();
    const calls: Call[] = [];
    const r = noting(postgresRecord(original.sql), calls);
    await replayLearnerHistory(r);
    const encounter = (calls.findLast((c) => c.method === "openEncounter")!.result as { id: string }).id;
    await r.recordView({ course: "astronomy", lesson: "orbits" }, "2026-11-21T12:00:00.000Z");
    const evidence = await r.encounterEvidence(encounter);
    expect(await r.recordDecisionNote({
      noteId: crypto.randomUUID(), choice: { course: "astronomy", lesson: "orbits", blockId: "moons" }, encounterId: encounter,
      rule: "due-review/wrong-first-try", reason: "Mars before Venus.", evidence: [evidence.at(-1)!.seq],
    }, "2026-11-21T12:01:00.000Z")).toMatchObject({ status: "stored" });
    await r.decisionNotes({ course: "astronomy", lesson: "orbits", blockId: "moons" });
    await r.encounterDecisionNotes(encounter);
    await r.lastStudied();

    const dir = folder();
    cleanup.push(dir);
    const ran = await backupOnce(dir, nameOf(original.url));
    expect(ran.code).toBe(0);
    const [file] = dumps(dir);
    expect(file).toBeDefined();
    expect(lines(ran)).toContainEqual(expect.objectContaining({ kind: "backup", event: "dumped", file }));

    const empty = await scratch.database(); // CREATE DATABASE: nothing migrated, nothing in it
    const restored = await restore(dir, nameOf(empty), file!);
    expect({ code: restored.code, stderr: restored.stderr }).toEqual({ code: 0, stderr: "" });

    // The restored database opens as a deployment opens it (flyingrobots/school#91): the migrate job
    // applies nothing, since its migration history came with it, and the server logs in as school_app.
    expect(await migrateRecord(empty, TEST_APP_PASSWORD)).toEqual({ applied: [] });
    const back = scratch.track(await openDatabase({ driver: "postgres", url: appUrl(empty) }));
    expect(back.applied).toEqual([]);
    const again = postgresRecord(back.sql);
    const now = postgresRecord(original.sql);
    const reads = calls.filter((c) => (READS as readonly string[]).includes(c.method));
    expect(new Set(reads.map((c) => c.method))).toEqual(new Set(READS)); // every read the port has
    for (const c of reads) {
      const call = (rec: LearningRecord) => (rec[c.method as (typeof READS)[number]] as (...a: unknown[]) => Promise<unknown>)(...c.args);
      expect({ read: c.method, args: c.args, result: await call(again) }).toEqual({ read: c.method, args: c.args, result: await call(now) });
    }
    // The how-to's check agrees: every table, every row.
    const tables = await verify(dir, nameOf(original.url));
    expect(tables).toEqual(await verify(dir, nameOf(empty)));
    expect(tables.map((l) => l.split("|")[0])).toEqual(expect.arrayContaining(["public.schema_migrations", "school.answers", "school.decision_notes", "school.exposures"]));
    // The story stores six answers: five over its first two days and one in review.
    expect(tables.find((l) => l.startsWith("school.answers|"))).toMatch(/^school\.answers\|6\|[0-9a-f]{32}$/);
    // And its rules came with it: a resend of a stored answer is still a duplicate, not a new answer.
    const sent = calls.findLast((c) => c.method === "submit")!;
    expect(await again.submit(...(sent.args as Parameters<LearningRecord["submit"]>))).toMatchObject({ status: "duplicate" });
  });

  test("Bun.SQL: a dump and its folder are readable by their owner only, and nothing it prints names the password", async () => {
    const { url } = await scratch.fresh();
    const dir = folder();
    cleanup.push(dir);
    const ran = await backupOnce(dir, nameOf(url));
    expect(ran.code).toBe(0);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const [file] = dumps(dir);
    expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
    expect(ran.stdout + ran.stderr).not.toContain(connection("x").env.PGPASSWORD);
    for (const l of lines(ran)) expect(l.kind).toBe("backup");
  });

  test("Bun.SQL: a real dump's lines all name a published schema and validate: dumped on stdout, nothing on stderr, one run id", async () => {
    const { url } = await scratch.fresh();
    const dir = folder();
    cleanup.push(dir);
    writeFileSync(join(dir, "school-20250101T000000Z.dump"), "x");
    const ran = await backupOnce(dir, nameOf(url), { SCHOOL_BACKUP_KEEP: "1" });
    expect({ code: ran.code, stderr: ran.stderr }).toEqual({ code: 0, stderr: "" });
    const out = backupSchemas.validated(ran.stdout);
    expect(out.map((l) => l._schema.id)).toEqual(["school.backup.dumped", "school.backup.pruned"]);
    expect(out[0]).toMatchObject({ kind: "backup", event: "dumped", file: dumps(dir)[0] });
    expect(out[0]!.bytes).toBe(statSync(join(dir, dumps(dir)[0]!)).size);
    expect(new Set(out.map((l) => l.run)).size).toBe(1);
  });

  test("Bun.SQL: what pg_dump prints on stderr during a good dump is a captured line on stderr, scrubbed of the password, never raw text", async () => {
    const { url } = await scratch.fresh();
    const dir = folder();
    cleanup.push(dir);
    const ran = await inImage(dir, nameOf(url), ["/bin/sh", "/backup/backup.sh", "once"], {},
      { docker: fakePgDump('echo "pg_dump: warning: something to note, password $PGPASSWORD" >&2') });
    expect(ran.code).toBe(0);
    const err = backupSchemas.validated(ran.stderr);
    expect(err.map((l) => l._schema.id)).toEqual(["school.backup.captured"]);
    expect(err[0]).toMatchObject({ stream: "stderr", command: "pg_dump", text: "pg_dump: warning: something to note, password (redacted)" });
    expect(backupSchemas.validated(ran.stdout).map((l) => l.event)).toEqual(["dumped"]);
    expect(ran.stdout + ran.stderr).not.toContain(connection("x").env.PGPASSWORD);
  });

  test("Bun.SQL: a failed pg_dump is one valid failed line on stderr carrying pg_dump's message, scrubbed of the password, exit 1", async () => {
    const dir = folder();
    cleanup.push(dir);
    const ran = await inImage(dir, "postgres", ["/bin/sh", "/backup/backup.sh", "once"], {},
      { docker: fakePgDump('printf \'pg_dump: error: refused "%s"\\n\\tsecond line\\n\' "$PGPASSWORD" >&2; exit 1') });
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    const err = backupSchemas.validated(ran.stderr);
    expect(err.map((l) => l._schema.id)).toEqual(["school.backup.failed"]);
    expect(err[0]!.message).toBe('pg_dump: error: refused "(redacted)"\n\tsecond line');
    expect(ran.stderr).not.toContain(connection("x").env.PGPASSWORD);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("Bun.SQL: stopped mid-dump, the schedule prints a valid stopped line, exits 0 and leaves no temporary file", async () => {
    const { url } = await scratch.fresh();
    const dir = folder();
    cleanup.push(dir);
    const name = `school-backup-stop-${crypto.randomUUID()}`;
    const ran = inImage(dir, nameOf(url), ["/bin/sh", "/backup/backup.sh"], {}, { docker: ["--name", name, ...fakePgDump("sleep 3")] });
    // Mid-dump: the temporary files exist while the (slow) pg_dump runs.
    const until = Date.now() + 60_000;
    while (!readdirSync(dir).some((f) => f.endsWith(".partial")) && Date.now() < until) await Bun.sleep(50);
    expect(readdirSync(dir).some((f) => f.endsWith(".partial"))).toBe(true);
    const kill = Bun.spawn(["docker", "kill", "--signal=TERM", name], { stdout: "ignore", stderr: "ignore" });
    expect(await kill.exited).toBe(0);
    const r = await ran;
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
    expect(backupSchemas.validated(r.stdout).map((l) => l.event)).toEqual(["started", "stopped"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("Bun.SQL: in the image, --schema prints every published schema from /backup/schemas and --help the same after its help line", async () => {
    const dir = folder();
    cleanup.push(dir);
    for (const args of [["--schema"], ["--help"]]) {
      const r = await inImage(dir, "postgres", ["/bin/sh", "/backup/backup.sh", ...args]);
      expect({ args, code: r.code, stderr: r.stderr }).toEqual({ args, code: 0, stderr: "" });
      const out = backupSchemas.validated(r.stdout);
      expect(out.filter((l) => l.event === "schema").map((l) => l.schema)).toEqual(backupSchemas.published.map((p) => p.schema) as never);
    }
    expect(statSync(dir).mode & 0o777).toBe(0o755); // --help and --schema touch nothing
  });

  test("Bun.SQL: retention keeps the newest SCHOOL_BACKUP_KEEP dumps and deletes only older dumps", async () => {
    const { url } = await scratch.fresh();
    const dir = folder();
    cleanup.push(dir);
    const old = ["school-20250101T000000Z.dump", "school-20250102T000000Z.dump", "school-20250103T000000Z.dump"];
    for (const f of [...old, "notes.txt", "school-manual-copy.dump"]) writeFileSync(join(dir, f), "x");
    const ran = await backupOnce(dir, nameOf(url), { SCHOOL_BACKUP_KEEP: "2" });
    expect(ran.code).toBe(0);
    const kept = dumps(dir);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(old[2]);
    expect(kept[1]! > old[2]!).toBe(true); // the new one, named by its UTC time
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(["notes.txt", "school-manual-copy.dump"]));
    const pruned = lines(ran).filter((l) => l.event === "pruned").map((l) => l.file).sort();
    expect(pruned).toEqual([old[0], old[1]]);
  });

  test("Bun.SQL: a dump that fails leaves no file behind, deletes nothing, and exits non-zero with a JSON line", async () => {
    const dir = folder();
    cleanup.push(dir);
    const old = ["school-20250101T000000Z.dump", "school-20250102T000000Z.dump"];
    for (const f of old) writeFileSync(join(dir, f), "x");
    const ran = await backupOnce(dir, "no_such_database", { SCHOOL_BACKUP_KEEP: "1" });
    expect(ran.code).not.toBe(0);
    expect(readdirSync(dir).sort()).toEqual(old);
    expect(lines(ran)).toContainEqual(expect.objectContaining({ kind: "backup", event: "failed" }));
    expect(ran.stdout + ran.stderr).not.toContain(connection("x").env.PGPASSWORD);
  });

  test("Bun.SQL: a dump that cannot be put in place fails: it overwrites nothing, prints no dumped line, prunes nothing, and leaves no temporary file", async () => {
    const { url } = await scratch.fresh();
    const dir = folder();
    cleanup.push(dir);
    // A dump already has the name this run will want: putting the new one in place must fail.
    const taken = "school-20260101T000000Z.dump";
    const old = ["school-20250101T000000Z.dump", "school-20250102T000000Z.dump"];
    for (const f of old) writeFileSync(join(dir, f), "x");
    writeFileSync(join(dir, taken), "the earlier dump");
    const ran = await inImage(dir, nameOf(url), ["/bin/sh", "/backup/backup.sh", "once"], { SCHOOL_BACKUP_KEEP: "1" }, { docker: frozenClock("20260101T000000Z") });
    expect(ran.code).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([...old, taken]); // nothing pruned, nothing left behind
    expect(readFileSync(join(dir, taken), "utf8")).toBe("the earlier dump");
    const out = lines(ran);
    expect(out.some((l) => l.event === "dumped" || l.event === "pruned")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ kind: "backup", event: "failed", file: taken }));
  });

  test("Bun.SQL: two dumps in the same second never share a file: one is put in place whole, the other fails", async () => {
    const { url } = await scratch.fresh();
    const dir = folder();
    cleanup.push(dir);
    const both = 'for i in 1 2; do (/bin/sh /backup/backup.sh once; echo "{\\"kind\\":\\"run\\",\\"exit\\":$?}") & done; wait';
    const ran = await inImage(dir, nameOf(url), ["/bin/sh", "-c", both], {}, { docker: frozenClock("20260101T000000Z") });
    expect(ran.code).toBe(0);
    const out = lines(ran, (l) => l.kind === "run");
    expect(out.filter((l) => l.kind === "run").map((l) => l.exit).sort()).toEqual([0, 1]);
    expect(readdirSync(dir)).toEqual(["school-20260101T000000Z.dump"]); // no temporary file left
    const listed = await inImage(dir, nameOf(url), ["pg_restore", "--list", "/backups/school-20260101T000000Z.dump"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("TABLE DATA school answers");
  });

  test("Bun.SQL: a retention or interval that is not a positive whole number is refused before anything runs", async () => {
    const refused: Record<string, string>[] = [{ SCHOOL_BACKUP_KEEP: "0" }, { SCHOOL_BACKUP_KEEP: "two" }, { SCHOOL_BACKUP_INTERVAL_SECONDS: "-5" }];
    for (const bad of refused) {
      const dir = folder();
      cleanup.push(dir);
      const ran = await backupOnce(dir, "postgres", bad);
      expect(ran.code).toBe(2);
      expect(readdirSync(dir)).toEqual([]);
      expect(lines(ran)).toContainEqual(expect.objectContaining({ kind: "backup", event: "error" }));
    }
  });
});

// --- The output contract without Docker or a database (flyingrobots/school#135) ----------------
// --help, --schema, a bad argument and a bad setting all finish before the script touches the folder
// or the database, so these run the script itself under the host's /bin/sh, with its schemas beside
// it as in the repository.

/** The script under /bin/sh with `args` and only `env` (and PATH); its exit code and both streams. */
async function onHost(args: string[], env: Record<string, string> = {}, script = SCRIPT): Promise<Ran> {
  const p = Bun.spawn(["/bin/sh", script, ...args], { env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

describe("the backup job's output (server/backup/schemas/)", () => {
  test("backup schemas: one file per message type, each well formed, kind backup", () => {
    expect(backupSchemas.ids).toEqual(IDS);
    for (const p of backupSchemas.published) {
      expect({ file: p.file, wrong: wellFormed(p, ["_schema", "kind", "event", "run"]) }).toEqual({ file: p.file, wrong: [] });
      expect(p.schema.properties.kind.const).toBe("backup");
    }
  });

  test("backup --help: a help line, then every schema, as JSON Lines, exit 0, nothing on stderr, no settings needed", async () => {
    const r = await onHost(["--help"]);
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
    const out = backupSchemas.validated(r.stdout);
    expect(out[0]).toMatchObject({ event: "help", command: "backup.sh" });
    expect((out[0]!.output as string[]).sort()).toEqual(IDS);
    expect((out[0]!.exit as { code: number }[]).map((e) => e.code)).toEqual([0, 1, 2]);
    expect((out[0]!.environment as { name: string }[]).map((e) => e.name)).toEqual(
      ["SCHOOL_BACKUP_INTERVAL_SECONDS", "SCHOOL_BACKUP_KEEP", "PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGPASSWORD"]);
    const schemas = out.slice(1);
    expect(schemas.map((l) => l.id)).toEqual(IDS);
    expect(schemas.map((l) => l.schema)).toEqual(backupSchemas.published.map((p) => p.schema) as never);
    expect(new Set(out.map((l) => l.run)).size).toBe(1);
    expect((await onHost(["-h"])).stdout.split("\n")[0]).toContain('"event":"help"');
  });

  test("backup --schema: every published schema, one schema line each, exit 0, each run its own id", async () => {
    const [a, b] = [await onHost(["--schema"]), await onHost(["--schema"])];
    expect({ code: a.code, stderr: a.stderr }).toEqual({ code: 0, stderr: "" });
    const out = backupSchemas.validated(a.stdout);
    expect(out.map((l) => [l.id, l.version])).toEqual(backupSchemas.published.map((p) => [p.id, p.version]));
    expect(backupSchemas.validated(b.stdout)[0]!.run).not.toBe(out[0]!.run);
  });

  test("backup, an unknown argument: one valid usage error line on stderr, exit 2", async () => {
    const r = await onHost(["twice"]);
    expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 2, stdout: "" });
    const err = backupSchemas.validated(r.stderr);
    expect(err.map((l) => l._schema.id)).toEqual(["school.backup.error.usage"]);
    expect(err[0]).toMatchObject({ event: "error", error: "usage", code: 2 });
    expect(String(err[0]!.message)).toContain("twice");
  });

  test("backup, a bad setting: one valid refused error line on stderr naming it, exit 2, the password never printed", async () => {
    const secret = "Zq7-backup-secret-0123";
    const refused: Record<string, string>[] = [{ SCHOOL_BACKUP_KEEP: "0" }, { SCHOOL_BACKUP_KEEP: `t"w\\o ${secret}` }, { SCHOOL_BACKUP_INTERVAL_SECONDS: "-5" }];
    for (const bad of refused) {
      const r = await onHost(["once"], { ...bad, PGPASSWORD: secret });
      expect({ bad, code: r.code, stdout: r.stdout }).toEqual({ bad, code: 2, stdout: "" });
      const err = backupSchemas.validated(r.stderr);
      expect(err.map((l) => l._schema.id)).toEqual(["school.backup.error.refused"]);
      expect(err[0]).toMatchObject({ event: "error", error: "refused", code: 2 });
      expect(String(err[0]!.message)).toContain(Object.keys(bad)[0]!);
      expect(r.stderr).not.toContain(secret);
    }
  });

  test("backup --help with no published schemas beside the script: one valid refused line, exit 2", async () => {
    const lone = mkdtempSync(join(tmpdir(), "school-backup-lone-"));
    cleanup.push(lone);
    copyFileSync(SCRIPT, join(lone, "backup.sh"));
    const r = await onHost(["--help"], {}, join(lone, "backup.sh"));
    expect({ code: r.code, stdout: r.stdout }).toEqual({ code: 2, stdout: "" });
    expect(lines(r).map((l) => l._schema.id)).toEqual(["school.backup.error.refused"]);
  });

  test("backup --human and --humanize: the help, a bad setting and the schemas are prose, no line JSON", async () => {
    const help = await onHost(["--help", "--human"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("SCHOOL_BACKUP_KEEP");
    expect(help.stdout).toContain("--schema");
    const alias = await onHost(["--humanize", "--help"]);
    expect(alias.stdout.replace(/run [0-9a-f-]{36}/g, "run X")).toBe(help.stdout.replace(/run [0-9a-f-]{36}/g, "run X"));
    const refused = await onHost(["once", "--human"], { SCHOOL_BACKUP_KEEP: "0" });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toBe('error (refused): SCHOOL_BACKUP_KEEP must be a positive whole number, not "0"\n');
    for (const text of [help.stdout, refused.stderr]) for (const l of text.split("\n").filter((x) => x !== "")) expect(() => JSON.parse(l)).toThrow();
    const schemas = await onHost(["--schema", "--human"]);
    expect(schemas.stdout).toStartWith("schema school.backup.captured 1.0.0\n{");
  });
});
