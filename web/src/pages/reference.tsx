// The reference page (flyingrobots/school#41): a course's reference documents, from the
// `reference` file names in GET /api/courses/:course. Each opens in a new tab at the address
// School serves it from, /courses/:course/reference/<file>, so the server's containment rules
// (server/server.ts, referenceDir and serveFrom) decide what is served; the page builds no other
// path to a file. Rendering the documents is not the app's job: they are course-authored HTML,
// complete pages of their own. Composed only of stock shadcn components.
import * as React from "react"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { ExternalLinkIcon, FileQuestionIcon, FileTextIcon, LibraryIcon, TriangleAlertIcon } from "lucide-react"
import { Link, useParams } from "react-router"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useDocumentTitle } from "@/lib/document-title"
import { useCourse } from "@/lib/course"
import { referenceHref, type CourseLoad } from "@/lib/school-api"

gsap.registerPlugin(useGSAP)

const grid = "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"

export function ReferencePage() {
  const { course: name } = useParams()
  useDocumentTitle("Reference", name!)
  const [state, retry] = useCourse(name!)
  const scope = React.useRef<HTMLDivElement>(null)

  useGSAP(
    () => {
      // Opacity, not autoAlpha: autoAlpha sets visibility: hidden, and a hidden link cannot take
      // focus, so j pressed while a document is still fading in would skip it.
      gsap.matchMedia().add("(prefers-reduced-motion: no-preference)", () => {
        gsap
          .timeline({ defaults: { ease: "power2.out" } })
          .from("[data-animate=heading]", { y: 24, opacity: 0, duration: 0.4 })
          .from("[data-animate=body] > *", { y: 16, opacity: 0, duration: 0.3, stagger: 0.04 }, "-=0.2")
      })
    },
    { scope, dependencies: [name, state.kind], revertOnUpdate: true }
  )

  return (
    <div ref={scope} className="flex w-full flex-col gap-8">
      <div data-animate="heading" className="flex flex-col gap-3">
        <Breadcrumb>
          <BreadcrumbList className="text-base">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/" data-nav>
                  Home
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={`/courses/${encodeURIComponent(name!)}`} data-nav>
                  {name}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Reference</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <h1 className="font-heading text-4xl font-semibold tracking-tight sm:text-5xl 2xl:text-6xl">Reference</h1>
      </div>
      <Body state={state} name={name!} retry={retry} />
    </div>
  )
}

function Body({ state, name, retry }: { state: CourseLoad; name: string; retry: () => void }) {
  switch (state.kind) {
    case "loading":
      return (
        <div data-animate="body" className="flex flex-col gap-4">
          <div className="flex items-center gap-3 text-lg text-muted-foreground">
            <Spinner className="size-5" />
            Loading the reference documents
          </div>
          <div className={grid}>
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        </div>
      )
    case "missing":
      return (
        <Empty data-animate="body" className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileQuestionIcon />
            </EmptyMedia>
            <EmptyTitle className="text-2xl">There is no course called {name}</EmptyTitle>
            <EmptyDescription className="text-lg">Check the address, or pick a course from the sidebar.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild size="lg">
              <Link to="/" data-nav>
                Go home
              </Link>
            </Button>
          </EmptyContent>
        </Empty>
      )
    case "unloaded":
      return (
        <div data-animate="body">
          <Alert variant="destructive" className="text-base">
            <TriangleAlertIcon />
            <AlertTitle className="text-lg">The reference documents could not be loaded</AlertTitle>
            <AlertDescription className="text-base">School's server did not answer as expected. Check that it is running, then try again.</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={retry} data-nav>
                Try again
              </Button>
            </AlertAction>
          </Alert>
        </div>
      )
    // A course whose lessons cannot be read still lists its documents (flyingrobots/school#115);
    // the lesson error is the course page's to show.
    case "ready":
    case "unreadable": {
      const reference = state.kind === "ready" ? state.course.reference : state.reference
      if (reference.length === 0)
        return (
          <Empty data-animate="body" className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LibraryIcon />
              </EmptyMedia>
              <EmptyTitle className="text-2xl">No reference documents</EmptyTitle>
              <EmptyDescription className="text-lg">
                Documents show up here once they are added to the course's reference folder.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      return (
        <div className="flex flex-col gap-4">
          {/* Each document is a link, so the group is not announced as a list of non-items. */}
          <ItemGroup data-animate="body" role={undefined} className={grid}>
            {reference.map((file) => (
              <Item key={file} asChild variant="outline" className="p-5">
                <a href={referenceHref(name, file)} target="_blank" rel="noopener noreferrer" data-nav data-reference={file}>
                  <ItemMedia variant="icon">
                    <FileTextIcon />
                  </ItemMedia>
                  <ItemContent className="gap-1">
                    <ItemTitle className="text-xl">{file.replace(/\.html$/, "")}</ItemTitle>
                    <ItemDescription className="text-base">Opens in a new tab</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ExternalLinkIcon className="size-5 text-muted-foreground" />
                  </ItemActions>
                </a>
              </Item>
            ))}
          </ItemGroup>
          <p className="flex items-center gap-2 text-base text-muted-foreground">
            <Kbd>j</Kbd>
            <Kbd>k</Kbd>
            move between documents,
            <Kbd>↵</Kbd>
            opens one in a new tab
          </p>
        </div>
      )
    }
  }
}
