// The Keychain, through @git-stunts/vault (flyingrobots/school#123). The vault is hexagonal: a
// VaultService over a keychain port, whose macOS adapter runs `security` through a command-runner
// port. School uses the vault's own service and macOS adapter, and supplies one thing of its own,
// the command runner, for one reason: the vault's adapter stores a secret with
// `security add-generic-password ... -w <secret>`, which puts the secret in argv, where any process
// of the same user can read it while `security` runs. StdinSecretRunner runs that one command
// through `security -i` instead, which reads it from stdin. Every other command, the reads among
// them, runs as the adapter gives it: a read puts the secret only on the child's stdout, a pipe.
import Vault, { createBunKeychainAdapter, type CommandResult, type CommandRunner } from "@git-stunts/vault";
import { SecretError, storable, type Store } from "./secrets.ts";

/** Bun.spawnSync's shape, as far as this module uses it: injectable so no test runs `security`. */
export type SpawnSync = (argv: string[], options: { stdin?: Uint8Array | "ignore"; stdout: "pipe"; stderr: "pipe" }) => { exitCode: number | null; stdout?: Uint8Array; stderr?: Uint8Array };

const realSpawnSync: SpawnSync = (argv, options) => {
  const r = Bun.spawnSync(argv, { stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
};

const text = (b: Uint8Array | undefined) => (b === undefined ? "" : new TextDecoder().decode(b));

/** One word for `security -i`: double-quoted, which keeps every character but `"` and `\` as written. */
const word = (w: string) => {
  if (!storable(w)) throw new SecretError("a Keychain item's account, name and value must be printable ASCII with no space, double quote or backslash");
  return `"${w}"`;
};

/** The vault's command-runner port, keeping a secret being stored out of argv (see the header). */
export class StdinSecretRunner implements CommandRunner {
  constructor(private readonly spawnSync: SpawnSync = realSpawnSync) {}

  run(command: string, args: string[] = [], _options: Record<string, unknown> = {}): CommandResult {
    if (command === "security" && args[0] === "add-generic-password") {
      const at = args.indexOf("-w");
      const account = args[args.indexOf("-a") + 1];
      const service = args[args.indexOf("-s") + 1];
      const value = at < 0 ? undefined : args[at + 1];
      if (account === undefined || service === undefined || value === undefined) return { status: 1 };
      const line = `add-generic-password -a ${word(account)} -s ${word(service)} -w ${word(value)} -U\n`;
      // `security -i` echoes a failed command line, secret and all, so its output is never shown.
      const r = this.spawnSync(["security", "-i"], { stdin: new TextEncoder().encode(line), stdout: "pipe", stderr: "pipe" });
      return { status: r.exitCode, stdout: "", stderr: "" };
    }
    let r: ReturnType<SpawnSync>;
    try {
      r = this.spawnSync([command, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch {
      // No such program (no `secret-tool` on a Linux CI runner): the item is not there.
      return { status: 127, stdout: "", stderr: "" };
    }
    return { status: r.exitCode, stdout: text(r.stdout), stderr: text(r.stderr) };
  }
}

/**
 * School's items in the Keychain under `account`: each secret is a generic password whose service
 * is the secret's name (SCHOOL_APP_PASSWORD, ...). `platform` and `spawnSync` are for tests.
 */
export function keychainStore(account: string, { platform, spawnSync }: { platform?: string; spawnSync?: SpawnSync } = {}): Store {
  const vault = new Vault({
    account,
    adapterFactory: ({ account }) => createBunKeychainAdapter({
      account,
      commandRunner: new StdinSecretRunner(spawnSync),
      ...(platform === undefined ? {} : { platformGetter: () => platform }),
    }),
  });
  return {
    get(name) {
      const v = vault.getSecret({ target: name });
      return v === undefined || v === "" ? undefined : v;
    },
    set(name, value) {
      if (!storable(value)) throw new SecretError(`${name} must be printable ASCII with no space, double quote or backslash to be stored in the Keychain`);
      try {
        vault.setSecret({ target: name, value });
      } catch {
        throw new SecretError(`the Keychain refused to store ${name} (account ${account})`, 1);
      }
      // `security -i` can exit 0 having stored nothing; read it back rather than trust that.
      if (vault.getSecret({ target: name }) !== value) throw new SecretError(`the Keychain did not keep ${name} (account ${account})`, 1);
    },
  };
}
