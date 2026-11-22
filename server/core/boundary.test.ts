// The hexagon's one structural rule (RFC 3, §4): the core imports nothing but itself and Zod.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const core = import.meta.dir;
const sources = readdirSync(core).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

test("the core has sources to check", () => {
  expect(sources.length).toBeGreaterThan(0);
});

test.each(sources)("core/%s imports only the core and zod", (file) => {
  const text = readFileSync(join(core, file), "utf8");
  const specifiers = [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s*["']([^"']+)["']/g), ...text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)]
    .map((m) => m[1]!);
  const outside = specifiers.filter((s) => !(s === "zod" || /^\.\/[\w-]+\.ts$/.test(s)));
  expect(outside).toEqual([]);
  expect(text).not.toMatch(/\bBun\.|\bprocess\.|\bfetch\(|\bDate\.now\(|new Date\(\)/);
});
