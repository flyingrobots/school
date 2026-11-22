// hjkl and the arrows move focus between the shell's regions (h/l: the sidebar, the main area) and
// through the items of a region (j/k). Regions are marked `data-nav-region`, items `data-nav`.

const lastIn = new WeakMap<Element, HTMLElement>()

function regions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-nav-region]")].filter(
    // a collapsed desktop sidebar is off screen; its items cannot take focus usefully
    (r) => !r.closest("[data-state=collapsed]") && items(r).length > 0
  )
}

function items(region: Element): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>("[data-nav]")].filter((el) => el.getClientRects().length > 0)
}

function focus(region: Element, el: HTMLElement | undefined) {
  if (!el) return
  lastIn.set(region, el)
  el.focus()
}

/** Remembers the item focus is on, however it got there, so h/l return to it. */
export function remember(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return
  const item = target.closest<HTMLElement>("[data-nav]")
  const region = item?.closest("[data-nav-region]")
  if (item && region) lastIn.set(region, item)
}

export type Direction = "up" | "down" | "left" | "right"

export function moveFocus(direction: Direction) {
  const all = regions()
  if (all.length === 0) return
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const region = all.find((r) => active && r.contains(active))
  const back = (r: Element) => {
    const last = lastIn.get(r)
    return last && last.isConnected && items(r).includes(last) ? last : items(r)[0]
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
  const to = at === -1 ? 0 : Math.min(Math.max(at + (direction === "down" ? 1 : -1), 0), list.length - 1)
  focus(region, list[to])
}
