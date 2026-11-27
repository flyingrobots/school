// Fetching one commit of a course repository over https (RFC 7 §6, task 6; flyingrobots/school#236).
//
// `fetchCommit` fetches exactly one commit from an https URL into a new bare repository,
// `<staging>/repo.git`, and answers its full hash, or a refusal with the staging folder deleted.
// The URL and the server are hostile until checked, so:
//
// - The URL is checked before git runs: it starts `https://`, holds no whitespace, control
//   character or backslash, no user or password, no query or fragment, and names port 443. Its
//   host is an IP address or a plain host name (letters, digits and hyphens in labels of 1 to 63
//   characters, no label starting or ending with a hyphen, 253 characters in all; one trailing dot
//   is dropped), so the pin below means what it says. Every
//   other form (`http`, `ssh`, scp-like `host:path`, `git://`, `file://`, `ext::`, a local path, an
//   option) is refused here, and again by git's `protocol.allow=never` with only `https` allowed.
// - The host is resolved once, and refused unless every address is public (`isPublicAddress`: not
//   loopback, private, CGNAT, link-local, multicast, reserved or documentation, in IPv4 or IPv6,
//   IPv4-mapped included). git is then pinned to exactly the addresses checked with
//   `http.curloptResolve` (`HOST:PORT:ADDRESS,...`, handed to libcurl's CURLOPT_RESOLVE), so a
//   second lookup that answers differently (DNS rebinding) is never made. A literal address is
//   checked as given and needs no pin. Redirects are not followed (`http.followRedirects=false`),
//   and no proxy is configured or inherited.
// - git runs with a fresh environment (no system or global configuration, `HOME` the staging
//   folder, so no `.netrc`, no askpass, `GIT_TERMINAL_PROMPT=0`), no credential helper, no hooks,
//   no submodules, `transfer.fsckObjects`, and no template in `git init`. Every git command after
//   `git init` names the new repository with `--git-dir` and starts in it, and
//   `GIT_CEILING_DIRECTORIES` stops git looking above the staging folder, so a repository around
//   the staging folder adds no configuration (a header, a URL rewrite, a proxy).
// - A branch, tag or `HEAD` is resolved once with `git ls-remote` to its full hash (an annotated
//   tag to the commit it tags); a name that is both a branch and a tag is refused as ambiguous.
//   A full hash is fetched as given. The fetch is `git fetch --depth=1 --no-tags
//   --no-recurse-submodules <url> <hash>`, and the result must be that commit.
// - Every git process has a time limit, and the fetch a size limit, watched on disk while it runs
//   and checked again when it ends. Passing either kills git's whole process group and deletes
//   the staging folder.
//
// The caller chooses the staging folder (task 7 puts it under the course store's `staging/`): an
// absolute path whose parent exists and which does not. Reading the commit's tree is a separate step (task 5).
import { lookup } from "node:dns/promises";
import { lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

export type FetchLimits = {
  /** Bytes the fetched repository may hold on disk, pack and all. */
  packBytes: number;
  /** Milliseconds each git process may run. */
  gitMs: number;
};
const MiB = 1024 * 1024;
/** RFC 7 Table 6.2's starting values for the fetched pack and each git process. */
export const DEFAULT_FETCH_LIMITS: Readonly<FetchLimits> = Object.freeze({ packBytes: 64 * MiB, gitMs: 60_000 });

export type FetchRefusalReason =
  | "bad-url" | "not-https" | "credentials" | "bad-port" | "unresolved" | "private-address"
  | "bad-commit" | "no-such-ref" | "ambiguous-ref" | "not-a-commit" | "bad-staging" | "too-large" | "timeout" | "git-failed";
/** Why nothing was fetched: the reason, and a sentence for a person. */
export type FetchRefusal = { reason: FetchRefusalReason; message: string };
export type Fetched = { ok: true; repository: string; commit: string } | { ok: false; refusal: FetchRefusal };

/**
 * How the fetch reaches the network. Production uses the defaults; tests replace them, through
 * `FetchTesting`, to reach a local server on loopback with its own certificate.
 */
export type Network = {
  /** Every address a host name resolves to. */
  resolve: (host: string) => Promise<string[]>;
  /** Whether git may connect to an address. */
  publicAddress: (address: string) => boolean;
  /** The ports a URL may name. */
  ports: readonly number[];
  /** A CA certificate file for git to trust instead of the system's, or null for the system's. */
  caFile: string | null;
};
const DEFAULT_NETWORK: Network = {
  resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
  publicAddress: isPublicAddress,
  ports: [443],
  caFile: null,
};

export type FetchRequest = {
  /** The repository's https URL. */
  url: string;
  /** A full commit hash (40 or 64 hex digits), or a branch, tag or `HEAD` to resolve to one. */
  commit: string;
  /** The folder to create and fetch into, as an absolute path. Its parent must exist; it must not. */
  staging: string;
};

/**
 * Test seams, for tests only: never part of a request, never built from a client's input. A
 * caller that could set these would choose the program that runs, the port, the CA it trusts and
 * the limits. Nothing in the server passes them; production runs with every default.
 */
export type FetchTesting = {
  /** The git executable; `git` from PATH by default. */
  git?: string;
  network?: Partial<Network>;
  limits?: Partial<FetchLimits>;
};

const MAX_URL = 2048;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
// Whitespace, control characters (C0, DEL, C1) and backslash, which URL parsers read as a slash.
const UNSAFE_URL_CHAR = /[\u0000- \u007f-\u009f\\]/;
// One label of a host name (RFC 1123 §2.1): letters, digits and hyphens, 1 to 63 of them, neither
// first nor last a hyphen. The URL parser has already lowercased the host and turned Unicode into
// punycode (`xn--`), which is such a label.
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_HOST = 253;

class Refused extends Error {
  constructor(readonly refusal: FetchRefusal) {
    super(refusal.message);
  }
}
const refuse = (reason: FetchRefusalReason, message: string): never => {
  throw new Refused({ reason, message });
};

// ---- Addresses ----

/** An IPv4 address in strict dotted-quad form as a number, or null. */
function ipv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

/** An IPv6 address as a 128-bit number, or null. A zone (`%en0`) is not accepted. */
function ipv6(s: string): bigint | null {
  if (!s.includes(":") || s.includes("%")) return null;
  let text = s;
  // A trailing dotted quad (`::ffff:127.0.0.1`) is the last two groups.
  const last = text.lastIndexOf(":");
  if (text.slice(last + 1).includes(".")) {
    const n = ipv4(text.slice(last + 1));
    if (n === null) return null;
    text = `${text.slice(0, last + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0] ?? "");
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
  const words = [...head, ...rest];
  if (!words.every((w) => /^[0-9a-fA-F]{1,4}$/.test(w))) return null;
  if (halves.length === 1 ? words.length !== 8 : words.length > 7) return null;
  const full = halves.length === 1 ? words : [...head, ...Array<string>(8 - words.length).fill("0"), ...rest];
  return full.reduce((acc, w) => (acc << 16n) | BigInt(parseInt(w, 16)), 0n);
}

const v4 = (a: string, bits: number): [number, number] => [ipv4(a) ?? 0, bits];
// Not globally reachable, from the IANA IPv4 Special-Purpose Address Registry (RFC 6890), with
// CGNAT (RFC 6598), multicast and the reserved 240/4.
const V4_REFUSED = [
  v4("0.0.0.0", 8), v4("10.0.0.0", 8), v4("100.64.0.0", 10), v4("127.0.0.0", 8), v4("169.254.0.0", 16), v4("172.16.0.0", 12),
  v4("192.0.0.0", 24), v4("192.0.2.0", 24), v4("192.88.99.0", 24), v4("192.168.0.0", 16), v4("198.18.0.0", 15),
  v4("198.51.100.0", 24), v4("203.0.113.0", 24), v4("224.0.0.0", 4), v4("240.0.0.0", 4),
];
const v6 = (a: string, bits: number): [bigint, number] => [ipv6(a) ?? 0n, bits];
// IPv6 is public only inside global unicast, 2000::/3 (RFC 4291 §2.4), and outside these: IETF
// protocol assignments with Teredo and benchmarking (2001::/23), documentation (2001:db8::/32,
// 3fff::/20) and 6to4 (2002::/16), which embeds an IPv4 address School would not have checked.
// Everything else, loopback, unique-local, link-local, multicast, IPv4-mapped and NAT64, is refused.
const V6_GLOBAL = v6("2000::", 3);
const V6_REFUSED = [v6("2001::", 23), v6("2001:db8::", 32), v6("2002::", 16), v6("3fff::", 20)];

const inV4 = (n: number, [base, bits]: [number, number]) => bits === 0 || n >>> (32 - bits) === base >>> (32 - bits);
const inV6 = (n: bigint, [base, bits]: [bigint, number]) => n >> BigInt(128 - bits) === base >> BigInt(128 - bits);

/**
 * Whether an address is globally reachable, so School may let git connect to it. Anything that is
 * not a plain IPv4 dotted quad or IPv6 address is not public.
 */
export function isPublicAddress(address: string): boolean {
  const four = ipv4(address);
  if (four !== null) return !V4_REFUSED.some((range) => inV4(four, range));
  const six = ipv6(address);
  if (six === null) return false;
  return inV6(six, V6_GLOBAL) && !V6_REFUSED.some((range) => inV6(six, range));
}

// ---- The URL and the commit ----

type Target = { href: string; host: string; port: number; literal: boolean };

/** The URL, checked: https, no credentials, query or fragment, a permitted port. */
function checkUrl(raw: string, ports: readonly number[]): Target {
  if (raw.length > MAX_URL) refuse("bad-url", `the repository URL is longer than ${MAX_URL} characters`);
  if (!raw.toLowerCase().startsWith("https://")) refuse("not-https", "School fetches courses only from https:// URLs");
  if (UNSAFE_URL_CHAR.test(raw)) refuse("bad-url", "the repository URL holds a space, a control character or a backslash");
  if (raw.includes("?") || raw.includes("#")) refuse("bad-url", "the repository URL holds a query or a fragment");
  if (raw[8] === "/" || raw[8] === undefined) refuse("bad-url", "the repository URL names no host");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("bad-url", "the repository URL is not a URL");
  }
  if (url.protocol !== "https:") refuse("not-https", "School fetches courses only from https:// URLs");
  if (url.username !== "" || url.password !== "" || raw.slice(8).split("/")[0]?.includes("@")) {
    refuse("credentials", "the repository URL holds a user or password; School stores no secret for a course, so a private course is installed from a bundle");
  }
  const port = url.port === "" ? 443 : Number(url.port);
  if (!ports.includes(port)) refuse("bad-port", `the repository URL names port ${port}; School fetches only from port 443`);
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "") refuse("bad-url", "the repository URL names no host");
  if (isIP(host) !== 0) return { href: url.href, host, port, literal: true };
  // A name is pinned as `NAME:PORT:ADDRESS`, so it must be a plain host name: anything else could
  // change what libcurl reads (a leading `-` removes the entry, and git would look the name up
  // itself). One trailing dot names the same host; it is dropped from the URL, the lookup and the
  // pin alike, so all three name the host the same way.
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name.length > MAX_HOST || !name.split(".").every((label) => HOST_LABEL.test(label))) {
    refuse("bad-url", `the repository URL's host ${JSON.stringify(host)} is not a host name: letters, digits and hyphens in dot-separated labels of at most 63 characters, none starting or ending with a hyphen, ${MAX_HOST} characters in all`);
  }
  url.hostname = name;
  return { href: url.href, host: name, port, literal: false };
}

type Wanted = { hash: string } | { ref: string };

/** A full hash, or a branch, tag or HEAD that is safe to hand to git. */
function checkCommit(commit: string): Wanted {
  const lower = commit.toLowerCase();
  if (HASH.test(lower)) return { hash: lower };
  const ok = commit === "HEAD" || (REF.test(commit) && !commit.includes("..") && !commit.includes("//") && !commit.includes("/.") &&
    !commit.includes("@{") && !commit.endsWith("/") && !commit.endsWith(".") && !commit.endsWith(".lock"));
  if (!ok) refuse("bad-commit", `${JSON.stringify(commit)} is not a full commit hash, branch or tag`);
  return { ref: commit };
}

/** Resolves the host and checks every address; returns the addresses to pin git to. */
async function checkAddresses(target: Target, net: Network): Promise<string[]> {
  if (target.literal) {
    if (!net.publicAddress(target.host)) refuse("private-address", `${target.host} is not a public address; School does not fetch from its own host or a private network`);
    return [];
  }
  let addresses: string[];
  try {
    addresses = await net.resolve(target.host);
  } catch (e) {
    return refuse("unresolved", `${target.host} could not be resolved: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (addresses.length === 0) refuse("unresolved", `${target.host} resolves to no address`);
  for (const a of addresses) {
    if (!net.publicAddress(a)) refuse("private-address", `${target.host} resolves to ${a}, which is not a public address; School does not fetch from its own host or a private network`);
  }
  return addresses;
}

// ---- Running git ----

/**
 * How git runs: `home` is its HOME, the staging folder; `cwd` the folder it starts in; `ceiling`
 * the folder above which git never looks for a repository of its own.
 */
type Git = { bin: string; home: string; cwd: string; ceiling: string; ms: number; config: string[] };

/**
 * Reads a stream to its end, keeping at most `max` bytes. Past that, a `truncate` stream keeps
 * draining; any other is a refusal at once, which stops git.
 */
async function capped(stream: ReadableStream<Uint8Array>, max: number, truncate: boolean, what: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  for await (const chunk of stream) {
    if (kept + chunk.length > max && !truncate) refuse("git-failed", `git ${what} wrote more than ${max} bytes`);
    const room = Math.max(0, max - kept);
    if (room > 0) chunks.push(chunk.subarray(0, room));
    kept += Math.min(room, chunk.length);
  }
  return Buffer.concat(chunks);
}

/**
 * Runs one git command under a clean environment, in its own process group, with a time limit.
 * `watch` is called every 100 ms while it runs; a refusal from it stops git. Stopping kills the
 * whole group, so no remote helper or index-pack outlives it.
 */
async function run(g: Git, args: string[], o: { maxStdout: number; watch?: () => void }): Promise<{ code: number; stdout: string; stderr: string }> {
  const what = (args[0] === "--git-dir" ? args[2] : args[0]) ?? "";
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: g.home, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_CEILING_DIRECTORIES: g.ceiling,
  };
  let proc;
  try {
    proc = Bun.spawn([g.bin, ...g.config, ...args], { env, cwd: g.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (e) {
    return refuse("git-failed", `git could not be started: ${e instanceof Error ? e.message : String(e)}`);
  }
  const p = proc;
  let stopped: Refused | null = null;
  const stop = (why: Refused) => {
    stopped ??= why;
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      p.kill("SIGKILL");
    }
  };
  const timer = setTimeout(() => stop(new Refused({ reason: "timeout", message: `git ${what} ran longer than ${g.ms} ms and was stopped` })), g.ms);
  const watcher = o.watch
    ? setInterval(() => {
        try {
          o.watch?.();
        } catch (e) {
          stop(e instanceof Refused ? e : new Refused({ reason: "git-failed", message: String(e) }));
        }
      }, 100)
    : null;
  let out: Uint8Array = new Uint8Array(0);
  let err: Uint8Array = new Uint8Array(0);
  try {
    [out, err] = await Promise.all([capped(p.stdout, o.maxStdout, false, what), capped(p.stderr, 4096, true, what)]);
  } catch (e) {
    stop(e instanceof Refused ? e : new Refused({ reason: "git-failed", message: String(e) }));
  }
  const code = await p.exited;
  clearTimeout(timer);
  if (watcher) clearInterval(watcher);
  // Anything git started that is still running goes with it.
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {
    // The group is already gone.
  }
  if (stopped) throw stopped;
  return { code, stdout: new TextDecoder().decode(out), stderr: new TextDecoder().decode(err).trim() };
}

const failed = (what: string, r: { code: number; stderr: string }): never =>
  refuse("git-failed", `git ${what} failed (exit ${r.code})${r.stderr ? `: ${r.stderr.slice(0, 1000)}` : ""}`);

/** Bytes under a folder, not following links. Entries that vanish while git works are skipped. */
function bytesUnder(dir: string): number {
  let total = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const s = lstatSync(path);
      total += s.isDirectory() ? bytesUnder(path) : s.size;
    } catch {
      // Renamed or removed by git meanwhile.
    }
  }
  return total;
}

/** The full hash a branch, tag or HEAD names on the remote, by one `git ls-remote` from `repository`. */
async function resolveRef(g: Git, repository: string, href: string, name: string): Promise<string> {
  const wanted = name === "HEAD" ? ["HEAD"] : [`refs/heads/${name}`, `refs/tags/${name}`, `refs/tags/${name}^{}`];
  const r = await run(g, ["--git-dir", repository, "ls-remote", href, ...wanted], { maxStdout: MiB });
  if (r.code !== 0) failed("ls-remote", r);
  const refs = new Map<string, string>();
  for (const line of r.stdout.split("\n")) {
    const m = /^([0-9a-f]{40}|[0-9a-f]{64})\t(.+)$/.exec(line);
    if (m?.[1] && m[2]) refs.set(m[2], m[1]);
  }
  if (name === "HEAD") return refs.get("HEAD") ?? refuse("no-such-ref", "the repository has no default branch (HEAD)");
  const branch = refs.get(`refs/heads/${name}`);
  const tag = refs.get(`refs/tags/${name}^{}`) ?? refs.get(`refs/tags/${name}`);
  if (branch && tag) refuse("ambiguous-ref", `${JSON.stringify(name)} is both a branch and a tag, so only the full commit hash says which`);
  return branch ?? tag ?? refuse("no-such-ref", `the repository has no branch or tag ${JSON.stringify(name)}; a commit is found by its full hash, not a short one`);
}

/**
 * Fetches one commit from an https URL into `<staging>/repo.git`, a new bare repository, and
 * answers its full hash; or refuses, with the staging folder deleted (or never made).
 */
export async function fetchCommit(request: FetchRequest, testing: FetchTesting = {}): Promise<Fetched> {
  // Only these three are read from the request, whatever else it carries.
  const { url, commit: asked, staging } = request;
  const net: Network = { ...DEFAULT_NETWORK, ...testing.network };
  const limits: FetchLimits = { ...DEFAULT_FETCH_LIMITS, ...testing.limits };
  let made = false;
  try {
    const wanted = checkCommit(asked);
    const target = checkUrl(url, net.ports);
    const pinned = await checkAddresses(target, net);
    if (!isAbsolute(staging)) refuse("bad-staging", `the staging folder ${JSON.stringify(staging)} is not an absolute path`);
    try {
      mkdirSync(staging);
    } catch (e) {
      return refuse("bad-staging", `the staging folder ${staging} could not be made: ${e instanceof Error ? e.message : String(e)}`);
    }
    made = true;
    const pin = pinned.map((a) => (a.includes(":") ? `[${a}]` : a)).join(",");
    const config = [
      "protocol.allow=never", "protocol.https.allow=always", "core.hooksPath=/dev/null", "core.fsmonitor=false",
      "transfer.fsckObjects=true", "fetch.fsckObjects=true", "submodule.recurse=false", "fetch.recurseSubmodules=false",
      "credential.helper=", "core.askPass=", "http.followRedirects=false", "http.proxy=", "http.sslVerify=true",
      "gc.auto=0", "maintenance.auto=false",
      ...(pin ? [`http.curloptResolve=${target.host}:${target.port}:${pin}`] : []),
      ...(net.caFile ? [`http.sslCAInfo=${net.caFile}`] : []),
    ].flatMap((c) => ["-c", c]);
    // Every git command names the repository it uses (`--git-dir`), starts in it, and may not look
    // above the staging folder for another, so no enclosing repository's configuration applies.
    const repository = join(staging, "repo.git");
    const atStaging: Git = { bin: testing.git ?? "git", home: staging, cwd: staging, ceiling: dirname(staging), ms: limits.gitMs, config };
    const g: Git = { ...atStaging, cwd: repository };
    const init = async (format: "sha1" | "sha256") => {
      const r = await run(atStaging, ["init", "--quiet", "--bare", "--template=", `--object-format=${format}`, repository], { maxStdout: 4096 });
      if (r.code !== 0) failed("init", r);
    };
    const format = (hash: string) => (hash.length === 64 ? "sha256" : "sha1");
    await init("hash" in wanted ? format(wanted.hash) : "sha1");
    const commit = "hash" in wanted ? wanted.hash : await resolveRef(g, repository, target.href, wanted.ref);
    if (format(commit) === "sha256" && !("hash" in wanted)) {
      // The remote's ref is a SHA-256 hash: the repository was made for SHA-1, so make it again.
      rmSync(repository, { recursive: true, force: true });
      await init("sha256");
    }
    const tooLarge = () => {
      if (bytesUnder(staging) > limits.packBytes) refuse("too-large", `the repository is larger than ${limits.packBytes} bytes at this commit`);
    };
    const fetch = await run(g, ["--git-dir", repository, "fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head", target.href, commit], { maxStdout: 64 * 1024, watch: tooLarge });
    tooLarge();
    if (fetch.code !== 0) failed("fetch", fetch);
    const type = await run(g, ["--git-dir", repository, "cat-file", "-t", commit], { maxStdout: 64 });
    if (type.code !== 0 || type.stdout.trim() !== "commit") refuse("not-a-commit", `${commit} is not a commit in the repository`);
    // A ref keeps the commit from being pruned before it is read.
    const ref = await run(g, ["--git-dir", repository, "update-ref", "refs/heads/course", commit], { maxStdout: 64 });
    if (ref.code !== 0) failed("update-ref", ref);
    return { ok: true, repository, commit };
  } catch (e) {
    if (made) rmSync(staging, { recursive: true, force: true });
    if (e instanceof Refused) return { ok: false, refusal: e.refusal };
    throw e;
  }
}
