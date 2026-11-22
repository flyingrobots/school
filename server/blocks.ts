// Block model: a lesson is a tree of blocks rooted at a `page`. Blocks are
// validated when loaded, and `{ "ref": id }` entries are resolved against
// every block with an id across all lesson files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type NestNode = { label: string; atoms: string[]; edge?: string; children: NestNode[] };
/** A quiz choice. `id` is stable for the choice's meaning, so a recorded answer survives rewording or reordering. */
export type Choice = { id: string; text: string; correct: boolean };

const CHOICE_ID = /^[a-z0-9-]+$/;

export type Block =
  | { type: "page"; id: string; title: string; subtitle: string; children: Block[] }
  | { type: "section"; id: string; title: string; children: Block[] }
  | { type: "prose"; id: string; html: string }
  | { type: "card"; id: string; html: string }
  | { type: "quote"; id: string; html: string }
  | { type: "aside"; id: string; html: string }
  | { type: "quiz"; id: string; q: string; choices: Choice[]; why: string }
  | { type: "explain"; id: string; prompt: string; model: string; sources: Source[] }
  | { type: "nest"; id: string; root: NestNode };

/** Material an explanation is graded against. `id` is what a grader's quote cites. */
export type Source = { id: string; title: string; text: string };

export class BlockError extends Error {}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function str(o: Obj, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new BlockError(`${where}: "${key}" must be a string`);
  return v;
}

function arr(o: Obj, key: string, where: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) throw new BlockError(`${where}: "${key}" must be an array`);
  return v;
}

function parseNest(v: unknown, where: string): NestNode {
  if (!isObj(v)) throw new BlockError(`${where}: nest node must be an object`);
  const atoms = (v.atoms === undefined ? [] : arr(v, "atoms", where)).map((a) => {
    if (typeof a !== "string") throw new BlockError(`${where}: atoms must be strings`);
    return a;
  });
  const children = (v.children === undefined ? [] : arr(v, "children", where)).map((c) => parseNest(c, where));
  const node: NestNode = { label: str(v, "label", where), atoms, children };
  if (v.edge !== undefined) node.edge = str(v, "edge", where);
  return node;
}

// A raw child is either a block or a reference to one by id.
type Raw = { kind: "block"; block: Block } | { kind: "ref"; id: string };

type Ctx = { out: Map<string, Block>; pending: Map<Block, Raw[]> };

function parseRaw(v: unknown, where: string, ctx: Ctx): Raw {
  const { out, pending } = ctx;
  if (!isObj(v)) throw new BlockError(`${where}: block must be an object`);
  if (typeof v.ref === "string") return { kind: "ref", id: v.ref };
  const id = str(v, "id", where);
  const at = `${where} > ${id}`;
  const kids = () => arr(v, "children", at).map((c) => parseRaw(c, at, ctx));
  let block: Block;
  const type = str(v, "type", at);
  switch (type) {
    case "page":
      block = { type, id, title: str(v, "title", at), subtitle: str(v, "subtitle", at), children: [] };
      pending.set(block, kids());
      break;
    case "section":
      block = { type, id, title: str(v, "title", at), children: [] };
      pending.set(block, kids());
      break;
    case "prose":
    case "card":
    case "quote":
    case "aside":
      block = { type, id, html: str(v, "html", at) };
      break;
    case "quiz": {
      const seen = new Set<string>();
      const choices = arr(v, "choices", at).map((c) => {
        if (!isObj(c) || typeof c.id !== "string" || typeof c.text !== "string" || typeof c.correct !== "boolean")
          throw new BlockError(`${at}: each choice needs "id", "text" and "correct"`);
        if (!CHOICE_ID.test(c.id)) throw new BlockError(`${at}: choice id "${c.id}" must match ${CHOICE_ID.source}`);
        if (seen.has(c.id)) throw new BlockError(`${at}: duplicate choice id "${c.id}"`);
        seen.add(c.id);
        return { id: c.id, text: c.text, correct: c.correct };
      });
      if (choices.filter((c) => c.correct).length !== 1) throw new BlockError(`${at}: exactly one choice must be correct`);
      block = { type, id, q: str(v, "q", at), choices, why: str(v, "why", at) };
      break;
    }
    case "explain": {
      const seen = new Set<string>();
      const sources = (v.sources === undefined ? [] : arr(v, "sources", at)).map((x) => {
        if (!isObj(x) || typeof x.id !== "string" || typeof x.title !== "string" || typeof x.text !== "string")
          throw new BlockError(`${at}: each source needs "id", "title" and "text"`);
        if (!CHOICE_ID.test(x.id) || x.id === "model") throw new BlockError(`${at}: source id "${x.id}" must match ${CHOICE_ID.source} and not be "model"`);
        if (seen.has(x.id)) throw new BlockError(`${at}: duplicate source id "${x.id}"`);
        seen.add(x.id);
        return { id: x.id, title: x.title, text: x.text };
      });
      block = { type, id, prompt: str(v, "prompt", at), model: str(v, "model", at), sources };
      break;
    }
    case "nest":
      block = { type, id, root: parseNest(v.root, at) };
      break;
    default:
      throw new BlockError(`${at}: unknown block type "${type}"`);
  }
  if (out.has(id)) throw new BlockError(`${at}: duplicate block id`);
  out.set(id, block);
  return { kind: "block", block };
}

export type Library = { pages: Block[]; byId: Map<string, Block> };

/** Load every `*.json` lesson in `dir` and resolve references. Throws BlockError on any problem. */
export function loadLibrary(dir: string): Library {
  const pending = new Map<Block, Raw[]>(); // containers resolved after every file is parsed
  const byId = new Map<string, Block>();
  const pages: Block[] = [];
  // A course with no lessons directory is a course with no lessons yet, not a broken one.
  if (!existsSync(dir)) return { pages, byId };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      throw new BlockError(`${file}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
    const raw = parseRaw(json, file, { out: byId, pending });
    if (raw.kind !== "block" || raw.block.type !== "page") throw new BlockError(`${file}: root must be a page block`);
    pages.push(raw.block);
  }
  for (const [block, raws] of pending) {
    if (block.type !== "page" && block.type !== "section") continue;
    block.children = raws.map((r) => {
      if (r.kind === "block") return r.block;
      const target = byId.get(r.id);
      if (target === undefined) throw new BlockError(`${block.id}: unknown ref "${r.id}"`);
      return target;
    });
  }
  rejectCycles(pages);
  return { pages, byId };
}

const childrenOf = (b: Block): Block[] => (b.type === "page" || b.type === "section" ? b.children : []);

/**
 * Refs make the resolved lessons a graph, not a tree. Sharing one block from several parents
 * (a diamond) is allowed; a block that contains itself, directly or not, is not, because the
 * renderer would recurse forever. Depth-first with an explicit path so the error names the cycle.
 */
function rejectCycles(pages: readonly Block[]): void {
  const done = new Set<Block>();
  const path: Block[] = [];
  const visit = (b: Block): void => {
    if (done.has(b)) return;
    const at = path.indexOf(b);
    if (at !== -1) {
      const cycle = [...path.slice(at), b].map((x) => x.id).join(" > ");
      throw new BlockError(`reference cycle: ${cycle}`);
    }
    path.push(b);
    for (const c of childrenOf(b)) visit(c);
    path.pop();
    done.add(b);
  };
  for (const p of pages) visit(p);
}

export type Load = { library: Library | null; error: BlockError | null };

/**
 * A loader that falls back to the last lesson set that loaded cleanly from each directory
 * (RFC 1: the server "keeps serving the previous valid set if validation fails"). The error
 * is returned on every failing load, so a fallback never hides a broken set silently.
 */
export function lastValidLoader(): (dir: string) => Load {
  const last = new Map<string, Library>();
  return (dir) => {
    try {
      const library = loadLibrary(dir);
      last.set(dir, library);
      return { library, error: null };
    } catch (e) {
      if (!(e instanceof BlockError)) throw e;
      return { library: last.get(dir) ?? null, error: e };
    }
  };
}
