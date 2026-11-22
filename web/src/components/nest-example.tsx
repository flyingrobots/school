import {
  Example,
  ExampleWrapper,
} from "@/components/example"
import { Nest, type NestNode } from "@/components/nest"

// Paper I's worked example: functions f and g, where f calls g. Every dot and every arrow of the
// call graph carries a graph of its own.
const warp: NestNode = {
  label: "skeleton: call graph",
  atoms: [],
  children: [
    {
      label: "dot f → syntax tree",
      atoms: ['"return"'],
      edge: "call",
      children: [{ label: "return value", atoms: ["x"], children: [] }],
    },
    { label: "dot g → syntax tree", atoms: ['"+"', "1"], children: [] },
    {
      label: "arrow f→g → provenance graph",
      atoms: ['"inlined"', "pass 3"],
      children: [],
    },
  ],
}

const deep: NestNode = {
  label: "program",
  atoms: [],
  children: [
    {
      label: "module parser",
      atoms: [],
      edge: "imports",
      children: [
        {
          label: "function parse",
          atoms: ["input"],
          children: [
            { label: "loop over tokens", atoms: ["token", "position"], children: [] },
            { label: "return tree", atoms: ["tree"], children: [] },
          ],
        },
      ],
    },
    {
      label: "module lexer",
      atoms: [],
      children: [{ label: "function tokens", atoms: ["text"], children: [] }],
    },
  ],
}

const atom: NestNode = { label: "an atom on its own", atoms: ["42"], children: [] }

export default function NestExample() {
  return (
    <ExampleWrapper>
      <NestThreeLevels />
      <NestFourLevels />
      <NestOneBox />
    </ExampleWrapper>
  )
}

function NestThreeLevels() {
  return (
    <Example title="Three levels" containerClassName="max-w-none" className="p-4 sm:p-12">
      <Nest id="warp-call-graph" root={warp} />
    </Example>
  )
}

function NestFourLevels() {
  return (
    <Example title="Four levels" containerClassName="max-w-none" className="p-4 sm:p-12">
      <Nest id="program" root={deep} />
    </Example>
  )
}

function NestOneBox() {
  return (
    <Example title="One box" containerClassName="max-w-none" className="p-4 sm:p-12">
      <Nest id="atom" root={atom} />
    </Example>
  )
}
