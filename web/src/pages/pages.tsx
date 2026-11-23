// The routes' pages. Each one's content is its own task; until it lands, a page is a placeholder.
// The lesson page is its own module (./lesson.tsx).
import { Link, useParams } from "react-router"

import { Button } from "@/components/ui/button"
import { Placeholder } from "./placeholder"

export { SettingsPage } from "./settings"

const home = { label: "Home", to: "/" }

export { HomePage } from "./home"

export { CoursePage } from "./course"

export function ReferencePage() {
  const { course } = useParams()
  return <Placeholder title="Reference" crumbs={[home, { label: course!, to: `/courses/${course}` }]} />
}

export function NotFoundPage() {
  return (
    <Placeholder title="Not found" crumbs={[home]}>
      <p className="text-lg text-muted-foreground">There is no page at this address.</p>
      <Button asChild size="lg" className="self-start">
        <Link to="/" data-nav>
          Go home
        </Link>
      </Button>
    </Placeholder>
  )
}
