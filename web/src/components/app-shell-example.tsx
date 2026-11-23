import * as React from "react"
import { HomeIcon, InboxIcon, SettingsIcon } from "lucide-react"

import { AppShell, type AppShellPage } from "@/components/app-shell"
import { Skeleton } from "@/components/ui/skeleton"

const pages: AppShellPage[] = [
  { href: "#home", label: "Home", icon: HomeIcon, leader: "h" },
  { href: "#inbox", label: "Inbox", icon: InboxIcon, leader: "i" },
  { href: "#settings", label: "Settings", icon: SettingsIcon, leader: "s" },
]

// The keys act while focus is inside the shell (contained), so a page around it keeps its own.
export default function AppShellExample() {
  const [at, setAt] = React.useState(pages[0]!.href)
  const page = pages.find((p) => p.href === at)!
  return (
    <AppShell
      title="Example"
      pages={pages}
      pathname={at}
      navigate={setAt}
      renderLink={({ href, onClick, ...props }) => (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
            onClick?.(event)
            setAt(href)
          }}
          {...props}
        />
      )}
      contained
    >
      <div className="flex w-full flex-col gap-8">
        <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl">{page.label}</h1>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {["a", "b", "c", "d", "e", "f"].map((k) => (
            <Skeleton key={k} className="h-32 w-full" />
          ))}
        </div>
      </div>
    </AppShell>
  )
}
