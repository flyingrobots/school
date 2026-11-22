// The bridge: a separate process on the host that runs LLM agents for the School server
// (RFC 1 proposal 4). The server sends a prompt and a JSON schema; the bridge tries the
// learner's configured agents in order and returns the first answer that matches.
//
//   SCHOOL_BRIDGE_TOKEN=<shared secret> bun bridge/bridge.ts
//
// Configuration is a JSON file (SCHOOL_BRIDGE_CONFIG, default ~/.config/school/bridge.json),
// re-read on every request so an edit takes effect without a restart. Logs are JSON Lines on
// stdout; they never contain a prompt or an answer, which are the learner's private work.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BridgeConfigError, loadConfig, runChain, type BridgeConfig } from "./run.ts";

const log = (kind: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ kind: `bridge.${kind}`, at: new Date().toISOString(), ...fields }));

const token = process.env.SCHOOL_BRIDGE_TOKEN ?? "";
const configPath = process.env.SCHOOL_BRIDGE_CONFIG ?? join(homedir(), ".config", "school", "bridge.json");
const host = process.env.SCHOOL_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.SCHOOL_BRIDGE_PORT ?? 4748);

function exit(message: string): never {
  log("error", { message });
  process.exit(2);
}
if (token.length < 16) exit("set SCHOOL_BRIDGE_TOKEN to a shared secret of at least 16 characters; the server sends the same one");
if (!Number.isInteger(port) || port < 1 || port > 65535) exit(`SCHOOL_BRIDGE_PORT ${process.env.SCHOOL_BRIDGE_PORT} is not a port`);

function config(): BridgeConfig {
  if (!existsSync(configPath)) throw new BridgeConfigError(`no configuration at ${configPath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new BridgeConfigError(`${configPath} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return loadConfig(raw);
}
try {
  const c = config();
  log("start", { host, port, config: configPath, agents: c.agents.map((a) => ({ name: a.name, enabled: a.enabled, program: a.argv[0] })) });
} catch (e) {
  exit(e instanceof Error ? e.message : String(e));
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const authorised = (req: Request) => {
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${token}`;
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

// One chain at a time: agents are heavy, and a single learner never needs two at once.
let queue: Promise<unknown> = Promise.resolve();
const serially = <T>(work: () => Promise<T>): Promise<T> => {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
};

Bun.serve({
  hostname: host,
  port,
  idleTimeout: 255,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (!authorised(req)) return json({ status: "unauthorised" }, 401);
    if (req.method === "GET" && pathname === "/health") {
      try {
        const c = config();
        return json({ status: "ok", agents: c.agents.map((a) => ({
          name: a.name, enabled: a.enabled, found: a.argv[0]!.includes("/") ? existsSync(a.argv[0]!) : Bun.which(a.argv[0]!) !== null,
        })) });
      } catch (e) {
        return json({ status: "misconfigured", error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    if (req.method === "POST" && pathname === "/run") {
      const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (type !== "application/json") return json({ status: "expected application/json" }, 415);
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json({ status: "invalid", error: "body is not JSON" }, 400);
      }
      const { prompt, schema, deadline_ms } = body ?? {};
      if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 200_000) return json({ status: "invalid", error: "prompt must be 1 to 200000 characters" }, 400);
      if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return json({ status: "invalid", error: "schema must be an object" }, 400);
      const deadline = deadline_ms === undefined ? undefined : Number(deadline_ms);
      if (deadline !== undefined && (!Number.isInteger(deadline) || deadline <= 0)) return json({ status: "invalid", error: "deadline_ms must be a positive integer" }, 400);
      let c: BridgeConfig;
      try {
        c = config();
      } catch (e) {
        return json({ status: "failed", error: e instanceof Error ? e.message : String(e), attempts: [] });
      }
      const id = crypto.randomUUID();
      log("run.start", { id });
      const result = await serially(() => runChain(c, { prompt, schema: schema as Record<string, unknown>, deadlineMs: deadline }));
      for (const a of result.attempts) log("attempt", { id, agent: a.agent, status: a.status, ms: a.ms, exit_code: a.exitCode ?? null, error: a.error ?? null });
      log("run.end", { id, status: result.status, agent: result.status === "succeeded" ? result.agent : null });
      return json(result);
    }
    return json({ status: "not found" }, 404);
  },
});
