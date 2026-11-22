// Settings chosen on School's settings page (flyingrobots/school#13), kept in the learner's
// private state directory as settings.json. Today they say how to reach the bridge. An
// environment variable always wins over a saved value, so a deployment can pin one; the page
// shows which source each value came from. The token is write-only: the page learns only
// whether one is set.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BridgeClientConfig } from "./grade.ts";

export type Saved = { bridge?: { url?: string; token?: string } };
export type Source = "environment" | "settings" | "none";
export type Effective = { url: string | null; token: string | null; urlFrom: Source; tokenFrom: Source };

export const settingsFile = (state: string) => join(state, "settings.json");

export function loadSettings(file: string): Saved {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return typeof v === "object" && v !== null ? (v as Saved) : {};
  } catch {
    return {}; // an unreadable file is reported on the page as "not configured", never fatal
  }
}

/** Write atomically and privately: the token is in this file. */
export function saveSettings(file: string, s: Saved): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

export function effectiveBridge(env: Record<string, string | undefined>, saved: Saved): Effective {
  const pick = (e: string | undefined, s: string | undefined): [string | null, Source] =>
    e !== undefined && e !== "" ? [e, "environment"] : s !== undefined && s !== "" ? [s, "settings"] : [null, "none"];
  const [url, urlFrom] = pick(env.SCHOOL_BRIDGE_URL, saved.bridge?.url);
  const [token, tokenFrom] = pick(env.SCHOOL_BRIDGE_TOKEN, saved.bridge?.token);
  return { url: url?.replace(/\/+$/, "") ?? null, token, urlFrom, tokenFrom };
}

/** What the grading client needs, or null when the bridge is not fully configured. */
export function bridgeClient(e: Effective, deadlineMs: number): BridgeClientConfig | null {
  return e.url === null || e.token === null ? null : { url: e.url, token: e.token, deadlineMs };
}

export const validUrl = (u: string) => /^https?:\/\/[^\s/]+/.test(u);
export const validToken = (t: string) => t.length >= 16 && !/\s/.test(t);

export type BridgeStatus = {
  connection: "none" | "unreachable" | "unauthorised" | "unconfigured" | "misconfigured" | "ok";
  error?: string;
  config?: string;
  agents: { name: string; enabled: boolean; found: boolean }[];
};

/** Ask the bridge for its health. Never throws; every failure is a status the page can show. */
export async function bridgeStatus(c: BridgeClientConfig | null): Promise<BridgeStatus> {
  if (c === null) return { connection: "none", agents: [] };
  let res: Response;
  try {
    res = await fetch(`${c.url}/health`, { headers: { authorization: `Bearer ${c.token}` }, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    return { connection: "unreachable", error: e instanceof Error ? e.message : String(e), agents: [] };
  }
  if (res.status === 401) return { connection: "unauthorised", agents: [] };
  const body = (await res.json().catch(() => ({}))) as Partial<BridgeStatus> & { status?: string };
  const agents = Array.isArray(body.agents) ? body.agents : [];
  const config = typeof body.config === "string" ? body.config : undefined;
  if (body.status === "ok") return { connection: "ok", config, agents };
  if (body.status === "unconfigured") return { connection: "unconfigured", config, agents: [] };
  return { connection: "misconfigured", config, error: typeof body.error === "string" ? body.error : `HTTP ${res.status}`, agents: [] };
}

/** Pass a settings request through to the bridge: its status code and JSON body, or a 502 describing why it could not be reached. */
export async function toBridge(c: BridgeClientConfig | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  if (c === null) return { status: 409, body: { status: "no bridge", error: "connect a bridge first" } };
  try {
    const res = await fetch(`${c.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${c.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(method === "POST" ? c.deadlineMs : 10_000),
    });
    if (res.status === 401) return { status: 502, body: { status: "unauthorised", error: "the bridge refused the token" } };
    return { status: res.status, body: await res.json().catch(() => ({ status: "invalid", error: "the bridge's reply was not JSON" })) };
  } catch (e) {
    return { status: 502, body: { status: "unreachable", error: e instanceof Error ? e.message : String(e) } };
  }
}
