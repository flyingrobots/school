# Lesson blocks

Reference: the block JSON a lesson file is written in. `server/blocks.ts` is the rule; this page
states every check it makes. How each block looks is in [the lesson page](../lesson-page/README.md#what-it-shows).

## Files

A course's `lessons/` folder holds one lesson per `*.json` file, read in file-name order, so
`0001-…json`, `0002-…json` keep lessons in order. A course with no `lessons/` folder has no lessons
yet; that is not an error. Other files in the folder are ignored.

Each file is valid JSON, and its root is a `page` block. All files load together: block ids are
unique across the whole course, and a `ref` can point into another file.

When any file breaks a rule below, the whole lesson set is refused, and the error names the file
and the path to the block (`0002-rounds.json > rounds > rounds-q1: exactly one choice must be correct`).
A running server keeps serving the last set that loaded and reports the error.

## Every block

Every block is a JSON object with a string `type` and a string `id`.

| Rule | Why |
| --- | --- |
| `id` is unique across every lesson file | The record keys answers, views and explanations by block id |
| `id` never starts with `school:` | School adds blocks of its own (the review section) under those ids |
| `type` is one of the nine below | Anything else is refused as an unknown block type |

Keep an `id` once learners have used it. Changing it starts a new block with no history.
Keys a type does not list are ignored.

## `page`

The root of a lesson file. It is shown as the lesson's title, subtitle and then its children.

| Key | Required | Holds |
| --- | --- | --- |
| `title` | yes | String |
| `subtitle` | yes | String; `""` is allowed |
| `children` | yes | Array of blocks or refs |
| `hook` | no | The lesson's question, teaser and figure for the home page ([a lesson's hook](README.md#a-lessons-hook)) |

```json
{
  "type": "page",
  "id": "rounds",
  "title": "Rounds",
  "subtitle": "Every bell in order, highest to lowest.",
  "hook": { "question": "Why does every method start and end in rounds?", "teaser": "It is the one row everyone can hear." },
  "children": [{ "type": "prose", "id": "rounds-intro", "html": "<p>Rounds is the row 1 2 3 4 5 6.</p>" }]
}
```

## `section`

A heading and its children. A section inside a section is a heading one level deeper.

| Key | Required | Holds |
| --- | --- | --- |
| `title` | yes | String |
| `children` | yes | Array of blocks or refs |

```json
{
  "type": "section",
  "id": "rounds-why",
  "title": "Why rounds",
  "children": [{ "type": "prose", "id": "rounds-why-text", "html": "<p>Rounds is where every change begins.</p>" }]
}
```

## `prose`, `card`, `quote` and `aside`

Reading blocks. Each one has a single key, `html` (required, a string). The HTML is sanitised
when it is shown. `prose` is shown plain, `card` in a card, `quote` as a quotation and `aside` as a
callout.

```json
{ "type": "card", "id": "rounds-card", "html": "<p><strong>Rounds:</strong> 1 2 3 4 5 6.</p>" }
```

```json
{ "type": "quote", "id": "rounds-quote", "html": "<p>Ring rounds until the band is steady.</p>" }
```

```json
{ "type": "aside", "id": "rounds-aside", "html": "<p>On a tower's bells, the treble is bell 1.</p>" }
```

## `quiz`

One question with choices, answered while reading.

| Key | Required | Holds |
| --- | --- | --- |
| `q` | yes | The question, a string |
| `choices` | yes | Array of `{ "id", "text", "correct" }`: two strings and a boolean |
| `why` | yes | A string explaining the answer, shown after a right answer |

- Exactly one choice has `"correct": true`.
- Each choice `id` matches `^[a-z0-9-]+$` and is unique within the quiz.
- Keep a choice's `id` tied to its meaning. A recorded answer survives rewording or reordering the
  choices, but not changing what an `id` means.

```json
{
  "type": "quiz",
  "id": "rounds-q1",
  "q": "Which bell sounds first in rounds?",
  "choices": [
    { "id": "treble", "text": "The treble, the highest bell", "correct": true },
    { "id": "tenor", "text": "The tenor, the lowest bell", "correct": false }
  ],
  "why": "Rounds runs from the highest bell down, so the treble leads."
}
```

## `explain`

The learner explains something in their own words, and a grader checks the explanation against the
sources.

| Key | Required | Holds |
| --- | --- | --- |
| `prompt` | yes | A question, in [School's voice](../voice/README.md): never a command |
| `model` | yes | A model answer, a string, shown after the learner saves |
| `sources` | no | Array of `{ "id", "title", "text" }`, all strings: what the grader may cite |

- Each source `id` matches `^[a-z0-9-]+$`, is unique within the block, and is not `model`.

```json
{
  "type": "explain",
  "id": "rounds-explain",
  "prompt": "How would you explain why a method starts and ends in rounds?",
  "model": "Rounds is the one row every ringer knows, so starting and ending there shows the method came back true.",
  "sources": [{ "id": "rounds-def", "title": "Rounds", "text": "Rounds is the bells rung in order from the treble to the tenor." }]
}
```

## `nest`

A tree of labelled ideas. `root` is required, and is a node:

| Key | Required | Holds |
| --- | --- | --- |
| `label` | yes | String |
| `atoms` | no | Array of strings |
| `edge` | no | String: how this node relates to its parent |
| `children` | no | Array of nodes |

```json
{
  "type": "nest",
  "id": "rounds-nest",
  "root": {
    "label": "A touch",
    "children": [
      { "label": "Rounds", "edge": "starts in", "atoms": ["1 2 3 4 5 6"] },
      { "label": "Changes", "edge": "then rings" }
    ]
  }
}
```

## Reuse by `ref`

Anywhere a page or section lists a child, `{ "ref": "<id>" }` places a block defined elsewhere,
in any lesson file. It is the same block, with one history, not a copy.

- The `id` must exist, or the set is refused (`unknown ref`).
- A block may appear under several parents, but never inside itself, directly or through other
  refs (`reference cycle`).

```json
{
  "type": "page",
  "id": "rounds-review",
  "title": "Rounds, again",
  "subtitle": "",
  "children": [
    { "type": "quiz", "id": "rounds-q2", "q": "Which bell sounds last in rounds?", "choices": [
      { "id": "tenor", "text": "The tenor", "correct": true },
      { "id": "treble", "text": "The treble", "correct": false }
    ], "why": "Rounds ends on the lowest bell." },
    { "type": "section", "id": "rounds-review-again", "title": "Once more", "children": [{ "ref": "rounds-q2" }] }
  ]
}
```
