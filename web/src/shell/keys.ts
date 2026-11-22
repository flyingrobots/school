// The keys the shell answers to, as the Kbd hints show them. ui-sdk's `mod` is Command on Apple
// platforms and Control elsewhere; this matches its test so the hint names the key that acts.
export const apple = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
const mod = apple ? "⌘" : "Ctrl"

export const keys = {
  palette: [mod, "K"],
  paletteLeader: ["Space", "Space"],
  move: ["h", "j", "k", "l"],
  arrows: ["←", "↓", "↑", "→"],
  home: ["Space", "h"],
  settings: ["Space", "s"],
  theme: ["Space", "t"],
  sidebar: [mod, "B"],
  close: ["Esc"],
  choose: ["↑", "↓"],
  run: ["↵"],
} as const

/** How long a lone Space waits for the key that follows it, in milliseconds. */
export const LEADER_TIMEOUT = 1500
