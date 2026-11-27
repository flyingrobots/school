import {
  BookOpenIcon,
  HomeIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from "lucide-react"
import {
  createBrowserRouter,
  NavLink,
  Outlet,
  RouterProvider,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router"

import { AppShell, type AppShellPage } from "@/components/app-shell-pinned"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from "@/components/ui/sidebar"
import { Gallery } from "@/demo/gallery"
import { useCourses } from "@/lib/courses"
import { LessonPage } from "@/pages/lesson"
import {
  CoursePage,
  HomePage,
  NotFoundPage,
  ReferencePage,
  SettingsPage,
} from "@/pages/pages"

const pages: AppShellPage[] = [
  { href: "/", label: "Home", icon: HomeIcon, leader: "h" },
  { href: "/settings", label: "Settings", icon: SettingsIcon, leader: "s" },
]

// The registry's app shell (@flyingrobots/app-shell-pinned), wired to React Router.
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
      sidebar={<SidebarCourses />}
    >
      <Outlet />
    </AppShell>
  )
}

// Every course from GET /api/courses, loaded once per visit and shared with the home page
// (web/src/lib/courses.ts). The course in the address, or the one a page under it belongs to, is marked.
// An untrusted course carries a neutral Safe mode badge, and its link says so (flyingrobots/school#277).
function SidebarCourses() {
  const [courses, retry] = useCourses()
  const current = useMatch("/courses/:course/*")?.params.course
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Courses</SidebarGroupLabel>
      <SidebarGroupContent>
        {courses.kind === "failed" ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>Courses could not be loaded</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-2">
              {courses.reason ?? "School's server did not answer as expected."}
              <Button size="sm" variant="outline" onClick={retry} data-nav>
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <SidebarMenu>
            {courses.kind === "loading"
              ? ["a", "b", "c"].map((k) => (
                  <SidebarMenuItem key={k}>
                    <SidebarMenuSkeleton showIcon />
                  </SidebarMenuItem>
                ))
              : courses.data.map((c) => (
                  <SidebarMenuItem key={c.name}>
                    <SidebarMenuButton
                      asChild
                      size="lg"
                      isActive={c.name === current}
                      className="text-base"
                    >
                      <NavLink
                        to={`/courses/${encodeURIComponent(c.name)}`}
                        data-nav
                        data-course={c.name}
                        aria-label={
                          c.trusted
                            ? undefined
                            : `${c.title}, shown in safe mode`
                        }
                      >
                        <BookOpenIcon />
                        <span className="truncate">{c.title}</span>
                        {!c.trusted && (
                          <Badge variant="outline" className="ml-auto">
                            Safe mode
                          </Badge>
                        )}
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
          </SidebarMenu>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
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
