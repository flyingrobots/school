// School's settings API, as the settings page uses it (server/server.ts, server/settings.ts).
// Every reply is parsed with Zod before the page reads it, so a reply of the wrong shape is the
// page's error state, never a status it shows. The token is write-only: no reply carries it,
// except the one that generates it.
import { z } from "zod"

const Source = z.enum(["environment", "settings", "none"])

export const Bridge = z.object({
  url: z.string().nullable(),
  urlFrom: Source,
  tokenSet: z.boolean(),
  tokenFrom: Source,
})
export type Bridge = z.infer<typeof Bridge>

export const Agent = z.object({
  name: z.string(),
  enabled: z.boolean(),
  found: z.boolean(),
})
export type Agent = z.infer<typeof Agent>

export const Status = z.object({
  connection: z.enum([
    "none",
    "unreachable",
    "unauthorised",
    "unconfigured",
    "misconfigured",
    "ok",
  ]),
  error: z.string().optional(),
  config: z.string().optional(),
  agents: z.array(Agent),
})
export type Status = z.infer<typeof Status>
export type Connection = Status["connection"]

const Saved = z.object({
  status: z.literal("saved"),
  tokenSet: z.boolean(),
  generated: z.string().optional(),
})
export type Saved = z.infer<typeof Saved>

const SavedAgents = z.object({
  status: z.literal("saved"),
  agents: z.array(Agent),
})

const Attempt = z.object({
  agent: z.string(),
  status: z.enum(["succeeded", "failed", "skipped"]),
  error: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  ms: z.number(),
})
export type Attempt = z.infer<typeof Attempt>

const Tested = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    agent: z.string(),
    attempts: z.array(Attempt),
  }),
  z.object({
    status: z.literal("failed"),
    error: z.string(),
    attempts: z.array(Attempt),
  }),
])
export type Tested = z.infer<typeof Tested>

/** What a refusal says: School's own `{ status, error }`, or the bridge's passed through. */
const Refusal = z.object({
  status: z.string().optional(),
  error: z.string().optional(),
})

/** A request that did not do what was asked, and why, in words the page can show. */
export class SettingsError extends Error {}

async function request<T>(
  path: string,
  reply: z.ZodType<T>,
  body?: unknown
): Promise<T> {
  let res: Response
  try {
    res = await fetch(
      path,
      body === undefined
        ? { headers: { accept: "application/json" } }
        : {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify(body),
          }
    )
  } catch {
    throw new SettingsError("School could not be reached.")
  }
  const json: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const refusal = Refusal.safeParse(json)
    throw new SettingsError(
      refusal.success && (refusal.data.error ?? refusal.data.status)
        ? (refusal.data.error ?? refusal.data.status)!
        : `School answered ${res.status}.`
    )
  }
  const parsed = reply.safeParse(json)
  if (!parsed.success)
    throw new SettingsError(
      `School's reply to ${path} was not what the page expects.`
    )
  return parsed.data
}

export type Read<T> = { ok: true; value: T } | { ok: false; error: string }

const settle = <T>(p: Promise<T>): Promise<Read<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (e: unknown) => ({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    })
  )

/** The bridge's settings and its status, read together; each is its value or why it could not be read. */
export async function readSettings(): Promise<{
  bridge: Read<Bridge>
  status: Read<Status>
}> {
  const [bridge, status] = await Promise.all([
    settle(request("/api/settings/bridge", Bridge)),
    settle(request("/api/settings/status", Status)),
  ])
  return { bridge, status }
}

export const saveBridge = (body: {
  url?: string
  token?: string
  generate?: true
}) => request("/api/settings/bridge", Saved, body)

export const saveAgents = (agents: Pick<Agent, "name" | "enabled">[]) =>
  request("/api/settings/agents", SavedAgents, {
    agents: agents.map(({ name, enabled }) => ({ name, enabled })),
  }).then((r) => r.agents)

export const testAgent = (agent: string) =>
  request("/api/settings/agents/test", Tested, { agent })
