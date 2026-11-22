// The shell's keys (RFC 2 §6): ⌘K or Space Space opens the palette, never Esc; Space then a key
// opens a feature; hjkl and the arrows move focus. Esc is left to the palette and menus, to close. None of them act inside a text field (ui-sdk's
// shortcuts skip typing unless a key has a Command modifier), or while a menu or dialog is open.
import * as React from "react"
import { useShortcut } from "@ui-sdk/react/shortcuts"
import { useNavigate } from "react-router"

import { moveFocus, remember, type Direction } from "./focus"
import { LEADER_TIMEOUT } from "./keys"

/** A Radix dialog, sheet or menu is open: its own keys win, the page's wait. */
const overlayOpen = () => document.querySelector("[role=dialog][data-state=open], [role=menu][data-state=open], [role=alertdialog][data-state=open]") !== null

/** Where a key is text: the same test ui-sdk's shortcuts use. */
function typing(target: EventTarget | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "SELECT") return true
  return target.tagName === "INPUT" && !/^(button|checkbox|radio|submit|reset|range|color|file|image)$/.test((target as HTMLInputElement).type)
}

export function useKeyLayer({ openPalette, openTheme }: { openPalette: () => void; openTheme: () => void }) {
  const navigate = useNavigate()
  const [leader, setLeader] = React.useState(false)
  const armed = React.useRef<{ event: KeyboardEvent; timer: number } | null>(null)

  const disarm = React.useCallback(() => {
    if (armed.current) window.clearTimeout(armed.current.timer)
    armed.current = null
    setLeader(false)
  }, [])

  const page = () => !overlayOpen()
  const free = () => page() && !armed.current
  const led = () => page() && armed.current !== null
  const then = (action: () => void) => () => {
    disarm()
    action()
  }

  useShortcut("mod+k", then(openPalette), { description: "Open the command palette" })
  useShortcut("h", then(() => navigate("/")), { when: led, description: "Home" })
  useShortcut("s", then(() => navigate("/settings")), { when: led, description: "Settings" })
  useShortcut("t", then(openTheme), { when: led, description: "Theme" })

  const move = (direction: Direction) => () => moveFocus(direction)
  const nav = { when: free, repeat: true }
  useShortcut("j", move("down"), { ...nav, description: "Focus the next item" })
  useShortcut("arrowdown", move("down"), { ...nav, description: "Focus the next item" })
  useShortcut("k", move("up"), { ...nav, description: "Focus the previous item" })
  useShortcut("arrowup", move("up"), { ...nav, description: "Focus the previous item" })
  useShortcut("h", move("left"), { ...nav, description: "Focus the sidebar" })
  useShortcut("arrowleft", move("left"), { ...nav, description: "Focus the sidebar" })
  useShortcut("l", move("right"), { ...nav, description: "Focus the main area" })
  useShortcut("arrowright", move("right"), { ...nav, description: "Focus the main area" })

  const onPalette = React.useEffectEvent(openPalette)

  React.useEffect(() => {
    // Any other key after a lone Space ends the leader. The shortcuts listen on the document, so
    // by the time a key reaches the window a leader key has already run.
    const onKey = (event: KeyboardEvent) => {
      if (armed.current && armed.current.event !== event) disarm()
    }
    // Space is the leader even while a button or a menu trigger has focus, so it is taken in the
    // capture phase, before the control turns it into a press; Enter still presses. In a text
    // field it is a space, and an open menu or dialog keeps it.
    const onSpace = (event: KeyboardEvent) => {
      if (event.key !== " " || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (typing(event.composedPath()[0]) || overlayOpen()) return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      if (armed.current) {
        disarm()
        onPalette()
      } else {
        armed.current = { event, timer: window.setTimeout(disarm, LEADER_TIMEOUT) }
        setLeader(true)
      }
    }
    const onFocus = (event: FocusEvent) => remember(event.target)
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
