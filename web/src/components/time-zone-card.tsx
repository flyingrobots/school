// The learner's time zone (flyingrobots/school#181): Automatic, the zone this browser sends, or one
// chosen here, which School keeps in its record and uses on every device until set back.
import * as React from "react"
import { GlobeIcon } from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { learnerZone } from "@/lib/zone"

const AUTOMATIC = "Automatic"
const ZONES = [AUTOMATIC, ...Intl.supportedValuesOf("timeZone")]

type State =
  | { kind: "loading" }
  | { kind: "ready"; zone: string | null; saved: boolean }
  | { kind: "failed"; reason: string }

export function TimeZoneCard({ className }: { className?: string }) {
  const [state, setState] = React.useState<State>({ kind: "loading" })
  const browser = learnerZone()

  React.useEffect(() => {
    let live = true
    fetch("/api/settings/time-zone")
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((b: { zone: string | null }) => {
        if (live) setState({ kind: "ready", zone: b.zone, saved: false })
      })
      .catch((e: Error) => {
        if (live) setState({ kind: "failed", reason: e.message })
      })
    return () => {
      live = false
    }
  }, [])

  const choose = async (value: string | null) => {
    if (value === null) return
    const zone = value === AUTOMATIC ? null : value
    const r = await fetch("/api/settings/time-zone", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ zone }),
    })
    if (r.ok) setState({ kind: "ready", zone, saved: true })
    else setState({ kind: "failed", reason: `HTTP ${r.status}` })
  }

  return (
    <Card
      data-animate="card"
      data-settings="time-zone"
      className={`min-w-0 text-base ${className ?? ""}`}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-2xl">
          <GlobeIcon aria-hidden="true" />
          Time zone
        </CardTitle>
        <CardDescription className="text-base">
          School names days in this zone: the days you studied, and the days
          questions come back.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.kind === "loading" && <Skeleton className="h-10 w-full" />}
        {state.kind === "failed" && (
          <p className="text-base text-muted-foreground">
            The time zone could not be loaded ({state.reason}).
          </p>
        )}
        {state.kind === "ready" && (
          <Field>
            <FieldLabel htmlFor="time-zone">Time zone</FieldLabel>
            <Combobox
              items={ZONES}
              value={state.zone ?? AUTOMATIC}
              onValueChange={(v) => void choose(v as string | null)}
            >
              <ComboboxInput id="time-zone" aria-label="Time zone" />
              <ComboboxContent>
                <ComboboxEmpty>No zone has that name.</ComboboxEmpty>
                <ComboboxList>
                  {(item: string) => (
                    <ComboboxItem key={item} value={item}>
                      {item}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <FieldDescription className="text-base">
              {state.zone === null
                ? `Automatic: ${browser}, from this browser`
                : state.saved
                  ? `Saved: School names days in ${state.zone}`
                  : `School names days in ${state.zone}, on every device`}
            </FieldDescription>
          </Field>
        )}
      </CardContent>
    </Card>
  )
}
