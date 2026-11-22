// Renderers: one function per (view, block type). Adding a view means adding
// one entry to VIEWS; adding a block type fails to compile until every view
// handles it.
import type { Block, NestNode } from "./blocks.ts";
import type { Recorded } from "./record.ts";
import type { ExplanationState } from "./explain.ts";

export type View = "web" | "slides";
export const isView = (v: string | null): v is View => v === "web" || v === "slides";

export type Nav = { prev?: Block; next?: Block };

/** The encounter a web page is served in, and what the learner has already answered in it. */
export type Progress = { encounterId: string; answers: readonly Recorded[]; explanations?: readonly ExplanationState[] };

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function nest(n: NestNode): string {
  const atoms = n.atoms.map((a) => `<span class="atom">${esc(a)}</span>`).join("");
  const edge = n.edge === undefined ? "" : `<span class="edge">${esc(n.edge)}</span>`;
  return `<div class="nest"><span class="lbl">${esc(n.label)}</span>${atoms}${n.children.map(nest).join("")}</div>${edge}`;
}

/**
 * A quiz, showing any answers already recorded in this encounter, so a reload shows the
 * learner's progress rather than a blank question. The database is the source of that state.
 */
function quiz(b: Extract<Block, { type: "quiz" }>, answered: readonly Recorded[]): string {
  const mine = answered.filter((a) => a.blockId === b.id);
  const last = mine.at(-1);
  const settled = mine.some((a) => a.correct);
  const buttons = b.choices.map((c) => {
    const cls = last?.choiceId === c.id ? ` class="${last.correct ? "ok" : "bad"}"` : "";
    return `<button data-choice="${esc(c.id)}" data-correct="${c.correct}"${cls}${settled ? " disabled" : ""}>${esc(c.text)}</button>`;
  }).join("");
  const fb = last === undefined ? "" : esc(`${last.correct ? "Correct." : "Not quite."} ${b.why}`.trim());
  const status = last === undefined ? "" : "Saved.";
  return `<div class="q" data-block="${esc(b.id)}" data-why="${esc(b.why)}"${settled ? ' data-settled="true"' : ""}><p>${esc(b.q)}</p>${buttons}<p class="fb" aria-live="polite">${fb}</p><p class="saved" aria-live="polite">${status}</p></div>`;
}

const VERDICT: Record<string, string> = { meets: "Meets", partly: "Partly", misses: "Misses" };

function gradingHtml(g: ExplanationState["grading"], submissionId: string): string {
  const retry = (label: string) => `<button type="button" data-act="grade" data-submission="${esc(submissionId)}">${label}</button>`;
  if (g === null) return `<p class="saved" aria-live="polite">Saved.</p>${retry("Get feedback")}`;
  if (g.status === "failed") {
    return `<p class="saved" role="status">Your explanation is saved. Automated feedback is unavailable. Retry when ready.</p>` +
      `<p class="why">${esc(g.error)}</p>${retry("Retry")}`;
  }
  const f = g.findings;
  if (f.insufficient_evidence) {
    return `<div class="feedback" role="status"><p><strong>Not enough to judge yet.</strong> ${esc(f.summary)}</p></div>`;
  }
  const row = (name: string, c: { verdict: string; note: string }) =>
    `<div class="crit"><dt>${name} <span class="verdict v-${esc(c.verdict)}">${esc(VERDICT[c.verdict] ?? c.verdict)}</span></dt><dd>${esc(c.note)}</dd></div>`;
  const conflicts = f.contradictions.length === 0 ? "" : `<p class="label">Conflicts with the sources</p><ul class="conflicts">${f.contradictions.map((c) =>
    `<li><q>${esc(c.quote)}</q> <span class="src">(${esc(c.source_id)}; ${c.quote_verified ? "quote found in the source" : "quote not found in the source"})</span><br>${esc(c.note)}</li>`).join("")}</ul>`;
  return `<div class="feedback" role="status"><p>${esc(f.summary)}</p><dl class="rubric">${row("Fidelity", f.fidelity)}${row("Completeness", f.completeness)}${row("Accessibility", f.accessibility)}</dl>${conflicts}</div>`;
}

const explainForm = () =>
  `<textarea rows="6" aria-label="Your explanation" placeholder="Explain it as if to someone new to it."></textarea>` +
  `<button type="button" data-act="submit">Submit explanation</button><p class="saved" aria-live="polite"></p>`;

/**
 * An explain block in the web view. Before an explanation is submitted it is a text box and the
 * model answer stays hidden, so the explanation is unaided. Afterwards it shows the learner's
 * text, the latest grading or an honest failure with a retry, and then the model answer.
 * Everything from the learner or the grader is escaped plain text.
 */
export function renderExplain(b: Extract<Block, { type: "explain" }>, state: ExplanationState | undefined): string {
  const open = `<div class="explain" data-block="${esc(b.id)}"${state ? ` data-submission="${esc(state.submissionId)}"` : ""}><p>${esc(b.prompt)}</p>`;
  if (state === undefined) return `${open}${explainForm()}</div>`;
  return `${open}<p class="label">Your explanation</p><blockquote class="mine">${esc(state.text)}</blockquote>` +
    gradingHtml(state.grading, state.submissionId) +
    `<details><summary>Model answer</summary><p>${esc(b.model)}</p></details>` +
    `<button type="button" class="secondary" data-act="again">Write a new explanation</button>` +
    `<template>${explainForm()}</template></div>`;
}

// Body renderer shared by both views; containers are handled per view.
function leaf(b: Block, render: (b: Block) => string, answered: readonly Recorded[] = [], explained?: readonly ExplanationState[]): string {
  switch (b.type) {
    case "prose":
      return b.html;
    case "card":
      return `<div class="card">${b.html}</div>`;
    case "quote":
      return `<blockquote>${b.html}</blockquote>`;
    case "aside":
      return `<p class="aside">${b.html}</p>`;
    case "quiz":
      return quiz(b, answered);
    case "explain":
      // Practice only where answers are recorded; a presentation shows the prompt and the answer.
      if (explained === undefined) {
        return `<div class="explain" data-block="${esc(b.id)}"><p>${esc(b.prompt)}</p><details><summary>Model answer</summary><p>${esc(b.model)}</p></details></div>`;
      }
      return renderExplain(b, explained.find((x) => x.blockId === b.id));
    case "nest":
      return nest(b.root);
    case "section":
      return `<h2>${esc(b.title)}</h2>${b.children.map(render).join("")}`;
    case "page":
      return b.children.map(render).join("");
    default: {
      const never: never = b;
      return never;
    }
  }
}

// Lucide's "settings" icon (ISC licence), drawn in the current text colour.
const COG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

function shell(title: string, view: View, body: string, scripts: readonly string[] = ["quiz.js", "explain.js"]): string {
  // Every page has the settings button and the Esc shortcut (nav.js); the settings page itself has a Back link instead.
  const cog = scripts.includes("settings.js") ? "" : `<a class="settings-cog" href="/settings" aria-label="Settings" title="Settings (Esc)">${COG}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/item.css"><link rel="stylesheet" href="/assets/style.css"><link rel="stylesheet" href="/assets/nest.css"></head>
<body class="view-${view}">${cog}${body}${[...scripts, "nav.js"].map((s) => `<script src="/assets/${s}"></script>`).join("")}</body></html>`;
}

export type SettingsView = { back: string; url: string | null; urlFrom: string; tokenSet: boolean; tokenFrom: string };

/**
 * The settings page. The connection form is rendered here; the agent list depends on the
 * bridge and is filled in by settings.js. The token is never in the page: only whether one is set.
 */
export function renderSettings(v: SettingsView): string {
  const locked = (from: string, name: string) =>
    from === "environment" ? `<p class="hint">Set by <code>${name}</code> in the server's environment, which overrides this page.</p>` : "";
  const tokenState = v.tokenSet
    ? (v.tokenFrom === "environment" ? "A token is set in the environment." : "A token is saved. Type a new one to replace it.")
    : "No token yet. Generate one, or paste the bridge's.";
  return shell("Settings", "web", `<nav class="course"><a href="${esc(v.back)}">\u2190 Back</a> <span class="sep">/</span> <span>Settings</span></nav>
<h1>Settings</h1>
<p class="subtitle">Press <kbd>Esc</kbd> to go back.</p>
<section class="panel" aria-labelledby="bridge-h">
<h2 id="bridge-h">Grading bridge</h2>
<p class="hint">Written explanations are graded by AI agents that the bridge runs on this computer, outside School. Start it in a terminal, then connect it here.</p>
<div id="bridge-status" class="status" role="status" aria-live="polite">Checking the bridge\u2026</div>
<form id="bridge-form" class="fields">
<label class="field"><span class="field-label">Bridge address</span>
<input name="url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:4748" value="${esc(v.url ?? "")}"${v.urlFrom === "environment" ? " disabled" : ""}></label>
${locked(v.urlFrom, "SCHOOL_BRIDGE_URL")}
<label class="field"><span class="field-label">Token</span>
<input name="token" type="password" autocomplete="off" spellcheck="false" placeholder="${v.tokenSet ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "At least 16 characters"}"${v.tokenFrom === "environment" ? " disabled" : ""}></label>
<p class="hint" id="token-state">${tokenState}</p>
${locked(v.tokenFrom, "SCHOOL_BRIDGE_TOKEN")}
<div class="actions"><button type="submit">Save connection</button>${v.tokenFrom === "environment" ? "" : `<button type="button" class="secondary" data-act="generate">Generate a token</button>`}</div>
<p class="form-msg" role="status" aria-live="polite"></p>
</form>
<div id="start-command" class="callout" hidden>
<p><strong>Start the bridge with this token.</strong> It is shown only now; School keeps it, but won't show it again.</p>
<pre><code></code></pre>
<button type="button" class="secondary" data-act="copy">Copy</button>
</div>
</section>
<section class="panel" aria-labelledby="agents-h">
<h2 id="agents-h">Agents</h2>
<p class="hint">Tried in order: if one is missing, fails, times out or gives an unusable answer, the next one runs. Write each command as you would type it. <code>{prompt}</code> becomes the prompt as one argument; without it, the prompt arrives on stdin. <code>{output_file}</code> is a file the agent may write its answer to. Commands run on this computer, so anyone who can open School can change them.</p>
<div id="agents"><p class="hint">Connect the bridge to edit its agents.</p></div>
</section>`, ["settings.js"]);
}

function navLinks(courseName: string, page: Block, nav: Nav, view: View, hasReference: boolean): string {
  const base = `/courses/${esc(courseName)}`;
  const link = (b: Block | undefined, label: string) =>
    b === undefined ? "" : ` <a href="${base}/lessons/${esc(b.id)}">${label}</a>`;
  const other: View = view === "web" ? "slides" : "web";
  // No document name is assumed here: which reference material exists is the course's business.
  const reference = hasReference ? ` <a href="${base}/reference">Reference</a>` : "";
  return `<nav class="course"><a href="/">School</a> <span class="sep">/</span> <a href="${base}">${esc(courseName)}</a>` +
    `${link(nav.prev, "\u2190 Previous")}${link(nav.next, "Next \u2192")}${reference}` +
    ` <a href="${base}/lessons/${esc(page.id)}?view=${other}">${other === "slides" ? "Present" : "Read"}</a></nav>`;
}

const FOLLOW_UP = `<p class="aside">Anything unclear? Ask your teacher (the agent) a follow-up question. That's what it's for.</p>`;

/**
 * `progress` is given for the web view only. Without it the page records nothing: the slides
 * view is a presentation, not practice (RFC 1, "Views").
 */
export function renderPage(courseName: string, page: Block, view: View, nav: Nav, hasReference = false, progress?: Progress): string {
  if (page.type !== "page") throw new Error(`renderPage: ${page.id} is not a page`);
  const answered = progress?.answers ?? [];
  const explained = progress === undefined ? undefined : progress.explanations ?? [];
  const render = (b: Block): string => leaf(b, render, answered, explained);
  const header = `<h1>${esc(page.title)}</h1><p class="subtitle">${esc(page.subtitle)}</p>`;
  const encounter = progress === undefined ? "" : ` data-encounter="${esc(progress.encounterId)}"`;
  const meta = `<div id="school-meta" data-course="${esc(courseName)}" data-lesson="${esc(page.id)}"${encounter} hidden></div>`;
  switch (view) {
    case "web":
      return shell(page.title, view, `${meta}${navLinks(courseName, page, nav, view, hasReference)}${header}${render(page)}${FOLLOW_UP}`);
    case "slides": {
      const slides = [header, ...page.children.map(render), FOLLOW_UP];
      return shell(page.title, view, `${meta}${navLinks(courseName, page, nav, view, hasReference)}${slides.map((s) => `<section class="slide">${s}</section>`).join("")}`);
    }
    default: {
      const never: never = view;
      return never;
    }
  }
}

const title = (file: string) => file.replace(/\.html$/, "").replace(/^\d+[-_]?/, "").replace(/[-_]+/g, " ").trim() || file;

export interface CourseSummary {
  readonly name: string;
  /** Null when the course's lessons could not be loaded at all. */
  readonly lessons: number | null;
  readonly reference: number;
}

/** School's landing page: the courses installed here, not any one course's lessons. */
export function renderLanding(summaries: readonly CourseSummary[]): string {
  if (summaries.length === 0) {
    return shell("School", "web", `<h1>School</h1>
<p class="subtitle">A framework for learning something properly.</p>
<div class="item-group outline"><div class="item"><div class="item-content">
<div class="item-title">No courses installed</div>
<div class="item-desc">Register one with <code>SCHOOL_COURSES="name=/path/to/course"</code>, then reload.</div>
</div></div></div>`);
  }
  const rows = summaries.map((s, i) => {
    const desc = s.lessons === null
      ? `<span class="badge">unreadable</span> its lessons could not be loaded`
      : `${s.lessons} lesson${s.lessons === 1 ? "" : "s"}${s.reference > 0 ? ` &middot; ${s.reference} reference` : ""}`;
    return `${i > 0 ? '<div class="item-sep"></div>' : ""}<a class="item" href="/courses/${esc(s.name)}">
<div class="item-media icon">${esc(s.name.slice(0, 2).toUpperCase())}</div>
<div class="item-content"><div class="item-title">${esc(s.name)}</div><div class="item-desc">${desc}</div></div>
<div class="item-actions" aria-hidden="true">&rarr;</div></a>`;
  }).join("");
  const n = summaries.length;
  return shell("School", "web", `<h1>School</h1>
<p class="subtitle">${n} course${n === 1 ? "" : "s"} installed.</p>
<div class="item-group outline">${rows}</div>`);
}

function referenceItems(courseName: string, reference: readonly string[]): string {
  const base = `/courses/${esc(courseName)}`;
  return reference.map((f) =>
    `<a class="item sm" href="${base}/reference/${encodeURIComponent(f)}">
<div class="item-content"><div class="item-title">${esc(title(f))}</div></div></a>`).join('<div class="item-sep"></div>');
}

/** The distinct quizzes a page shows, counting a block reused through `ref` once. */
export function quizIds(b: Block, into = new Set<string>()): Set<string> {
  if (b.type === "quiz") into.add(b.id);
  if (b.type === "page" || b.type === "section") for (const c of b.children) quizIds(c, into);
  return into;
}

export function renderCourse(courseName: string, pages: readonly Block[], reference: readonly string[] = [],
  progress: ReadonlyMap<string, ReadonlySet<string>> = new Map()): string {
  const base = `/courses/${esc(courseName)}`;
  const done = (p: Block) => {
    // Only quizzes the lesson still shows count, so an edited lesson never reads as over 100%.
    const ids = quizIds(p);
    const right = [...ids].filter((id) => progress.get(p.id)?.has(id)).length;
    return ids.size === 0 ? "" : `<div class="item-desc">${right} of ${ids.size} answered correctly</div>`;
  };
  const rows = pages.map((p, i) => p.type !== "page" ? "" :
    `${i > 0 ? '<div class="item-sep"></div>' : ""}<a class="item" href="${base}/lessons/${esc(p.id)}">
<div class="item-media icon">${i + 1}</div>
<div class="item-content"><div class="item-title">${esc(p.title)}</div><div class="item-desc">${esc(p.subtitle ?? p.id)}</div>${done(p)}</div>
<div class="item-actions" aria-hidden="true">&rarr;</div></a>`).join("");
  const lessons = rows === ""
    ? `<div class="item-group outline"><div class="item"><div class="item-content">
<div class="item-title">No lessons yet</div>
<div class="item-desc">A course's lessons are block JSON in its <code>lessons/</code> directory.</div>
</div></div></div>`
    : `<div class="item-group outline">${rows}</div>`;
  const refs = reference.length === 0 ? ""
    : `<h2>Reference</h2><div class="item-group outline">${referenceItems(courseName, reference)}</div>`;
  const nav = `<nav class="course"><a href="/">School</a> <span class="sep">/</span> <span>${esc(courseName)}</span></nav>`;
  return shell(courseName, "web", `${nav}<h1>${esc(courseName)}</h1><h2>Lessons</h2>${lessons}${refs}`);
}

export function renderReference(courseName: string, reference: readonly string[]): string {
  const base = `/courses/${esc(courseName)}`;
  const body = reference.length === 0
    ? `<p class="aside">This course has no reference documents.</p>`
    : `<div class="item-group outline">${referenceItems(courseName, reference)}</div>`;
  const nav = `<nav class="course"><a href="/">School</a> <span class="sep">/</span> <a href="${base}">${esc(courseName)}</a> <span class="sep">/</span> <span>Reference</span></nav>`;
  return shell("Reference", "web", `${nav}<h1>Reference</h1>${body}`);
}
