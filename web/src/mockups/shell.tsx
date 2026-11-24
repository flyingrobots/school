import { StrictMode, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { LightbulbIcon, SettingsIcon } from "lucide-react"

import "@/index.css"
import { ModeToggle } from "@/components/mode-toggle"
import { ThemeProvider } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"

export type MockCourse = {
  name: string
  lessons: number | null
  reference: number
  quizzes: number
  correct: number
}

export const COURSES: MockCourse[] = [
  { name: "aion", lessons: 2, reference: 3, quizzes: 10, correct: 6 },
  { name: "rust-ownership", lessons: 5, reference: 0, quizzes: 24, correct: 0 },
  {
    name: "category-theory",
    lessons: null,
    reference: 1,
    quizzes: 0,
    correct: 0,
  },
]

export const initials = (name: string) => name.slice(0, 2).toUpperCase()
export const lessonCount = (n: number) => `${n} lesson${n === 1 ? "" : "s"}`

export type Rationale = {
  title: string
  summary: string
  points: string[]
  components: string
}

function Why({ rationale }: { rationale: Rationale }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <LightbulbIcon data-icon="inline-start" />
          Why this design?
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rationale.title}</DialogTitle>
          <DialogDescription>{rationale.summary}</DialogDescription>
        </DialogHeader>
        <ul className="flex list-disc flex-col gap-2 ps-5 text-sm">
          {rationale.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Stock parts: {rationale.components}
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Got it</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function mount(
  rationale: Rationale,
  page: ReactNode,
  width = "max-w-3xl"
) {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <div className="flex min-h-svh flex-col">
          <header className="flex h-14 items-center gap-2 px-4">
            <span className="font-heading font-medium">School</span>
            <div className="ms-auto flex items-center gap-1">
              <Why rationale={rationale} />
              <Button variant="ghost" size="icon" aria-label="Settings">
                <SettingsIcon />
              </Button>
              <ModeToggle />
            </div>
          </header>
          <Separator />
          <main
            className={`mx-auto flex w-full ${width} flex-col gap-6 px-4 py-10`}
          >
            {page}
          </main>
        </div>
      </ThemeProvider>
    </StrictMode>
  )
}
