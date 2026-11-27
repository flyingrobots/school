// Asking about a passage, on the server (RFC 6 §5.3 to §5.5; flyingrobots/school#227).
import { z } from "zod";
import type { Block } from "./blocks.ts";
import type { ReplySource } from "./core/model.ts";

/** Material an answer may quote: a part of the lesson, or a reference document. */
export type AskSource = { id: string; title: string; text: string };
/** One earlier turn of the conversation, from the record. */
export type Turn = { question: string; answer: string | null };
export type PromptInput = { page: Block; references: readonly AskSource[]; passage: string; question: string; earlier: readonly Turn[] };
export type Quote = { sourceId: string; quote: string };

export const REFERENCE_MAX = 100_000;

const notYet = (): never => { throw new Error("not implemented"); };

export function passageInLesson(_page: Block, _blockId: string, _passage: string): boolean { return notYet(); }
export function lessonSources(_page: Block): AskSource[] { return notYet(); }
export function askPrompt(_i: PromptInput): { prompt: string; sources: AskSource[] } { return notYet(); }
export function citations(): { push(delta: string): string; end(): { tail: string; quotes: Quote[] } } { return notYet(); }
export function checkSources(_quotes: readonly Quote[], _sources: readonly AskSource[]): ReplySource[] { return notYet(); }

export const AskLine = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stored"), conversationId: z.string(), questionId: z.string() }).strict(),
  z.object({ type: z.literal("delta"), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal("sources"), sources: z.array(z.object({ sourceId: z.string(), title: z.string(), quote: z.string() }).strict()) }).strict(),
  z.object({ type: z.literal("done"), agent: z.string().nullable() }).strict(),
  z.object({ type: z.literal("failed"), error: z.string().min(1) }).strict(),
]);
export type AskLine = z.infer<typeof AskLine>;
