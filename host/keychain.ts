// The Keychain, through @git-stunts/vault (flyingrobots/school#123). The vault is hexagonal: a
// VaultService over a keychain port, whose macOS adapter runs `security` through a command-runner
// port. School uses the vault's own service and macOS adapter, and supplies one thing of its own,
// the command runner, for one reason: the vault's adapter stores a secret with
// `security add-generic-password ... -w <secret>`, which puts the secret in argv, where any process
// of the same user can read it while `security` runs. StdinSecretRunner runs that one command
// through `security -i` instead, which reads it from stdin. Every other command, the reads among
// them, runs as the adapter gives it: a read puts the secret only on the child's stdout, a pipe.
//
// Two more things the vault's adapter does not do, which the runner and the store add:
// - The adapter's read returns undefined for any nonzero exit of `security`. Only exit 44 ("could
//   not be found") means the item is missing; a locked or denied Keychain is another code, and
//   taking it for a missing item would make `school up` generate a secret and overwrite the real
//   one. The runner keeps the last read's status, and the store throws for anything but 44.
// - The adapter's store runs `delete-generic-password` before `add-generic-password ... -U`, so an
//   add that fails leaves no item at all. `-U` already updates an existing item in place, so while
//   the store is storing, the runner skips that delete.
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
  /** The last `security find-generic-password`'s exit status and stderr, for telling missing from refused. */
  lastRead: { status: number | null; stderr: string } | null = null;
  /** True while the store is storing: the adapter's delete before its `add ... -U` is skipped (see the header). */
  updatingInPlace = false;

  constructor(private readonly spawnSync: SpawnSync = realSpawnSync) {}

  run(command: string, args: string[] = [], _options: Record<string, unknown> = {}): CommandResult {
    if (command === "security" && args[0] === "delete-generic-password" && this.updatingInPlace) return { status: 0, stdout: "", stderr: "" };
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
    const result = { status: r.exitCode, stdout: text(r.stdout), stderr: text(r.stderr) };
    if (command === "security" && args[0] === "find-generic-password") this.lastRead = { status: result.status, stderr: result.stderr };
    return result;
  }
}

/** `security`'s exit status for an item that is not there (errSecItemNotFound). */
const NOT_FOUND = 44;

/**
 * School's items in the Keychain under `account`: each secret is a generic password whose service
 * is the secret's name (SCHOOL_APP_PASSWORD, ...). `platform` and `spawnSync` are for tests.
 */
export function keychainStore(account: string, { platform, spawnSync }: { platform?: string; spawnSync?: SpawnSync } = {}): Store {
  const runner = new StdinSecretRunner(spawnSync);
  const vault = new Vault({
    account,
    adapterFactory: ({ account }) => createBunKeychainAdapter({
      account,
      commandRunner: runner,
      ...(platform === undefined ? {} : { platformGetter: () => platform }),
    }),
  });
  return {
    get(name) {
      runner.lastRead = null;
      const v = vault.getSecret({ target: name });
      if (v !== undefined && v !== "") return v;
      // lastRead is null when the read was not `security` (secret-tool on Linux): missing, as before.
      const read = runner.lastRead as { status: number | null; stderr: string } | null;
      if (read !== null && read.status !== 0 && read.status !== NOT_FOUND) {
        // The stderr of a failed read is `security`'s own message; the value is only ever on stdout.
        const why = read.stderr.trim().split("\n")[0] ?? "";
        throw new SecretError(`the Keychain could not read ${name} (account ${account}): security exit ${read.status}${why === "" ? "" : ` (${why})`}; nothing was changed`, 1);
      }
      return undefined;
    },
    set(name, value) {
      if (!storable(value)) throw new SecretError(`${name} must be printable ASCII with no space, double quote or backslash to be stored in the Keychain`);
      runner.updatingInPlace = true;
      try {
        vault.setSecret({ target: name, value });
      } catch {
        throw new SecretError(`the Keychain refused to store ${name} (account ${account})`, 1);
      } finally {
        runner.updatingInPlace = false;
      }
      // `security -i` can exit 0 having stored nothing; read it back rather than trust that.
      if (vault.getSecret({ target: name }) !== value) throw new SecretError(`the Keychain did not keep ${name} (account ${account})`, 1);
    },
  };
}
