// The routes' pages. Each one's content is its own task; until then each is a placeholder. The
// lesson page is its own module (./lesson.tsx).
import { Link, useParams } from "react-router"

import { Button } from "@/components/ui/button"
import { Placeholder } from "./placeholder"

const home = { label: "Home", to: "/" }

export function HomePage() {
  return <Placeholder title="Home" />
}

export function CoursePage() {
  const { course } = useParams()
  return <Placeholder title={course!} crumbs={[home]} />
}

export function ReferencePage() {
  const { course } = useParams()
  return <Placeholder title="Reference" crumbs={[home, { label: course!, to: `/courses/${course}` }]} />
}

export function SettingsPage() {
  return <Placeholder title="Settings" crumbs={[home]} />
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
