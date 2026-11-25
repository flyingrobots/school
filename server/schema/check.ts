// The compile-time check RFC 3 §5 requires of school.graphql (flyingrobots/school#182): each type
// Wesley generates from the SDL equals the z.infer of the matching hand-written schema in
// server/core/model.ts. Nothing here runs; `bunx tsc -p server` fails when any pair disagrees.
// Regenerate school.generated.ts with the command in docs/working-notes.md, never by hand.
import type { z } from "zod";
import type * as M from "../core/model.ts";
import type * as W from "./school.generated.ts";

/** True only when A and B are the same type: TypeScript's own identity check, not assignability. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Fails to compile unless its argument is `true`. */
export type Assert<T extends true> = T;

type Block<K extends M.Block["type"]> = Extract<M.Block, { type: K }>;

export type Checks = [
  Assert<Equal<W.Choice, z.infer<typeof M.Choice>>>,
  Assert<Equal<W.Source, z.infer<typeof M.Source>>>,
  Assert<Equal<W.ProseBlock, Block<"prose">>>,
  Assert<Equal<W.CardBlock, Block<"card">>>,
  Assert<Equal<W.QuoteBlock, Block<"quote">>>,
  Assert<Equal<W.AsideBlock, Block<"aside">>>,
  Assert<Equal<W.QuizBlock, Block<"quiz">>>,
  Assert<Equal<W.ExplainBlock, Block<"explain">>>,
  Assert<Equal<W.Submission, z.infer<typeof M.Submission>>>,
  Assert<Equal<W.ExplanationSubmission, z.infer<typeof M.ExplanationSubmission>>>,
  Assert<Equal<W.ViewEvent, z.infer<typeof M.ViewEvent>>>,
  Assert<Equal<W.GradeRequest, z.infer<typeof M.GradeRequest>>>,
  Assert<Equal<W.AidRequest, z.infer<typeof M.AidRequest>>>,
  Assert<Equal<W.ExposureResult, z.infer<typeof M.ExposureResult>>>,
  Assert<Equal<W.SaveResult, z.infer<typeof M.SaveResult>>>,
  Assert<Equal<W.Encounter, z.infer<typeof M.Encounter>>>,
  Assert<Equal<W.SubmitResult, z.infer<typeof M.SubmitResult>>>,
  Assert<Equal<W.Recorded, z.infer<typeof M.Recorded>>>,
  Assert<Equal<W.LastStudied, z.infer<typeof M.LastStudied>>>,
  Assert<Equal<W.StudyDay, z.infer<typeof M.StudyDay>>>,
  Assert<Equal<W.Verdict, z.infer<typeof M.Verdict>>>,
  Assert<Equal<W.Criterion, z.infer<typeof M.Criterion>>>,
  Assert<Equal<W.Contradiction, z.infer<typeof M.Contradiction>>>,
  Assert<Equal<W.Findings, z.infer<typeof M.Findings>>>,
  Assert<Equal<W.LatestFeedback, z.infer<typeof M.LatestFeedback>>>,
  Assert<Equal<W.CheckedFindings, z.infer<typeof M.CheckedFindings>>>,
  Assert<Equal<W.Grading, z.infer<typeof M.Grading>>>,
  Assert<Equal<W.ExplanationState, z.infer<typeof M.ExplanationState>>>,
  Assert<Equal<W.EvidenceKind, z.infer<typeof M.EvidenceKind>>>,
  Assert<Equal<W.EvidenceRow, z.infer<typeof M.EvidenceRow>>>,
  Assert<Equal<W.DecisionChoice, z.infer<typeof M.DecisionChoice>>>,
  Assert<Equal<W.DecisionNoteInput, z.infer<typeof M.DecisionNoteInput>>>,
  Assert<Equal<W.DecisionNote, z.infer<typeof M.DecisionNote>>>,
  Assert<Equal<W.DecisionNoteResult, z.infer<typeof M.DecisionNoteResult>>>,
  Assert<Equal<W.DueReviewQuery, z.infer<typeof M.DueReviewQuery>>>,
  Assert<Equal<W.ReviewReason, z.infer<typeof M.ReviewReason>>>,
];
