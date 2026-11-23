import { HomeIcon, SettingsIcon } from "lucide-react"
import { createBrowserRouter, NavLink, Outlet, RouterProvider, useLocation, useNavigate } from "react-router"

import { AppShell, type AppShellPage } from "@/components/app-shell"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { Gallery } from "@/demo/gallery"
import { CoursePage, HomePage, LessonPage, NotFoundPage, ReferencePage, SettingsPage } from "@/pages/pages"

const pages: AppShellPage[] = [
  { href: "/", label: "Home", icon: HomeIcon, leader: "h" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, leader: "s" },
]

// The registry's app shell (@flyingrobots/app-shell), wired to React Router.
function Shell() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <AppShell
      title="School"
      pages={pages}
      pathname={pathname}
      navigate={(href) => navigate(href)}
      renderLink={({ href, ...props }) => <NavLink to={href} {...props} />}
      sidebar={
        <SidebarGroup>
          <SidebarGroupLabel>Courses</SidebarGroupLabel>
          <SidebarGroupContent>
            {/* The course list is its own task; until then the shell shows where it goes. */}
            <SidebarMenu>
              {["a", "b", "c"].map((k) => (
                <SidebarMenuItem key={k}>
                  <SidebarMenuSkeleton showIcon />
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      }
    >
      <Outlet />
    </AppShell>
  )
}

const router = createBrowserRouter([
  // The theme sandbox (src/demo/README.md) keeps its own frame, outside the shell.
  { path: "/demo/*", element: <Gallery /> },
  {
    element: <Shell />,
    children: [
      { path: "/", element: <HomePage /> },
      { path: "/courses/:course", element: <CoursePage /> },
      { path: "/courses/:course/reference", element: <ReferencePage /> },
      { path: "/courses/:course/lessons/:lesson", element: <LessonPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
])

export function App() {
  return <RouterProvider router={router} />
}

export default App
