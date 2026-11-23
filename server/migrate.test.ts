// The migrate command's output contract (flyingrobots/school#120; docs/topics/migrate-job/README.md
// and its test plan). Every line it prints, on stdout and stderr, is one JSON object that names its
// schema (`_schema`: id and version), and every such line validates against the published schema in
// server/schemas/, checked here by an independent JSON Schema validator (Ajv, draft 2020-12).
// `--help` and `--schema` print JSON Lines and change nothing; `--human` (or `--humanize`) is prose.
//
// The tests that need a database run on the real Postgres server the Bun.SQL tests use
// (SCHOOL_TEST_POSTGRES_URL, a superuser URL); skipped without it, and CI fails a run that skips
// them (server/testing/postgres-gate.ts). The rest need no database.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { scratchPostgres, TEST_APP_PASSWORD, TEST_POSTGRES_URL as URL_ } from "./testing/postgres.ts";
import { readMigrations } from "./db/migrate.ts";

const SLOW = 30_000;
const MIGRATE = join(import.meta.dir, "migrate.ts");
const SCHEMAS = join(import.meta.dir, "schemas");

type Line = Record<string, unknown> & { _schema: { id: string; version: string }; event: string };

/** Every published schema, by the file it is in. */
const published = readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json")).sort()
  .map((file) => ({ file, schema: JSON.parse(readFileSync(join(SCHEMAS, file), "utf8")) as Record<string, any> }));

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map(published.map(({ schema }) => [schema.$id as string, ajv.compile(schema)]));

/** `text` as JSON Lines, each line checked against the published schema it names. Throws on any line that is not. */
function validated(text: string): Line[] {
  return text.split("\n").filter((l) => l !== "").map((raw) => {
    let line: Line;
    try { line = JSON.parse(raw); } catch { throw new Error(`not a JSON line: ${raw}`); }
    const named = line?._schema;
    if (typeof named?.id !== "string" || typeof named?.version !== "string") throw new Error(`no _schema: ${raw}`);
    const validate = validators.get(`${named.id}/${named.version}`);
    if (validate === undefined) throw new Error(`no published schema ${named.id} ${named.version}: ${raw}`);
    if (!validate(line)) throw new Error(`${raw}\ndoes not validate against ${named.id} ${named.version}: ${ajv.errorsText(validate.errors)}`);
    return line;
  });
}

/** Run the migrate command with `args` and `env`; its exit code and both streams. */
async function run(args: string[], env: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn(["bun", MIGRATE, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

/** The message types the command can print, as the schema files name them. */
const IDS = ["school.migrate.applied", "school.migrate.captured", "school.migrate.done", "school.migrate.error.failed",
  "school.migrate.error.settings", "school.migrate.error.usage", "school.migrate.help", "school.migrate.schema", "school.migrate.start"];

describe("the migrate command's schemas (server/schemas/)", () => {
  test("every message type has one schema file, named for its id, whose $id is id/version and whose _schema pins both", () => {
    expect(published.map((p) => p.file)).toEqual(IDS.map((id) => `${id}.schema.json`));
    for (const { file, schema } of published) {
      const id = file.replace(/\.schema\.json$/, "");
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      const version = schema.properties._schema.properties.version.const;
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(schema.$id).toBe(`${id}/${version}`);
      expect(schema.properties._schema.properties.id.const).toBe(id);
      expect(schema.properties.kind.const).toBe("school.migrate");
      expect(schema.additionalProperties).toBe(false);
      for (const field of ["_schema", "kind", "event", "run", "at"]) expect(schema.required).toContain(field);
    }
  });

  test("a line naming a database cannot carry a user or password: `where` admits no user info", () => {
    const start = validators.get(published.find((p) => p.file === "school.migrate.start.schema.json")!.schema.$id)!;
    const base = { _schema: { id: "school.migrate.start", version: "1.0.0" }, kind: "school.migrate", event: "start",
      run: crypto.randomUUID(), at: new Date().toISOString(), role: "school_app" };
    expect(start({ ...base, where: "postgres://db:5432/school" })).toBe(true);
    expect(start({ ...base, where: "postgres://postgres:secret@db:5432/school" })).toBe(false);
  });
});

describe("the migrate command without a database", () => {
  test("--help prints a help line, then the schema of every message type, as JSON Lines; exit 0, nothing on stderr, no settings needed", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const out = validated(r.stdout);
    expect(out[0]).toMatchObject({ event: "help", command: "migrate" });
    const help = out[0] as Line & { output: string[]; exit: { code: number }[]; environment: { name: string }[] };
    expect(help.output.sort()).toEqual(IDS);
    expect(help.exit.map((e) => e.code)).toEqual([0, 1, 2]);
    expect(help.environment.map((e) => e.name)).toEqual(["SCHOOL_MIGRATE_URL", "SCHOOL_APP_PASSWORD"]);
    const schemas = out.slice(1) as (Line & { id: string; version: string; schema: { $id: string } })[];
    expect(schemas.every((l) => l.event === "schema")).toBe(true);
    expect(schemas.map((l) => l.id)).toEqual(IDS);
    for (const l of schemas) {
      expect(l.schema).toEqual(published.find((p) => p.file === `${l.id}.schema.json`)!.schema as never);
      expect(l.schema.$id).toBe(`${l.id}/${l.version}`);
    }
    // One run: every line carries the same run id.
    expect(new Set(out.map((l) => l.run)).size).toBe(1);
    expect((await run(["-h"])).stdout.split("\n")[0]).toContain('"event":"help"');
  });

  test("--schema prints every published schema, one schema line each, and exits 0", async () => {
    const r = await run(["--schema"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const out = validated(r.stdout) as (Line & { id: string; schema: unknown })[];
    expect(out.map((l) => l.event)).toEqual(IDS.map(() => "schema"));
    expect(out.map((l) => l.schema)).toEqual(published.map((p) => p.schema) as never);
  });

  test("an unknown argument is a usage error line on stderr, exit 2", async () => {
    const r = await run(["--frobnicate"], { SCHOOL_MIGRATE_URL: "postgres://nobody@127.0.0.1:1/none", SCHOOL_APP_PASSWORD: "a".repeat(24) });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    const err = validated(r.stderr);
    expect(err).toHaveLength(1);
    expect(err[0]).toMatchObject({ _schema: { id: "school.migrate.error.usage" }, event: "error", error: "usage", code: 2 });
    expect(String(err[0]!.message)).toContain("--frobnicate");
  });

  test("a missing or invalid setting is a settings error line on stderr, exit 2, naming no password", async () => {
    const secret = "Zq7".repeat(8);
    for (const env of [{ SCHOOL_APP_PASSWORD: secret }, { SCHOOL_MIGRATE_URL: `postgres://postgres:${secret}@127.0.0.1:1/x` },
      { SCHOOL_MIGRATE_URL: "pglite:/tmp/x", SCHOOL_APP_PASSWORD: secret }]) {
      const r = await run([], env);
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      const err = validated(r.stderr);
      expect(err.map((l) => l._schema.id)).toEqual(["school.migrate.error.settings"]);
      expect(err[0]).toMatchObject({ event: "error", error: "settings", code: 2 });
      expect(r.stderr).not.toContain(secret);
    }
  });

  test("--human and --humanize print the help as prose, not JSON, and the same prose", async () => {
    const human = await run(["--help", "--human"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("SCHOOL_MIGRATE_URL");
    expect(human.stdout).toContain("--schema");
    for (const l of human.stdout.split("\n").filter((x) => x !== "")) expect(() => JSON.parse(l)).toThrow();
    const alias = await run(["--humanize", "--help"]);
    expect(alias.stdout.replace(/run [0-9a-f-]{36}/g, "run X")).toBe(human.stdout.replace(/run [0-9a-f-]{36}/g, "run X"));
  });

  test("an error with --human is prose on stderr", async () => {
    const r = await run(["--human"], { SCHOOL_APP_PASSWORD: "a".repeat(24) });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error \(settings\): SCHOOL_MIGRATE_URL/);
    expect(() => JSON.parse(r.stderr.split("\n")[0]!)).toThrow();
  });
});

const { database } = scratchPostgres();

/** Whether schema `school` or the migrations ledger exists in the database at `url`. */
async function touched(url: string): Promise<boolean> {
  const db = new Bun.SQL(url);
  try {
    return (await db.unsafe(`SELECT (SELECT count(*) FROM pg_namespace WHERE nspname = 'school')
      + (SELECT count(*) FROM pg_class WHERE relname = 'schema_migrations') AS n`))[0].n > 0;
  } finally {
    await db.close();
  }
}

describe.skipIf(URL_ === undefined)("the migrate command on a real Postgres through Bun.SQL (SCHOOL_TEST_POSTGRES_URL)", () => {
  test("--help and --schema, with every setting in place, exit 0 and change nothing in the database", async () => {
    const url = await database();
    const env = { SCHOOL_MIGRATE_URL: url, SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD };
    for (const args of [["--help"], ["--schema"], ["--help", "--human"], ["--schema", "--human"]]) {
      const r = await run(args, env);
      expect({ args, code: r.code, stderr: r.stderr }).toEqual({ args, code: 0, stderr: "" });
    }
    expect(await touched(url)).toBe(false);
  }, SLOW);

  test("a run streams start, one applied line per migration in order, then done, every line valid, one run id, no password", async () => {
    const url = await database();
    const superPassword = new URL(url).password;
    const migrations = readMigrations();
    const first = await run([], { SCHOOL_MIGRATE_URL: url, SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD });
    expect(first.code).toBe(0);
    expect(first.stderr).toBe("");
    const out = validated(first.stdout);
    expect(out.map((l) => l.event)).toEqual(["start", ...migrations.map(() => "applied"), "done"]);
    expect(out.filter((l) => l.event === "applied").map((l) => [l.version, l.name])).toEqual(migrations.map((m) => [m.version, m.name]));
    expect(out.at(-1)).toMatchObject({ ok: true, applied: migrations.map((m) => m.version), role: "school_app" });
    expect(new Set(out.map((l) => l.run)).size).toBe(1);
    for (const text of [first.stdout, first.stderr]) {
      expect(text).not.toContain(TEST_APP_PASSWORD);
      if (superPassword !== "") expect(text).not.toContain(superPassword);
    }
    const again = await run([], { SCHOOL_MIGRATE_URL: url, SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD });
    expect(again.code).toBe(0);
    const second = validated(again.stdout);
    expect(second.map((l) => l.event)).toEqual(["start", "done"]);
    expect(second[0]!.run).not.toBe(out[0]!.run);
  }, SLOW);

  test("a database that refuses the login is a failed error line on stderr, exit 1, naming neither password", async () => {
    const url = await database();
    const wrong = new URL(url);
    wrong.password = "WrongPassword0123456789";
    const r = await run([], { SCHOOL_MIGRATE_URL: wrong.toString(), SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD });
    expect(r.code).toBe(1);
    expect(validated(r.stdout).map((l) => l.event)).toEqual(["start"]);
    const err = validated(r.stderr);
    expect(err.map((l) => l._schema.id)).toEqual(["school.migrate.error.failed"]);
    expect(err[0]).toMatchObject({ event: "error", error: "failed", code: 1 });
    expect(r.stdout + r.stderr).not.toContain("WrongPassword0123456789");
    expect(r.stdout + r.stderr).not.toContain(TEST_APP_PASSWORD);
    expect(await touched(url)).toBe(false);
  }, SLOW);

  test("a run with --human prints prose: what it applied, and that it is done", async () => {
    const url = await database();
    const r = await run(["--human"], { SCHOOL_MIGRATE_URL: url, SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD });
    expect(r.code).toBe(0);
    const prose = r.stdout.split("\n").filter((l) => l !== "");
    expect(prose[0]).toStartWith("migrating postgres://");
    expect(prose.slice(1, -1)).toEqual(readMigrations().map((m) => `applied ${m.name}`));
    expect(prose.at(-1)).toBe(`done: applied ${readMigrations().length} migrations; school_app may log in`);
    expect(r.stdout).not.toContain(TEST_APP_PASSWORD);
  }, SLOW);
});
