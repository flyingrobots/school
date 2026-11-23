// flyingrobots/school#114: no intro hides what it brings in. GSAP's autoAlpha sets visibility:
// hidden until an element starts to fade in, and a hidden element cannot take focus, so j pressed
// during the intro skipped it. Every page and block fades opacity only; the pages that animate
// focus stops are also driven during their intro (course, reference, settings tests).
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const src = join(import.meta.dir, "..", "src")

test("no source file animates autoAlpha", () => {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => /\.(ts|tsx)$/.test(f))
  expect(files.length).toBeGreaterThan(10)
  expect(files.filter((f) => /\bautoAlpha\s*:\s*[\d.]/.test(readFileSync(join(src, f), "utf8")))).toEqual([])
})
