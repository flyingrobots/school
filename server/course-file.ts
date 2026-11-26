// A course's own declaration about itself (flyingrobots/school#143): `course.json`, beside
// `lessons/` and `reference/`. Optional; today it holds only the title the pages show. It is read
// once, when the server starts, and a file that is there but malformed stops the start, because a
// course named wrongly everywhere is worse than a course that refuses to load.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export class CourseFileError extends Error {}

/** The file's shape. Strict, so a misspelt key is refused rather than ignored. */
const CourseFile = z.strictObject({
  title: z.string().trim().min(1, "must not be empty"),
});

export type CourseFile = { title: string | null; summary: string | null; author: string | null; license: string | null; format: number | null };
const NOT_YET = { summary: null, author: null, license: null, format: null }; // flyingrobots/school#209: not implemented yet

/** The course at `root`'s declaration, or `{ title: null }` when it has no course.json. Throws CourseFileError when it is malformed. */
export function readCourseFile(root: string): CourseFile {
  const path = join(root, "course.json");
  if (!existsSync(path)) return { title: null, ...NOT_YET };
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
  return { title: parsed.data.title, ...NOT_YET };
}
