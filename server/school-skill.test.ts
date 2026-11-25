// The school skill (flyingrobots/school#193), .agents/skills/school/: its frontmatter names it, and
// its worked example is a course School would serve (run through `school check`, server/check-course.ts),
// showing every block type, with explain prompts written as questions (docs/topics/voice).
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKILL = join(import.meta.dir, "..", ".agents", "skills", "school");
const EXAMPLE = join(SKILL, "example");
const TYPES = ["page", "section", "prose", "card", "quote", "aside", "quiz", "explain", "nest"];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
function blocks(v: unknown, into: Json[] = []): Json[] {
  if (Array.isArray(v)) for (const x of v) blocks(x, into);
  if (!isObj(v)) return into;
  if (typeof v.type === "string") into.push(v);
  for (const x of Object.values(v)) blocks(x, into);
  return into;
}
const lessons = () => {
  try { return readdirSync(join(EXAMPLE, "lessons")).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(EXAMPLE, "lessons", f), "utf8"))); }
  catch { return []; }
};

describe("the school skill", () => {
  test("SKILL-1: its frontmatter names it school and says when to use it", () => {
    const text = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    expect(front).toMatch(/^name: school$/m);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
    expect(description).toContain("School course");
    expect(description.length).toBeGreaterThan(80);
  });

  test("SKILL-2: its worked example is a course School would serve", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "check-course.ts"), EXAMPLE], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const done = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(done.title).toEqual(expect.any(String));
    expect(done.lessons.length).toBeGreaterThanOrEqual(2);
  });

  test("SKILL-3: the example shows every block type and a ref", () => {
    const all = lessons().flatMap((l) => blocks(l));
    expect(TYPES.filter((t) => !all.some((b) => b.type === t))).toEqual([]);
    expect(JSON.stringify(lessons())).toContain('"ref":');
  });

  test("SKILL-4: every explain prompt in the example is a question", () => {
    const prompts = lessons().flatMap((l) => blocks(l)).filter((b) => b.type === "explain").map((b) => String(b.prompt));
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.filter((p) => !p.trim().endsWith("?"))).toEqual([]);
  });
});
