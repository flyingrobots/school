import * as React from "react"
import { z } from "zod"

export type Load<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  // No usable answer: unreachable, or the wrong shape. `reason` is the server's, when it gave one.
  | { kind: "failed"; reason: string | null }

/** GET `url`, checked with `schema`, and a function that asks again. */
export function useJson<T>(
  url: string,
  schema: z.ZodType<T>
): [Load<T>, () => void] {
  const [attempt, setAttempt] = React.useState(0)
  const [answer, setAnswer] = React.useState<{
    attempt: number
    load: Load<T>
  } | null>(null)

  React.useEffect(() => {
    const abort = new AbortController()
    const settle = (load: Load<T>) =>
      abort.signal.aborted || setAnswer({ attempt, load })
    ;(async (): Promise<Load<T>> => {
      const res = await fetch(url, { signal: abort.signal })
      const body: unknown = await res.json()
      if (!res.ok) {
        const reason = z.object({ error: z.string() }).safeParse(body)
        return {
          kind: "failed",
          reason: reason.success ? reason.data.error : null,
        }
      }
      const parsed = schema.safeParse(body)
      return parsed.success
        ? { kind: "ready", data: parsed.data }
        : { kind: "failed", reason: null }
    })().then(settle, () => settle({ kind: "failed", reason: null }))
    return () => abort.abort()
  }, [url, schema, attempt])

  return [
    answer?.attempt === attempt ? answer.load : { kind: "loading" },
    () => setAttempt((n) => n + 1),
  ]
}
