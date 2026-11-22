// Command templates for the bridge. A learner writes an agent's command the way they would type
// it, `xyz --myArgument "foo" {prompt}`; it is split into words with shell quoting rules, then
// run directly. Nothing is ever passed to a shell, so `$(...)`, `;`, `|` and globs are just text.

export class TemplateError extends Error {}

export const PLACEHOLDERS = ["{prompt}", "{output_file}"] as const;

/**
 * Split a command line into words. Single quotes are literal; double quotes allow `\"`, `\\`,
 * `\$` and `` \` ``; a backslash outside quotes escapes the next character. Unbalanced quotes
 * are an error rather than a guess.
 */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new TemplateError(`unbalanced single quote in ${JSON.stringify(line)}`);
      word += line.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      inWord = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        if (line[j] === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1]!)) j++;
        word += line[j];
      }
      if (j >= line.length) throw new TemplateError(`unbalanced double quote in ${JSON.stringify(line)}`);
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= line.length) throw new TemplateError(`trailing backslash in ${JSON.stringify(line)}`);
      word += line[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  if (words.length === 0) throw new TemplateError("a command needs at least the program to run");
  return words;
}

/** Replace placeholders inside each word. A word that is exactly `{prompt}` becomes the whole prompt, as one argument. */
export function expand(argv: readonly string[], values: Readonly<Record<string, string>>): string[] {
  return argv.map((w) => {
    let out = w;
    for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
    return out;
  });
}

export const usesPlaceholder = (argv: readonly string[], p: string) => argv.some((w) => w.includes(p));
