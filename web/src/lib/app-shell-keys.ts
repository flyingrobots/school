import * as React from "react"
import { registerShortcut, useShortcut } from "@ui-sdk/react/shortcuts"

export const apple =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
const mod = apple ? "⌘" : "Ctrl"
export const modAria = apple ? "Meta" : "Control"

export const appKeys = {
  palette: [mod, "K"],
  paletteLeader: ["Space", "Space"],
  move: ["h", "j", "k", "l"],
  arrows: ["←", "↓", "↑", "→"],
  sidebar: [mod, "B"],
  close: ["Esc"],
  choose: ["↑", "↓"],
  run: ["↵"],
} as const

export const LEADER_TIMEOUT = 1500

export type Direction = "up" | "down" | "left" | "right"

const lastIn = new WeakMap<Element, HTMLElement>()

function items(region: Element): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>("[data-nav]")].filter(
    (el) => el.getClientRects().length > 0
  )
}

function regions(root: ParentNode): HTMLElement[] {
  // A collapsed desktop sidebar is off screen, so its items are skipped.
  return [...root.querySelectorAll<HTMLElement>("[data-nav-region]")].filter(
    (r) => !r.closest("[data-state=collapsed]") && items(r).length > 0
  )
}

function focus(region: Element, el: HTMLElement | undefined) {
  if (!el) return
  lastIn.set(region, el)
  el.focus()
}

export function rememberFocus(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return
  const item = target.closest<HTMLElement>("[data-nav]")
  const region = item?.closest("[data-nav-region]")
  if (item && region) lastIn.set(region, item)
}

export function moveFocus(direction: Direction, root: ParentNode = document) {
  const all = regions(root)
  if (all.length === 0) return
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const region = all.find((r) => active && r.contains(active))
  const back = (r: Element) => {
    const last = lastIn.get(r)
    return last && last.isConnected && items(r).includes(last)
      ? last
      : items(r)[0]
  }
  if (!region) {
    const start = all.find((r) => r.dataset.navRegion === "main") ?? all[0]!
    return focus(start, back(start))
  }
  if (direction === "left" || direction === "right") {
    const next = all[all.indexOf(region) + (direction === "left" ? -1 : 1)]
    if (next) focus(next, back(next))
    return
  }
  const list = items(region)
  const at = list.indexOf(active!.closest<HTMLElement>("[data-nav]")!)
  const to =
    at === -1
      ? 0
      : Math.min(
          Math.max(at + (direction === "down" ? 1 : -1), 0),
          list.length - 1
        )
  focus(region, list[to])
}

const overlayOpen = () =>
  document.querySelector(
    "[role=dialog][data-state=open], [role=menu][data-state=open], [role=alertdialog][data-state=open]"
  ) !== null

function typing(target: EventTarget | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (
    target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
    return true
  return (
    target.tagName === "INPUT" &&
    !/^(button|checkbox|radio|submit|reset|range|color|file|image)$/.test(
      (target as HTMLInputElement).type
    )
  )
}

export type LeaderKey = { key: string; run: () => void; description: string }

export function useAppKeys({
  openPalette,
  leaders,
  root,
}: {
  openPalette: () => void
  leaders: LeaderKey[]
  /** When set, the keys act only while focus is inside this element (for a shell shown inside a larger page). */
  root?: React.RefObject<HTMLElement | null>
}) {
  const [leader, setLeader] = React.useState(false)
  const armed = React.useRef<number | null>(null)

  const disarm = React.useCallback(() => {
    if (armed.current !== null) window.clearTimeout(armed.current)
    armed.current = null
    setLeader(false)
  }, [])

  const inScope = () =>
    !root || (root.current?.contains(document.activeElement) ?? false)
  const page = () => inScope() && !overlayOpen()
  const free = () => page() && armed.current === null
  const led = () => page() && armed.current !== null
  const then = (action: () => void) => () => {
    disarm()
    action()
  }

  useShortcut("mod+k", then(openPalette), {
    when: inScope,
    description: "Open the command palette",
  })
  const runLeader = React.useEffectEvent((key: string) => {
    disarm()
    leaders.find((l) => l.key === key)?.run()
  })
  const leaderKeys = JSON.stringify(leaders.map((l) => [l.key, l.description]))
  React.useEffect(() => {
    const offs = (JSON.parse(leaderKeys) as [string, string][]).map(
      ([key, description]) =>
        registerShortcut(key, () => runLeader(key), { when: led, description })
    )
    return () => offs.forEach((off) => off())
    // led reads only refs and the DOM, so it never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaderKeys])

  const move = (direction: Direction) => () =>
    moveFocus(direction, root?.current ?? document)
  const nav = { when: free, repeat: true }
  useShortcut("j", move("down"), { ...nav, description: "Focus the next item" })
  useShortcut("arrowdown", move("down"), {
    ...nav,
    description: "Focus the next item",
  })
  useShortcut("k", move("up"), {
    ...nav,
    description: "Focus the previous item",
  })
  useShortcut("arrowup", move("up"), {
    ...nav,
    description: "Focus the previous item",
  })
  useShortcut("h", move("left"), {
    ...nav,
    description: "Focus the region to the left",
  })
  useShortcut("arrowleft", move("left"), {
    ...nav,
    description: "Focus the region to the left",
  })
  useShortcut("l", move("right"), {
    ...nav,
    description: "Focus the region to the right",
  })
  useShortcut("arrowright", move("right"), {
    ...nav,
    description: "Focus the region to the right",
  })

  const onPalette = React.useEffectEvent(openPalette)
  const scoped = React.useEffectEvent(inScope)

  React.useEffect(() => {
    // Space is the leader even on a focused button or menu trigger, so it is taken in the capture
    // phase before the control turns it into a press; Enter still presses.
    const onSpace = (event: KeyboardEvent) => {
      if (
        event.key !== " " ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return
      if (typing(event.composedPath()[0]) || overlayOpen() || !scoped()) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      if (armed.current !== null) {
        disarm()
        onPalette()
      } else {
        armed.current = window.setTimeout(disarm, LEADER_TIMEOUT)
        setLeader(true)
      }
    }
    // Leader keys run on the document; any other key reaching the window ends the leader.
    const onKey = () => {
      if (armed.current !== null) disarm()
    }
    const onFocus = (event: FocusEvent) => rememberFocus(event.target)
    window.addEventListener("keydown", onSpace, { capture: true })
    window.addEventListener("keydown", onKey)
    document.addEventListener("focusin", onFocus)
    return () => {
      window.removeEventListener("keydown", onSpace, { capture: true })
      window.removeEventListener("keydown", onKey)
      document.removeEventListener("focusin", onFocus)
      disarm()
    }
  }, [disarm])

  return { leader }
}
