// The image's file allowlist broke the build twice (docs/working-notes.md): a new server module
// was missing from .dockerignore or the Dockerfile COPY, and the server died on an import.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = import.meta.dir;

test("the image admits every server module by pattern, and no tests", () => {
  const rules = readFileSync(join(dir, ".dockerignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  expect(rules).toEqual(["*", "!*.ts", "*.test.ts"]);
  expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toMatch(/^COPY \*\.ts \.\/$/m);
});

test("every module the server imports is a .ts file beside it", () => {
  const modules = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  for (const f of modules) {
    for (const m of readFileSync(join(dir, f), "utf8").matchAll(/from "\.\/([^"]+)"/g)) expect(modules).toContain(m[1]!);
  }
});
