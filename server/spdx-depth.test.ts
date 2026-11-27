// A course's `license` nested deeper than 32 parentheses is refused like any other bad expression
// (flyingrobots/school#279). The parser recurses once per parenthesis, so at about 20,000 the stack
// ran out and `school check` reported `error.failed` with no file or key, and the server crashed
// at start instead of printing its refusal. docs/topics/course-format/test-plan.md lists these cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotStarted, startSchool, timeout } from "./testing/processes.ts";
import { spdxProblem } from "./spdx.ts";

/** The deepest nesting accepted. */
const LIMIT = 32;
const nest = (depth: number, inner = "MIT"): string => `${"(".repeat(depth)}${inner}${")".repeat(depth)}`;
const WITH = "GPL-2.0-only WITH Classpath-exception-2.0";

describe("spdxProblem: nesting depth", () => {
  test("SPDX-DEPTH-1: an expression nested to the limit is accepted, one level deeper is refused", () => {
    expect(spdxProblem(nest(LIMIT))).toBeNull();
    const problem = spdxProblem(nest(LIMIT + 1));
    expect(problem).not.toBeNull();
    expect(problem).toContain(String(LIMIT));
    expect(problem).toMatch(/nest/i);
  });

  test("SPDX-DEPTH-2: the limit holds for a WITH inside the nesting, and with operators beside it", () => {
    expect(spdxProblem(nest(LIMIT, WITH))).toBeNull();
    expect(spdxProblem(nest(LIMIT + 1, WITH))).toMatch(/nest/i);
    expect(spdxProblem(`${nest(LIMIT)} AND (MIT OR ${nest(LIMIT)})`)).toBeNull();
    expect(spdxProblem(`MIT OR ${nest(LIMIT + 1)}`)).toMatch(/nest/i);
  });

  test("SPDX-DEPTH-3: a nesting that is never closed is refused, not thrown, however deep", () => {
    for (const depth of [LIMIT, LIMIT + 1, 20_000]) expect(spdxProblem("(".repeat(depth) + "MIT")).not.toBeNull();
  });

  test("SPDX-DEPTH-4: 20,000 and 1,000,000 levels are refused without throwing, and quickly", () => {
    for (const depth of [20_000, 1_000_000]) {
      const started = performance.now();
      expect(spdxProblem(nest(depth))).toMatch(/nest/i);
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });

  test("SPDX-DEPTH-5: random nesting depths are accepted up to the limit and refused beyond it, never thrown", () => {
    let seed = 20_240_726; // fixed, so a failure repeats
    const next = (n: number) => (seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0) % n;
    const depths: number[] = [];
    for (let i = 0; i < 200; i++) {
      const depth = next(i % 2 === 0 ? 100 : 40_000);
      depths.push(depth);
      const inner = [`MIT`, WITH, `MIT OR Apache-2.0`][next(3)]!;
      const problem = spdxProblem(nest(depth, inner));
      if (depth <= LIMIT) expect(problem, `depth ${depth}`).toBeNull();
      else expect(problem, `depth ${depth}`).toMatch(/nest/i);
    }
    expect(depths.some((d) => d <= LIMIT) && depths.some((d) => d > LIMIT)).toBe(true);
  });
});

describe("a deeply nested license in a course", () => {
  const root = mkdtempSync(join(tmpdir(), "school-spdx-depth-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const deep = nest(20_000);
  const lesson = JSON.stringify({ type: "page", id: "l1", title: "One", subtitle: "", children: [] });
  const folder = (name: string): string => {
    const dir = join(root, name);
    mkdirSync(join(dir, "lessons"), { recursive: true });
    writeFileSync(join(dir, "lessons", "0001.json"), lesson);
    writeFileSync(join(dir, "course.json"), JSON.stringify({ title: "T", license: deep }));
    return dir;
  };

  test("SPDX-DEPTH-6: school check refuses it with error.invalid naming course.json and the license, exit 1", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "check-course.ts"), folder("check")], { stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).not.toContain("Maximum call stack");
    const lines = stderr.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ _schema: { id: "school.check.error.invalid" }, error: "invalid", code: 1, file: "course.json" });
    expect(String(lines[0]!.message)).toContain('"license"');
    expect(code).toBe(1);
  }, 30_000);

  test("SPDX-DEPTH-7: the server exits 2 at start with its usual message naming the course, the file and the license", async () => {
    const dir = folder("server");
    let failure: NotStarted | null = null;
    try {
      const s = await startSchool({ ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
        SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`, SCHOOL_COURSES: `deep=${dir}` });
      s.proc.kill();
      await s.proc.exited;
    } catch (e) {
      if (!(e instanceof NotStarted)) throw e;
      failure = e;
    }
    expect(failure).not.toBeNull();
    expect(failure!.exitCode).toBe(2);
    expect(failure!.stderr).not.toContain("Maximum call stack");
    expect(failure!.stderr).toContain(`course "deep"`);
    expect(failure!.stderr).toContain(join(dir, "course.json"));
    expect(failure!.stderr).toContain('"license"');
  }, timeout(1));
});
