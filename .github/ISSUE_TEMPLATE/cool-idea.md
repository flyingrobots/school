---
name: Cool idea
about: "Use for an idea worth keeping that is not designed yet. Its first deliverable is a plan, not code."
labels: lane:inbox, cool-idea, needs-plan
---

```yaml
.dag: issue-dag/2
.id: flyingrobots/school#NEW
.kind: task
.type: feature
.blocked_by: []
.size_hours: 4
```

# Cool idea

```text
You are the planner for this issue, not the builder. Read all sections of this issue.
Do not write product code for it.
Write a plan (an RFC, or a design note where the repository has no RFCs) that answers the open
questions in section 2b and is decided by the maintainer.
Split the decided work into task issues from the repository's templates, each one independently
mergeable, with honest .blocked_by entries, and a container issue that lists them in .children.
Then remove the needs-plan label. Close this issue when the plan is merged and the tasks exist.
Read docs/working-notes.md and the project's conventions before you write the plan.
```

<!--
issue-dag/2 frontmatter (Taskalisk): after GitHub assigns the number, replace NEW in `.id` with it; a block
whose `.id` does not name the issue fails. Every reference is owner/repo#N, never a bare #N.
.size_hours estimates the plan, not the build. Write "none" or "not applicable, because X" instead of
padding a section.
-->

## 1. Background Context
Whose idea, when, and what exists today that it builds on.

## 2. Problem Description
What someone cannot do, or does badly, today.

## 2b. Proposed Solution
The idea in a paragraph, then its open questions as a list.

## 2c. Alternatives considered and rejected
none yet

## 2d. Acceptance Criteria
- A plan answering the open questions is written and decided.
- The decided work is filed as task issues with `.blocked_by` filled in.

## 2e. Test Plan
not applicable, because this issue produces a plan; the task issues it spawns carry the tests.

## 3. Prerequisites
- [ ] none

## 4. Scope
In: the plan and the split. Out: building it.

## 5. Why now
Captured now so it is not lost; it is not scheduled.

## 6. Risks
What it could break, expose or make worse.

## 7. Definition of Done
The plan is merged with a decision, the task issues exist, and `needs-plan` is removed.

## 8. Stakeholders
## 9. Related Issues
