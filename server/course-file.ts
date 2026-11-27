// A course's own declaration about itself (flyingrobots/school#143, #209): `course.json`, beside
// `lessons/` and `reference/`. Optional; it holds the title the pages show and, optionally, the
// course's summary, author, license and the course format it is written in. It is read once, when
// the server starts, and a file that is there but malformed stops the start, because a course
// described wrongly everywhere is worse than a course that refuses to load.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { spdxProblem } from "./spdx.ts";

export class CourseFileError extends Error {}

/** The course format this School plays. A course that declares another is refused. */
export const COURSE_FORMAT = 1;

const text = () => z.string().trim().min(1, "must not be empty");

/** The file's shape. Strict, so a misspelt key is refused rather than ignored. */
const CourseFile = z.strictObject({
  title: text(),
  summary: text().optional(),
  author: text().optional(),
  license: text().superRefine((license, ctx) => {
    // An empty license has been refused above, as empty; saying what is wrong with its grammar as well would be a second reason.
    if (license.length === 0) return;
    const problem = spdxProblem(license);
    if (problem !== null) ctx.addIssue({ code: "custom", message: `must be an SPDX license expression, such as "MIT OR Apache-2.0": ${problem}` });
  }).optional(),
  format: z.number().int().min(1).superRefine((format, ctx) => {
    // A format that is not a positive integer has already been refused above.
    if (Number.isInteger(format) && format >= 1 && format !== COURSE_FORMAT) ctx.addIssue({ code: "custom", message: `is ${format}, but this School plays course format ${COURSE_FORMAT}` });
  }).optional(),
});

/** What a course declares about itself; each key is null when the course does not declare it. */
export type CourseFile = { title: string | null; summary: string | null; author: string | null; license: string | null; format: number | null };

/** The course at `root`'s declaration, every key null when it has no course.json. Throws CourseFileError when it is malformed. */
export function readCourseFile(root: string): CourseFile {
  const path = join(root, "course.json");
  if (!existsSync(path)) return { title: null, summary: null, author: null, license: null, format: null };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CourseFileError(`${path} is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  const parsed = CourseFile.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => (i.path.length > 0 ? `"${i.path.join(".")}" ${i.message}` : i.message)).join("; ");
    throw new CourseFileError(`${path} is not a course file: ${why}. It must be an object such as {"title": "My Course"}`);
  }
  const { title, summary, author, license, format } = parsed.data;
  return { title, summary: summary ?? null, author: author ?? null, license: license ?? null, format: format ?? null };
}
