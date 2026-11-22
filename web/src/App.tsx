import { ModeToggle } from "@/components/mode-toggle"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"

export function App() {
  return (
    <div className="mx-auto flex min-h-svh max-w-2xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">School</h1>
        <ModeToggle />
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Explain it</CardTitle>
          <CardDescription>Say why a lesson is a tree of blocks rather than one HTML file.</CardDescription>
        </CardHeader>
        <CardContent>
          <Field>
            <FieldLabel htmlFor="explanation">Your explanation</FieldLabel>
            <Textarea id="explanation" placeholder="Explain it as if to someone new to it." />
            <FieldDescription>Saved before it's graded.</FieldDescription>
          </Field>
        </CardContent>
        <CardFooter className="gap-2">
          <Button>Submit explanation</Button>
          <Badge variant="secondary">Fidelity: meets</Badge>
        </CardFooter>
      </Card>
    </div>
  )
}

export default App
