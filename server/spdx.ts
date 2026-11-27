// A course's `license` (flyingrobots/school#209) is an SPDX license expression: SPDX specification
// 2.3, Annex D. This checks one against that grammar and the SPDX License List
// (server/spdx-license-ids.ts), without any list of licenses School prefers:
//
//   expression := and ("OR" and)*        "OR" binds loosest, then "AND", then "WITH"
//   and        := term ("AND" term)*
//   term       := "(" expression ")" | license ("WITH" exception)?
//   exception  := a listed exception id
//   license    := a listed id, optionally followed by "+" | LicenseRef-<id> | DocumentRef-<id>:LicenseRef-<id>
//
// Operators are matched with their case; license and exception ids without it, as the specification
// says. An exception is a listed id (server/spdx-exception-ids.ts); a LicenseRef- is not one.
import { EXCEPTION_IDS } from "./spdx-exception-ids.ts";
import { DEPRECATED_LICENSE_IDS, LICENSE_IDS } from "./spdx-license-ids.ts";

const listed = new Set([...LICENSE_IDS, ...DEPRECATED_LICENSE_IDS].map((id) => id.toLowerCase()));
const ID = /^[A-Za-z0-9.-]+$/;
const REF = /^(DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/;
const exceptions = new Set(EXCEPTION_IDS.map((id) => id.toLowerCase()));
const OPERATORS = new Set(["AND", "OR", "WITH"]);

/** The refusal for `token` when it is an operator spelt without its capitals, else null. */
function lowercaseOperator(token: string): string | null {
  const operator = token.toUpperCase();
  return OPERATORS.has(operator) && token !== operator ? `${JSON.stringify(token)} is not an operator: operators are written in capitals, so write ${JSON.stringify(operator)}` : null;
}

/** Why `expression` is not an SPDX license expression, or null when it is one. */
export function spdxProblem(expression: string): string | null {
  const tokens = expression.split(/\s+|([()])/).filter((t): t is string => t !== undefined && t !== "");
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const found = (): string => (peek() === undefined ? "the end of the expression" : JSON.stringify(peek()));

  function license(): string | null {
    const t = peek();
    if (t === undefined || OPERATORS.has(t.toUpperCase()) || t === ")") return `expected a license, found ${found()}`;
    at++;
    if (REF.test(t)) return null;
    const id = t.endsWith("+") ? t.slice(0, -1) : t;
    if (id !== t && REF.test(id)) return `${JSON.stringify(t)}: "+" cannot follow a LicenseRef, which names a license of your own, with no later versions; write ${JSON.stringify(id)}`;
    if (!ID.test(id)) return `${JSON.stringify(t)} is not a license id`;
    if (!listed.has(id.toLowerCase())) return `unknown license ${JSON.stringify(t)}; it is not on the SPDX License List (use LicenseRef-<name> for one of your own)`;
    return null;
  }
  function term(): string | null {
    if (peek() === "(") {
      at++;
      const inner = or();
      if (inner !== null) return inner;
      if (peek() !== ")") return (peek() === undefined ? null : lowercaseOperator(peek()!)) ?? `expected ")", found ${found()}`;
      at++;
      return peek() === "WITH" ? "WITH takes a license id on its left, not a parenthesised group" : null;
    }
    const problem = license();
    if (problem !== null || peek() !== "WITH") return problem;
    at++;
    const t = peek();
    if (t === undefined || OPERATORS.has(t.toUpperCase()) || t === "(" || t === ")") return `expected an exception after WITH, found ${found()}`;
    at++;
    if (!ID.test(t)) return `${JSON.stringify(t)} is not an exception id`;
    if (!exceptions.has(t.toLowerCase())) return `unknown exception ${JSON.stringify(t)}; it is not on the SPDX exceptions list`;
    return peek() === "WITH" ? "a license takes one WITH exception; found a second WITH" : null;
  }
  function chain(operator: string, next: () => string | null): string | null {
    let problem = next();
    while (problem === null && peek() === operator) {
      at++;
      problem = next();
    }
    return problem;
  }
  const and = () => chain("AND", term);
  const or = () => chain("OR", and);

  const problem = or();
  if (problem !== null) return problem;
  if (peek() === undefined) return null;
  return lowercaseOperator(tokens[at]!) ?? `expected AND, OR or WITH, found ${found()}`;
}
