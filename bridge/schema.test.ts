// The answer validator's problems are logged as a grading attempt's error (bridge.attempt), and
// that log holds no prompt and no answer. A key the answer is not allowed to have is chosen by the
// model, so a problem names where it is, never the key itself (flyingrobots/school#289).
import { expect, test } from "bun:test";
import { validate } from "./schema.ts";

const closed = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
const nested = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: closed } },
};
// The probe from the baker-street review of flyingrobots/school#283 (F-4).
const PROBE = "The learner wrote: my secret answer";

test("an unexpected key at the top is reported by its path, quoting none of the key", () => {
  expect(validate({ ok: true, [PROBE]: 1 }, closed)).toBe("unexpected key at $");
});

test("an unexpected key inside an array item is reported by the item's path, quoting none of the key", () => {
  expect(validate({ items: [{ ok: true }, { ok: false, [PROBE]: 1 }] }, nested)).toBe("unexpected key at $.items[1]");
});

// Oracle: the schema declares only `ok`, so a key named like an Object.prototype member is as
// unexpected as any other; looked up on a plain object it would find the inherited member.
test("a key named like an inherited member of every object is unexpected too, and not quoted", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    const answer = JSON.parse(`{"ok": true, ${JSON.stringify(key)}: {}}`);
    expect([key, validate(answer, closed)]).toEqual([key, "unexpected key at $"]);
  }
});

// A seeded generator, so a failure can be replayed: SCHOOL_TEST_SEED=<seed> bun test bridge/schema.test.ts
function generator(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHABET = "abcXYZ019 :.$[]\"'\\{}é😀\n\t";

test("no random unexpected key appears in the problem, which is always its path", () => {
  const seed = Number(process.env.SCHOOL_TEST_SEED ?? 289);
  const random = generator(seed);
  let checked = 0;
  for (let i = 0; i < 500; i++) {
    const length = 3 + Math.floor(random() * 30);
    let key = "";
    for (let j = 0; j < length; j++) key += [...ALPHABET][Math.floor(random() * [...ALPHABET].length)];
    const top = validate({ ok: true, [key]: 1 }, closed);
    const inner = validate({ items: [{ ok: true, [key]: 1 }] }, nested);
    expect({ seed, key, top, inner }).toEqual({ seed, key, top: "unexpected key at $", inner: "unexpected key at $.items[0]" });
    checked++;
  }
  expect(checked).toBe(500);
});
