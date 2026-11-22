// A small JSON Schema validator for the subset the bridge's callers use: object with required,
// properties and additionalProperties false; array with items; string (with enum); boolean;
// number; integer. Enough to decide whether an agent's answer is usable or the next agent should
// run. Anything outside the subset is rejected when checked, not silently accepted.

export type Schema = Readonly<Record<string, unknown>>;

/** null when `value` matches `schema`, otherwise the first problem, with its path. */
export function validate(value: unknown, schema: Schema, path = "$"): string | null {
  const type = schema.type;
  switch (type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object`;
      const props = (schema.properties ?? {}) as Record<string, Schema>;
      for (const k of (schema.required ?? []) as string[]) if (!(k in value)) return `${path}.${k} is missing`;
      for (const [k, v] of Object.entries(value)) {
        const sub = props[k];
        if (sub === undefined) {
          if (schema.additionalProperties === false) return `${path}.${k} is not allowed`;
          continue;
        }
        const e = validate(v, sub, `${path}.${k}`);
        if (e !== null) return e;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      const items = schema.items as Schema | undefined;
      if (items === undefined) return null;
      for (let i = 0; i < value.length; i++) {
        const e = validate(value[i], items, `${path}[${i}]`);
        if (e !== null) return e;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path} must be a number`;
    case "integer":
      return Number.isInteger(value) ? null : `${path} must be an integer`;
    default:
      return `${path}: the schema uses an unsupported type ${JSON.stringify(type)}`;
  }
}
