// The image's file allowlist broke the build twice (docs/working-notes.md): a new server module
// was missing from .dockerignore or the Dockerfile COPY, and the server died on an import. Now
// modules sit in folders (the hexagon) and the server has dependencies, so this checks both.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { MIGRATIONS, readMigrations } from "./db/migrate.ts";

const dir = import.meta.dir;
const dockerfile = readFileSync(join(dir, "Dockerfile"), "utf8");

/**
 * What the build context keeps, per .dockerignore: the manifest, the lockfile, every non-test module outside contract/
 * and testing/, and the SQL migrations under db/.
 */
const admitted = (path: string) => path === "package.json" || path === "bun.lock" ||
  (path.startsWith("db/") && path.endsWith(".sql")) ||
  (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.startsWith("contract/") && !path.startsWith("testing/") && !path.startsWith("node_modules/"));

function modules(at = dir): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((e) => {
    const p = join(at, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : modules(p);
    return e.name.endsWith(".ts") ? [relative(dir, p)] : [];
  });
}
const shipped = modules().filter(admitted);

test("the image admits modules at any depth, the manifest and lockfile, the migrations, and no tests, test helpers, contract suites or host node_modules", () => {
  const rules = readFileSync(join(dir, ".dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  expect(rules).toEqual(["*", "!package.json", "!bun.lock", "!**/*.ts", "!db/**/*.sql", "**/*.test.ts", "contract/**", "testing/**", "node_modules/**"]);
  expect(dockerfile).toMatch(/^COPY package\.json bun\.lock \.\/$/m);
  expect(dockerfile).toMatch(/^RUN bun install --production --frozen-lockfile$/m);
  expect(dockerfile).toMatch(/^COPY \. \.\/$/m);
});

test("every relative import of a shipped module is shipped, and every package it imports is a dependency", () => {
  const deps = Object.keys(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {});
  for (const f of shipped) {
    for (const [, spec] of readFileSync(join(dir, f), "utf8").matchAll(/from "([^"]+)"/g)) {
      if (spec!.startsWith(".")) expect(shipped).toContain(relative(dir, resolve(dir, dirname(f), spec!)));
      else if (!/^(bun|node):/.test(spec!)) expect(deps).toContain(spec!);
    }
  }
});

test("the image is Ubuntu LTS with the pinned Bun, run as a non-root user", () => {
  expect(dockerfile).toMatch(/^FROM oven\/bun:1\.4\.4 AS bun$/m); // the same Bun as CI
  expect(dockerfile).toMatch(/^FROM ubuntu:\d\d\.04$/m); // an LTS release
  expect(dockerfile).toMatch(/^USER school$/m);
});

test("every migration the runner reads is shipped, beside the runner that reads it", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  expect(files.length).toBeGreaterThan(0);
  expect(relative(dir, MIGRATIONS)).toBe(join("db", "migrations")); // the runner finds them relative to itself
  expect(shipped).toContain(join("db", "migrate.ts"));
  for (const f of files) expect(admitted(join("db", "migrations", f))).toBe(true);
  expect(readMigrations(MIGRATIONS).map((m) => m.name)).toEqual(files.sort());
});

// flyingrobots/school#49: SQLite is deleted. The one thing left that reads it is the startup refusal
// of a populated progress.db (RFC 3 §3.3, server/legacy.ts), read-only; the image ships nothing else
// that imports bun:sqlite, and no other module in the repository does, tests aside from that
// refusal's own fixture.
const SQLITE = new RegExp(`from "bun:${"sqlite"}"`); // spelled so this file does not match itself
const importsSqlite = (f: string) => SQLITE.test(readFileSync(join(dir, f), "utf8"));

test("the image imports bun:sqlite only in the startup refusal of an old progress.db", () => {
  expect(shipped.filter(importsSqlite)).toEqual(["legacy.ts"]);
});

test("no module but the startup refusal and its test reads SQLite", () => {
  expect(modules().filter(importsSqlite).sort()).toEqual(["legacy.ts", "startup.test.ts"]);
});

// flyingrobots/school#91: under compose the server holds only school_app's credentials. The one-shot
// `migrate` service holds the superuser's, runs the migrations and exits; the server waits for it.
type Service = { build?: string; pull_policy?: string; command?: string[]; restart?: string; depends_on?: Record<string, { condition: string }>; environment?: Record<string, string> };
const compose = Bun.YAML.parse(readFileSync(join(dir, "compose.yaml"), "utf8")) as { services: Record<string, Service> };

test("compose runs the migrate job once, as the superuser, before the server, and the server logs in as school_app only", () => {
  const { migrate, school, postgres } = compose.services;
  expect(postgres).toBeDefined();
  expect(migrate?.build).toBe(".");
  // flyingrobots/school#112 review, F-3: a plain `docker compose up` after a pull must rebuild both
  // services from this checkout; a cached old server image would crash-loop on school_app's URL.
  expect(migrate?.pull_policy).toBe("build");
  expect(school?.build).toBe(".");
  expect(school?.pull_policy).toBe("build");
  expect(migrate?.command).toEqual(["bun", "migrate.ts"]);
  expect(migrate?.restart).toBe("no"); // one-shot: it exits after applying, and is not restarted
  expect(migrate?.depends_on).toEqual({ postgres: { condition: "service_healthy" } });
  expect(migrate?.environment?.SCHOOL_MIGRATE_URL).toMatch(/^postgres:\/\/postgres:\$\{SCHOOL_POSTGRES_PASSWORD\}@postgres:5432\/school$/);
  expect(migrate?.environment?.SCHOOL_APP_PASSWORD).toMatch(/^\$\{SCHOOL_APP_PASSWORD:\?/);
  expect(school?.depends_on?.migrate).toEqual({ condition: "service_completed_successfully" });
  expect(school?.environment?.SCHOOL_DATABASE_URL).toMatch(/^postgres:\/\/school_app:\$\{SCHOOL_APP_PASSWORD\}@postgres:5432\/school$/);
  // No superuser credential reaches the server's container, by any variable.
  for (const value of Object.values(school?.environment ?? {})) {
    expect(value).not.toContain("SCHOOL_POSTGRES_PASSWORD");
    expect(value).not.toMatch(/postgres:\/\/postgres:/);
  }
  expect(Object.keys(school?.environment ?? {})).not.toContain("SCHOOL_MIGRATE_URL");
});

test("the image ships the migrate command", () => {
  expect(shipped).toContain("migrate.ts");
});
