// Checks a program's output against its published schemas (flyingrobots/school#135), as
// server/migrate.test.ts checks the migrate job's: every line is one JSON object naming its schema
// (`_schema: {id, version}`), and validates against that schema by Ajv (draft 2020-12), an
// independent validator. A line that is not JSON, names no schema, names one not published in the
// given folder, or does not validate, throws.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";

export type Line = Record<string, unknown> & { _schema: { id: string; version: string } };
export type Published = { file: string; id: string; version: string; schema: Record<string, any> };

export function publishedIn(dir: string) {
  const published: Published[] = readdirSync(dir).filter((f) => f.endsWith(".schema.json")).sort().map((file) => {
    const schema = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, any>;
    return { file, id: file.slice(0, -".schema.json".length), version: schema.properties?._schema?.properties?.version?.const, schema };
  });
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validators = new Map(published.map(({ schema }) => [schema.$id as string, ajv.compile(schema)]));

  /** One line, parsed and checked. */
  const check = (raw: string): Line => {
    let line: Line;
    try { line = JSON.parse(raw); } catch { throw new Error(`not a JSON line: ${raw}`); }
    const named = line?._schema;
    if (typeof named?.id !== "string" || typeof named?.version !== "string") throw new Error(`no _schema: ${raw}`);
    const validate = validators.get(`${named.id}/${named.version}`);
    if (validate === undefined) throw new Error(`no published schema ${named.id} ${named.version}: ${raw}`);
    if (!validate(line)) throw new Error(`${raw}\ndoes not validate against ${named.id} ${named.version}: ${ajv.errorsText(validate.errors)}`);
    return line;
  };

  return {
    published,
    ids: published.map((p) => p.id),
    check,
    /** `text` as JSON Lines, every line checked. */
    validated: (text: string): Line[] => text.split("\n").filter((l) => l !== "").map(check),
    /** Whether `line` validates against the published schema `id`. */
    valid: (id: string, line: unknown): boolean => {
      const p = published.find((x) => x.id === id);
      if (p === undefined) throw new Error(`no published schema ${id}`);
      return validators.get(p.schema.$id)!(line) as boolean;
    },
  };
}

/**
 * The shape every published schema keeps: draft 2020-12, `$id` `<id>/<version>` with a semver
 * version, `_schema` pinning both, `kind` a constant, the envelope required, no other fields.
 */
export function wellFormed(p: Published, envelope: string[]): string[] {
  const wrong: string[] = [];
  const s = p.schema;
  if (s.$schema !== "https://json-schema.org/draft/2020-12/schema") wrong.push("$schema");
  if (!/^\d+\.\d+\.\d+$/.test(String(p.version))) wrong.push("version");
  if (s.$id !== `${p.id}/${p.version}`) wrong.push("$id");
  if (s.properties?._schema?.properties?.id?.const !== p.id) wrong.push("_schema.id");
  if (typeof s.properties?.kind?.const !== "string") wrong.push("kind");
  if (s.additionalProperties !== false) wrong.push("additionalProperties");
  for (const f of envelope) if (!s.required?.includes(f)) wrong.push(`required ${f}`);
  return wrong;
}
