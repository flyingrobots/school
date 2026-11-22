// The theme sandbox (/demo) shows shadcn's own registry examples, unedited, for every stock component.
// Oracle: test/fixtures/registry-examples.sha256, the hashes of the files the shadcn CLI wrote.
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const components = join(import.meta.dir, "..", "src", "components")
const read = (name: string) => readFileSync(join(components, name), "utf8")
const examples = readdirSync(components).filter((f) => f.endsWith("-example.tsx")).sort()
const shown = examples.filter((f) => f !== "component-example.tsx") // the gallery skips the website's landing composite
const exampleSource = shown.map(read).join("\n")
// The sonner example calls toast() from the sonner package; the stock Toaster that shows it is mounted by the frame.
const frameSource = readFileSync(join(import.meta.dir, "..", "src", "demo", "gallery.tsx"), "utf8")
const stock = readdirSync(join(components, "ui")).filter((f) => f.endsWith(".tsx")).map((f) => f.slice(0, -4)).sort()

const manifest = new Map(
  readFileSync(join(import.meta.dir, "fixtures", "registry-examples.sha256"), "utf8")
    .trim().split("\n").map((line) => { const [hash, file] = line.split(/\s+/); return [file!, hash!] as const })
)

test("the examples are exactly the files the shadcn CLI wrote", () => {
  const actual = Object.fromEntries(examples.map((f) => [f, createHash("sha256").update(read(f)).digest("hex")]))
  expect(actual).toEqual(Object.fromEntries(manifest))
})

// direction has no registry example; it is a provider that renders nothing of its own.
test("every stock component except direction appears in a registry example the gallery shows", () => {
  const unshown = stock.filter((c) => !(exampleSource + frameSource).includes(`from "@/components/ui/${c}"`))
  expect(stock.length).toBeGreaterThan(0) // zero witnesses would mean the harvest read nothing
  expect(unshown).toEqual(["direction"])
})

test("every example the gallery shows has a default export to render", () => {
  expect(shown.filter((f) => !/^export default function /m.test(read(f)))).toEqual([])
})

/** Every value of every cva variant axis in the stock components, as `Component axis=value`. */
function declaredVariants(): { component: string; axis: string; value: string; isDefault: boolean }[] {
  return stock.flatMap((c) => {
    const source = readFileSync(join(components, "ui", `${c}.tsx`), "utf8")
    return [...source.matchAll(/const (\w+)Variants = cva\(/g)].flatMap((m) => {
      const body = source.slice(m.index! + m[0].length, source.indexOf("\n)", m.index!))
      const defaults = Object.fromEntries([...body.slice(body.indexOf("defaultVariants")).matchAll(/(\w+): "([\w-]+)"/g)].map((d) => [d[1], d[2]]))
      const variants = body.slice(body.indexOf("variants:"), body.includes("defaultVariants") ? body.indexOf("defaultVariants") : undefined)
      const component = m[1]![0]!.toUpperCase() + m[1]!.slice(1)
      return [...variants.matchAll(/\n\s+(\w+): \{(.*?)\n\s+\},/gs)].flatMap((axis) =>
        [...axis[2]!.matchAll(/\n\s+"?([\w-]+)"?:\s/g)].map((v) => ({
          component, axis: axis[1]!, value: v[1]!,
          // a default lives in cva's defaultVariants or in the component's parameter default (`orientation = "horizontal"`)
          isDefault: v[1] === "default" || defaults[axis[1]!] === v[1] || source.includes(`${axis[1]} = "${v[1]}"`),
        }))
      )
    })
  })
}

// A value counts as shown when an example passes it as a prop or as data (`variant: "added"`);
// a default is shown whenever the component appears at all.
const isShown = (v: ReturnType<typeof declaredVariants>[number]) =>
  v.isDefault
    ? new RegExp(`<${v.component}\\b`).test(exampleSource)
    : new RegExp(`<${v.component}\\b[^>]*?\\b${v.axis}="${v.value}"`, "s").test(exampleSource) ||
      new RegExp(`\\b${v.axis}: "${v.value}"`).test(exampleSource) ||
      new RegExp(`\\b${v.axis}=\\{[^}]*"${v.value}"`).test(exampleSource)

test("the registry examples show every cva variant the stock components declare, except one known gap", () => {
  const declared = declaredVariants()
  const unshown = declared.filter((v) => !isShown(v)).map((v) => `${v.component} ${v.axis}=${v.value}`)
  console.log(`declared ${declared.length} cva variant values; ${unshown.length} not shown`)
  expect(declared.length).toBeGreaterThan(0)
  // No shadcn registry example uses this value (shadcn CLI 4.23.0). If one ever does, this fails: drop it.
  expect(unshown).toEqual(["SidebarMenuButton variant=outline"])
})
