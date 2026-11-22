import { Kbd, KbdGroup } from "@/components/ui/kbd"

/** A key, or a sequence of keys pressed one after another, as stock Kbd. */
export function KeyHint({ keys }: { keys: readonly string[] }) {
  if (keys.length === 1) return <Kbd>{keys[0]}</Kbd>
  return (
    <KbdGroup>
      {keys.map((k, i) => (
        <Kbd key={i}>{k}</Kbd>
      ))}
    </KbdGroup>
  )
}
