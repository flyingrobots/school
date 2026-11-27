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
 * and testing/, the SQL migrations under db/, and the published output schemas under schemas/.
 */
const admitted = (path: string) => path === "package.json" || path === "bun.lock" ||
  (path.startsWith("db/") && path.endsWith(".sql")) ||
  (/^schemas\/[^/]+\.schema\.json$/.test(path)) ||
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
  expect(rules).toEqual(["*", "!package.json", "!bun.lock", "!**/*.ts", "!db/**/*.sql", "!schemas/*.schema.json", "**/*.test.ts", "contract/**", "testing/**", "node_modules/**"]);
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
type Service = { build?: string; pull_policy?: string; command?: string[]; restart?: string; depends_on?: Record<string, { condition: string }>; environment?: Record<string, string>; secrets?: unknown[]; volumes?: string[] };
const compose = Bun.YAML.parse(readFileSync(join(dir, "compose.yaml"), "utf8")) as { services: Record<string, Service>; volumes?: Record<string, unknown> };

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
  // flyingrobots/school#123: the passwords are compose secret files, not interpolated into the URLs
  // (server/compose-secrets.test.ts checks which service holds which).
  expect(migrate?.environment?.SCHOOL_MIGRATE_URL).toBe("postgres://postgres@postgres:5432/school");
  expect(migrate?.environment?.SCHOOL_MIGRATE_PASSWORD_FILE).toBe("/run/secrets/postgres_password");
  expect(migrate?.environment?.SCHOOL_APP_PASSWORD_FILE).toBe("/run/secrets/app_password");
  expect(school?.depends_on?.migrate).toEqual({ condition: "service_completed_successfully" });
  expect(school?.environment?.SCHOOL_DATABASE_URL).toBe("postgres://school_app@postgres:5432/school");
  expect(school?.environment?.SCHOOL_DATABASE_PASSWORD_FILE).toBe("/run/secrets/app_password");
  // No superuser credential reaches the server's container, by any variable or secret.
  for (const value of Object.values(school?.environment ?? {})) {
    expect(value).not.toContain("SCHOOL_POSTGRES_PASSWORD");
    expect(value).not.toContain("postgres_password");
    expect(value).not.toMatch(/postgres:\/\/postgres[:@]/);
  }
  expect(JSON.stringify(school?.secrets ?? [])).not.toContain("postgres_password");
  expect(Object.keys(school?.environment ?? {})).not.toContain("SCHOOL_MIGRATE_URL");
});

test("compose mounts the built web app, read-only, where the server looks for it (flyingrobots/school#152)", () => {
  const root = dockerfile.match(/SCHOOL_ROOT=(\S+)/)?.[1];
  expect(root).toBe("/framework");
  // config.ts: the web app is $SCHOOL_ROOT/web/dist unless SCHOOL_WEB says otherwise.
  expect(compose.services.school?.environment?.SCHOOL_WEB).toBeUndefined();
  expect(compose.services.school?.volumes).toContain(`../web/dist:${root}/web/dist:ro`);
});

test("compose can serve more courses from an optional library mount (flyingrobots/school#156)", () => {
  const school = compose.services.school;
  expect(school?.environment?.SCHOOL_COURSES).toBe("${SCHOOL_COURSES:-}");
  // Without SCHOOL_LIBRARY_DIR the mount falls back to the course folder, so an existing deployment still starts.
  expect(school?.volumes).toContain("${SCHOOL_LIBRARY_DIR:-${SCHOOL_COURSE_DIR}}:/library:ro");
  // The course at /course is unchanged, slug and all.
  expect(dockerfile).toMatch(/SCHOOL_COURSE=\/course/);
});

test("compose passes SCHOOL_UNTRUSTED_COURSES through, empty by default (flyingrobots/school#210)", () => {
  expect(compose.services.school?.environment?.SCHOOL_UNTRUSTED_COURSES).toBe("${SCHOOL_UNTRUSTED_COURSES:-}");
});

// RFC 7 §5.1 and §6 (flyingrobots/school#233): installing fetches a course with git, into the course
// store, a named volume at /store that the server's user must be able to write.
test("the image has git, and the CA certificates an https fetch needs", () => {
  const installs = [...dockerfile.matchAll(/^RUN apt-get update && apt-get install --yes --no-install-recommends ([^&\n]+) && rm -rf \/var\/lib\/apt\/lists\/\*$/gm)].flatMap((m) => m[1]!.trim().split(/\s+/));
  expect(installs).toContain("git");
  expect(installs).toContain("ca-certificates");
});

test("the image makes /store owned by the server's user, so a new course-store volume is writable", () => {
  // Docker fills an empty named volume from the image's folder at its mount point, owner included.
  expect(dockerfile).toMatch(/^RUN install --directory --owner=school --group=school --mode=0755 \/store$/m);
  expect(dockerfile.indexOf("useradd")).toBeLessThan(dockerfile.indexOf("/store"));
});

test("compose mounts the course-store volume at /store and points SCHOOL_COURSE_STORE at it through SCHOOL_COMPOSE_COURSE_STORE, which .env may set empty and a host export never reaches", () => {
  const school = compose.services.school;
  expect(school?.volumes).toContain("course-store:/store");
  expect(Object.keys(compose.volumes ?? {})).toContain("course-store");
  // `-`, not `:-`: unset means /store, and an empty value in .env means no store, so installing is off.
  expect(school?.environment?.SCHOOL_COURSE_STORE).toBe("${SCHOOL_COMPOSE_COURSE_STORE-/store}");
});

// The pinned school skill (RFC 9 §5.3, flyingrobots/school#257): the image is built from server/ and
// cannot reach .agents/, so compose mounts the checkout's skill and the references it links, read-only,
// beside /framework/assets, and points the server at them.
test("compose mounts the checkout's school skill and its references read-only under /framework", () => {
  const school = compose.services.school;
  expect(school?.volumes).toEqual(expect.arrayContaining([
    "../.agents/skills/school:/framework/skills/school:ro",
    "../docs/topics/course-format:/framework/docs/course-format:ro",
    "../docs/topics/voice:/framework/docs/voice:ro",
  ]));
});

test("compose points SCHOOL_SKILL at the mount through SCHOOL_COMPOSE_SKILL, which .env may set empty and a host export never reaches, and SCHOOL_SKILL_DOCS at the references with no variable at all", () => {
  const school = compose.services.school;
  // `-`, not `:-`: unset means the mount, and an empty value in .env means no skill, so authoring is off.
  expect(school?.environment?.SCHOOL_SKILL).toBe("${SCHOOL_COMPOSE_SKILL-/framework/skills/school}");
  expect(school?.environment?.SCHOOL_SKILL_DOCS).toBe("/framework/docs");
});

test("the image ships the migrate command", () => {
  expect(shipped).toContain("migrate.ts");
});

// flyingrobots/school#120: `migrate.ts --help` and `--schema` read the published schemas at run
// time, and every line it prints names one, so the image must carry every one of them.
test("every published output schema is shipped, beside the migrate command that reads them", () => {
  const files = readdirSync(join(dir, "schemas")).filter((f) => f.endsWith(".schema.json"));
  expect(files.length).toBeGreaterThan(0);
  expect(shipped).toContain("migrate.ts");
  expect(shipped).toContain("jsonl.ts");
  for (const f of files) expect(admitted(join("schemas", f))).toBe(true);
  expect(admitted("schemas/notes.md")).toBe(false);
});
