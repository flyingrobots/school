// Read aloud (flyingrobots/school#175): a button that asks School to read a lesson or the latest
// feedback aloud, and, while it does, a playback bar fixed to the bottom of the page. The voice is
// AI-TTS's, so the bar carries a robot label, as AI feedback does. Keys: `r` starts, `,` and `.` go
// to the previous and next part, `/` pauses and resumes, Esc stops. Space is the shell's leader
// key (docs/topics/app-shell/README.md), so it cannot pause here.
import * as React from "react"
import { useShortcut } from "@ui-sdk/react/shortcuts"
import {
  BotIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SquareIcon,
  Volume2Icon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Card, CardContent } from "@/components/ui/card"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import * as readAloud from "@/lib/read-aloud"

/** True while focus is in an explain block, whose own `r` revises the explanation. */
const inExplain = () =>
  document.activeElement?.closest("[data-explain=root]") != null

/** What the bar says: which part is being read, of how many. */
function words(s: readAloud.ReadAloud): string {
  const of = s.count > 0 ? ` ${s.index + 1} of ${s.count}` : ""
  switch (s.phase) {
    case "starting":
      return "Getting ready to read"
    case "waiting":
      return s.count > 0 ? `Getting part${of} ready` : "Getting ready to read"
    case "playing":
      return `Reading ·${of}`
    case "paused":
      return `Paused ·${of}`
    case "failed":
      return "School can't read this aloud right now"
  }
}

/** The playback bar for what is being read now. Rendered only while something is. */
function ReadAloudBar({ reading: s }: { reading: readAloud.ReadAloud }) {
  const going = s.phase !== "failed"
  useShortcut("escape", readAloud.stop, {
    description: "Stop reading aloud",
  })
  useShortcut(",", readAloud.previous, {
    when: () => going,
    description: "Read the previous part",
  })
  useShortcut(".", readAloud.next, {
    when: () => going,
    description: "Read the next part",
  })
  const paused = s.phase === "paused"
  const toggle = paused ? readAloud.resume : readAloud.pause
  useShortcut("/", toggle, {
    when: () => going,
    description: "Pause or resume reading aloud",
  })
  const busy = s.phase === "starting" || s.phase === "waiting"
  return (
    <Card
      data-read-aloud-bar=""
      data-phase={s.phase}
      role="region"
      aria-label="Reading aloud"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-3xl py-3 shadow-lg"
    >
      <CardContent className="flex flex-wrap items-center gap-3 px-4">
        <Badge variant="outline">
          <BotIcon /> AI voice
        </Badge>
        {busy && <Spinner />}
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            data-read-aloud-label=""
            aria-live="polite"
            className="font-medium"
          >
            {words(s)}
          </span>
          {s.error !== null && (
            <span className="text-sm text-muted-foreground">{s.error}</span>
          )}
        </span>
        {going && (
          <ButtonGroup>
            <Button
              variant="outline"
              aria-label="Previous part"
              aria-keyshortcuts=","
              disabled={s.index === 0}
              onClick={readAloud.previous}
            >
              <SkipBackIcon />
              <Kbd>,</Kbd>
            </Button>
            <Button
              variant="outline"
              aria-label={paused ? "Resume reading" : "Pause reading"}
              aria-keyshortcuts="/"
              onClick={toggle}
            >
              {paused ? <PlayIcon /> : <PauseIcon />}
              <Kbd>/</Kbd>
            </Button>
            <Button
              variant="outline"
              aria-label="Next part"
              aria-keyshortcuts="."
              disabled={s.count === 0 || s.index + 1 >= s.count}
              onClick={readAloud.next}
            >
              <SkipForwardIcon />
              <Kbd>.</Kbd>
            </Button>
          </ButtonGroup>
        )}
        <Button
          variant="outline"
          aria-label={going ? "Stop reading" : "Close"}
          aria-keyshortcuts="Escape"
          onClick={readAloud.stop}
        >
          <SquareIcon />
          <Kbd>Esc</Kbd>
        </Button>
      </CardContent>
    </Card>
  )
}

/**
 * "Read aloud" for `request`, with `r` on the page, and the bar while it reads. Leaving the page
 * stops it.
 */
export function ReadAloud({
  readKey,
  request,
  size = "lg",
}: {
  /** What is read, to tell this reading from another one. */
  readKey: string
  request: readAloud.ReadAloudRequest
  size?: "default" | "lg"
}) {
  const reading = readAloud.useReadAloud()
  const mine = reading?.key === readKey ? reading : null
  const latest = React.useRef(request)
  React.useEffect(() => {
    latest.current = request
  })
  const go = React.useCallback(
    () => void readAloud.start(readKey, latest.current),
    [readKey]
  )
  useShortcut("r", go, {
    // While this reads, `r` does not start it again from the top.
    when: () =>
      !inExplain() &&
      (readAloud.reading()?.key !== readKey ||
        readAloud.reading()?.phase === "failed"),
    description: "Read aloud",
  })
  React.useEffect(
    () => () => {
      if (readAloud.reading()?.key === readKey) readAloud.stop()
    },
    [readKey]
  )
  return (
    <>
      <Button
        variant="outline"
        size={size}
        aria-keyshortcuts="R"
        disabled={mine !== null && mine.phase !== "failed"}
        onClick={go}
      >
        <Volume2Icon data-icon="inline-start" />
        Read aloud
        <Kbd data-icon="inline-end">R</Kbd>
      </Button>
      {mine !== null && <ReadAloudBar reading={mine} />}
    </>
  )
}
