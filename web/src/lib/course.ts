// One course from GET /api/courses/:course, as the course page and its reference page read it.
// Each page asks when it opens, since the answer carries progress that studying changes.
import * as React from "react"

import { loadCourse, type CourseLoad } from "@/lib/school-api"

/** The course called `name`, and a retry. An answer belongs to the request it came from. */
export function useCourse(name: string): [CourseLoad, () => void] {
  const [attempt, setAttempt] = React.useState(0)
  // Until the current request answers, it is loading.
  const key = `${attempt} ${name}`
  const [answer, setAnswer] = React.useState<{
    key: string
    state: CourseLoad
  } | null>(null)

  React.useEffect(() => {
    const abort = new AbortController()
    loadCourse(name, abort.signal).then(
      (state) => abort.signal.aborted || setAnswer({ key, state })
    )
    return () => abort.abort()
  }, [name, key])

  return [
    answer?.key === key ? answer.state : { kind: "loading" },
    () => setAttempt((n) => n + 1),
  ]
}
