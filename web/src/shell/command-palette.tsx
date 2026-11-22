import { HomeIcon, MonitorIcon, MoonIcon, PanelLeftIcon, SettingsIcon, SunIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { useTheme } from "@/components/theme-provider"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { Separator } from "@/components/ui/separator"
import { useSidebar } from "@/components/ui/sidebar"
import { KeyHint } from "./key-hint"
import { keys } from "./keys"

/** The command palette: ⌘K or Space Space opens it, Esc closes it. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const { setTheme } = useTheme()
  const { toggleSidebar } = useSidebar()
  const run = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Commands" description="Search for a page or a command to run.">
      <Command>
        <CommandInput placeholder="Type a command or a page…" />
        <CommandList>
          <CommandEmpty>No matching command.</CommandEmpty>
          <CommandGroup heading="Go to">
            <CommandItem onSelect={run(() => navigate("/"))}>
              <HomeIcon />
              Home
              <CommandShortcut>
                <KeyHint keys={keys.home} />
              </CommandShortcut>
            </CommandItem>
            <CommandItem onSelect={run(() => navigate("/settings"))}>
              <SettingsIcon />
              Settings
              <CommandShortcut>
                <KeyHint keys={keys.settings} />
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Theme">
            <CommandItem onSelect={run(() => setTheme("light"))}>
              <SunIcon />
              Light theme
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme("dark"))}>
              <MoonIcon />
              Dark theme
            </CommandItem>
            <CommandItem onSelect={run(() => setTheme("system"))}>
              <MonitorIcon />
              System theme
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="View">
            <CommandItem onSelect={run(toggleSidebar)}>
              <PanelLeftIcon />
              Toggle sidebar
              <CommandShortcut>
                <KeyHint keys={keys.sidebar} />
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <Separator />
        <div className="flex flex-wrap items-center gap-4 px-3 py-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <KeyHint keys={keys.choose} /> Choose
          </span>
          <span className="flex items-center gap-2">
            <KeyHint keys={keys.run} /> Run
          </span>
          <span className="flex items-center gap-2">
            <KeyHint keys={keys.close} /> Close
          </span>
        </div>
      </Command>
    </CommandDialog>
  )
}
