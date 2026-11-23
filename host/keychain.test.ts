// The Keychain adapter (flyingrobots/school#123): @git-stunts/vault's own macOS adapter, with a
// command runner that keeps the secret out of argv. A fake spawnSync stands in for `security`, so
// no test touches the real Keychain. docs/topics/secrets/test-plan.md lists these cases by ID.
import { expect, test } from "bun:test";
import { keychainStore, StdinSecretRunner, type SpawnSync } from "./keychain.ts";
import { generateSecret, resolveSecret, SecretError, storable } from "./secrets.ts";

type Call = { argv: string[]; stdin: string | null };

/** A `security` in memory: `-i` reads commands from stdin; find, add and delete work on a map. */
function fakeSecurity() {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const key = (a: string, s: string) => `${a}\u0000${s}`;
  const opt = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
  const enc = (s: string) => new TextEncoder().encode(s);
  const exec = (args: string[]): { exitCode: number; stdout: Uint8Array } => {
    const [sub] = args;
    if (sub === "find-generic-password") {
      const v = items.get(key(opt(args, "-a"), opt(args, "-s")));
      return v === undefined ? { exitCode: 44, stdout: enc("") } : { exitCode: 0, stdout: enc(`${v}\n`) };
    }
    if (sub === "delete-generic-password") return { exitCode: items.delete(key(opt(args, "-a"), opt(args, "-s"))) ? 0 : 44, stdout: enc("") };
    if (sub === "add-generic-password") {
      items.set(key(opt(args, "-a"), opt(args, "-s")), opt(args, "-w"));
      return { exitCode: 0, stdout: enc("") };
    }
    return { exitCode: 1, stdout: enc("") };
  };
  /** security -i's tokenizer, for the double-quoted words the runner writes. */
  const words = (line: string) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  const spawnSync: SpawnSync = (argv, opts) => {
    const stdin = opts.stdin instanceof Uint8Array ? new TextDecoder().decode(opts.stdin) : null;
    calls.push({ argv, stdin });
    if (argv[0] !== "security") throw new Error(`unexpected ${argv[0]}`);
    if (argv[1] === "-i") {
      let code = 0;
      for (const line of (stdin ?? "").split("\n").filter((l) => l.trim() !== "")) code = exec(words(line)).exitCode || code;
      return { exitCode: code, stdout: enc(""), stderr: enc("") };
    }
    return { ...exec(argv.slice(1)), stderr: enc("") };
  };
  return { items, calls, spawnSync };
}

const SECRET = "Value0123456789'$#;!{}|%&*=+/<>~`x";

test("SEC-K1: storing a secret runs `security -i` with the command on stdin: no argv of any call holds the value", () => {
  const sec = fakeSecurity();
  const store = keychainStore("school-test-k1", { platform: "darwin", spawnSync: sec.spawnSync });
  store.set("SCHOOL_APP_PASSWORD", SECRET);
  expect(store.get("SCHOOL_APP_PASSWORD")).toBe(SECRET);
  expect(sec.calls.length).toBeGreaterThan(0);
  for (const c of sec.calls) expect(c.argv.join(" ")).not.toContain(SECRET);
  const add = sec.calls.find((c) => c.stdin?.includes("add-generic-password"));
  expect(add?.argv).toEqual(["security", "-i"]);
  expect(add?.stdin).toBe(`add-generic-password -a "school-test-k1" -s "SCHOOL_APP_PASSWORD" -w "${SECRET}" -U\n`);
});

test("SEC-K2: reading uses the vault's `find-generic-password ... -w`, with the secret only on the child's stdout", () => {
  const sec = fakeSecurity();
  sec.items.set("school-test-k2\u0000SCHOOL_BRIDGE_TOKEN", "BridgeToken0123456789");
  const store = keychainStore("school-test-k2", { platform: "darwin", spawnSync: sec.spawnSync });
  expect(store.get("SCHOOL_BRIDGE_TOKEN")).toBe("BridgeToken0123456789");
  expect(store.get("SCHOOL_APP_PASSWORD")).toBeUndefined();
  expect(sec.calls.map((c) => c.argv)).toEqual([
    ["security", "find-generic-password", "-a", "school-test-k2", "-s", "SCHOOL_BRIDGE_TOKEN", "-w"],
    ["security", "find-generic-password", "-a", "school-test-k2", "-s", "SCHOOL_APP_PASSWORD", "-w"],
  ]);
});

test("SEC-K3: a value the stdin line could not carry exactly is refused before `security` runs", () => {
  const sec = fakeSecurity();
  const store = keychainStore("school-test-k3", { platform: "darwin", spawnSync: sec.spawnSync });
  for (const bad of ["", "two words", 'a"quote', "back\\slash", "new\nline", "tab\tx", "nön-ascii"]) {
    expect(storable(bad)).toBe(false);
    expect(() => store.set("SCHOOL_APP_PASSWORD", bad)).toThrow(SecretError);
  }
  expect(sec.calls.filter((c) => c.stdin?.includes("add-generic-password"))).toEqual([]);
});

test("SEC-K4: a store the Keychain did not keep is an error, not a silent success", () => {
  const sec = fakeSecurity();
  const forgetful: SpawnSync = (argv, opts) => (argv[1] === "-i" ? { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() } : sec.spawnSync(argv, opts));
  const store = keychainStore("school-test-k4", { platform: "darwin", spawnSync: forgetful });
  expect(() => store.set("SCHOOL_APP_PASSWORD", "Value0123456789abcdef")).toThrow(/did not keep SCHOOL_APP_PASSWORD/);
});

test("SEC-K5: the runner passes every other command through unchanged", () => {
  const sec = fakeSecurity();
  const runner = new StdinSecretRunner(sec.spawnSync);
  runner.run("security", ["delete-generic-password", "-a", "x", "-s", "y"], {});
  expect(sec.calls).toEqual([{ argv: ["security", "delete-generic-password", "-a", "x", "-s", "y"], stdin: null }]);
});

test("SEC-K6: generated secrets are 32 letters and digits, and differ", () => {
  const a = generateSecret();
  const b = generateSecret();
  expect(a).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(b).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(a).not.toBe(b);
});

test("SEC-K7: resolveSecret takes the environment first, then the store, and says which; an empty variable counts as unset", () => {
  const store = { get: (n: string) => (n === "SCHOOL_BRIDGE_TOKEN" ? "FromKeychain0123456789" : undefined), set() { throw new Error("no writes"); } };
  expect(resolveSecret("SCHOOL_BRIDGE_TOKEN", { SCHOOL_BRIDGE_TOKEN: "FromEnv0123456789" }, () => store)).toEqual({ value: "FromEnv0123456789", from: "environment" });
  expect(resolveSecret("SCHOOL_BRIDGE_TOKEN", { SCHOOL_BRIDGE_TOKEN: "" }, () => store)).toEqual({ value: "FromKeychain0123456789", from: "keychain" });
  expect(resolveSecret("SCHOOL_APP_PASSWORD", {}, () => store)).toBeNull();
  // The environment is enough: the store is not even opened.
  expect(resolveSecret("SCHOOL_BRIDGE_TOKEN", { SCHOOL_BRIDGE_TOKEN: "FromEnv0123456789" }, () => { throw new Error("not opened"); })).toEqual({ value: "FromEnv0123456789", from: "environment" });
});

test("SEC-K8: a read returns nothing only for a missing item (exit 44); any other failure is an error, so no caller takes a locked Keychain for an empty one", () => {
  const sec = fakeSecurity();
  const failing = (exitCode: number, stderr: string): SpawnSync => (argv, opts) =>
    argv[1] === "find-generic-password" ? { exitCode, stdout: new Uint8Array(), stderr: new TextEncoder().encode(stderr) } : sec.spawnSync(argv, opts);
  const missing = keychainStore("school-test-k8", { platform: "darwin", spawnSync: failing(44, "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n") });
  expect(missing.get("SCHOOL_APP_PASSWORD")).toBeUndefined();
  for (const [code, stderr] of [[36, "security: SecKeychainSearchCopyNext: User interaction is not allowed.\n"], [51, "security: SecKeychainSearchCopyNext: The user name or passphrase you entered is not correct.\n"], [1, ""]] as const) {
    const store = keychainStore("school-test-k8", { platform: "darwin", spawnSync: failing(code, stderr) });
    expect(() => store.get("SCHOOL_APP_PASSWORD")).toThrow(SecretError);
    expect(() => store.get("SCHOOL_APP_PASSWORD")).toThrow(new RegExp(`could not read SCHOOL_APP_PASSWORD .*exit ${code}`));
  }
});

test("SEC-K9: storing updates the item in place: no delete runs first, so a failed store leaves the old secret where it was", () => {
  const sec = fakeSecurity();
  sec.items.set("school-test-k9\u0000SCHOOL_APP_PASSWORD", "OldValue0123456789");
  const store = keychainStore("school-test-k9", { platform: "darwin", spawnSync: sec.spawnSync });
  store.set("SCHOOL_APP_PASSWORD", "NewValue0123456789");
  expect(sec.items.get("school-test-k9\u0000SCHOOL_APP_PASSWORD")).toBe("NewValue0123456789");
  expect(sec.calls.some((c) => c.argv.includes("delete-generic-password") || c.stdin?.includes("delete-generic-password"))).toBe(false);

  const refusing: SpawnSync = (argv, opts) => (argv[1] === "-i" ? { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } : sec.spawnSync(argv, opts));
  const refused = keychainStore("school-test-k9", { platform: "darwin", spawnSync: refusing });
  expect(() => refused.set("SCHOOL_APP_PASSWORD", "Another0123456789")).toThrow(SecretError);
  expect(sec.items.get("school-test-k9\u0000SCHOOL_APP_PASSWORD")).toBe("NewValue0123456789");
});
