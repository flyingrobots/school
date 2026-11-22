// Every stock shadcn component in src/components/ui is exactly what the shadcn CLI installs (WEB_STYLE: no hand edits).
// Oracle: test/fixtures/stock-components.sha256, hashed from a fresh `shadcn add` (see test/fixtures/README.md).
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const components = join(import.meta.dir, "..", "src", "components")
const ui = join(components, "ui")
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")

const manifest = Object.fromEntries(
  readFileSync(join(import.meta.dir, "fixtures", "stock-components.sha256"), "utf8")
    .trim().split("\n").map((line) => { const [hash, file] = line.split(/\s+/); return [file!, hash!] })
)

test("every stock component is byte-for-byte a fresh shadcn CLI install", () => {
  const files = readdirSync(ui).filter((f) => f.endsWith(".tsx")).sort()
  expect(files.length).toBeGreaterThan(0) // zero witnesses would mean the read found nothing
  expect(Object.fromEntries(files.map((f) => [f, sha256(join(ui, f))]))).toEqual(manifest)
})

// components.json sets rsc: false, so the CLI means to drop "use client" from every file it writes. shadcn 4.23.0
// drops it from only every other file (its directive regex is global, so RegExp.test keeps lastIndex between files),
// which is why reinstalls flipped the line back and forth. No installed file keeps it.
test('no installed component starts with "use client"', () => {
  const files = readdirSync(components, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx"))
  expect(files.length).toBeGreaterThan(0)
  expect(files.filter((f) => readFileSync(join(components, f), "utf8").startsWith('"use client"')).sort()).toEqual([])
})
