// Secrets read from files (flyingrobots/school#123): under compose each secret is a file under
// /run/secrets/, named by a `*_FILE` variable, and never a value in the container's environment.
// docs/topics/secrets/test-plan.md lists these cases by ID.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, parseConfig } from "./config.ts";
import { withPassword, withSecretFiles } from "./secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "school-secrets-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text, { mode: 0o600 });
  return p;
};

test("SEC-F1: X_FILE is read into X, preferred over a plain X, with one trailing newline dropped", () => {
  const p = file("app", "FromTheFile0123456789\n");
  const env = withSecretFiles({ SCHOOL_APP_PASSWORD: "PlainValue0123456789", SCHOOL_APP_PASSWORD_FILE: p, OTHER: "kept" });
  expect(env.SCHOOL_APP_PASSWORD).toBe("FromTheFile0123456789");
  expect(env.OTHER).toBe("kept");
  expect(withSecretFiles({ SCHOOL_BRIDGE_TOKEN_FILE: file("crlf", "Token0123456789abc\r\n") }).SCHOOL_BRIDGE_TOKEN).toBe("Token0123456789abc");
});

test("SEC-F2: without X_FILE, a plain X is used as it is, so CI and development keep plain variables", () => {
  expect(withSecretFiles({ SCHOOL_APP_PASSWORD: "PlainValue0123456789" }).SCHOOL_APP_PASSWORD).toBe("PlainValue0123456789");
  expect(withSecretFiles({ SCHOOL_APP_PASSWORD_FILE: "" }).SCHOOL_APP_PASSWORD).toBeUndefined();
});

test("SEC-F3: a missing, unreadable or empty secret file is refused, naming the variable and the path, never the contents", () => {
  expect(() => withSecretFiles({ SCHOOL_DATABASE_PASSWORD_FILE: join(dir, "nope") })).toThrow(/SCHOOL_DATABASE_PASSWORD_FILE .*nope.*ENOENT/);
  expect(() => withSecretFiles({ SCHOOL_DATABASE_PASSWORD_FILE: file("empty", "\n") })).toThrow(/SCHOOL_DATABASE_PASSWORD_FILE .* is empty/);
  if (process.getuid?.() !== 0) {
    const locked = file("locked", "Secret0123456789abcd");
    chmodSync(locked, 0o000);
    let message = "";
    try { withSecretFiles({ SCHOOL_MIGRATE_PASSWORD_FILE: locked }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/SCHOOL_MIGRATE_PASSWORD_FILE .*EACCES/);
    expect(message).not.toContain("Secret0123456789abcd");
  }
  expect(() => withSecretFiles({ SCHOOL_DATABASE_PASSWORD_FILE: join(dir, "nope") })).toThrow(ConfigError);
});

test("SEC-F4: withPassword puts a password into a postgres URL that has none, and refuses a URL that already has one", () => {
  expect(withPassword("postgres://school_app@postgres:5432/school", "Pw0123456789", "SCHOOL_DATABASE_URL", "SCHOOL_DATABASE_PASSWORD"))
    .toBe("postgres://school_app:Pw0123456789@postgres:5432/school");
  expect(withPassword("postgres://school_app:x@postgres:5432/school", undefined, "SCHOOL_DATABASE_URL", "SCHOOL_DATABASE_PASSWORD"))
    .toBe("postgres://school_app:x@postgres:5432/school");
  expect(() => withPassword("postgres://school_app:x@postgres:5432/school", "Pw0123456789", "SCHOOL_DATABASE_URL", "SCHOOL_DATABASE_PASSWORD"))
    .toThrow(/SCHOOL_DATABASE_URL already has a password/);
  expect(() => withPassword("pglite:/state/db", "Pw0123456789", "SCHOOL_DATABASE_URL", "SCHOOL_DATABASE_PASSWORD")).toThrow(/postgres:\/\//);
});

test("SEC-F5: the server's record URL takes school_app's password from SCHOOL_DATABASE_PASSWORD_FILE", () => {
  const p = file("db", "AppPassword0123456789\n");
  const config = parseConfig(withSecretFiles({ SCHOOL_DATABASE_URL: "postgres://school_app@postgres:5432/school", SCHOOL_DATABASE_PASSWORD_FILE: p }), dir);
  expect(config.database).toEqual({ driver: "postgres", url: "postgres://school_app:AppPassword0123456789@postgres:5432/school" });
});

test("SEC-F6: the server, the migrate job and the bridge settings read every secret through withSecretFiles", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["server.ts", "migrate.ts"]) {
    const src = readFileSync(join(import.meta.dir, f), "utf8");
    expect(src).toContain("withSecretFiles(process.env)");
    // Nothing reads a secret from process.env directly.
    expect(src).not.toMatch(/process\.env\.(SCHOOL_APP_PASSWORD|SCHOOL_BRIDGE_TOKEN|SCHOOL_DATABASE_PASSWORD|SCHOOL_MIGRATE_PASSWORD|SCHOOL_MIGRATE_URL)\b/);
    // Nor hands the raw environment to anything but withSecretFiles.
    expect(src.replaceAll("withSecretFiles(process.env)", "").includes("(process.env")).toBe(false);
  }
});
