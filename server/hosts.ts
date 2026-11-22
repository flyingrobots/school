// The names School answers to (flyingrobots/school#18). School has no login: the tailnet and
// localhost are the access control. DNS rebinding gets around both, by pointing an attacker's
// own name at 127.0.0.1 so that their page becomes same-origin with School. The Host header
// still carries the attacker's name, so a request is served only when it names School.
import { ConfigError } from "./config.ts";

const LOCAL = ["127.0.0.1", "localhost", "::1"];
/** Bind addresses that mean "every interface"; nobody browses to them by that name. */
const WILDCARD = new Set(["", "0.0.0.0", "::", "[::]"]);
const NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const IPV6 = /^[0-9a-f:.]+$/;

/** A host name as the allowlist stores it: lowercase, without brackets or a trailing dot. Null if it is not a bare name. */
function bare(name: string): string | null {
  let n = name.toLowerCase();
  if (n.startsWith("[") && n.endsWith("]")) {
    n = n.slice(1, -1);
    return n.includes(":") && IPV6.test(n) ? n : null;
  }
  if (n.endsWith(".")) n = n.slice(0, -1);
  return NAME.test(n) ? n : null;
}

/**
 * Every name a request may carry in its Host header: the localhost forms, the configured bind
 * host when it is a real name, and the comma-separated names in `SCHOOL_ALLOWED_HOSTS` (the
 * tailnet name, for one). Names only: the port is not checked, because `tailscale serve` and a
 * Docker port mapping both put School behind a port other than its own.
 */
export function allowedHosts(config: { host: string }, env: Record<string, string | undefined>): string[] {
  const out = new Set(LOCAL);
  if (!WILDCARD.has(config.host)) {
    const h = bare(config.host);
    if (h !== null) out.add(h);
  }
  for (const entry of (env.SCHOOL_ALLOWED_HOSTS ?? "").split(",")) {
    const text = entry.trim();
    if (text === "") continue;
    const h = bare(text);
    if (h === null) throw new ConfigError(`SCHOOL_ALLOWED_HOSTS entry ${JSON.stringify(text)} is not a host name; list bare names such as school.example.ts.net, without a port, scheme or wildcard`);
    out.add(h);
  }
  return [...out];
}

/** Whether a Host header names one of `allowed`. A missing or malformed header never does. */
export function hostAllowed(header: string | null, allowed: readonly string[]): boolean {
  if (header === null) return false;
  let name = header;
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    if (end === -1) return false;
    const rest = header.slice(end + 1);
    if (rest !== "" && !/^:\d+$/.test(rest)) return false;
    name = header.slice(0, end + 1);
  } else {
    const colon = header.indexOf(":");
    if (colon !== -1) {
      if (!/^\d+$/.test(header.slice(colon + 1))) return false;
      name = header.slice(0, colon);
    }
  }
  const h = bare(name);
  return h !== null && allowed.includes(h);
}
