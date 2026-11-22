import { createBrowserRouter, RouterProvider } from "react-router"

import { Gallery } from "@/demo/gallery"
import { CoursePage, HomePage, LessonPage, NotFoundPage, ReferencePage, SettingsPage } from "@/pages/pages"
import { AppShell } from "@/shell/app-shell"

const router = createBrowserRouter([
  // The theme sandbox (src/demo/README.md) keeps its own frame, outside the shell.
  { path: "/demo/*", element: <Gallery /> },
  {
    element: <AppShell />,
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
