import { expect, test } from "bun:test";
import { TemplateError, expand, splitCommand } from "./template.ts";

test("the learner's example splits the way a shell would", () => {
  expect(splitCommand('xyz --myArgument "foo" {prompt}')).toEqual(["xyz", "--myArgument", "foo", "{prompt}"]);
});

test("quoting rules", () => {
  expect(splitCommand(`a 'b c' "d \\"e\\" \\$f" g\\ h ''`)).toEqual(["a", "b c", 'd "e" $f', "g h", ""]);
  expect(splitCommand(`claude -p --tools "" {prompt}`)).toEqual(["claude", "-p", "--tools", "", "{prompt}"]);
});

test("shell syntax is just text: nothing is interpreted", () => {
  expect(splitCommand("echo $(touch pwned); rm -rf * | cat")).toEqual(["echo", "$(touch", "pwned);", "rm", "-rf", "*", "|", "cat"]);
});

test("unbalanced quotes and empty commands are errors", () => {
  expect(() => splitCommand(`a "b`)).toThrow(TemplateError);
  expect(() => splitCommand(`a 'b`)).toThrow(TemplateError);
  expect(() => splitCommand("   ")).toThrow(TemplateError);
});

test("{prompt} becomes one argument however much whitespace or quoting the prompt holds", () => {
  const prompt = `two words; "quoted" $(not run)\nnew line`;
  expect(expand(["x", "-p", "{prompt}"], { "{prompt}": prompt })).toEqual(["x", "-p", prompt]);
  expect(expand(["x", "--out={output_file}"], { "{output_file}": "/tmp/o" })).toEqual(["x", "--out=/tmp/o"]);
});
