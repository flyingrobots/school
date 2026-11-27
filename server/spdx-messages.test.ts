// What a refusal of a course's `license` says (flyingrobots/school#278): each message names the rule
// the expression actually broke, and one refusal is one reason. Which expressions are accepted is
// unchanged, and pinned here (the same cases as MANIFEST-4 and MANIFEST-5 in course-manifest.test.ts, and more).
// docs/topics/course-format/test-plan.md lists these cases by ID.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CourseFileError, readCourseFile } from "./course-file.ts";
import { spdxProblem } from "./spdx.ts";

const MISLEADING = "expected AND, OR or WITH";

describe("spdxProblem: what a refusal says", () => {
  test.each([
    ["WITH after a parenthesised group", "(MIT) WITH Classpath-exception-2.0", /parenthes/i],
    ["a second WITH", "GPL-2.0-only WITH Classpath-exception-2.0 WITH LLVM-exception", /second WITH|one WITH|only one/i],
    ["a second WITH inside parentheses", "(GPL-2.0-only WITH Classpath-exception-2.0 WITH LLVM-exception) OR MIT", /second WITH|one WITH|only one/i],
  ])("SPDX-MSG-1: %s is refused for that rule, not as an unexpected WITH", (_, expression, cause) => {
    const problem = spdxProblem(expression);
    expect(problem).toMatch(cause);
    expect(problem).not.toContain(MISLEADING);
  });

  test.each([
    ["and", "MIT and Apache-2.0", '"and"', '"AND"'],
    ["or", "MIT or Apache-2.0", '"or"', '"OR"'],
    ["with", "GPL-2.0-only with Classpath-exception-2.0", '"with"', '"WITH"'],
    ["a mixed-case And", "MIT And Apache-2.0", '"And"', '"AND"'],
    ["a mixed-case Or after a group", "(MIT) Or Apache-2.0", '"Or"', '"OR"'],
    ["and inside parentheses", "(MIT and Apache-2.0)", '"and"', '"AND"'],
    ["with inside parentheses", "(MIT with Classpath-exception-2.0)", '"with"', '"WITH"'],
    ["or inside nested parentheses", "((MIT or Apache-2.0)) AND BSD-2-Clause", '"or"', '"OR"'],
  ])("SPDX-MSG-2: a lowercase operator (%s) is refused for not being in capitals", (_, expression, found, wanted) => {
    const problem = spdxProblem(expression);
    expect(problem).toContain(found);
    expect(problem).toContain(wanted);
    expect(problem).toMatch(/capital/i);
    expect(problem).not.toContain(MISLEADING);
  });

  test.each([
    ["OR", "MIT OR and", '"and"'],
    ["AND", "MIT AND or", '"or"'],
    ["a leading operator", "and MIT", '"and"'],
    ["a capitalised operator", "MIT OR AND", '"AND"'],
    ["an opening parenthesis", "(with MIT)", '"with"'],
  ])("SPDX-MSG-7: where a license is expected (after %s), the refusal says so, with no capitals hint or imperative", (_, expression, found) => {
    const problem = spdxProblem(expression);
    expect(problem).toBe(`expected a license, found ${found}`);
    expect(problem).not.toMatch(/capital|write/i);
  });

  test.each(["LicenseRef-x+", "DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style+", "MIT OR LicenseRef-x+"])(
    "SPDX-MSG-3: a LicenseRef with a trailing + (%s) is refused for the +, not advised to use a LicenseRef",
    (expression) => {
      const problem = spdxProblem(expression);
      expect(problem).toContain('"+"');
      expect(problem).toContain("LicenseRef");
      expect(problem).not.toMatch(/unknown license|not a license id|use LicenseRef-<name>/);
    },
  );
});

describe("spdxProblem: what is accepted is unchanged", () => {
  test.each([
    "MIT", "mit", "MIT OR Apache-2.0", "Apache-2.0 WITH LLVM-exception", "(MIT AND BSD-2-Clause) OR GPL-2.0-or-later", "GPL-2.0+",
    "LicenseRef-Our-Own", "CC-BY-SA-4.0", "GPL-2.0-only WITH classpath-exception-2.0", "DocumentRef-spdx-tool-1.2:LicenseRef-MIT-Style",
    "((MIT))", "MIT AND (Apache-2.0 OR GPL-2.0+)", "(GPL-2.0-only WITH Classpath-exception-2.0) AND MIT", "LicenseRef-x WITH LLVM-exception",
  ])("SPDX-MSG-4: %p is accepted", (expression) => {
    expect(spdxProblem(expression)).toBeNull();
  });

  test.each([
    "", "  ", "MIT License", "MIT OR", "OR MIT", "(MIT OR Apache-2.0", "MIT)", "()", "MIT AND", "Frobnicate-1.0", "MIT OR Frobnicate-1.0",
    "MIT WITH Frobnicate-exception", "(MIT and Apache-2.0)", "(MIT with Classpath-exception-2.0)", "MIT OR and", "MIT WITH LicenseRef-x", "MIT WITH", "MIT WITH (", "MIT or Apache-2.0", "MIT and Apache-2.0", "MIT And Apache-2.0",
    "(MIT) WITH Classpath-exception-2.0", "GPL-2.0-only WITH Classpath-exception-2.0 WITH LLVM-exception", "LicenseRef-x+", "MIT++", "MIT, Apache-2.0", "MIT/Apache-2.0",
  ])("SPDX-MSG-5: %p is still refused, with a reason", (expression) => {
    const problem = spdxProblem(expression);
    expect(problem).not.toBeNull();
    expect(problem).not.toBe("");
  });
});

describe("an empty license", () => {
  const root = mkdtempSync(join(tmpdir(), "school-spdx-messages-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const refusal = (license: string): string => {
    const dir = join(root, `c${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "course.json"), JSON.stringify({ title: "T", license }));
    try {
      readCourseFile(dir);
    } catch (e) {
      if (e instanceof CourseFileError) return e.message;
      throw e;
    }
    throw new Error("the license was accepted");
  };

  test.each([["an empty", ""], ["a whitespace-only", "   "]])("SPDX-MSG-6: %s license is refused once, as empty, with no second reason", (_, license) => {
    const message = refusal(license);
    expect(message).toContain('"license"');
    expect(message).toContain("must not be empty");
    expect(message).not.toContain("SPDX");
    expect(message).not.toContain("expected a license");
    expect(message.match(/"license"/g)).toHaveLength(1);
  });
});
