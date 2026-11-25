// Reading aloud (flyingrobots/school#175): what School speaks, and the proxy to the bridge, which
// hands the text to the AI-TTS daemon on the host. The text is built here, never taken from the
// browser: a lesson as written, or the latest feedback. A lesson is read as the learner sees it
// before answering: its title and subtitle, its section titles, its prose, cards, quotes and asides,
// each quiz's question and each explain block's prompt. Nothing that gives an answer away is ever
// in it: no quiz choice (the correct one, or the others, which would leave it by elimination), no
// `why`, no model answer, no source an explanation is graded against, and no nest diagram.
import { z } from "zod";
import type { Block } from "./blocks.ts";
import type { BridgeClientConfig } from "./grade.ts";

/** A block's HTML as plain text: tags dropped, blocks as paragraphs, entities decoded. Scripts, styles and drawings are not read. */
export function htmlText(html: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
  return html
    .replace(/<(script|style|svg|template|math)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|ul|ol|h[1-6]|blockquote|section|figure|figcaption|table|tr|pre|dl|dt|dd)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return named[e.toLowerCase()] ?? all;
    })
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p !== "")
    .join("\n\n");
}

/** A lesson's spoken text, as Markdown, in the order the page shows it. */
export function lessonSpeech(page: Block): string {
  const parts: string[] = [];
  const walk = (b: Block, depth: number) => {
    switch (b.type) {
      case "page":
        parts.push(`# ${b.title}`);
        if (b.subtitle.trim() !== "") parts.push(b.subtitle.trim());
        for (const c of b.children) walk(c, depth);
        return;
      case "section":
        parts.push(`${"#".repeat(Math.min(depth + 2, 6))} ${b.title}`);
        for (const c of b.children) walk(c, depth + 1);
        return;
      case "prose":
      case "card":
      case "quote":
      case "aside": {
        const t = htmlText(b.html);
        if (t !== "") parts.push(t);
        return;
      }
      case "quiz":
        parts.push(b.q.trim());
        return;
      case "explain":
        parts.push(b.prompt.trim());
        return;
      case "nest":
        return;
    }
  };
  walk(page, 0);
  return parts.filter((p) => p !== "").join("\n\n") + "\n";
}

type Verdict = "meets" | "partly" | "misses";
type Criterion = { verdict: Verdict; note: string };
export type SpokenFeedback = {
  lessonTitle: string;
  prompt: string | null;
  findings: { summary: string; fidelity: Criterion; completeness: Criterion; accessibility: Criterion };
};

// School's voice (docs/topics/voice/README.md): results are words, and "misses" is "Not yet", as on the home page's card.
const VERDICT: Record<Verdict, string> = { meets: "Meets", partly: "Partly", misses: "Not yet" };

/** The latest feedback's spoken text: what the home page's card shows, in its order. */
export function feedbackSpeech(f: SpokenFeedback): string {
  const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
  const parts = [`# Feedback on your explanation of ${f.lessonTitle}`];
  if (f.prompt !== null && f.prompt.trim() !== "") parts.push(f.prompt.trim());
  if (f.findings.summary.trim() !== "") parts.push(f.findings.summary.trim());
  for (const [key, name] of [["fidelity", "Fidelity"], ["completeness", "Completeness"], ["accessibility", "Accessibility"]] as const) {
    const c = f.findings[key];
    parts.push(`${name}: ${VERDICT[c.verdict]}.${c.note.trim() === "" ? "" : ` ${sentence(c.note.trim())}`}`);
  }
  return parts.join("\n\n") + "\n";
}

/** What the browser may ask to hear: a lesson, or the latest feedback. Never text. */
export const SpeakRequest = z.union([
  z.object({ course: z.string().min(1), lesson: z.string().min(1) }).strict(),
  z.object({ feedback: z.literal(true) }).strict(),
]);

export const UTTERANCE = /^utt_[0-9a-f]{32}$/;
export const SEGMENT = /^[0-9]{1,6}$/;

const PASSED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];

/**
 * One request to the bridge's /speak routes, as the browser's answer. Without a bridge, or when it
 * cannot be reached, a 503 that says so in words. The token goes only in the Authorization header
 * to the bridge; nothing the bridge sends back but its JSON body, or a segment's bytes and these
 * headers, reaches the browser.
 */
export async function toSpeech(c: BridgeClientConfig | null, why: string, method: "GET" | "POST", path: string, init: { body?: unknown; range?: string | null } = {}): Promise<Response> {
  const unavailable = (error: string, status = "no bridge") => Response.json({ status, error }, { status: 503, headers: { "cache-control": "no-store" } });
  if (c === null) return unavailable(why);
  let res: Response;
  try {
    res = await fetch(`${c.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${c.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.range ? { range: init.range } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return unavailable(`The bridge could not be reached (${e instanceof Error ? e.message : String(e)}), so School cannot read aloud right now. Check that the bridge is running.`, "unreachable");
  }
  if (res.status === 401) return Response.json({ status: "unauthorised", error: "The bridge refused School's token, so School cannot read aloud. Check the token in Settings." }, { status: 502 });
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("audio/")) {
    const headers: Record<string, string> = { "cache-control": "no-store" };
    for (const h of PASSED_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) headers[h] = v;
    }
    return new Response(res.body, { status: res.status, headers });
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  // A bridge from before reading aloud has no /speak routes.
  if (res.status === 404 && path === "/speak") return unavailable("This bridge is older than reading aloud. Update and restart the bridge, then try again.", "unsupported");
  if (body === null) return Response.json({ status: "invalid", error: "The bridge's reply was not JSON." }, { status: 502 });
  return Response.json(body, { status: res.status, headers: { "cache-control": "no-store" } });
}
