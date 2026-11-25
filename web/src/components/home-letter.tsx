// The home page's letter (flyingrobots/school#166): the newest feedback on an explanation, and the
// questions ready for another look, each naming its course and lesson and saying why it's back.
import * as React from "react"
import { Link } from "react-router"
import {
  BookOpenIcon,
  BotIcon,
  InfoIcon,
  PenLineIcon,
  RotateCcwIcon,
} from "lucide-react"

import { ReadAloud } from "@/components/read-aloud"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  lessonHref,
  type Feedback,
  type ReviewItem,
  type Verdict,
} from "@/lib/home-api"

// School's voice (docs/topics/voice/README.md): results are words, and "misses" reads "Not yet".
const verdictWord: Record<Verdict, string> = {
  meets: "Meets",
  partly: "Partly",
  misses: "Not yet",
}
const verdictVariant: Record<Verdict, "default" | "secondary" | "outline"> = {
  meets: "default",
  partly: "secondary",
  misses: "outline",
}
const CRITERIA = [
  ["fidelity", "Fidelity"],
  ["completeness", "Completeness"],
  ["accessibility", "Accessibility"],
] as const

const grader = (model: string | null) =>
  model === null ? "the grader" : model.charAt(0).toUpperCase() + model.slice(1)

export function FeedbackCard({ feedback: f }: { feedback: Feedback }) {
  const href = `${lessonHref(f.course, f.lesson.id)}#${f.blockId}`
  return (
    <Card data-feedback>
      <CardHeader>
        <CardDescription className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            <BotIcon /> graded by {grader(f.model)}
          </Badge>
          {f.lesson.title}, {f.courseTitle}
        </CardDescription>
        <CardTitle className="font-heading text-2xl leading-snug">
          Your explanation of {f.lesson.title}
        </CardTitle>
        {f.prompt && <CardDescription>{f.prompt}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-lg leading-relaxed">{f.findings.summary}</p>
        <ItemGroup className="gap-2">
          {CRITERIA.map(([key, name]) => {
            const c = f.findings[key]
            return (
              <Item key={key} variant="outline" size="sm" data-criterion={key}>
                <ItemContent>
                  <ItemTitle>
                    {name}
                    <Badge variant={verdictVariant[c.verdict]}>
                      {verdictWord[c.verdict]}
                    </Badge>
                  </ItemTitle>
                  {c.note && (
                    <ItemDescription className="line-clamp-none">
                      {c.note}
                    </ItemDescription>
                  )}
                </ItemContent>
              </Item>
            )
          })}
        </ItemGroup>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button asChild data-nav>
          <Link to={href}>
            <PenLineIcon data-icon="inline-start" /> Write a new draft
          </Link>
        </Button>
        <ReadAloud
          readKey={`feedback:${f.at}`}
          request={{ feedback: true }}
          size="default"
        />
      </CardFooter>
    </Card>
  )
}

const RULE =
  "School brings back questions you've met before that took a second go or a little help. It waits at least a day, so this time the answer comes from memory, which is what makes it stick."

/** "Why am I being asked this?", on hover with a pointer and on tap with a finger. */
function WhyAsked({ item }: { item: ReviewItem }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Why am I being asked this question?"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <InfoIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle>Why am I being asked this?</PopoverTitle>
          <PopoverDescription>{item.reason}</PopoverDescription>
        </PopoverHeader>
        <p className="text-sm text-muted-foreground">
          {item.lesson
            ? `It's from ${item.lesson.title}, in ${item.courseTitle}. `
            : `It's from ${item.courseTitle}. `}
          {RULE}
        </p>
      </PopoverContent>
    </Popover>
  )
}

const dayMonth = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" }).format(
    new Date(iso)
  )

/**
 * The questions ready for another look. A question comes back at the top of another lesson in its
 * course, so its button opens `answerAt` for its course.
 */
export function ReviewList({
  items,
  answerAt,
}: {
  items: readonly ReviewItem[]
  answerAt: (item: ReviewItem) => string
}) {
  return (
    <ItemGroup className="gap-2">
      {items.map((r) => (
        <Item
          key={`${r.course}:${r.blockId}`}
          variant="muted"
          data-review={r.blockId}
        >
          <ItemContent>
            <ItemDescription className="flex items-center gap-1.5">
              <BookOpenIcon className="size-3.5" />
              {r.courseTitle}
              {r.lesson && ` · ${r.lesson.title}`}
            </ItemDescription>
            <ItemTitle className="text-base">
              {r.question ?? "A question from this course"}
            </ItemTitle>
            <ItemDescription>
              You answered it on {dayMonth(r.answeredAt)}.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <WhyAsked item={r} />
            <Button asChild variant="outline" size="sm" data-nav>
              <Link to={answerAt(r)}>
                <RotateCcwIcon data-icon="inline-start" /> Answer
              </Link>
            </Button>
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  )
}
