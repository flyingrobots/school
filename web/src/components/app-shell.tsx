import * as React from "react"
import { MonitorIcon, MoonIcon, PanelLeftIcon, SunIcon, type LucideIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { ThemeSwitch } from "@/components/theme-switch"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { appKeys, modAria, useAppKeys, type LeaderKey } from "@/lib/app-shell-keys"

export type AppShellPage = {
  href: string
  label: string
  icon: LucideIcon
  /** The key after Space that opens the page, like "s" for Space s. */
  leader?: string
}

export type AppShellLinkProps = React.ComponentProps<"a"> & { href: string }

export type AppShellProps = {
  title: string
  pages: AppShellPage[]
  /** The current path, to mark the active page. */
  pathname: string
  navigate: (href: string) => void
  /** Renders a page link, for a client router's link; a plain anchor by default. */
  renderLink?: (props: AppShellLinkProps) => React.ReactElement
  /** More sidebar groups, below the pages. */
  sidebar?: React.ReactNode
  /** Keys act only while focus is inside the shell, for a shell shown within a larger page. */
  contained?: boolean
  children: React.ReactNode
}

const THEME_LEADER = "t"

export function KeyHint({ keys }: { keys: readonly string[] }) {
  if (keys.length === 1) return <Kbd>{keys[0]}</Kbd>
  return (
    <KbdGroup>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </KbdGroup>
  )
}

export function AppShell(props: AppShellProps) {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Shell {...props} />
      </SidebarProvider>
    </TooltipProvider>
  )
}

function Shell({ title, pages, pathname, navigate, renderLink = (p) => <a {...p} />, sidebar, contained, children }: AppShellProps) {
  const [palette, setPalette] = React.useState(false)
  const [themeMenu, setThemeMenu] = React.useState(false)
  const root = React.useRef<HTMLDivElement>(null)

  const leaders: LeaderKey[] = [
    ...pages.flatMap((p) => (p.leader ? [{ key: p.leader, run: () => navigate(p.href), description: p.label }] : [])),
    { key: THEME_LEADER, run: () => setThemeMenu(true), description: "Theme" },
  ]
  const { leader } = useAppKeys({ openPalette: () => setPalette(true), leaders, root: contained ? root : undefined })
  const leaderHint = (key: string) => ["Space", key] as const
  const keyList: { label: string; hints: (readonly string[])[] }[] = [
    { label: "Commands", hints: [appKeys.palette, appKeys.paletteLeader] },
    { label: "Move focus", hints: [appKeys.move, appKeys.arrows] },
    ...pages.flatMap((p) => (p.leader ? [{ label: p.label, hints: [leaderHint(p.leader)] }] : [])),
    { label: "Theme", hints: [leaderHint(THEME_LEADER)] },
    { label: "Sidebar", hints: [appKeys.sidebar] },
    { label: "Close", hints: [appKeys.close] },
  ]

  return (
    <div ref={root} className="contents">
      <Sidebar>
        <SidebarHeader className="px-4 py-4">
          <span className="font-heading text-2xl font-semibold">{title}</span>
        </SidebarHeader>
        <SidebarContent data-nav-region="sidebar">
          <SidebarGroup>
            <SidebarGroupLabel>Go to</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pages.map((page) => (
                  <SidebarMenuItem key={page.href}>
                    <SidebarMenuButton asChild size="lg" isActive={pathname === page.href} className="text-base">
                      {renderLink({
                        href: page.href,
                        "data-nav": "",
                        "aria-keyshortcuts": page.leader ? `Space ${page.leader.toUpperCase()}` : undefined,
                        children: (
                          <>
                            <page.icon />
                            <span>{page.label}</span>
                          </>
                        ),
                      } as AppShellLinkProps)}
                    </SidebarMenuButton>
                    {page.leader && (
                      <SidebarMenuBadge>
                        <KeyHint keys={leaderHint(page.leader)} />
                      </SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {sidebar}
        </SidebarContent>
        <SidebarFooter data-keys>
          <SidebarGroupLabel>Keys</SidebarGroupLabel>
          <ItemGroup>
            {keyList.map((k) => (
              <Item key={k.label} size="xs">
                <ItemContent>
                  <ItemTitle>{k.label}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  {k.hints.map((h) => (
                    <KeyHint key={h.join(" ")} keys={h} />
                  ))}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset data-nav-region="main">
        <header className="flex h-16 items-center gap-3 px-4 md:px-6">
          <Tooltip>
            <TooltipTrigger asChild>
              <SidebarTrigger data-nav size="icon-lg" aria-keyshortcuts={`${modAria}+B`} />
            </TooltipTrigger>
            <TooltipContent>
              Sidebar <KeyHint keys={appKeys.sidebar} />
            </TooltipContent>
          </Tooltip>
          {leader && (
            <Badge variant="secondary" aria-live="polite">
              <KeyHint keys={["Space"]} /> then {[...leaders.map((l) => l.key), "Space"].join(", ")}
            </Badge>
          )}
          <div className="ms-auto flex items-center gap-2">
            <Button variant="outline" size="lg" data-nav aria-keyshortcuts={`${modAria}+K Space`} onClick={() => setPalette(true)}>
              Commands
              <KeyHint keys={appKeys.palette} />
            </Button>
            <ThemeSwitch open={themeMenu} onOpenChange={setThemeMenu} keys={leaderHint(THEME_LEADER)} data-nav aria-keyshortcuts="Space T" />
          </div>
        </header>
        <Separator />
        <div className="flex flex-1 flex-col px-4 py-8 md:px-8 2xl:px-12">{children}</div>
      </SidebarInset>

      <Palette open={palette} onOpenChange={setPalette} pages={pages} navigate={navigate} />
    </div>
  )
}

function Palette({
  open,
  onOpenChange,
  pages,
  navigate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pages: AppShellPage[]
  navigate: (href: string) => void
}) {
  const { setTheme } = useTheme()
  const { toggleSidebar } = useSidebar()
  const run = (action: () => void) => () => {
    onOpenChange(false)
    action()
  }
  const themes = [
    { value: "light", label: "Light theme", icon: SunIcon },
    { value: "dark", label: "Dark theme", icon: MoonIcon },
    { value: "system", label: "System theme", icon: MonitorIcon },
  ] as const

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Commands" description="Search for a page or a command to run.">
      <Command>
        <CommandInput placeholder="Type a command or a page…" />
        <CommandList>
          <CommandEmpty>No matching command.</CommandEmpty>
          <CommandGroup heading="Go to">
            {pages.map((page) => (
              <CommandItem key={page.href} onSelect={run(() => navigate(page.href))}>
                <page.icon />
                {page.label}
                {page.leader && (
                  <CommandShortcut>
                    <KeyHint keys={["Space", page.leader]} />
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Theme">
            {themes.map((t) => (
              <CommandItem key={t.value} onSelect={run(() => setTheme(t.value))}>
                <t.icon />
                {t.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="View">
            <CommandItem onSelect={run(toggleSidebar)}>
              <PanelLeftIcon />
              Toggle sidebar
              <CommandShortcut>
                <KeyHint keys={appKeys.sidebar} />
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <Separator />
        <div className="flex flex-wrap items-center gap-4 px-3 py-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-2">
            <KeyHint keys={appKeys.choose} /> Choose
          </span>
          <span className="flex items-center gap-2">
            <KeyHint keys={appKeys.run} /> Run
          </span>
          <span className="flex items-center gap-2">
            <KeyHint keys={appKeys.close} /> Close
          </span>
        </div>
      </Command>
    </CommandDialog>
  )
}
