// The bridge's output contract (flyingrobots/school#135; docs/topics/program-output/README.md): every
// line it prints names its published schema in bridge/schemas/ and validates against it (Ajv, draft
// 2020-12, through server/testing/schemas.ts). `--help` and `--schema` print JSON Lines without
// starting; `--human` is prose.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, timeout } from "../server/testing/processes.ts";
import { publishedIn, wellFormed } from "../server/testing/schemas.ts";

const BRIDGE = join(import.meta.dir, "bridge.ts");
const TOKEN = "output-token-0123456789";
const bridgeSchemas = publishedIn(join(import.meta.dir, "schemas"));
const TYPES = ["attempt", "config.saved", "error", "help", "listening", "run.end", "run.start", "schema", "speak.cancel", "speak.failed", "speak.submit", "start", "test"];
const IDS = TYPES.map((t) => `school.bridge.${t}`);

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "school-bridge-output-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The bridge run to completion with `args` and `env`; its exit code and both streams. */
async function once(args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn(["bun", BRIDGE, ...args], { env: { PATH: process.env.PATH, HOME: dir, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("the bridge's schemas (bridge/schemas/)", () => {
  test("bridge schemas: one file per message type, each well formed, kind bridge.<type>", () => {
    expect(bridgeSchemas.ids).toEqual(IDS);
    for (const p of bridgeSchemas.published) {
      expect({ file: p.file, wrong: wellFormed(p, ["_schema", "kind", "run", "at"]) }).toEqual({ file: p.file, wrong: [] });
      expect(p.schema.properties.kind.const).toBe(`bridge.${p.id.slice("school.bridge.".length)}`);
    }
  });
});

describe("the bridge's output", () => {
  test("bridge, a session: start, listening, a run with its attempts, a test and a saved configuration, every line valid, one run id, no token, no prompt", async () => {
    const good = join(dir, "good");
    writeFileSync(good, `#!/bin/sh\necho '{"ok": true}'\n`);
    chmodSync(good, 0o755);
    writeFileSync(join(dir, "bridge.json"), JSON.stringify({ timeout_seconds: 5, agents: [
      { name: "missing", command: "no-such-cli-qqq {prompt}" }, { name: "good", command: `${good} {prompt}` }] }));
    const b = await startBridge({ PATH: process.env.PATH, HOME: dir, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json") });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const send = (method: string, path: string, body: unknown) => fetch(b.url + path, { method, headers, body: JSON.stringify(body) }).then((r) => r.json());
    expect(await send("POST", "/run", { prompt: "SECRET-LEARNER-TEXT", schema: { type: "object" } })).toMatchObject({ status: "succeeded" });
    expect(await send("POST", "/test", { agent: "good" })).toMatchObject({ status: "succeeded" });
    expect(await send("PUT", "/config", { agents: [{ name: "good" }, { name: "missing", enabled: false }] })).toMatchObject({ status: "saved" });
    b.proc.kill();
    const { stdout, stderr } = await b.output();
    expect(stderr).toBe("");
    const out = bridgeSchemas.validated(stdout);
    expect(out.map((l) => l.kind)).toEqual(["bridge.start", "bridge.listening", "bridge.run.start", "bridge.attempt", "bridge.attempt", "bridge.run.end", "bridge.test", "bridge.config.saved"]);
    expect(out.map((l) => l._schema.id)).toEqual(out.map((l) => `school.${l.kind}`));
    expect(new Set(out.map((l) => l.run)).size).toBe(1);
    expect(new Set(out.filter((l) => "id" in l).map((l) => l.id)).size).toBe(1);
    expect(stdout).not.toContain(TOKEN);
    expect(stdout).not.toContain("SECRET-LEARNER-TEXT");
  }, timeout(1));

  test("bridge, a refusal to start (short token, bad port, unreadable configuration, unknown argument): one valid bridge.error line, exit 2, no token", async () => {
    writeFileSync(join(dir, "broken.json"), "{ not json");
    const cases: [string[], Record<string, string>][] = [
      [[], { SCHOOL_BRIDGE_TOKEN: "short" }],
      [[], { SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_PORT: "99999" }],
      [[], { SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "broken.json") }],
      [["--frobnicate"], { SCHOOL_BRIDGE_TOKEN: TOKEN }],
    ];
    for (const [args, env] of cases) {
      const r = await once(args, { SCHOOL_BRIDGE_CONFIG: join(dir, "none.json"), ...env });
      expect({ args, env, code: r.code, stderr: r.stderr }).toEqual({ args, env, code: 2, stderr: "" });
      const out = bridgeSchemas.validated(r.stdout);
      expect(out.at(-1)!._schema.id).toBe("school.bridge.error");
      expect(out.filter((l) => l.kind === "bridge.error")).toHaveLength(1);
      expect(r.stdout).not.toContain(TOKEN);
    }
  });

  test("bridge, a taken port: its bridge.error line, with host, port and code EADDRINUSE, validates; exit 2", async () => {
    const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    try {
      const r = await once([], { SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "none.json"), SCHOOL_BRIDGE_PORT: String(holder.port) });
      expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 2, stderr: "" });
      const out = bridgeSchemas.validated(r.stdout);
      expect(out.at(-1)).toMatchObject({ kind: "bridge.error", host: "127.0.0.1", port: holder.port, code: "EADDRINUSE" });
      expect(r.stdout).not.toContain(TOKEN);
    } finally {
      holder.stop(true);
    }
  });

  test("bridge --help: a help line, then every schema, exit 0, without a token or listening; --schema: every schema", async () => {
    const help = await once(["--help"], {});
    expect({ code: help.code, stderr: help.stderr }).toEqual({ code: 0, stderr: "" });
    const out = bridgeSchemas.validated(help.stdout);
    expect(out[0]).toMatchObject({ kind: "bridge.help", command: "bridge" });
    expect((out[0]!.output as string[]).sort()).toEqual(IDS);
    expect((out[0]!.environment as { name: string }[]).map((e) => e.name)).toEqual(["SCHOOL_BRIDGE_TOKEN", "SCHOOL_BRIDGE_CONFIG", "SCHOOL_BRIDGE_HOST", "SCHOOL_BRIDGE_PORT", "AI_TTS_SOCKET", "AI_TTS_HOME"]);
    expect(out.slice(1).map((l) => l.schema)).toEqual(bridgeSchemas.published.map((p) => p.schema) as never);
    expect(new Set(out.map((l) => l.run)).size).toBe(1);
    expect((await once(["-h"], {})).stdout.split("\n")[0]).toContain('"kind":"bridge.help"');
    const schema = await once(["--schema"], { SCHOOL_BRIDGE_TOKEN: "short" });
    expect(schema.code).toBe(0);
    expect(bridgeSchemas.validated(schema.stdout).map((l) => l.id)).toEqual(IDS);
  });

  test("bridge --human: the help and a refusal are prose, no line JSON, and the token is never printed", async () => {
    const help = await once(["--help", "--human"], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("SCHOOL_BRIDGE_TOKEN");
    expect(help.stdout).toContain("--schema");
    const refused = await once(["--humanize"], { SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_PORT: "99999" });
    expect(refused.code).toBe(2);
    expect(refused.stdout).toStartWith("error: SCHOOL_BRIDGE_PORT 99999 is not a port");
    for (const text of [help.stdout, refused.stdout]) for (const l of text.split("\n").filter((x) => x !== "")) expect(() => JSON.parse(l)).toThrow();
    expect(refused.stdout).not.toContain(TOKEN);
  });
});
