// School's secrets on the host (flyingrobots/school#123). They live in the macOS Keychain through
// @git-stunts/vault (host/keychain.ts) and reach the containers only as compose secrets, mounted
// under /run/secrets/ (server/compose.yaml). This module is the rule both host processes share,
// the launcher (host/launcher.ts) and the bridge (bridge/bridge.ts): the environment first, then
// the Keychain. It holds no value itself and never prints one. docs/topics/secrets/README.md.

/** Where the vault keeps a secret: a get and a set, by name. The Keychain, or a fake in tests. */
export interface Store {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
}

/**
 * What the launcher does when a secret is in neither the environment nor the Keychain. The
 * superuser's password is asked for, because an existing database was initialised with one and a
 * new one would not open it; the other two are generated, because the migrate job sets
 * school_app's password on every run and the bridge reads its token from the same Keychain.
 */
export type Missing = "prompt" | "generate";

export const SECRETS = [
  { name: "SCHOOL_POSTGRES_PASSWORD", missing: "prompt", what: "the Postgres superuser's password (postgres, migrate and backup services)" },
  { name: "SCHOOL_APP_PASSWORD", missing: "generate", what: "school_app's password (migrate and school services)" },
  { name: "SCHOOL_BRIDGE_TOKEN", missing: "generate", what: "the token the server and the bridge share (school service and the bridge)" },
] as const satisfies readonly { name: string; missing: Missing; what: string }[];

export type SecretName = (typeof SECRETS)[number]["name"];
export const SECRET_NAMES: readonly SecretName[] = SECRETS.map((s) => s.name);

/** Where a resolved secret came from. */
export type Source = "environment" | "keychain" | "prompted" | "generated";

/** A refusal with an exit code: 2 for a missing or invalid setting, 1 for anything else. */
export class SecretError extends Error {
  constructor(message: string, readonly code: 1 | 2 = 2) { super(message); }
}

/** The Keychain account School's items are kept under; SCHOOL_KEYCHAIN_ACCOUNT changes it. */
export const DEFAULT_ACCOUNT = "school";

export function accountFrom(env: Record<string, string | undefined>): string {
  const account = env.SCHOOL_KEYCHAIN_ACCOUNT === undefined || env.SCHOOL_KEYCHAIN_ACCOUNT === "" ? DEFAULT_ACCOUNT : env.SCHOOL_KEYCHAIN_ACCOUNT;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(account)) throw new SecretError("SCHOOL_KEYCHAIN_ACCOUNT must be letters, digits, dots, dashes and underscores");
  return account;
}

/**
 * Whether `value` can be stored exactly: printable ASCII with no space, double quote or backslash.
 * The Keychain adapter writes the value inside a double-quoted word on `security -i`'s stdin
 * (host/keychain.ts), and those three are the characters that word could not carry as they are.
 */
export const storable = (value: string) => /^[!#-[\]-~]+$/.test(value);

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** 32 letters and digits from the system's CSPRNG: about 190 bits, and safe in a URL as it is. */
export function generateSecret(): string {
  const out: string[] = [];
  // Rejection sampling: 248 is the largest multiple of 62 below 256, so every letter is equally likely.
  while (out.length < 32) {
    for (const b of crypto.getRandomValues(new Uint8Array(48))) if (b < 248 && out.length < 32) out.push(ALPHABET[b % 62]!);
  }
  return out.join("");
}

/**
 * `name` from the environment if it is set and not empty, else from the store, which is opened
 * only then; null if neither has it.
 */
export function resolveSecret(name: string, env: Record<string, string | undefined>, store: () => Store): { value: string; from: "environment" | "keychain" } | null {
  const fromEnv = env[name];
  if (fromEnv !== undefined && fromEnv !== "") return { value: fromEnv, from: "environment" };
  const fromStore = store().get(name);
  return fromStore === undefined || fromStore === "" ? null : { value: fromStore, from: "keychain" };
}
