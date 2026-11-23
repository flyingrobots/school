// The settings page (flyingrobots/school#44): connect the bridge, see its status and agents, and
// reorder, switch on or off and test them through /api/settings/*. Agents' commands are written
// only in the bridge's file on its computer (flyingrobots/school#18), so nothing here edits one.
// The token is write-only: the page sends it and learns only whether one is set.
import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { BotIcon, InfoIcon, KeyRoundIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { Link } from "react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ItemActions, ItemContent, ItemDescription, ItemGroup, Item, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { SortableList, SortableListHandle, SortableListItem, SortableListItems, SortableListKeys } from "@/components/sortable-list"

gsap.registerPlugin(useGSAP)

type Source = "environment" | "settings" | "none"
type Bridge = { url: string | null; urlFrom: Source; tokenSet: boolean; tokenFrom: Source }
type Agent = { name: string; enabled: boolean; found: boolean }
type Connection = "none" | "unreachable" | "unauthorised" | "unconfigured" | "misconfigured" | "ok"
type Status = { connection: Connection; error?: string; config?: string; agents: Agent[] }
type Attempt = { agent: string; status: "succeeded" | "failed" | "skipped"; error?: string; exitCode?: number | null; ms: number }
type TestResult = { agent: string; status: string; error?: string; attempts: Attempt[] }

async function call(path: string, body?: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const json = (await res.json().catch(() => ({ error: `School answered ${res.status} with no JSON` }))) as Record<string, unknown>
    return { ok: res.ok, body: json }
  } catch (e) {
    return { ok: false, body: { error: e instanceof Error ? e.message : String(e) } }
  }
}

async function fetchSettings() {
  const [b, s] = await Promise.all([call("/api/settings/bridge"), call("/api/settings/status")])
  return { b, s }
}

const errorOf = (b: Record<string, unknown>) => (typeof b.error === "string" ? b.error : typeof b.status === "string" ? b.status : "something went wrong")

const connectionLabel: Record<Connection, string> = {
  none: "Not connected",
  unreachable: "Unreachable",
  unauthorised: "Token refused",
  unconfigured: "No agents yet",
  misconfigured: "File has a problem",
  ok: "Connected",
}

function connectionText(s: Status, url: string | null): string {
  switch (s.connection) {
    case "none":
      return "No bridge is connected. Enter the bridge's address and its token."
    case "unreachable":
      return `School could not reach the bridge at ${url ?? "its address"}: ${s.error ?? "no answer"}.`
    case "unauthorised":
      return "The bridge refused the token. Enter the token the bridge was started with, or generate one and restart the bridge with it."
    case "unconfigured":
      return `The bridge is connected but has no agents yet. Declare them in ${s.config ?? "its file"} on the bridge's computer.`
    case "misconfigured":
      return `The bridge's file ${s.config ?? ""} has a problem: ${s.error ?? "unknown"}.`
    case "ok":
      return s.agents.length === 0 ? "Connected. The bridge declares no agents." : "Connected. Agents are tried from the top; the first that answers grades."
  }
}

const envLock = (name: string) => `Set by ${name} in the server's environment, which overrides this page. Change it there.`

export function SettingsPage() {
  const scope = React.useRef<HTMLDivElement>(null)
  const [bridge, setBridge] = React.useState<Bridge | null>(null)
  const [status, setStatus] = React.useState<Status | null>(null)
  const [checking, setChecking] = React.useState(true)
  const [address, setAddress] = React.useState("")
  const [token, setToken] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [tokenCleared, setTokenCleared] = React.useState(false)
  const [generated, setGenerated] = React.useState<string | null>(null)
  const [agentError, setAgentError] = React.useState<string | null>(null)
  const [testing, setTesting] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<TestResult | null>(null)

  const apply = React.useCallback(({ b, s }: Awaited<ReturnType<typeof fetchSettings>>) => {
    if (b.ok) {
      const next = b.body as unknown as Bridge
      setBridge(next)
      setAddress(next.url ?? "")
    }
    setStatus(s.ok ? (s.body as unknown as Status) : { connection: "unreachable", error: errorOf(s.body), agents: [] })
    setChecking(false)
  }, [])

  const refresh = React.useCallback(async () => {
    setChecking(true)
    apply(await fetchSettings())
  }, [apply])

  React.useEffect(() => {
    let live = true
    void fetchSettings().then((r) => live && apply(r))
    return () => {
      live = false
    }
  }, [apply])

  useGSAP(
    () => {
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power2.out" } })
          .from("[data-animate=heading]", { y: 24, autoAlpha: 0, duration: 0.4 })
          .from("[data-animate=card]", { y: 16, autoAlpha: 0, duration: 0.3, stagger: 0.06 }, "-=0.2")
      })
    },
    { scope }
  )

  const urlLocked = bridge?.urlFrom === "environment" || bridge?.tokenFrom === "environment"
  const tokenLocked = bridge?.tokenFrom === "environment"
  const savedUrl = bridge?.url ?? ""
  const moving = !urlLocked && address.replace(/\/+$/, "") !== savedUrl && bridge?.tokenFrom === "settings" && token === ""

  async function save(body: Record<string, unknown>) {
    setSaving(true)
    setSaveError(null)
    const before = bridge
    const r = await call("/api/settings/bridge", body)
    setSaving(false)
    if (!r.ok) {
      setSaveError(errorOf(r.body))
      return
    }
    setToken("")
    setTokenCleared(Boolean(before?.tokenSet) && r.body.tokenSet === false && typeof body.url === "string" && body.url.replace(/\/+$/, "") !== (before?.url ?? ""))
    if (typeof r.body.generated === "string") setGenerated(r.body.generated)
    await refresh()
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    const body: Record<string, unknown> = {}
    if (!urlLocked) body.url = address.trim()
    if (!tokenLocked && token !== "") body.token = token
    void save(body)
  }

  const agents = status?.connection === "ok" ? status.agents : []
  const byName = new Map(agents.map((a) => [a.name, a]))

  async function saveAgents(next: Agent[]) {
    setAgentError(null)
    setStatus((s) => (s ? { ...s, agents: next } : s))
    const r = await call("/api/settings/agents", { agents: next.map(({ name, enabled }) => ({ name, enabled })) })
    if (r.ok && Array.isArray(r.body.agents)) setStatus((s) => (s ? { ...s, agents: r.body.agents as Agent[] } : s))
    else {
      setAgentError(errorOf(r.body))
      await refresh()
    }
  }

  async function test(name: string) {
    setTesting(name)
    setResult(null)
    const r = await call("/api/settings/agents/test", { agent: name })
    const attempts = Array.isArray(r.body.attempts) ? (r.body.attempts as Attempt[]) : []
    setResult({ agent: name, status: typeof r.body.status === "string" ? r.body.status : "failed", error: typeof r.body.error === "string" ? r.body.error : undefined, attempts })
    setTesting(null)
  }

  const config = status?.config

  return (
    <div ref={scope} className="flex w-full flex-col gap-8">
      <div data-animate="heading" className="flex flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList className="text-base">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/" data-nav>
                  Home
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Settings</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl 2xl:text-6xl">Settings</h1>
        <p className="max-w-none text-lg text-muted-foreground">
          The bridge runs the agents that grade your explanations, on your own computer. Connect it here, then choose the order its agents are tried in.
        </p>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2 2xl:grid-cols-4">
        <Card data-animate="card" data-settings="bridge" className="min-w-0 text-base">
          <CardHeader>
            <CardTitle className="text-2xl">Bridge</CardTitle>
            <CardDescription className="text-base">Where School finds the bridge, and the token it proves itself with.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {bridge === null ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : (
              <form onSubmit={onSubmit} className="flex flex-col gap-6">
                <FieldGroup>
                  <Field data-disabled={urlLocked}>
                    <FieldLabel htmlFor="bridge-address" className="text-base">
                      Bridge address
                    </FieldLabel>
                    <Input
                      id="bridge-address"
                      data-nav
                      className="h-11 text-base md:text-base"
                      inputMode="url"
                      placeholder="http://127.0.0.1:4748"
                      value={address}
                      disabled={urlLocked}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                    {bridge.urlFrom === "environment" ? (
                      <FieldDescription className="text-base">{envLock("SCHOOL_BRIDGE_URL")}</FieldDescription>
                    ) : bridge.tokenFrom === "environment" ? (
                      <FieldDescription className="text-base">
                        SCHOOL_BRIDGE_TOKEN is set in the server's environment, so the address can only be changed there too: set SCHOOL_BRIDGE_URL beside it.
                      </FieldDescription>
                    ) : moving ? (
                      <FieldDescription className="text-base">Saving a new address clears the saved token, so enter the token again with it.</FieldDescription>
                    ) : null}
                  </Field>
                  <Field data-disabled={tokenLocked}>
                    <FieldLabel htmlFor="bridge-token" className="text-base">
                      Token
                    </FieldLabel>
                    <Input
                      id="bridge-token"
                      data-nav
                      type="password"
                      autoComplete="off"
                      className="h-11 text-base md:text-base"
                      placeholder={bridge.tokenSet ? "A token is saved. Type a new one to replace it." : "At least 16 characters"}
                      value={token}
                      disabled={tokenLocked}
                      onChange={(e) => setToken(e.target.value)}
                    />
                    <FieldDescription className="text-base">
                      {tokenLocked ? envLock("SCHOOL_BRIDGE_TOKEN") : "The token the bridge was started with. Once saved it is never shown again."}
                    </FieldDescription>
                  </Field>
                </FieldGroup>
                {saveError && <FieldError className="text-base">{saveError}</FieldError>}
                <div className="flex flex-wrap gap-3">
                  <Button type="submit" size="lg" data-nav disabled={saving || (urlLocked && tokenLocked)}>
                    {saving && <Spinner />}
                    Save
                  </Button>
                  <Button type="button" size="lg" variant="outline" data-nav disabled={saving || tokenLocked} onClick={() => void save({ generate: true })}>
                    <KeyRoundIcon />
                    Generate a token
                  </Button>
                </div>
              </form>
            )}
            {tokenCleared && (
              <Alert data-settings="token-cleared">
                <TriangleAlertIcon />
                <AlertTitle className="text-base">The saved token was cleared</AlertTitle>
                <AlertDescription className="text-base">
                  The bridge's address changed, and a token is only ever sent to the address it was saved with. Enter the token again.
                </AlertDescription>
              </Alert>
            )}
            {generated && (
              <Alert data-settings="generated">
                <KeyRoundIcon />
                <AlertTitle className="text-base">Your new token, shown only now</AlertTitle>
                <AlertDescription className="flex flex-col gap-3 text-base">
                  <p>Start the bridge with SCHOOL_BRIDGE_TOKEN set to this token. School keeps it, but it will not show it again.</p>
                  <Input readOnly aria-label="New token" className="h-11 font-mono text-base md:text-base" value={generated} onFocus={(e) => e.target.select()} />
                  <Button type="button" variant="outline" className="self-start" data-nav onClick={() => setGenerated(null)}>
                    I have stored it
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card data-animate="card" data-settings="status" className="min-w-0 text-base 2xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-2xl">Connection and agents</CardTitle>
            <CardDescription className="text-base">What the bridge reports, and the order its agents are tried in.</CardDescription>
            <CardAction>
              <Button variant="outline" data-nav disabled={checking} onClick={() => void refresh()}>
                {checking ? <Spinner /> : <RefreshCwIcon />}
                Check again
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {status === null ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Badge variant={status.connection === "ok" ? "default" : status.connection === "none" ? "secondary" : "destructive"} className="h-7 px-3 text-sm">
                    {connectionLabel[status.connection]}
                  </Badge>
                  <p className="text-lg">{connectionText(status, bridge?.url ?? null)}</p>
                </div>
                {agents.length > 0 && (
                  <SortableList
                    value={agents.map((a) => a.name)}
                    onValueChange={(order) => void saveAgents(order.map((name) => byName.get(name)!))}
                  >
                    <SortableListItems aria-label="Agents">
                      {({ order }) =>
                        order.map((name) => {
                          const a = byName.get(name)
                          if (!a) return null
                          return (
                            <SortableListItem key={name} value={name} className="text-base">
                              <SortableListHandle value={name} aria-label={`Move ${name}`} data-nav />
                              <ItemContent>
                                <ItemTitle className="text-lg">{name}</ItemTitle>
                                <ItemDescription className="line-clamp-none text-base">
                                  {a.found ? "Its program was found on the bridge's computer." : "Its program was not found on the bridge's computer."}
                                </ItemDescription>
                              </ItemContent>
                              <ItemActions className="flex-wrap">
                                <Badge variant={a.found ? "secondary" : "destructive"}>{a.found ? "Found" : "Not found"}</Badge>
                                <Switch
                                  aria-label={`Use ${name}`}
                                  data-nav
                                  checked={a.enabled}
                                  onCheckedChange={(enabled) => void saveAgents(agents.map((x) => (x.name === name ? { ...x, enabled } : x)))}
                                />
                                <Button variant="outline" aria-label={`Test ${name}`} data-nav disabled={testing !== null} onClick={() => void test(name)}>
                                  {testing === name ? <Spinner /> : <BotIcon />}
                                  Test
                                </Button>
                              </ItemActions>
                            </SortableListItem>
                          )
                        })
                      }
                    </SortableListItems>
                    <SortableListKeys />
                  </SortableList>
                )}
                {agentError && <FieldError className="text-base">{agentError}</FieldError>}
                {config && (status.connection === "ok" || status.connection === "unconfigured" || status.connection === "misconfigured") && (
                  <Alert data-settings="commands">
                    <InfoIcon />
                    <AlertTitle className="text-base">Commands are edited on the bridge's computer</AlertTitle>
                    <AlertDescription className="text-base wrap-anywhere">
                      Each agent's command is written only in the bridge's file, {config}, on its computer. From here agents can be reordered, switched on or off, and tested.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card data-animate="card" data-settings="test-result" className="min-w-0 text-base xl:col-span-2 2xl:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <BotIcon aria-hidden="true" />
              Agent test
            </CardTitle>
            <CardDescription className="text-base">Testing an agent asks it, through the bridge, for one fixed answer, and shows each attempt.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {testing ? (
              <p className="flex items-center gap-2 text-lg">
                <Spinner />
                Testing {testing}…
              </p>
            ) : result === null ? (
              <p className="text-lg text-muted-foreground">Test an agent to see its attempts here.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-medium">{result.agent}</span>
                  <Badge variant={result.status === "succeeded" ? "default" : "destructive"} className="h-7 px-3 text-sm">
                    {result.status === "succeeded" ? "Succeeded" : "Failed"}
                  </Badge>
                </div>
                {result.error && <p className="text-base text-muted-foreground">{result.error}</p>}
                <ItemGroup aria-label="Attempts">
                  {result.attempts.map((a, i) => (
                    <Item key={`${a.agent}-${i}`} variant="outline" role="listitem" className="text-base">
                      <ItemContent>
                        <ItemTitle className="text-lg">{a.agent}</ItemTitle>
                        {a.error && <ItemDescription className="line-clamp-none font-mono text-sm wrap-anywhere">{a.error}</ItemDescription>}
                      </ItemContent>
                      <ItemActions className="flex-wrap">
                        <Badge variant={a.status === "succeeded" ? "default" : a.status === "skipped" ? "secondary" : "destructive"}>{a.status}</Badge>
                        <Badge variant="outline">{a.ms} ms</Badge>
                        {a.exitCode !== undefined && a.exitCode !== null && <Badge variant="outline">exit {a.exitCode}</Badge>}
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
