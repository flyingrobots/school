// `school check <folder>` (flyingrobots/school#197): loads a course folder with School's own loader,
// the one the server uses (server/course-file.ts for course.json, server/blocks.ts for lessons/),
// and says whether School would serve it. It reads the folder and writes nothing.
//
//   bun check-course.ts <folder> [--human]
//   bun check-course.ts --help | --schema [--human]
//
// Output is JSON Lines on stdout and stderr alike, each line naming its schema in
// server/schemas/check/ (flyingrobots/school#120's rules, as for the migrate job): `start`, then
// `done` with the lessons it found, or one `error` line on stderr. The loader stops at the first
// problem, so that is the one reported. `--human` prints prose instead. Exit codes: 0 School would
// serve the course, 1 it would refuse it (or the check failed), 2 a bad argument or no such folder.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BlockError, loadLibrary, quizIds, type Block } from "./blocks.ts";
import { CourseFileError, readCourseFile } from "./course-file.ts";
import { jsonLines, loadSchemas } from "./jsonl.ts";

const KIND = "school.check";
const schemas = loadSchemas(join(import.meta.dir, "schemas", "check"));
const ids = { help: `${KIND}.help`, schema: `${KIND}.schema`, start: `${KIND}.start`, done: `${KIND}.done`,
  invalid: `${KIND}.error.invalid`, usage: `${KIND}.error.usage`, failed: `${KIND}.error.failed` };

const USAGE = "bun check-course.ts <folder> [--human] | --help | --schema";
const SUMMARY = "Load a course folder with School's own loader and say whether School would serve it. Reads the folder; writes nothing.";
const OPTIONS = [
  { flags: ["<folder>"], description: "The course's folder: the one holding course.json, lessons/ and reference/." },
  { flags: ["--help", "-h"], description: "Print this help and the schema of every message type, then exit 0." },
  { flags: ["--schema"], description: "Print every published message schema, then exit 0." },
  { flags: ["--human", "--humanize"], description: "Print prose instead of JSON Lines. Nothing else switches the format." },
];
const EXIT = [
  { code: 0, meaning: "School would serve the course; or --help or --schema printed." },
  { code: 1, meaning: "School would refuse the course (the error names the first problem), or the check itself failed." },
  { code: 2, meaning: "No folder, more than one, an unknown argument, or a folder that does not exist. Nothing was checked." },
];

type Lesson = { file: string; id: string; title: string; quizzes: number; explains: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The done line's author, license and format, as a prose line naming those the course declares; none when it declares none. */
function manifestLine(l: { author: string | null; license: string | null; format: number | null }): string[] {
  const parts = [l.author === null ? null : `by ${l.author}`, l.license === null ? null : `license ${l.license}`, l.format === null ? null : `format ${l.format}`];
  const declared = parts.filter((p) => p !== null);
  return declared.length === 0 ? [] : [`  ${declared.join("; ")}`];
}

function prose(l: Record<string, any>): string {
  switch (l._schema.id) {
    case ids.help:
      return [`check: ${l.summary}`, "", `usage: ${l.usage}`, "", "options:",
        ...l.options.map((o: { flags: string[]; description: string }) => `  ${o.flags.join(", ")}  ${o.description}`), "", "exit codes:",
        ...l.exit.map((e: { code: number; meaning: string }) => `  ${e.code}  ${e.meaning}`), "",
        "output: JSON Lines unless --human is given, each line one of these message types (--schema prints their schemas):",
        ...l.output.map((id: string) => `  ${id}`)].join("\n");
    case ids.schema: return `schema ${l.id} ${l.version}\n${JSON.stringify(l.schema, null, 2)}`;
    case ids.start: return `checking ${l.folder}`;
    case ids.done:
      return [`ok: ${l.title ?? "(no title declared)"}, ${plural(l.lessons.length, "lesson")}, ${plural(l.quizzes, "quiz", "quizzes")}, ${plural(l.explains, "explain block")}`,
        ...(l.summary === null ? [] : [`  ${l.summary}`]),
        ...manifestLine({ author: l.author, license: l.license, format: l.format }),
        ...l.lessons.map((x: Lesson) => `  ${x.file}  ${x.title}  (${plural(x.quizzes, "quiz", "quizzes")}, ${plural(x.explains, "explain block")})`)].join("\n");
    default: return `error (${l.error})${l.file ? ` in ${l.file}` : ""}: ${l.message}`;
  }
}

const args = process.argv.slice(2);
const human = args.includes("--human") || args.includes("--humanize");
const out = jsonLines({ kind: KIND, schemas, human, prose });
process.on("uncaughtException", out.crashHandler(ids.failed, { error: "failed", code: 1 }));
process.on("unhandledRejection", out.crashHandler(ids.failed, { error: "failed", code: 1 }));

function usage(message: string): never {
  out.emit("stderr", ids.usage, { event: "error", error: "usage", code: 2, message: `${message}; usage: ${USAGE}` });
  process.exit(2);
}

const FLAGS = ["--help", "-h", "--schema", "--human", "--humanize"];
const printSchemas = () => {
  for (const s of schemas.values()) out.emit("stdout", ids.schema, { event: "schema", id: s.id, version: s.version, schema: s.schema });
};
const unknown = args.filter((a) => a.startsWith("-") && !FLAGS.includes(a));
if (unknown.length > 0) usage(`unknown argument${unknown.length === 1 ? "" : "s"} ${unknown.join(" ")}`);
if (args.includes("--help") || args.includes("-h")) {
  out.emit("stdout", ids.help, { event: "help", command: "check", usage: USAGE, summary: SUMMARY, options: OPTIONS, exit: EXIT, output: [...schemas.keys()] });
  if (!human) printSchemas();
  process.exit(0);
}
if (args.includes("--schema")) {
  printSchemas();
  process.exit(0);
}
const folders = args.filter((a) => !a.startsWith("-"));
if (folders.length !== 1) usage(folders.length === 0 ? "no course folder given" : "give one course folder");
const folder = resolve(folders[0]!);
if (!existsSync(folder) || !statSync(folder).isDirectory()) usage(`${folder} is not a folder`);

/** Distinct explain blocks a page shows, counting one reused through `ref` once. */
function explainIds(b: Block, into = new Set<string>()): Set<string> {
  if (b.type === "explain") into.add(b.id);
  if (b.type === "page" || b.type === "section") for (const c of b.children) explainIds(c, into);
  return into;
}

out.emit("stdout", ids.start, { event: "start", folder });
const lessonsDir = join(folder, "lessons");
// The same files, in the same order, that loadLibrary reads.
const files = existsSync(lessonsDir) ? readdirSync(lessonsDir).filter((f) => f.endsWith(".json")).sort() : [];
try {
  const { title, summary, author, license, format } = readCourseFile(folder);
  const library = loadLibrary(lessonsDir);
  const lessons: Lesson[] = library.pages.map((p, i) => ({
    file: files[i]!, id: p.id, title: p.type === "page" ? p.title : p.id, quizzes: quizIds(p).size, explains: explainIds(p).size,
  }));
  const all = [...library.byId.values()];
  out.emit("stdout", ids.done, { event: "done", ok: true, folder, title, summary, author, license, format, lessons,
    quizzes: all.filter((b) => b.type === "quiz").length, explains: all.filter((b) => b.type === "explain").length });
  process.exit(0);
} catch (e) {
  if (!(e instanceof BlockError) && !(e instanceof CourseFileError)) throw e;
  // A lesson's problem starts with its file name; one that spans files (an unknown ref, a cycle) names none.
  const file = e instanceof CourseFileError ? "course.json" : files.find((f) => e.message.startsWith(`${f}:`) || e.message.startsWith(`${f} >`)) ?? null;
  out.emit("stderr", ids.invalid, { event: "error", error: "invalid", code: 1, file, message: e.message });
  process.exit(1);
}
