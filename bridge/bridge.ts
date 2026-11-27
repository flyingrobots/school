// The bridge: a separate process on the host that runs LLM agents for the School server
// (RFC 1 proposal 4). The server sends a prompt and a JSON schema; the bridge tries the
// learner's configured agents in order and returns the first answer that matches.
//
//   bun bridge/bridge.ts
//
// The token is SCHOOL_BRIDGE_TOKEN from the environment if it is set, else the macOS Keychain item
// `school up` stores, through @git-stunts/vault (host/secrets.ts, flyingrobots/school#123), so it is
// in no file and no argv. SCHOOL_KEYCHAIN_ACCOUNT names the Keychain account (default `school`).
//
// Configuration is a JSON file (SCHOOL_BRIDGE_CONFIG, default ~/.config/school/bridge.json),
// re-read on every request so an edit takes effect without a restart. Agents and their commands
// are declared only in that file; over HTTP they can be reordered, switched on and off, and
// tested, never given a command (flyingrobots/school#18). Logs are JSON Lines on
// stdout; they never contain a prompt or an answer, which are the learner's private work. Every
// failure is a `bridge.error` line too: a refusal to start (a bad setting, a taken port) exits 2,
// and any other uncaught throw or rejection exits 1 (flyingrobots/school#134).
import type { Server } from "bun";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BridgeConfigError, killAgents, loadConfig, runChain, type BridgeConfig } from "./run.ts";
import { runAsk, type AskResult } from "./ask.ts";
import { keychainStore } from "../host/keychain.ts";
import { accountFrom, resolveSecret } from "../host/secrets.ts";
import { lineWriter, loadSchemas } from "../server/jsonl.ts";
import { fileResponse, MAX_TEXT, NoSegment, NotOurs, socketPath, speech, SpeechRefused, SpeechUnavailable } from "./speech.ts";

// Every line names its published schema, `school.bridge.<kind>` in bridge/schemas/, carries the
// process's `run` id, and is scrubbed of the token (flyingrobots/school#135;
// docs/topics/program-output/README.md). `--help` and `--schema` print JSON Lines and exit without
// starting; `--human` (alias `--humanize`) prints prose instead; nothing else changes the format.
const schemas = loadSchemas(join(import.meta.dir, "schemas"));
const RUN = crypto.randomUUID();
const ARGS = process.argv.slice(2);
const FLAGS = ["--help", "-h", "--schema", "--human", "--humanize"];
const human = ARGS.includes("--human") || ARGS.includes("--humanize");
// The token from the environment now; the Keychain's, if that is where it comes from, once read.
const SECRETS = [process.env.SCHOOL_BRIDGE_TOKEN ?? ""];
const writer = lineWriter({ schemas, human, prose, secrets: SECRETS });
const log = (kind: string, fields: Record<string, unknown> = {}) =>
  writer.emit("stdout", `school.bridge.${kind}`, { kind: `bridge.${kind}`, at: new Date().toISOString(), ...fields, run: RUN });

/** A line as prose, for --human. */
function prose(l: Record<string, any>): string {
  switch (l.kind) {
    case "bridge.help":
      return [`bridge: ${l.summary}`, "", `usage: ${l.usage}`, "", "options:",
        ...l.options.map((o: { flags: string[]; description: string }) => `  ${o.flags.join(", ")}  ${o.description}`), "", "settings:",
        ...l.environment.map((e: { name: string; description: string }) => `  ${e.name}  ${e.description}`), "", "exit codes:",
        ...l.exit.map((e: { code: number; meaning: string }) => `  ${e.code}  ${e.meaning}`), "",
        "output: JSON Lines unless --human is given, each line one of these message types (--schema prints their schemas):",
        ...l.output.map((id: string) => `  ${id}`), "", `(run ${l.run})`].join("\n");
    case "bridge.schema": return `schema ${l.id} ${l.version}\n${JSON.stringify(l.schema, null, 2)}`;
    case "bridge.start": return `starting on ${l.host}:${l.port} with ${l.agents === null ? `no configuration yet (${l.config})` : `${l.agents.length} agents from ${l.config}`} (run ${l.run})`;
    case "bridge.listening": return `listening on ${l.host}:${l.port}`;
    case "bridge.config.saved": return `configuration saved: ${l.agents.join(", ")}`;
    case "bridge.test": return `test of ${l.agent}: ${l.status}`;
    case "bridge.run.start": return `run ${l.id} started`;
    case "bridge.attempt": return `run ${l.id}: ${l.agent} ${l.status} in ${l.ms} ms${l.error === null ? "" : ` (${l.error})`}`;
    case "bridge.run.end": return `run ${l.id} ${l.status}${l.agent === null ? "" : ` (${l.agent})`}`;
    case "bridge.ask.start": return `question ${l.id} started`;
    case "bridge.ask.attempt": return `question ${l.id}: ${l.agent} ${l.status} in ${l.ms} ms, ${l.deltas} deltas${l.error === null ? "" : ` (${l.error})`}`;
    case "bridge.ask.end": return `question ${l.id} ${l.status}${l.agent === null ? "" : ` (${l.agent})`}${l.usage === null ? "" : `, ${l.usage.input_tokens ?? "?"} tokens in, ${l.usage.output_tokens ?? "?"} out`}`;
    case "bridge.speak.submit": return `speech ${l.id} submitted to AI-TTS: ${l.segments ?? "an unknown number of"} segments`;
    case "bridge.speak.cancel": return `speech ${l.id} cancelled (${l.state ?? "no state"})`;
    case "bridge.speak.failed": return `speech ${l.op} ${l.status}: ${l.message}`;
    default: return `error: ${l.message}`;
  }
}

{
  const unknown = ARGS.filter((a) => !FLAGS.includes(a));
  if (unknown.length > 0) {
    log("error", { message: `unknown argument${unknown.length === 1 ? "" : "s"} ${unknown.join(" ")}; usage: bun bridge/bridge.ts [--help | --schema] [--human]` });
    process.exit(2);
  }
  const printSchemas = () => { for (const s of schemas.values()) log("schema", { id: s.id, version: s.version, schema: s.schema }); };
  if (ARGS.includes("--help") || ARGS.includes("-h")) {
    log("help", { command: "bridge", usage: "SCHOOL_BRIDGE_TOKEN=<shared secret> bun bridge/bridge.ts [--help | --schema] [--human]",
      summary: "Run the learner's configured LLM agents for the School server, over HTTP on the host, until stopped.",
      options: [
        { flags: ["--help", "-h"], description: "Print this help and the schema of every message type, then exit 0. Reads no setting and does not listen." },
        { flags: ["--schema"], description: "Print every published message schema, then exit 0. Reads no setting and does not listen." },
        { flags: ["--human", "--humanize"], description: "Print prose instead of JSON Lines. Nothing else switches the format." },
      ],
      environment: [
        { name: "SCHOOL_BRIDGE_TOKEN", description: "The shared secret the server sends, at least 16 characters; if unset, read from the macOS Keychain. Never printed." },
        { name: "SCHOOL_BRIDGE_CONFIG", description: "The agents file, re-read on every request. Default ~/.config/school/bridge.json." },
        { name: "SCHOOL_BRIDGE_HOST", description: "The address to listen on. Default 127.0.0.1." },
        { name: "SCHOOL_BRIDGE_PORT", description: "The port to listen on; 0 lets the OS choose. Default 4748." },
        { name: "AI_TTS_SOCKET", description: "The AI-TTS daemon's Unix socket, for reading aloud. Default $AI_TTS_HOME/ai-tts.sock." },
        { name: "AI_TTS_HOME", description: "The AI-TTS daemon's folder, when AI_TTS_SOCKET is unset. Default ~/Library/Application Support/ai-tts." },
      ],
      exit: [
        { code: 0, meaning: "--help or --schema printed; or stopped." },
        { code: 1, meaning: "An uncaught throw or rejection after start-up." },
        { code: 2, meaning: "Refused to start: an unknown argument, a bad setting, an unreadable configuration file, or a port it cannot listen on." },
      ],
      output: [...schemas.keys()] });
    if (!human) printSchemas();
    process.exit(0);
  }
  if (ARGS.includes("--schema")) {
    printSchemas();
    process.exit(0);
  }
}

const configPath = process.env.SCHOOL_BRIDGE_CONFIG ?? join(homedir(), ".config", "school", "bridge.json");
const host = process.env.SCHOOL_BRIDGE_HOST ?? "127.0.0.1";
const port = Number(process.env.SCHOOL_BRIDGE_PORT ?? 4748);

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function exit(message: string, fields: Record<string, unknown> = {}): never {
  log("error", { message, ...fields });
  process.exit(2);
}

// The top-level handler: whatever escapes is one error line and a non-zero exit, never Bun's own
// uncaught-error output. Only the message is logged; a stack could quote the learner's work.
const crash = (e: unknown) => {
  log("error", { message: messageOf(e) });
  process.exit(1);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

// Stopping: every agent leads its own process group, so the signal that stops the bridge never
// reaches one. Kill each live agent's group, then exit, all in this one turn: no queued grading or
// question can start an agent in between (flyingrobots/school#286).
const stop = () => {
  killAgents();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

let token = "";
let tokenFrom = "";
{
  let account = "";
  try {
    account = accountFrom(process.env);
    const found = resolveSecret("SCHOOL_BRIDGE_TOKEN", process.env, () => keychainStore(account));
    if (found !== null) [token, tokenFrom] = [found.value, found.from];
    SECRETS.push(token);
  } catch (e) {
    exit(`cannot read SCHOOL_BRIDGE_TOKEN from the Keychain${account === "" ? "" : ` (account ${account})`}: ${messageOf(e)}`);
  }
  if (token === "") exit(`SCHOOL_BRIDGE_TOKEN is in neither the environment nor the Keychain (account ${account}): run \`./school up\`, which stores the token the server uses, or set SCHOOL_BRIDGE_TOKEN`);
}
if (token.length < 16) exit("set SCHOOL_BRIDGE_TOKEN to a shared secret of at least 16 characters; the server sends the same one");
// Port 0 asks the OS for a free port; the `bridge.listening` line says which one it got.
if (!Number.isInteger(port) || port < 0 || port > 65535) exit(`SCHOOL_BRIDGE_PORT ${process.env.SCHOOL_BRIDGE_PORT} is not a port`);

/** The configuration file as written (commands as the learner typed them), or null if there is none yet. */
function rawConfig(): Record<string, unknown> | null {
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new BridgeConfigError(`${configPath} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** The checked configuration, or null when none has been written yet. Only the learner writes one, on this computer. */
function config(): BridgeConfig | null {
  const raw = rawConfig();
  return raw === null ? null : loadConfig(raw);
}

/** Replace the configuration file atomically: a half-written file is never what the next run reads. */
function saveConfig(raw: unknown): BridgeConfig {
  const checked = loadConfig(raw); // throws, and nothing is written, if the configuration is invalid
  mkdirSync(dirname(configPath), { recursive: true });
  const temp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
  renameSync(temp, configPath);
  return checked;
}

class OrderError extends Error {}
const ONLY = `agent commands and settings are set only in ${configPath} on this computer; over HTTP agents can only be reordered and switched on or off`;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The file's configuration with its declared agents in a new order and switched on or off as
 * `body` says (flyingrobots/school#18). Every agent must be named exactly once, and nothing but
 * a name and `enabled` may be sent: every command, and every other field, stays as written.
 */
function reorder(file: Record<string, unknown>, body: unknown): Record<string, unknown> {
  if (!isObject(body) || !Array.isArray(body.agents)) throw new OrderError('send { "agents": [{ "name": ..., "enabled": true }] }');
  if (Object.keys(body).some((k) => k !== "agents")) throw new OrderError(ONLY);
  const declared = new Map<string, Record<string, unknown>>();
  for (const a of (Array.isArray(file.agents) ? file.agents : []) as unknown[]) if (isObject(a) && typeof a.name === "string") declared.set(a.name, a);
  const seen = new Set<string>();
  const agents = (body.agents as unknown[]).map((a) => {
    if (!isObject(a) || typeof a.name !== "string") throw new OrderError('each agent is named by its "name"');
    if (Object.keys(a).some((k) => k !== "name" && k !== "enabled")) throw new OrderError(ONLY);
    const was = declared.get(a.name);
    if (was === undefined) throw new OrderError(`no agent "${a.name}" is declared in ${configPath}`);
    if (seen.has(a.name)) throw new OrderError(`agent "${a.name}" is named twice`);
    seen.add(a.name);
    if (a.enabled !== undefined && typeof a.enabled !== "boolean") throw new OrderError(`agent "${a.name}": "enabled" is true or false`);
    return a.enabled === undefined ? was : { ...was, enabled: a.enabled };
  });
  const left = [...declared.keys()].filter((n) => !seen.has(n));
  if (left.length > 0) throw new OrderError(`name every declared agent; missing ${left.map((n) => JSON.stringify(n)).join(", ")}`);
  return { ...file, agents };
}

try {
  const c = config();
  log("start", { host, port, config: configPath, agents: c === null ? null : c.agents.map((a) => ({ name: a.name, enabled: a.enabled, program: a.argv[0] })) });
} catch (e) {
  exit(e instanceof Error ? e.message : String(e));
}

const found = (program: string) => (program.includes("/") ? existsSync(program) : Bun.which(program) !== null);

const json = (body: unknown, status = 200) => Response.json(body, { status });
const authorised = (req: Request) => {
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${token}`;
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
};

// One chain at a time: agents are heavy, and a single learner never needs two at once. Questions
// have a queue of their own (RFC 6 §5.4), so a question never waits behind a three-minute grading.
const queue = () => {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };
};
const serially = queue();
const askSerially = queue();

const MAX_PROMPT = 200_000;

/**
 * POST /ask (RFC 6 Table 5.4): `{ prompt, deadline_ms }` in; NDJSON out, a `delta` line for each
 * piece of the answer as the agent writes it, then one `end` line with the status, the agent, its
 * token counts and every attempt. A refusal before anything runs is a JSON status, as on /run.
 */
async function askRoute(req: Request, server: Server<unknown>): Promise<Response> {
  if (req.method !== "POST") return json({ status: "method not allowed" }, 405);
  if (!isJsonRequest(req)) return json({ status: "expected application/json" }, 415);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ status: "invalid", error: "body is not JSON" }, 400);
  }
  const { prompt, deadline_ms } = isObject(body) ? body : {};
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_PROMPT) return json({ status: "invalid", error: `prompt must be 1 to ${MAX_PROMPT} characters` }, 400);
  if (deadline_ms !== undefined && (typeof deadline_ms !== "number" || !Number.isInteger(deadline_ms) || deadline_ms <= 0)) return json({ status: "invalid", error: "deadline_ms must be a positive integer" }, 400);

  let failure: string | null = null;
  let c: BridgeConfig | null = null;
  try {
    c = config();
  } catch (e) {
    failure = messageOf(e);
  }
  if (failure === null && (c === null || c.ask === null)) failure = `the bridge has no ask agents configured yet; declare an "ask" list in ${configPath}`;
  // The answer takes as long as its agents' timeouts allow; Bun's idle timeout must not end it first.
  server.timeout(req, 0);
  const id = crypto.randomUUID();
  const caller = new AbortController();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(out) {
      const send = (line: Record<string, unknown>) => {
        try { out.enqueue(encoder.encode(JSON.stringify(line) + "\n")); } catch {} // the caller has gone
      };
      const finish = (r: AskResult) => {
        for (const a of r.attempts) log("ask.attempt", { id, agent: a.agent, status: a.status, ms: a.ms, exit_code: a.exitCode, error: a.error, deltas: a.deltas });
        const deltas = r.attempts.reduce((n, a) => n + a.deltas, 0);
        const usage = r.status === "succeeded" ? r.usage : null;
        log("ask.end", { id, status: r.status, agent: r.agent, deltas, usage });
        send({ type: "end", status: r.status, agent: r.agent, usage, error: r.status === "failed" ? r.error : null,
          attempts: r.attempts.map((a) => ({ agent: a.agent, status: a.status, ms: a.ms, exit_code: a.exitCode, error: a.error, deltas: a.deltas })) });
        try { out.close(); } catch {}
      };
      log("ask.start", { id });
      if (failure !== null) return finish({ status: "failed", agent: null, error: failure, attempts: [] });
      const ask = c!.ask!;
      askSerially(() => runAsk(ask, { prompt, deadlineMs: deadline_ms, signal: caller.signal }, (text) => send({ type: "delta", text })))
        .then(finish, (e: unknown) => {
          log("error", { message: messageOf(e) });
          finish({ status: "failed", agent: null, error: "the bridge failed on this question; its log has the reason", attempts: [] });
        });
    },
    cancel() {
      caller.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}

// Reading aloud (flyingrobots/school#175): the AI-TTS daemon synthesizes, School's page plays. The
// socket is resolved at each request, so starting AI-TTS after the bridge needs no restart.
const voice = speech(() => socketPath(process.env));

/** The /speak routes' answer, or null for any other path. The text is never logged. */
async function speakRoute(req: Request, pathname: string): Promise<Response | null> {
  const m = /^\/speak(?:\/([^/]+)(?:\/(segments\/([^/]+)|cancel))?)?$/.exec(pathname);
  if (m === null) return null;
  const [, id, tail, n] = m;
  const op = id === undefined ? "submit" : tail === undefined ? "get" : tail === "cancel" ? "cancel" : "segment";
  const allowed = op === "submit" || op === "cancel" ? "POST" : "GET";
  if (req.method !== allowed) return json({ status: "method not allowed" }, 405);
  try {
    if (op === "submit") {
      if (!isJsonRequest(req)) return json({ status: "expected application/json" }, 415);
      const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
      const text = body?.text;
      if (typeof text !== "string" || text.trim() === "" || text.includes("\u0000") || Buffer.byteLength(text) > MAX_TEXT) {
        return json({ status: "invalid", error: `text must be words to speak, at most ${MAX_TEXT} bytes` }, 400);
      }
      const r = await voice.submit(text);
      log("speak.submit", { id: r.id, state: r.state, segments: r.segments });
      return json(r);
    }
    if (op === "get") return json(await voice.progress(id!), 200);
    if (op === "cancel") {
      const r = await voice.cancel(id!);
      log("speak.cancel", { id: r.id, state: r.state });
      return json(r);
    }
    if (!/^[0-9]{1,6}$/.test(n!)) return json({ status: "not found", error: "a segment is numbered from 0" }, 404);
    // Ownership first: a foreign utterance is a 403 whatever segment is asked for.
    const file = await voice.segmentFile(id!, Number(n));
    return fileResponse(file, req.headers.get("range"), "audio/wav");
  } catch (e) {
    if (e instanceof NotOurs) return json({ status: "forbidden", error: e.message }, 403);
    if (e instanceof NoSegment) return json({ status: e.notReady ? "not ready" : "not found", error: e.message }, e.notReady ? 409 : 404);
    if (e instanceof SpeechUnavailable) {
      log("speak.failed", { op, status: "unavailable", message: e.message });
      return json({ status: "unavailable", error: e.message }, 503);
    }
    if (e instanceof SpeechRefused) {
      log("speak.failed", { op, status: "refused", message: e.message });
      return json({ status: e.type === "not_found" ? "gone" : "refused", error: e.message }, e.type === "not_found" ? 404 : 502);
    }
    throw e;
  }
}

const isJsonRequest = (r: Request) => (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

function listen(options: Parameters<typeof Bun.serve>[0]) {
  try {
    return Bun.serve(options);
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (code === "EADDRINUSE") exit(`${host}:${port} is already in use; stop what holds it or set SCHOOL_BRIDGE_PORT to another port`, { host, port, code });
    exit(`could not listen on ${host}:${port} (${messageOf(e)})`, { host, port, code: typeof code === "string" ? code : null });
  }
}

const server = listen({
  hostname: host,
  port,
  idleTimeout: 255,
  // A request handler's throw is a line and a 500, not Bun's error page and stack on stderr.
  error(e) {
    log("error", { message: messageOf(e) });
    return json({ status: "failed", error: "the bridge failed on this request; its log has the reason" }, 500);
  },
  async fetch(req, server) {
    const { pathname } = new URL(req.url);
    if (!authorised(req)) return json({ status: "unauthorised" }, 401);
    if (pathname === "/ask") return askRoute(req, server);
    if (req.method === "GET" && pathname === "/health") {
      try {
        const c = config();
        if (c === null) return json({ status: "unconfigured", config: configPath, agents: [] });
        return json({ status: "ok", config: configPath, agents: c.agents.map((a) => ({ name: a.name, enabled: a.enabled, found: found(a.argv[0]!) })) });
      } catch (e) {
        return json({ status: "misconfigured", config: configPath, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    if (req.method === "GET" && pathname === "/config") {
      try {
        const raw = rawConfig();
        return json({ status: raw === null ? "unconfigured" : "ok", config: configPath, raw: raw ?? { timeout_seconds: 180, agents: [] } });
      } catch (e) {
        return json({ status: "misconfigured", config: configPath, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }
    const isJson = (r: Request) => (r.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
    if (req.method === "PUT" && pathname === "/config") {
      if (!isJson(req)) return json({ status: "expected application/json" }, 415);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ status: "invalid", error: "body is not JSON" }, 400);
      }
      let file: Record<string, unknown> | null;
      try {
        file = rawConfig();
        if (file !== null) loadConfig(file);
      } catch (e) {
        return json({ status: "misconfigured", config: configPath, error: e instanceof Error ? e.message : String(e) }, 409);
      }
      if (file === null) return json({ status: "unconfigured", config: configPath, error: `declare the agents in ${configPath} on the bridge's computer first` }, 409);
      try {
        const c = saveConfig(reorder(file, body));
        log("config.saved", { config: configPath, agents: c.agents.map((a) => a.name) });
        return json({ status: "saved", agents: c.agents.map((a) => ({ name: a.name, enabled: a.enabled, found: found(a.argv[0]!) })) });
      } catch (e) {
        if (e instanceof OrderError || e instanceof BridgeConfigError) return json({ status: "invalid", error: e.message }, 400);
        throw e;
      }
    }
    if (req.method === "POST" && pathname === "/test") {
      if (!isJson(req)) return json({ status: "expected application/json" }, 415);
      const body = (await req.json().catch(() => null)) as { agent?: unknown } | null;
      let c: BridgeConfig | null;
      try {
        c = config();
      } catch (e) {
        return json({ status: "failed", error: e instanceof Error ? e.message : String(e), attempts: [] });
      }
      const agent = c?.agents.find((a) => a.name === body?.agent);
      if (agent === undefined) return json({ status: "invalid", error: "no agent by that name" }, 404);
      // One agent, forced on, with a prompt that has exactly one right answer.
      const result = await serially(() => runChain({ timeoutMs: agent.timeoutMs, agents: [{ ...agent, enabled: true }] }, {
        prompt: 'This is a connection test. Reply with exactly this JSON object and nothing else: {"ok": true}',
        schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
      }));
      log("test", { agent: agent.name, status: result.status });
      return json(result);
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
      let c: BridgeConfig | null;
      try {
        c = config();
      } catch (e) {
        return json({ status: "failed", error: e instanceof Error ? e.message : String(e), attempts: [] });
      }
      if (c === null) return json({ status: "failed", error: `the bridge has no agents configured yet; declare them in ${configPath}`, attempts: [] });
      const id = crypto.randomUUID();
      log("run.start", { id });
      const result = await serially(() => runChain(c!, { prompt, schema: schema as Record<string, unknown>, deadlineMs: deadline }));
      for (const a of result.attempts) log("attempt", { id, agent: a.agent, status: a.status, ms: a.ms, exit_code: a.exitCode ?? null, error: a.error ?? null });
      log("run.end", { id, status: result.status, agent: result.status === "succeeded" ? result.agent : null });
      return json(result);
    }
    const spoken = await speakRoute(req, pathname);
    if (spoken !== null) return spoken;
    return json({ status: "not found" }, 404);
  },
});
log("listening", { host, port: server.port, tokenFrom });
