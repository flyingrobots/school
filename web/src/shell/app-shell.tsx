// Every School page sits in this shell: the sidebar, the header with the palette and the theme
// switch, and the key layer. Pages render into the Outlet.
import * as React from "react"
import { HomeIcon, SettingsIcon } from "lucide-react"
import { NavLink, Outlet, useLocation } from "react-router"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
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
  SidebarMenuSkeleton,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { CommandPalette } from "./command-palette"
import { KeyHint } from "./key-hint"
import { apple, keys } from "./keys"
import { ThemeSwitch } from "./theme-switch"
import { useKeyLayer } from "./use-key-layer"

const PAGES = [
  { to: "/", label: "Home", icon: HomeIcon, keys: keys.home },
  { to: "/settings", label: "Settings", icon: SettingsIcon, keys: keys.settings },
]

const KEYS: { label: string; hints: (readonly string[])[] }[] = [
  { label: "Commands", hints: [keys.palette, keys.paletteLeader] },
  { label: "Move focus", hints: [keys.move, keys.arrows] },
  { label: "Home", hints: [keys.home] },
  { label: "Settings", hints: [keys.settings] },
  { label: "Theme", hints: [keys.theme] },
  { label: "Sidebar", hints: [keys.sidebar] },
  { label: "Close", hints: [keys.close] },
]

const mod = apple ? "Meta" : "Control"

export function AppShell() {
  const [palette, setPalette] = React.useState(false)
  const [theme, setTheme] = React.useState(false)
  return (
    <TooltipProvider>
      <SidebarProvider>
        <Shell palette={palette} setPalette={setPalette} theme={theme} setTheme={setTheme} />
      </SidebarProvider>
    </TooltipProvider>
  )
}

type ShellProps = { palette: boolean; setPalette: (open: boolean) => void; theme: boolean; setTheme: (open: boolean) => void }

function Shell({ palette, setPalette, theme, setTheme }: ShellProps) {
  const { pathname } = useLocation()
  const { leader } = useKeyLayer({ openPalette: () => setPalette(true), openTheme: () => setTheme(true) })

  return (
    <>
      <Sidebar>
        <SidebarHeader className="px-4 py-4">
          <span className="font-heading text-2xl font-semibold">School</span>
        </SidebarHeader>
        <SidebarContent data-nav-region="sidebar">
          <SidebarGroup>
            <SidebarGroupLabel>Go to</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {PAGES.map((page) => (
                  <SidebarMenuItem key={page.to}>
                    <SidebarMenuButton asChild size="lg" isActive={pathname === page.to} className="text-base">
                      <NavLink to={page.to} data-nav aria-keyshortcuts={`Space ${page.keys[1]!.toUpperCase()}`}>
                        <page.icon />
                        <span>{page.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                    <SidebarMenuBadge>
                      <KeyHint keys={page.keys} />
                    </SidebarMenuBadge>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Courses</SidebarGroupLabel>
            <SidebarGroupContent>
              {/* The course list is its own task; until then the shell shows where it goes. */}
              <SidebarMenu>
                {[0, 1, 2].map((i) => (
                  <SidebarMenuItem key={i}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter data-keys>
          <SidebarGroupLabel>Keys</SidebarGroupLabel>
          <ItemGroup>
            {KEYS.map((k) => (
              <Item key={k.label} size="xs">
                <ItemContent>
                  <ItemTitle>{k.label}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  {k.hints.map((h, i) => (
                    <KeyHint key={i} keys={h} />
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
              <SidebarTrigger data-nav size="icon-lg" aria-keyshortcuts={`${mod}+B`} />
            </TooltipTrigger>
            <TooltipContent>
              Sidebar <KeyHint keys={keys.sidebar} />
            </TooltipContent>
          </Tooltip>
          {leader && (
            <Badge variant="secondary" aria-live="polite">
              <KeyHint keys={["Space"]} /> then h, s, t or Space
            </Badge>
          )}
          <div className="ms-auto flex items-center gap-2">
            <Button variant="outline" size="lg" data-nav aria-keyshortcuts={`${mod}+K Space`} onClick={() => setPalette(true)}>
              Commands
              <KeyHint keys={keys.palette} />
            </Button>
            <ThemeSwitch open={theme} onOpenChange={setTheme} />
          </div>
        </header>
        <Separator />
        <div className="flex flex-1 flex-col px-4 py-8 md:px-8 2xl:px-12">
          <Outlet />
        </div>
      </SidebarInset>

      <CommandPalette open={palette} onOpenChange={setPalette} />
    </>
  )
}
