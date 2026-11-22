import {
  Example,
  ExampleWrapper,
} from "@/components/example"
import { Quiz, QuizView } from "@/components/quiz"

const quiz = {
  id: "closest-planet",
  q: "Which planet is closest to the sun?",
  choices: [
    { id: "venus", text: "Venus" },
    { id: "mercury", text: "Mercury" },
    { id: "mars", text: "Mars" },
    { id: "earth", text: "Earth" },
  ],
  why: "Mercury orbits at about 0.39 AU, closer than any other planet.",
}

const noop = () => {}

// Stands in for the server, which decides correctness in the app. Answers after a second.
const pretendServer = (choiceId: string) =>
  new Promise<{ correct: boolean }>((resolve) =>
    setTimeout(() => resolve({ correct: choiceId === "mercury" }), 1000)
  )

export default function QuizExample() {
  return (
    <ExampleWrapper>
      <QuizTry />
      <QuizUnanswered />
      <QuizInFlight />
      <QuizWrong />
      <QuizRight />
      <QuizSettled />
      <QuizNotRecorded />
    </ExampleWrapper>
  )
}

function QuizTry() {
  return (
    <Example title="Try it">
      <Quiz {...quiz} onAnswer={pretendServer} />
    </Example>
  )
}

function QuizUnanswered() {
  return (
    <Example title="Unanswered">
      <QuizView {...quiz} state={{ status: "unanswered" }} onChoose={noop} />
    </Example>
  )
}

function QuizInFlight() {
  return (
    <Example title="In flight">
      <QuizView
        {...quiz}
        state={{ status: "in-flight", choiceId: "venus" }}
        onChoose={noop}
      />
    </Example>
  )
}

function QuizWrong() {
  return (
    <Example title="Wrong">
      <QuizView
        {...quiz}
        state={{ status: "wrong", choiceId: "venus" }}
        onChoose={noop}
      />
    </Example>
  )
}

function QuizRight() {
  return (
    <Example title="Right">
      <QuizView
        {...quiz}
        state={{ status: "right", choiceId: "mercury" }}
        onChoose={noop}
      />
    </Example>
  )
}

function QuizSettled() {
  return (
    <Example title="Settled">
      <Quiz
        {...quiz}
        recorded={{ choiceId: "mercury", correct: true }}
        onAnswer={pretendServer}
      />
    </Example>
  )
}

function QuizNotRecorded() {
  return (
    <Example title="Not recorded">
      <QuizView
        {...quiz}
        state={{ status: "unanswered" }}
        error="That answer was not recorded. Try again."
        onChoose={noop}
      />
    </Example>
  )
}
