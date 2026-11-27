// `fetchCommit` (flyingrobots/school#236, RFC 7 task 6): one commit of a course repository fetched
// over https into a bare repository in staging, under hardened git, pinned to the address School
// checked, within the time and size limits of RFC 7 Table 6.2. The oracle for every refusal is RFC 7
// §6 and Table 6.1. Every network case runs against a local https server (server/testing/https-git.ts)
// on loopback; none reaches the internet. docs/topics/architecture/test-plan.md lists these by ID.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchCommit, isPublicAddress, type FetchRequest, type Network } from "./fetch-commit.ts";
import { certificate, configFile, git, gitBackend, serveHttps, TestRepo } from "./testing/https-git.ts";

// `.test` is reserved (RFC 6761) and never resolves, so a fetch from it can only reach the test
// server through the address School pinned.
const HOST = "course.test";
const root = mkdtempSync(join(tmpdir(), "school-fetch-commit-"));
const home = join(root, "home");
const repos = join(root, "repos");
mkdirSync(home);
mkdirSync(repos);
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A fresh staging path under a fresh parent: the parent exists, the staging folder does not. */
function staging() {
  const parent = join(root, `s${++n}`);
  mkdirSync(parent);
  return join(parent, "preview");
}

const tls = certificate(join(root, "tls"), HOST);
type Server = ReturnType<typeof serveHttps>;
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.stop(true); });
function server(handler: Parameters<typeof serveHttps>[1], hostname?: string) {
  const s = serveHttps(tls, handler, hostname);
  servers.push(s);
  return s;
}

/** The test network: HOST resolves to `address`, which alone counts as public, on the server's port. */
function network(port: number, address = "127.0.0.1"): Partial<Network> {
  return { resolve: async (host) => (host === HOST ? [address] : []), publicAddress: (a) => a === address, ports: [port], caFile: tls.cert };
}

// A course repository with two commits on main, a lightweight and an annotated tag, and a branch.
const course = new TestRepo(join(repos, "course.git"), home);
const first = course.commit({ "course.json": '{"title":"First"}\n' }, "first");
const second = course.commit({ "course.json": '{"title":"Second"}\n' }, "second", [first]);
course.ref("refs/heads/main", second);
course.ref("refs/heads/old", first);
course.ref("refs/tags/v1", first);
course.annotatedTag("v2", second);
course.ref("refs/heads/same", first);
course.ref("refs/tags/same", second);

// A repository whose one commit is far larger than the test's pack limit: a blob of 2 MiB that does
// not compress (a fixed linear congruential sequence, so the fixture is the same every run).
const big = new TestRepo(join(repos, "big.git"), home);
const noise = new Uint8Array(2 * 1024 * 1024);
for (let i = 0, x = 1; i < noise.length; i++) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; noise[i] = x >>> 24; }
const bigCommit = big.commit({ "course.json": "{}\n", "big.bin": noise }, "big");
big.ref("refs/heads/main", bigCommit);

let good: Server;
let url: (repo: string) => string;
beforeAll(() => {
  good = server(gitBackend(repos, home));
  url = (repo) => `https://${HOST}:${good.port}/${repo}`;
});

const request = (o: Partial<FetchRequest> & { commit: string }): FetchRequest => ({ url: url("course.git"), staging: staging(), network: network(good.port!), ...o });

/** The commits the fetched repository holds, by listing every object reachable from the commit. */
const commitsIn = (repository: string, commit: string) => git(home, ["--git-dir", repository, "rev-list", commit]).split("\n");

describe("fetchCommit: a good fetch", () => {
  test("FETCH-1: a full hash is fetched as given, alone, into a bare repository in staging", async () => {
    const r = request({ commit: second });
    const got = await fetchCommit(r);
    expect(got).toEqual({ ok: true, repository: join(r.staging, "repo.git"), commit: second });
    // Oracle: RFC 7 §6, `git fetch --depth=1` into `git init --bare`: one commit, no working tree.
    expect(git(home, ["--git-dir", join(r.staging, "repo.git"), "rev-parse", "--is-bare-repository"])).toBe("true");
    expect(commitsIn(join(r.staging, "repo.git"), second)).toEqual([second]);
  });

  test("FETCH-2: a commit no branch points at is fetched by its hash", async () => {
    const r = request({ commit: first });
    expect(await fetchCommit(r)).toMatchObject({ ok: true, commit: first });
    expect(commitsIn(join(r.staging, "repo.git"), first)).toEqual([first]);
  });

  test.each([
    ["a branch", "main", () => second],
    ["another branch", "old", () => first],
    ["a lightweight tag", "v1", () => first],
    ["an annotated tag, to the commit it tags", "v2", () => second],
    ["HEAD, the default branch", "HEAD", () => second],
  ])("FETCH-3: %s resolves to its full hash, which is fetched", async (_what, name, expected) => {
    const r = request({ commit: name });
    expect(await fetchCommit(r)).toEqual({ ok: true, repository: join(r.staging, "repo.git"), commit: expected() });
  });

  test("FETCH-4: a branch force-moved between two fetches resolves to where it points now", async () => {
    const moving = new TestRepo(join(repos, "moving.git"), home);
    const a = moving.commit({ "course.json": '{"title":"A"}\n' }, "a");
    const b = moving.commit({ "course.json": '{"title":"B"}\n' }, "b");
    moving.ref("refs/heads/main", a);
    const before = await fetchCommit(request({ url: url("moving.git"), commit: "main" }));
    moving.ref("refs/heads/main", b);
    const r = request({ url: url("moving.git"), commit: "main" });
    const after = await fetchCommit(r);
    expect([before.ok && before.commit, after.ok && after.commit]).toEqual([a, b]);
    expect(commitsIn(join(r.staging, "repo.git"), b)).toEqual([b]);
  });

  test("FETCH-5: the pin works for an IPv6 address too", async () => {
    const six = server(gitBackend(repos, home), "::1");
    const r = request({ url: `https://${HOST}:${six.port}/course.git`, commit: "main", network: network(six.port!, "::1") });
    expect(await fetchCommit(r)).toMatchObject({ ok: true, commit: second });
  });
});

describe("fetchCommit: refused URLs, before git runs", () => {
  // `git` names no program, so a refusal made after git started would be git-failed, not the reason here.
  const NO_GIT = "/nonexistent/git";
  // Production's address checks and ports; a lookup here would fail the case as `unresolved`.
  const NO_DNS: Partial<Network> = { resolve: async () => { throw new Error("these cases make no lookup"); } };
  const refused = (url: string, network: Partial<Network> = NO_DNS) => {
    const r = { url, commit: second, staging: staging(), git: NO_GIT, network };
    return fetchCommit(r).then((got) => ({ got, staged: existsSync(r.staging) }));
  };

  test.each([
    ["http", "http://example.com/course.git", "not-https"],
    ["ssh", "ssh://git@example.com/course.git", "not-https"],
    ["scp-like ssh", "git@example.com:course.git", "not-https"],
    ["git://", "git://example.com/course.git", "not-https"],
    ["file://", "file:///srv/course.git", "not-https"],
    ["ext::, which runs a command", "ext::sh -c touch% /tmp/pwned", "not-https"],
    ["a local path", "/srv/course.git", "not-https"],
    ["an option", "--upload-pack=touch /tmp/pwned", "not-https"],
    ["https without its slashes", "https:example.com/course.git", "not-https"],
    ["backslashes", "https:\\\\example.com\\course.git", "not-https"],
    ["a user and token", "https://user:token@example.com/course.git", "credentials"],
    ["a user alone", "https://user@example.com/course.git", "credentials"],
    ["a non-default port", "https://example.com:8443/course.git", "bad-port"],
    ["a query", "https://example.com/course.git?x=1", "bad-url"],
    ["a fragment", "https://example.com/course.git#x", "bad-url"],
    ["leading whitespace", " https://example.com/course.git", "not-https"],
    ["a space", "https://example.com/my course.git", "bad-url"],
    ["a newline", "https://exam\nple.com/course.git", "bad-url"],
    ["no host", "https:///course.git", "bad-url"],
    ["an overlong URL", `https://example.com/${"a".repeat(2100)}`, "bad-url"],
    ["a loopback literal", "https://127.0.0.1/course.git", "private-address"],
    ["a loopback literal in hex", "https://0x7f.1/course.git", "private-address"],
    ["an IPv6 loopback literal", "https://[::1]/course.git", "private-address"],
    ["an IPv4-mapped IPv6 loopback literal", "https://[::ffff:127.0.0.1]/course.git", "private-address"],
    ["the cloud metadata address", "https://169.254.169.254/latest", "private-address"],
    ["a private literal", "https://10.0.0.8/course.git", "private-address"],
  ])("FETCH-6: %s is refused", async (_what, raw, reason) => {
    expect(await refused(raw)).toMatchObject({ got: { ok: false, refusal: { reason } }, staged: false });
  });

  test.each([
    ["loopback", ["127.0.0.1"]],
    ["a private address", ["192.168.1.20"]],
    ["CGNAT", ["100.64.0.1"]],
    ["link-local", ["169.254.169.254"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv6 unique-local", ["fd00::1"]],
    ["IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["one private among public addresses", ["93.184.216.34", "10.0.0.1"]],
  ])("FETCH-7: a host resolving to %s is refused", async (_what, addresses) => {
    expect(await refused("https://localhost/course.git", { resolve: async () => addresses }))
      .toMatchObject({ got: { ok: false, refusal: { reason: "private-address" } }, staged: false });
  });

  test("FETCH-8: a host that resolves to no address is refused", async () => {
    expect(await refused("https://nowhere.test/course.git", { resolve: async () => [] }))
      .toMatchObject({ got: { ok: false, refusal: { reason: "unresolved" } }, staged: false });
  });

  test("FETCH-8: a host that does not resolve is refused", async () => {
    expect(await refused("https://nowhere.test/course.git", { resolve: async () => { throw new Error("ENOTFOUND"); } }))
      .toMatchObject({ got: { ok: false, refusal: { reason: "unresolved" } }, staged: false });
  });

  test.each([
    ["an option", "--upload-pack=touch"],
    ["a range", "main..evil"],
    ["an empty name", ""],
    ["a space", "my branch"],
    ["a trailing slash", "main/"],
    ["a lock file name", "main.lock"],
  ])("FETCH-9: a commit given as %s is refused", async (_what, commit) => {
    const r = request({ commit, git: NO_GIT });
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "bad-commit" } });
    expect(existsSync(r.staging)).toBe(false);
  });
});

describe("fetchCommit: refusals from the server, with staging deleted", () => {
  test("FETCH-10: a branch or tag the repository lacks is refused", async () => {
    const r = request({ commit: "nope" });
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "no-such-ref" } });
    expect(existsSync(r.staging)).toBe(false);
  });

  test("FETCH-11: a name that is both a branch and a tag is refused as ambiguous", async () => {
    const r = request({ commit: "same" });
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "ambiguous-ref" } });
    expect(existsSync(r.staging)).toBe(false);
  });

  test("FETCH-12: a hash the repository lacks is refused", async () => {
    const r = request({ commit: "0123456789abcdef0123456789abcdef01234567" });
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "git-failed" } });
    expect(existsSync(r.staging)).toBe(false);
  });

  test("FETCH-13: a fetch over the size limit is stopped and its staging folder deleted", async () => {
    const r = request({ url: url("big.git"), commit: bigCommit, limits: { packBytes: 256 * 1024 } });
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "too-large" } });
    expect(existsSync(r.staging)).toBe(false);
  });

  test("FETCH-14: a server that never answers is stopped at the time limit and its staging folder deleted", async () => {
    const slow = server(() => new Promise<Response>(() => {}));
    const r = request({ url: `https://${HOST}:${slow.port}/course.git`, commit: second, network: network(slow.port!), limits: { gitMs: 1500 } });
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "timeout" } });
    expect(existsSync(r.staging)).toBe(false);
  });

  test("FETCH-15: a redirect is not followed", async () => {
    const redirect = server((req) => Response.redirect(`https://${HOST}:${good.port}${new URL(req.url).pathname}${new URL(req.url).search}`, 302));
    const r = request({ url: `https://${HOST}:${redirect.port}/course.git`, commit: second, network: network(redirect.port!) });
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "git-failed" } });
    expect(existsSync(r.staging)).toBe(false);
  });

  test("FETCH-16: a staging folder that already exists is refused and left alone", async () => {
    const r = request({ commit: second });
    mkdirSync(r.staging);
    writeFileSync(join(r.staging, "keep"), "mine");
    expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "bad-staging" } });
    expect(existsSync(join(r.staging, "keep"))).toBe(true);
  });
});

describe("fetchCommit: git ignores the user's configuration and credentials", () => {
  test("FETCH-17: asked for a password, git uses no credential helper, askpass, netrc or configured header", async () => {
    // A server that wants a password and records every Authorization header it is sent.
    const seen: string[] = [];
    const locked = server((req) => {
      const auth = req.headers.get("authorization");
      if (auth !== null) seen.push(auth);
      const extra = req.headers.get("x-from-config");
      if (extra !== null) seen.push(`x-from-config: ${extra}`);
      return new Response("who are you?", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="course"' } });
    });
    const dir = join(root, "user");
    mkdirSync(dir);
    const marker = join(dir, "asked");
    const askpass = join(dir, "askpass");
    writeFileSync(askpass, `#!/bin/sh\ntouch ${marker}\necho secret\n`);
    chmodSync(askpass, 0o755);
    writeFileSync(join(dir, ".netrc"), `machine ${HOST} login user password secret\n`);
    const global = configFile(dir, `[credential]\n\thelper = !touch ${marker}.global\n[http]\n\textraHeader = X-From-Config: global\n`);
    const saved = { ...process.env };
    Object.assign(process.env, {
      HOME: dir, GIT_CONFIG_GLOBAL: global, GIT_ASKPASS: askpass, SSH_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "1",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: `!touch ${marker}.env`,
    });
    try {
      const r = request({ url: `https://${HOST}:${locked.port}/course.git`, commit: "main", network: network(locked.port!) });
      expect(await fetchCommit(r)).toMatchObject({ ok: false, refusal: { reason: "git-failed" } });
      expect(existsSync(r.staging)).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    expect({ seen, asked: [marker, `${marker}.global`, `${marker}.env`].filter(existsSync) }).toEqual({ seen: [], asked: [] });
  });
});

describe("isPublicAddress", () => {
  // Oracle: the IANA IPv4 and IPv6 Special-Purpose Address Registries (RFC 6890 and its updates),
  // RFC 6598 for CGNAT, and RFC 4291 §2.4 for IPv6's global unicast range 2000::/3.
  test.each([
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.255.254",
    "169.254.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1",
    "192.168.0.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255",
    "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1", "ff0e::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1", "100::1",
    "2001:db8::1", "2001::1", "2001:2::1", "2001:4:112::1", "2002:7f00:1::1", "3fff::1", "fe80::1%en0",
    "", "localhost", "1.2.3", "1.2.3.4.5", "01.2.3.4", "256.0.0.1",
  ])("%p is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test.each([
    "1.1.1.1", "8.8.8.8", "93.184.216.34", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0",
    "192.0.1.1", "192.169.0.1", "198.17.255.255", "198.20.0.0", "223.255.255.255",
    "2606:4700:4700::1111", "2001:4860:4860::8888", "2a00:1450:4009::1",
  ])("%p is public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
