// The browser tab's title, set by each page from what it shows (flyingrobots/school#142):
// the parts most specific first, then School, joined by " · ".
import * as React from "react"

export const SITE = "School"

/** The document title for `parts` (most specific first), always ending in School. */
export const titleOf = (...parts: string[]): string => [...parts.filter((p) => p !== ""), SITE].join(" · ")

/** Sets `document.title` to `parts` followed by School, for as long as the calling page is shown. */
export function useDocumentTitle(...parts: string[]): void {
  const title = titleOf(...parts)
  React.useEffect(() => {
    document.title = title
  }, [title])
}
