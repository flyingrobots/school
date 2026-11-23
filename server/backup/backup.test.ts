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
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../adapters/database.ts";
import { postgresRecord } from "../adapters/postgres.ts";
import { replayLearnerHistory } from "../contract/learner-history.ts";
import type { LearningRecord } from "../core/ports.ts";
import { scratchPostgres, TEST_POSTGRES_URL } from "../testing/postgres.ts";

setDefaultTimeout(120_000); // each case starts containers and copies databases

const SERVER = join(import.meta.dir, "..");
const SCRIPT = join(import.meta.dir, "backup.sh");
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
 * Run `args` in the database's image with `dir` mounted at /backups and the script at
 * /backup/backup.sh, as compose runs it. The password goes in the environment, never in argv.
 */
async function inImage(dir: string, database: string, args: string[], extra: Record<string, string> = {}, input?: string): Promise<Ran> {
  // Docker would mount a missing path as a new, empty directory in its place.
  if (!statSync(SCRIPT, { throwIfNoEntry: false })?.isFile()) throw new Error(`${SCRIPT} is not a file`);
  const { network, env } = connection(database);
  const all = { ...env, ...extra };
  const p = Bun.spawn([
    "docker", "run", "--rm", ...(input === undefined ? [] : ["-i"]), `--user=${process.getuid!()}:${process.getgid!()}`, ...network,
    "-v", `${SCRIPT}:/backup/backup.sh:ro`, "-v", `${dir}:/backups`,
    ...Object.keys(all).flatMap((k) => ["-e", k]),
    "--entrypoint", args[0]!, IMAGE, ...args.slice(1),
  ], { env: { ...process.env, ...all }, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

/** One run of the script, as the service's schedule runs it: one dump, then the retention. */
const backupOnce = (dir: string, database: string, extra: Record<string, string> = {}) =>
  inImage(dir, database, ["/bin/sh", "/backup/backup.sh", "once"], extra);

/** The restore, as the how-to gives it. */
const restore = (dir: string, database: string, file: string) =>
  inImage(dir, database, ["pg_restore", "--exit-on-error", "--single-transaction", `--dbname=${database}`, `/backups/${file}`]);

/** verify.sql's lines for `database`, as the how-to runs it. */
async function verify(dir: string, database: string): Promise<string[]> {
  const r = await inImage(dir, database, ["psql", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1"], {}, readFileSync(join(import.meta.dir, "verify.sql"), "utf8"));
  expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
  return r.stdout.split("\n").filter((l) => l !== "");
}

/** Every line the script printed, on either stream, as JSON. */
function lines(r: Ran): Record<string, unknown>[] {
  return (r.stdout + r.stderr).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
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

    // The restored database opens as the server opens it: its migration history came with it.
    const back = scratch.track(await openDatabase({ driver: "postgres", url: empty }));
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
