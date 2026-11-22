// What School's settings page may send the bridge about its agents (flyingrobots/school#18). An
// agent's command runs on the bridge's computer, so it is written only in the bridge's own file
// there. The page may reorder the declared agents, switch them on and off, and test one. These
// functions rebuild a request from exactly those fields, so nothing else can be passed through,
// whatever the bridge on the other end would accept. The bridge checks the same rule itself.

export type AgentOrder = { agents: { name: string; enabled?: boolean }[] };

const ONLY = "agent commands and settings are set only in the bridge's own file on its computer; from here agents can only be reordered, switched on or off, and tested";

const keysWithin = (o: object, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ agents: [{ name, enabled? }] }`, rebuilt from the body, or why the body is refused. */
export function agentOrder(body: unknown): AgentOrder | { error: string } {
  if (!isObject(body) || !Array.isArray(body.agents)) return { error: 'send { "agents": [{ "name": ..., "enabled": true }] }' };
  if (!keysWithin(body, ["agents"])) return { error: ONLY };
  const agents: AgentOrder["agents"] = [];
  for (const a of body.agents as unknown[]) {
    if (!isObject(a) || typeof a.name !== "string") return { error: "each agent is named by its \"name\"" };
    if (!keysWithin(a, ["name", "enabled"])) return { error: ONLY };
    if (a.enabled !== undefined && typeof a.enabled !== "boolean") return { error: `agent "${a.name}": "enabled" is true or false` };
    agents.push(a.enabled === undefined ? { name: a.name } : { name: a.name, enabled: a.enabled });
  }
  return { agents };
}

/** `{ agent }`, rebuilt from the body, or why the body is refused. */
export function agentTest(body: unknown): { agent: string } | { error: string } {
  if (!isObject(body) || typeof body.agent !== "string") return { error: 'send { "agent": "<a declared agent\'s name>" }' };
  if (!keysWithin(body, ["agent"])) return { error: ONLY };
  return { agent: body.agent };
}
