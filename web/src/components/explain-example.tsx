import {
  Example,
  ExampleWrapper,
} from "@/components/example"
import {
  Explain,
  ExplainView,
  type ExplainExplanation,
  type ExplainFindings,
  type ExplainState,
} from "@/components/explain"

const explain = {
  id: "why-seasons",
  prompt: "Explain why Earth has seasons.",
  model:
    "Earth's axis is tilted about 23.4° to its orbit. For part of the year one hemisphere leans toward the sun, so sunlight hits it more directly and its days are longer: that is its summer. Half a year later it leans away and has winter. Distance from the sun changes too little to matter.",
  sources: [
    {
      id: "tilt",
      title: "Axial tilt",
      text: "Earth's rotation axis is tilted about 23.4 degrees relative to the plane of its orbit, and it points the same way all year.",
    },
    {
      id: "orbit",
      title: "Earth's orbit",
      text: "Earth's distance from the sun varies by about 3% over a year. It is closest in early January, during the northern winter.",
    },
  ],
}

const explanation: ExplainExplanation = {
  submissionId: "example-submission",
  blockId: explain.id,
  text: "Earth is closer to the sun in summer and farther away in winter, so it gets more heat in summer.",
  at: "2026-11-22T12:00:00.000Z",
  grading: null,
}

const findings: ExplainFindings = {
  insufficient_evidence: false,
  fidelity: {
    verdict: "misses",
    note: "It says distance causes the seasons; the sources say Earth is closest to the sun in the northern winter.",
  },
  completeness: {
    verdict: "partly",
    note: "It names summer and winter, but not the tilt or why the hemispheres differ.",
  },
  accessibility: {
    verdict: "meets",
    note: "Plain words a newcomer can follow.",
  },
  contradictions: [
    {
      source_id: "orbit",
      quote: "It is closest in early January, during the northern winter.",
      note: "If distance caused summer, January would be summer in the north.",
      quote_verified: true,
    },
    {
      source_id: "tilt",
      quote: "the axis wobbles to face the sun in summer",
      note: "The grader quoted words the source does not contain.",
      quote_verified: false,
    },
  ],
  summary: "Clear, but the cause is wrong: the tilt, not the distance, makes the seasons.",
}

const noop = () => {}

// Stands in for the server, which stores and grades in the app. Each answers after a second.
const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 1000))
const pretendSave = (text: string) => later({ ...explanation, text })
const pretendGrade = () =>
  later<ExplainExplanation>({
    ...explanation,
    grading: { id: 1, status: "succeeded", findings, model: "pretend-grader", supersedes: null, at: "2026-11-22T12:01:00.000Z" },
  })

function View({ state, draft = "" }: { state: ExplainState; draft?: string }) {
  return (
    <ExplainView
      {...explain}
      state={state}
      draft={draft}
      onDraftChange={noop}
      onSave={noop}
      onGrade={noop}
    />
  )
}

export default function ExplainExample() {
  return (
    <ExampleWrapper>
      <ExplainTry />
      <ExplainEmpty />
      <ExplainSaving />
      <ExplainSaved />
      <ExplainGrading />
      <ExplainGraded />
      <ExplainInsufficient />
      <ExplainFailed />
      <ExplainNotSaved />
    </ExampleWrapper>
  )
}

function ExplainTry() {
  return (
    <Example title="Try it">
      <Explain {...explain} onSave={pretendSave} onGrade={pretendGrade} />
    </Example>
  )
}

function ExplainEmpty() {
  return (
    <Example title="Empty">
      <View state={{ status: "empty" }} />
    </Example>
  )
}

function ExplainSaving() {
  return (
    <Example title="Saving">
      <View state={{ status: "saving", text: explanation.text }} />
    </Example>
  )
}

function ExplainSaved() {
  return (
    <Example title="Saved">
      <View state={{ status: "saved", explanation }} />
    </Example>
  )
}

function ExplainGrading() {
  return (
    <Example title="Grading">
      <View state={{ status: "grading", explanation }} />
    </Example>
  )
}

function ExplainGraded() {
  return (
    <Example title="Graded">
      <View state={{ status: "graded", explanation, findings }} />
    </Example>
  )
}

function ExplainInsufficient() {
  return (
    <Example title="Not enough to judge">
      <View
        state={{
          status: "graded",
          explanation: { ...explanation, text: "Because." },
          findings: { ...findings, insufficient_evidence: true, contradictions: [], summary: "One word does not explain anything yet." },
        }}
      />
    </Example>
  )
}

function ExplainFailed() {
  return (
    <Example title="Failed">
      <View
        state={{ status: "failed", explanation, error: "The grader did not answer in time." }}
      />
    </Example>
  )
}

function ExplainNotSaved() {
  return (
    <Example title="Not saved">
      <ExplainView
        {...explain}
        state={{ status: "empty" }}
        draft={explanation.text}
        error="Your explanation was not saved. Try again."
        onDraftChange={noop}
        onSave={noop}
        onGrade={noop}
      />
    </Example>
  )
}
