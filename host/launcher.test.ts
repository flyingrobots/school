// The launcher, `school up` (flyingrobots/school#123), with a fake vault and a fake `docker compose`:
// nothing here reads or writes the real Keychain or starts a container. docs/topics/secrets/test-plan.md
// lists these cases by ID.
import { describe, expect, test } from "bun:test";
import { main, type Deps, type Spawned } from "./launcher.ts";
import { SECRETS, type Store } from "./secrets.ts";

/** A vault adapter in memory, counting every read and write. */
function fakeStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const calls = { get: 0, set: [] as string[] };
  const store: Store = {
    get(name) { calls.get++; return items.get(name); },
    set(name, value) { calls.set.push(name); items.set(name, value); },
  };
  return { store, items, calls };
}

type Run = { code: number; stdout: string[]; stderr: string[]; spawned: { args: string[]; cwd: string; env: Record<string, string | undefined> }[]; prompts: string[] };

let counter = 0;
/** A distinct, recognisable value per call: what "generated" gives in these tests. */
const generated = () => `Gen${++counter}abcdefghijklmnopqrstuvwxyz0123`;

async function run(argv: string[], over: Partial<Deps> & { answers?: string[]; composeCode?: number; composeLines?: { stream: "stdout" | "stderr"; line: string }[] } = {}): Promise<Run> {
  const r: Run = { code: -1, stdout: [], stderr: [], spawned: [], prompts: [] };
  const answers = [...(over.answers ?? [])];
  const deps: Deps = {
    env: {},
    store: () => fakeStore().store,
    isTTY: false,
    prompt: async (message) => { r.prompts.push(message); return answers.shift() ?? ""; },
    spawn: (args, opts): Spawned => {
      r.spawned.push({ args, cwd: opts.cwd, env: opts.env });
      expect(opts.stdin).toBe("ignore");
      return {
        lines: (async function* () { for (const l of over.composeLines ?? []) yield l; })(),
        exited: Promise.resolve(over.composeCode ?? 0),
      };
    },
    out: (l) => r.stdout.push(l),
    err: (l) => r.stderr.push(l),
    readText: () => null,
    writeText: () => { throw new Error("nothing should be written"); },
    generate: generated,
    serverDir: "/checkout/server",
    ...over,
  };
  r.code = await main(argv, deps);
  return r;
}

const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const all = (r: Run) => [...r.stdout, ...r.stderr];

/** Every line on either stream is one JSON object with a `kind`, and no line holds any of `secrets`. */
function contract(r: Run, secrets: string[]) {
  for (const l of all(r)) {
    const o = JSON.parse(l);
    expect(typeof o).toBe("object");
    expect(typeof o.kind).toBe("string");
    for (const s of secrets) expect(l).not.toContain(s);
  }
  for (const s of r.spawned) for (const s2 of secrets) expect(s.args.join(" ")).not.toContain(s2);
}

const NAMES = SECRETS.map((s) => s.name);

describe("school up", () => {
  test("SEC-L1: from a clean Keychain on a terminal it asks for the superuser password, generates the rest, stores all three, and starts compose with them in its environment only", async () => {
    const { store, items, calls } = fakeStore();
    const r = await run(["up"], { store: () => store, isTTY: true, answers: [""] });
    expect(r.code).toBe(0);
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain("SCHOOL_POSTGRES_PASSWORD");
    expect([...items.keys()].sort()).toEqual([...NAMES].sort());
    expect(calls.set.sort()).toEqual([...NAMES].sort());
    expect(r.spawned).toHaveLength(1);
    const [c] = r.spawned;
    expect(c!.args).toEqual(["docker", "compose", "up", "--detach", "--build"]);
    expect(c!.cwd).toBe("/checkout/server");
    for (const n of NAMES) expect(c!.env[n]).toBe(items.get(n)!);
    const events = parsed(r.stdout);
    expect(events.filter((e) => e.event === "secret").map((e) => [e.name, e.from])).toEqual([
      ["SCHOOL_POSTGRES_PASSWORD", "generated"], ["SCHOOL_APP_PASSWORD", "generated"], ["SCHOOL_BRIDGE_TOKEN", "generated"],
    ]);
    expect(events.at(-1)).toMatchObject({ kind: "school.up", event: "done", ok: true });
    contract(r, [...items.values()]);
  });

  test("SEC-L2: a second run reads every secret from the Keychain silently: no prompt, nothing stored", async () => {
    const { store, items, calls } = fakeStore();
    await run(["up"], { store: () => store, isTTY: true, answers: [""] });
    calls.set.length = 0;
    const again = await run(["up"], { store: () => store, isTTY: true });
    expect(again.code).toBe(0);
    expect(again.prompts).toEqual([]);
    expect(calls.set).toEqual([]);
    expect(parsed(again.stdout).filter((e) => e.event === "secret").map((e) => e.from)).toEqual(["keychain", "keychain", "keychain"]);
    for (const n of NAMES) expect(again.spawned[0]!.env[n]).toBe(items.get(n)!);
    contract(again, [...items.values()]);
  });

  test("SEC-L3: a superuser password typed at the prompt is stored as typed", async () => {
    const { store, items } = fakeStore();
    const typed = "TheOldSuperuserPassword0123";
    const r = await run(["up"], { store: () => store, isTTY: true, answers: [typed] });
    expect(r.code).toBe(0);
    expect(items.get("SCHOOL_POSTGRES_PASSWORD")).toBe(typed);
    expect(parsed(r.stdout).find((e) => e.name === "SCHOOL_POSTGRES_PASSWORD")).toMatchObject({ from: "prompted" });
    contract(r, [typed]);
  });

  test("SEC-L4: the environment comes first: a secret set there is used and never read from or written to the Keychain", async () => {
    const env = { SCHOOL_POSTGRES_PASSWORD: "EnvSuperuser0123456789", SCHOOL_APP_PASSWORD: "EnvApp01234567890123456", SCHOOL_BRIDGE_TOKEN: "EnvBridge0123456789" };
    const { store, calls } = fakeStore();
    const r = await run(["up"], { env, store: () => store });
    expect(r.code).toBe(0);
    expect(calls).toEqual({ get: 0, set: [] });
    for (const [k, v] of Object.entries(env)) expect(r.spawned[0]!.env[k]).toBe(v);
    expect(parsed(r.stdout).filter((e) => e.event === "secret").map((e) => e.from)).toEqual(["environment", "environment", "environment"]);
    contract(r, Object.values(env));
  });

  test("SEC-L5: without a terminal a missing superuser password is an error line, exit 2, and nothing is stored or started", async () => {
    const { store, calls } = fakeStore();
    const r = await run(["up"], { store: () => store, isTTY: false });
    expect(r.code).toBe(2);
    expect(r.spawned).toEqual([]);
    expect(calls.set).toEqual([]);
    expect(parsed(r.stderr).at(-1)).toMatchObject({ kind: "school.up", event: "error", code: 2 });
    expect(String(parsed(r.stderr).at(-1)!.message)).toContain("SCHOOL_POSTGRES_PASSWORD");
    contract(r, []);
  });

  test("SEC-L6: a typed password the Keychain cannot take safely (space, quote, backslash) is refused, and nothing is stored", async () => {
    for (const bad of ["has space0123", 'quote"d0123', "back\\slash0123"]) {
      const { store, calls } = fakeStore();
      const r = await run(["up"], { store: () => store, isTTY: true, answers: [bad] });
      expect(r.code).toBe(2);
      expect(calls.set).toEqual([]);
      expect(r.spawned).toEqual([]);
      contract(r, [bad]);
    }
  });

  test("SEC-L7: a secret still in server/.env stops it before anything is read, stored or started, naming the key and never the value", async () => {
    const leaked = "LeakedInDotEnv0123456789";
    const { store, calls } = fakeStore();
    const r = await run(["up"], {
      store: () => store,
      isTTY: true,
      readText: (p) => (p === "/checkout/server/.env" ? `SCHOOL_COURSE_DIR=../c\nSCHOOL_APP_PASSWORD=${leaked}\n` : null),
    });
    expect(r.code).toBe(2);
    expect(calls).toEqual({ get: 0, set: [] });
    expect(r.spawned).toEqual([]);
    const e = parsed(r.stderr).at(-1)!;
    expect(e).toMatchObject({ kind: "school.up", event: "error", code: 2, keys: ["SCHOOL_APP_PASSWORD"] });
    expect(String(e.message)).toContain("school import");
    contract(r, [leaked]);
  });

  test("SEC-L8: compose's own output is streamed as JSON lines, scrubbed of every secret, and its failure is an error line, exit 1", async () => {
    const env = { SCHOOL_POSTGRES_PASSWORD: "EnvSuperuser0123456789", SCHOOL_APP_PASSWORD: "EnvApp01234567890123456", SCHOOL_BRIDGE_TOKEN: "EnvBridge0123456789" };
    const r = await run(["up"], {
      env,
      composeCode: 17,
      composeLines: [{ stream: "stderr", line: " Container server-postgres-1 Started" }, { stream: "stdout", line: `echoed ${env.SCHOOL_APP_PASSWORD} by mistake` }],
    });
    expect(r.code).toBe(1);
    const compose = parsed(r.stdout).filter((e) => e.event === "compose");
    expect(compose).toEqual([
      { kind: "school.up", event: "compose", stream: "stderr", line: " Container server-postgres-1 Started" },
      { kind: "school.up", event: "compose", stream: "stdout", line: "echoed (redacted) by mistake" },
    ]);
    expect(parsed(r.stderr).at(-1)).toMatchObject({ kind: "school.up", event: "error", code: 1, exitCode: 17 });
    contract(r, Object.values(env));
  });

  test("SEC-L9: the Keychain account defaults to `school` and SCHOOL_KEYCHAIN_ACCOUNT changes it; an unsafe account name is refused", async () => {
    const seen: string[] = [];
    const env = { SCHOOL_POSTGRES_PASSWORD: "a1".repeat(12), SCHOOL_APP_PASSWORD: "b2".repeat(12), SCHOOL_BRIDGE_TOKEN: "c3".repeat(12) };
    const accountOf = (r: Run) => parsed(r.stdout).find((e) => e.event === "keychain")?.account;
    const a = await run(["up"], { env, store: (account) => { seen.push(account); return fakeStore().store; } });
    const b = await run(["up"], { env: { ...env, SCHOOL_KEYCHAIN_ACCOUNT: "school-test-1" }, store: (account) => { seen.push(account); return fakeStore().store; } });
    expect([accountOf(a), accountOf(b)]).toEqual(["school", "school-test-1"]);
    const bad = await run(["up"], { env: { ...env, SCHOOL_KEYCHAIN_ACCOUNT: 'x" -w y' } });
    expect(bad.code).toBe(2);
    expect(bad.spawned).toEqual([]);
  });

  test("SEC-L10: --human prints prose instead, still without a secret", async () => {
    const { store, items } = fakeStore();
    const r = await run(["up", "--human"], { store: () => store, isTTY: true, answers: [""] });
    expect(r.code).toBe(0);
    for (const l of all(r)) expect(() => JSON.parse(l)).toThrow();
    expect(r.stdout.join("\n")).toContain("SCHOOL_APP_PASSWORD: generated and stored in the Keychain");
    for (const v of items.values()) expect(all(r).join("\n")).not.toContain(v);
  });
});

describe("school down", () => {
  test("SEC-L11: runs `docker compose down` with no secret resolved, read or passed", async () => {
    const { store, calls } = fakeStore();
    const r = await run(["down"], { store: () => store });
    expect(r.code).toBe(0);
    expect(calls).toEqual({ get: 0, set: [] });
    expect(r.spawned.map((s) => s.args)).toEqual([["docker", "compose", "down"]]);
    for (const n of NAMES) expect(r.spawned[0]!.env[n]).toBeUndefined();
    expect(parsed(r.stdout).at(-1)).toMatchObject({ kind: "school.down", event: "done", ok: true });
  });
});

describe("school compose", () => {
  test("SEC-L17: passes its arguments to `docker compose` as they are, with the secrets resolved as for up and in the environment only, and stdin inherited", async () => {
    const { store, items } = fakeStore({ SCHOOL_POSTGRES_PASSWORD: "Kc0123456789abcdefghij", SCHOOL_APP_PASSWORD: "Kc1123456789abcdefghij", SCHOOL_BRIDGE_TOKEN: "Kc2123456789abcdefghij" });
    const stdins: (string | undefined)[] = [];
    const r = await run(["--human", "compose", "run", "--rm", "-T", "--entrypoint", "psql", "backup", "--human"], {
      store: () => store,
      spawn: (args, opts) => { stdins.push(opts.stdin); r0.push({ args, env: opts.env }); return { lines: (async function* () {})(), exited: Promise.resolve(0) }; },
    });
    expect(r.code).toBe(0);
    expect(r0.map((c) => c.args)).toEqual([["docker", "compose", "run", "--rm", "-T", "--entrypoint", "psql", "backup", "--human"]]);
    expect(stdins).toEqual(["inherit"]);
    for (const [k, v] of items) expect(r0[0]!.env[k]).toBe(v);
    for (const v of items.values()) expect(all(r).join("\n")).not.toContain(v);
  });

  test("SEC-L18: `school compose` with nothing after it is an error line, exit 2", async () => {
    const r = await run(["compose"]);
    expect(r.code).toBe(2);
    expect(parsed(r.stderr).at(-1)).toMatchObject({ kind: "school.compose", event: "error", code: 2 });
  });
});

const r0: { args: string[]; env: Record<string, string | undefined> }[] = [];

describe("school import", () => {
  const DOTENV = [
    "# settings",
    "SCHOOL_COURSE_DIR=../../my-course",
    "SCHOOL_POSTGRES_PASSWORD=OldSuperuser0123456789",
    "export SCHOOL_APP_PASSWORD='OldApp01234567890123456'",
    "SCHOOL_ALLOWED_HOSTS=school.example.ts.net",
    "",
  ].join("\n");

  test("SEC-L12: moves each secret from server/.env into the Keychain and removes only those lines", async () => {
    const { store, items } = fakeStore();
    const written: { path: string; text: string }[] = [];
    const r = await run(["import"], {
      store: () => store,
      readText: (p) => (p === "/checkout/server/.env" ? DOTENV : null),
      writeText: (path, text) => { written.push({ path, text }); },
    });
    expect(r.code).toBe(0);
    expect(items.get("SCHOOL_POSTGRES_PASSWORD")).toBe("OldSuperuser0123456789");
    expect(items.get("SCHOOL_APP_PASSWORD")).toBe("OldApp01234567890123456");
    expect(items.has("SCHOOL_BRIDGE_TOKEN")).toBe(false);
    expect(written).toEqual([{ path: "/checkout/server/.env", text: "# settings\nSCHOOL_COURSE_DIR=../../my-course\nSCHOOL_ALLOWED_HOSTS=school.example.ts.net\n" }]);
    expect(parsed(r.stdout).filter((e) => e.event === "imported").map((e) => e.name)).toEqual(["SCHOOL_POSTGRES_PASSWORD", "SCHOOL_APP_PASSWORD"]);
    contract(r, ["OldSuperuser0123456789", "OldApp01234567890123456"]);
  });

  test("SEC-L13: refuses, changing nothing, when the Keychain already holds a different value", async () => {
    const { store, items, calls } = fakeStore({ SCHOOL_APP_PASSWORD: "SomethingElse0123456789" });
    const r = await run(["import"], { store: () => store, readText: () => DOTENV });
    expect(r.code).toBe(2);
    expect(calls.set).toEqual([]);
    expect(items.get("SCHOOL_APP_PASSWORD")).toBe("SomethingElse0123456789");
    expect(parsed(r.stderr).at(-1)).toMatchObject({ kind: "school.import", event: "error", code: 2 });
    contract(r, ["OldSuperuser0123456789", "OldApp01234567890123456", "SomethingElse0123456789"]);
  });

  test("SEC-L14: with no secret in server/.env it changes nothing and says so", async () => {
    const { store, calls } = fakeStore();
    const r = await run(["import"], { store: () => store, readText: () => "SCHOOL_COURSE_DIR=x\n" });
    expect(r.code).toBe(0);
    expect(calls.set).toEqual([]);
    expect(parsed(r.stdout).at(-1)).toMatchObject({ kind: "school.import", event: "done", ok: true, imported: [] });
  });
});

describe("the command line", () => {
  test("SEC-L15: --help is JSON lines naming every command; an unknown command is an error line, exit 2", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    const lines = parsed(help.stdout);
    expect(lines.every((l) => l.kind === "school.help")).toBe(true);
    expect(lines.filter((l) => l.command !== undefined).map((l) => l.command)).toEqual(["up", "down", "compose", "import"]);
    const bad = await run(["fly"]);
    expect(bad.code).toBe(2);
    expect(parsed(bad.stderr).at(-1)).toMatchObject({ kind: "school.error", event: "error", code: 2 });
  });

  test("SEC-L16: a Keychain that throws is an error line, exit 1, never a stack trace", async () => {
    const r = await run(["up"], { store: () => ({ get() { throw new Error("security: boom"); }, set() {} }) });
    expect(r.code).toBe(1);
    expect(parsed(r.stderr).at(-1)).toMatchObject({ kind: "school.up", event: "error", code: 1 });
    contract(r, []);
  });
});
