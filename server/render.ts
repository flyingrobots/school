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
        .map((c) => `<button data-correct="${c.correct}">${esc(c.text)}</button>`)
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
<title>${esc(title)}</title><link rel="stylesheet" href="/assets/style.css"><link rel="stylesheet" href="/assets/nest.css">${css}</head>
<body class="view-${view}">${body}<script src="/assets/quiz.js"></script>${js}</body></html>`;
}

function navLinks(page: Block, nav: Nav, view: View, hasReference: boolean): string {
  const link = (b: Block | undefined, label: string) => (b === undefined ? "" : ` · <a href="/lessons/${esc(b.id)}">${label}</a>`);
  const other: View = view === "web" ? "slides" : "web";
  // No document name is assumed here: which reference material exists is the course's business.
  const reference = hasReference ? ` · <a href="/reference">Reference</a>` : "";
  return `<nav class="course"><a href="/">Home</a>${link(nav.prev, "← Previous")}${link(nav.next, "Next →")}${reference} · <a href="/lessons/${esc(page.id)}?view=${other}">${other === "slides" ? "Present" : "Read"}</a></nav>`;
}

const FOLLOW_UP = `<p class="aside">Anything unclear? Ask your teacher (the agent) a follow-up question. That's what it's for.</p>`;

export function renderPage(page: Block, view: View, nav: Nav, hasReference = false): string {
  if (page.type !== "page") throw new Error(`renderPage: ${page.id} is not a page`);
  const render = (b: Block): string => leaf(b, render);
  const header = `<h1>${esc(page.title)}</h1><p class="subtitle">${page.subtitle}</p>`;
  switch (view) {
    case "web":
      return shell(page.title, view, `${navLinks(page, nav, view, hasReference)}${header}${render(page)}${FOLLOW_UP}`);
    case "slides": {
      const slides = [header, ...page.children.map(render), FOLLOW_UP];
      return shell(page.title, view, `${navLinks(page, nav, view, hasReference)}${slides.map((s) => `<section class="slide">${s}</section>`).join("")}`);
    }
    default: {
      const never: never = view;
      return never;
    }
  }
}

const title = (file: string) => file.replace(/\.html$/, "").replace(/^\d+[-_]?/, "").replace(/[-_]+/g, " ").trim() || file;

export function renderIndex(pages: Block[], reference: string[] = [], notice?: string): string {
  const items = pages
    .map((p) => (p.type === "page" ? `<li><a href="/lessons/${esc(p.id)}">${esc(p.title)}</a> <span class="aside">${esc(p.id)}</span></li>` : ""))
    .join("");
  const lessons = items === "" ? `<p class="aside">No lessons yet.</p>` : `<ol>${items}</ol>`;
  const refs = reference.length === 0 ? "" : `<h2>Reference</h2><ul>${referenceItems(reference)}</ul>`;
  const head = notice === undefined ? "" : `<p class="aside">${esc(notice)}</p>`;
  return shell("School", "web", `<h1>School</h1>${head}<h2>Lessons</h2>${lessons}${refs}`);
}

function referenceItems(reference: string[]): string {
  return reference.map((f) => `<li><a href="/reference/${encodeURIComponent(f)}">${esc(title(f))}</a></li>`).join("");
}

export function renderReference(reference: string[]): string {
  const body = reference.length === 0
    ? `<p class="aside">This course has no reference documents.</p>`
    : `<ul>${referenceItems(reference)}</ul>`;
  return shell("Reference", "web", `<nav class="course"><a href="/">Home</a></nav><h1>Reference</h1>${body}`);
}
