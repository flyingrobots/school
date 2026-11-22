// Renderers: one function per (view, block type). Adding a view means adding
// one entry to VIEWS; adding a block type fails to compile until every view
// handles it.
import type { Block, NestNode } from "./blocks.ts";

export type View = "web" | "slides";
export const isView = (v: string | null): v is View => v === "web" || v === "slides";

export type Nav = { prev?: Block; next?: Block };

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

function nest(n: NestNode): string {
  const atoms = n.atoms.map((a) => `<span class="atom">${esc(a)}</span>`).join("");
  const edge = n.edge === undefined ? "" : `<span class="edge">${esc(n.edge)}</span>`;
  return `<div class="nest"><span class="lbl">${esc(n.label)}</span>${atoms}${n.children.map(nest).join("")}</div>${edge}`;
}

// Body renderer shared by both views; containers are handled per view.
function leaf(b: Block, render: (b: Block) => string): string {
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
      return `<div class="q" data-block="${esc(b.id)}" data-why="${esc(b.why)}"><p>${b.q}</p>${b.choices
        .map((c) => `<button data-choice="${esc(c.id)}" data-correct="${c.correct}">${esc(c.text)}</button>`)
        .join("")}<p class="fb"></p></div>`;
    case "explain":
      return `<div class="explain" data-block="${esc(b.id)}"><p>${b.prompt}</p><details><summary>Model answer</summary><p>${b.model}</p></details></div>`;
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

function shell(title: string, view: View, body: string): string {
  const css = view === "slides" ? `<link rel="stylesheet" href="/assets/slides.css">` : "";
  const js = view === "slides" ? `<script src="/assets/slides.js"></script>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/item.css"><link rel="stylesheet" href="/assets/style.css"><link rel="stylesheet" href="/assets/nest.css">${css}</head>
<body class="view-${view}">${body}<script src="/assets/quiz.js"></script>${js}</body></html>`;
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

export function renderPage(courseName: string, page: Block, view: View, nav: Nav, hasReference = false): string {
  if (page.type !== "page") throw new Error(`renderPage: ${page.id} is not a page`);
  const render = (b: Block): string => leaf(b, render);
  const header = `<h1>${esc(page.title)}</h1><p class="subtitle">${page.subtitle}</p>`;
  const meta = `<div id="school-meta" data-course="${esc(courseName)}" data-lesson="${esc(page.id)}" hidden></div>`;
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

export function renderCourse(courseName: string, pages: readonly Block[], reference: readonly string[] = []): string {
  const base = `/courses/${esc(courseName)}`;
  const rows = pages.map((p, i) => p.type !== "page" ? "" :
    `${i > 0 ? '<div class="item-sep"></div>' : ""}<a class="item" href="${base}/lessons/${esc(p.id)}">
<div class="item-media icon">${i + 1}</div>
<div class="item-content"><div class="item-title">${esc(p.title)}</div><div class="item-desc">${esc(p.subtitle ?? p.id)}</div></div>
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
