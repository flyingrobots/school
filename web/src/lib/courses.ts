// The course list, loaded once per visit and shared: the sidebar (web/src/App.tsx) and the home
// page read the same answer to GET /api/courses, so moving between pages does not ask again
// (flyingrobots/school#95). One request is in flight at a time; a second caller joins it.
import * as React from "react"

import {
  CoursesUnavailable,
  listCourses,
  type CourseSummary,
} from "@/lib/school-api"

export type CoursesLoad =
  | { kind: "loading" }
  | { kind: "ready"; data: CourseSummary[] }
  // No usable answer: unreachable, or the wrong shape. `reason` is the server's, when it gave one.
  | { kind: "failed"; reason: string | null }

let state: CoursesLoad = { kind: "loading" }
let asked = false
let inFlight = false
const listeners = new Set<() => void>()

function set(next: CoursesLoad) {
  state = next
  for (const l of listeners) l()
}

/**
 * Asks School for the list. Over a list already shown it asks in the background: the list stays
 * until the answer replaces it, and a failure then keeps it. Otherwise it shows as loading.
 */
function ask() {
  if (inFlight) return
  asked = true
  inFlight = true
  const shown = state.kind === "ready"
  if (!shown) set({ kind: "loading" })
  listCourses()
    .then(
      (data) => set({ kind: "ready", data }),
      (e: unknown) =>
        shown ||
        set({
          kind: "failed",
          reason: e instanceof CoursesUnavailable ? e.reason : null,
        })
    )
    .finally(() => (inFlight = false))
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The shared course list, and a retry. It is asked for the first time any component reads it.
 * `fresh` also asks again when the component mounts, in the background: the home page shows
 * progress, which studying changes, while the sidebar's names do not.
 */
export function useCourses({ fresh = false }: { fresh?: boolean } = {}): [
  CoursesLoad,
  () => void,
] {
  const courses = React.useSyncExternalStore(subscribe, () => state)
  React.useEffect(() => {
    if (!asked || fresh) ask()
  }, [fresh])
  return [courses, ask]
}

/**
 * What the pages call the course `name` (flyingrobots/school#143): its title from the shared course
 * list, or `name` itself while the list loads, when it failed, or when the course is not in it.
 */
export function useCourseTitle(name: string): string {
  const [courses] = useCourses()
  return titleIn(courses, name)
}

/** The title of the course `name` in `courses`, or `name` when the list has none for it. */
export function titleIn(courses: CoursesLoad, name: string): string {
  return (
    (courses.kind === "ready"
      ? courses.data.find((c) => c.name === name)?.title
      : undefined) ?? name
  )
}
