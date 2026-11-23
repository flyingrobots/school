// Stands in for shadcn's `@/components/example` frame (see README.md): the registry examples import
// Example and ExampleWrapper from it, and this version shows one example at a time.
import * as React from "react"
import { cn } from "cn"

type Variants = {
  index: number
  onCount: (count: number) => void
  onTitle: (title: string | undefined) => void
}

const VariantContext = React.createContext<Variants>({ index: 0, onCount: () => {}, onTitle: () => {} })

function ExampleWrapper({ children }: React.ComponentProps<"div">) {
  const { index, onCount } = React.useContext(VariantContext)
  const items = React.Children.toArray(children)
  React.useLayoutEffect(() => onCount(items.length), [items.length, onCount])
  return <div data-slot="example-wrapper" className="flex w-full justify-center">{items[Math.min(index, items.length - 1)]}</div>
}

function Example({
  title,
  children,
  className,
  containerClassName,
  ...props
}: React.ComponentProps<"div"> & { title?: string; containerClassName?: string }) {
  const { onTitle } = React.useContext(VariantContext)
  React.useLayoutEffect(() => onTitle(title), [title, onTitle])
  return (
    <div data-slot="example" className={cn("flex w-full max-w-3xl min-w-0 flex-col", containerClassName)} {...props}>
      <div
        data-slot="example-content"
        className={cn(
          "flex min-w-0 flex-1 flex-col items-start gap-6 rounded-xl bg-card p-6 text-foreground max-sm:relative max-sm:overflow-x-auto sm:p-12 *:[div:not([class*='w-'])]:w-full",
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

export { Example, ExampleWrapper, VariantContext }
