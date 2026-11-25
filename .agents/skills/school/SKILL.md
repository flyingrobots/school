---
name: school
description: Write or revise a School course, a folder of lessons in School's block JSON with quizzes and explain blocks, and check it with `school check` before saying it is done. Use when asked to create a course, add or change a lesson, quiz or explain block, or fix a course that School refuses to load.
---

# Writing a School course

A School course is a folder: `course.json`, `lessons/*.json` in School's block JSON, and
`reference/*.html`. School reads it and never writes to it. Learners' answers live in School's own
database, never in the course.

`example/` beside this file is a small, complete course that School serves. Copy its shape.

## Read first

These are the living references. Do not work from memory of them, because they change:

- [A course's folder](https://github.com/flyingrobots/school/blob/main/docs/topics/course-format/README.md):
  the files, `course.json`, a lesson's hook, and `school check`.
- [Lesson blocks](https://github.com/flyingrobots/school/blob/main/docs/topics/course-format/blocks.md):
  every block type, its keys, and every rule the loader enforces.
- [School's voice](https://github.com/flyingrobots/school/blob/main/docs/topics/voice/README.md):
  encouraging or neutral, inviting with questions and never commanding.
- [The glossary's teaching loop](https://github.com/flyingrobots/school/blob/main/docs/glossary.md#the-teaching-loop):
  objectives, resources, and fluency versus storage strength.

In a School checkout the same pages are under `docs/`.

## Write a course

1. **Objectives first.** `OBJECTIVES.md` says what a learner can do after the course, as a
   numbered list of things they could show. Every lesson serves one or more of them.
2. **Sources, not memory.** Knowledge comes from high-trust sources, never from what you happen to
   recall. List them in `RESOURCES.md` with what each one supports. If you cannot read the sources
   (no web access, a book you don't have), say so plainly in `RESOURCES.md`, mark every claim
   written without them as unsourced, and tell the person who asked. Never list a source you did
   not read as if you had.
3. **One lesson per file**, numbered so file-name order is course order:
   `lessons/0001-<slug>.json`, `0002-…`. Each file's root is a `page` with a `title`, a
   `subtitle` and a `hook`. The hook's `question` is the one the lesson answers, worth wanting
   answered. Name things after the lesson's slug: the page id is the slug without its number
   (`places-worth-twice`), and every block id in the lesson starts with a short form of it
   (`places-q-read`), so ids stay unique across the course.
4. **Teach, then practise.** Reading blocks (`prose`, `card`, `quote`, `aside`, `nest`) inside
   `section`s, then the lesson's quizzes, then one `explain` block. A quiz checks one idea the
   lesson actually taught.
5. **Quizzes.** Exactly one right choice and plausible wrong ones. A `why` that teaches, because
   it shows after a right answer. Choice ids that name what the choice means (`treble`, not `a`),
   so reordering or rewording keeps the learner's history.
6. **Explain blocks.** The `prompt` is a question, with any constraint inside it ("How would you
   explain X to a friend, in under a minute?"). The `model` is a short answer a strong learner
   could give. The `sources` hold the passages the grader may quote, taken from the lesson's own
   text.
7. **Reuse with `ref`.** To bring an earlier quiz back in a later lesson, write
   `{ "ref": "<id>" }`. It is the same block with one history. A copy under a new id would start
   a new one.
8. **Reference documents.** `reference/*.html` is the cheat sheet a learner comes back to, such as
   a glossary. Keep it short and durable.
9. **Check it.** From a School checkout run `./school check <course-folder>`. Exit 0 means School
   would serve it. Otherwise the error line names the first problem and its file. Fix it, run the
   check again, and repeat until it exits 0. Never say a course is ready before this passes.
   The check proves structure only. It cannot tell whether a claim is true, a source supports it,
   or the copy keeps School's voice. Read the course back for those yourself.

## Revise a course

- **Keep every id a learner may have used**: block ids and choice ids. A changed id loses that
  block's history and starts a new block. Adding blocks is always safe.
- Removing a quiz removes it from review too: School reviews only the quizzes it serves now.
- A course's name in School (`SCHOOL_COURSES`) is the key its progress is filed under. Do not
  rename it by hand. Renaming has its own job, in the migrate-job reference.
- If the course has a generator (the bells course has `tools/generate.py`), edit the generator
  and run it, never the JSON it writes.
- Run `./school check` after every change.

## Voice

Encouraging or neutral, always. Invite with questions. Never write "wrong", "fail", "mistake",
"attempt" or "retry", and never use a score. Say "a draft", "on a second go", "not yet". The
voice reference has the full table.

## Install

This skill lives in the School repository at `.agents/skills/school/`. Install it for every agent
on a machine with agent-hub:

```sh
sync-agents --skill <school-checkout>/.agents/skills/school
```

After the skill changes, run the same command with `--force-skill`.
