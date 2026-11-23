// Secrets from files (flyingrobots/school#123). Under compose each secret is a file under
// /run/secrets/, copied in by compose from the launcher's environment (host/school.ts), and the
// container's environment holds only its path, in `<NAME>_FILE`. So no secret shows in
// `docker inspect`. Outside compose (CI, development) the plain variable still works; when both
// are set the file wins. A value read here is never logged or echoed in an error.
// docs/topics/secrets/README.md.
import { readFileSync } from "node:fs";
import { ConfigError } from "./config.ts";

/** The secrets a School process may read from a file: the server's and the migrate job's. */
export const SECRET_VARIABLES = ["SCHOOL_DATABASE_PASSWORD", "SCHOOL_MIGRATE_PASSWORD", "SCHOOL_APP_PASSWORD", "SCHOOL_BRIDGE_TOKEN"] as const;

/**
 * `env` with each of `names` read from the file `<name>_FILE` names, when that is set: the file's
 * text, less one trailing newline. A missing, unreadable or empty file is a ConfigError naming the
 * variable and the path, never the contents.
 */
export function withSecretFiles(env: Record<string, string | undefined>, names: readonly string[] = SECRET_VARIABLES): Record<string, string | undefined> {
  const out = { ...env };
  for (const name of names) {
    const path = env[`${name}_FILE`];
    if (path === undefined || path === "") continue;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      throw new ConfigError(`${name}_FILE (${path}) cannot be read: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    }
    const value = text.replace(/\r?\n$/, "");
    if (value === "") throw new ConfigError(`${name}_FILE (${path}) is empty`);
    out[name] = value;
  }
  return out;
}

/**
 * `url` with `password` as its password, for a URL that names its user and host but not the
 * password, as compose gives them. Without a password, `url` as it is. A password given twice, in
 * the URL and beside it, is refused rather than one silently chosen.
 */
export function withPassword(url: string | undefined, password: string | undefined, urlName: string, passwordName: string): string | undefined {
  if (password === undefined || password === "") return url;
  if (url === undefined || !/^postgres(ql)?:\/\//.test(url)) throw new ConfigError(`${passwordName} is set, so ${urlName} must be a postgres:// URL to put it in`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`${urlName} is not a valid postgres:// URL`);
  }
  if (u.password !== "") throw new ConfigError(`${urlName} already has a password, and ${passwordName} gives another: give it once`);
  u.password = encodeURIComponent(password);
  return u.toString();
}
