// The registry's Badge, one per phrase of how quizzes are holding (src/lib/holding.ts), as the
// course page's lesson cards and the home timeline's lanes show them.
import { Badge } from "@/components/ui/badge"

export function HoldingBadges({ words }: { words: string[] }) {
  if (words.length === 0) return null
  return (
    <span data-holding className="flex flex-wrap gap-1">
      {words.map((w) => (
        <Badge key={w} variant="secondary">
          {w}
        </Badge>
      ))}
    </span>
  )
}
