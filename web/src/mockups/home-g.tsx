import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { REVIEWS } from "./learner"
import { mount } from "./shell"
import {
  ContinueLine,
  FeedbackCard,
  ReviewList,
  Rhythm,
  RhythmLegend,
} from "./parts"

mount(
  {
    title: "G · The letter and the calendar",
    summary:
      "F and E side by side: what's new on the left, and where it sits in time on the right.",
    points: [
      "The letter (F) is what you read; the timeline (E) is what you glance at. Putting them side by side lets each do its job without competing for the top of the page.",
      "On a wide screen the timeline stays beside the letter as you scroll, so 'two questions are ready for another look' always has its context: which day they came from and what's coming next.",
      "On a phone the letter comes first and the timeline follows. Feedback is the thing you act on; the timeline is the thing you check.",
      "The headline is still one sentence in words. The chart never has to be read to know what to do.",
      "On a quiet day with no new feedback, the letter column shrinks to the lesson to continue and the timeline becomes the main thing on the page.",
      "Trade-off: two columns need room. On a laptop the timeline gets narrow; a 2200 px screen is where this shines.",
    ],
    components:
      "Card, Item, ItemGroup, Badge, Alert, Button, Kbd, mode toggle, and the d3 timeline.",
  },
  <>
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        Since you were last here, Sunday night
      </p>
      <h1 className="font-heading text-4xl font-semibold text-balance">
        Claude read your explanation, and {REVIEWS.length} questions are ready
        for another look.
      </h1>
    </div>
    <div className="grid gap-6 lg:grid-cols-12">
      <div className="flex flex-col gap-6 lg:col-span-7">
        <FeedbackCard />
        <div className="flex flex-col gap-3">
          <h2 className="font-heading text-xl font-medium">
            Ready for another look
          </h2>
          <ReviewList />
        </div>
        <ContinueLine />
      </div>
      <div className="lg:col-span-5">
        <Card className="lg:sticky lg:top-6">
          <CardHeader>
            <CardTitle>You studied on 9 of the last 14 days</CardTitle>
            <CardDescription>
              One question comes back tomorrow, and four more by Saturday.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Rhythm />
            <div className="text-xs text-muted-foreground">
              <RhythmLegend />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  </>,
  "max-w-6xl"
)
