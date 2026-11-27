// A local https git server for the fetch tests (flyingrobots/school#236). Never the internet: it
// binds loopback on port 0, serves bare repositories under one folder through `git http-backend`
// (git's own smart-http CGI), and presents a self-signed certificate made here for one host name.
// The fetch is pointed at it with `http.sslCAInfo`, which only tests pass.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A clean environment for the git the tests run: no system or global configuration, fixed dates and names. */
export function gitEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Author", GIT_AUTHOR_EMAIL: "author@example.test", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Author", GIT_COMMITTER_EMAIL: "author@example.test", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
}

/** Runs git and returns its trimmed stdout; throws with stderr when it fails. */
export function git(home: string, args: string[], input?: Uint8Array | string): string {
  const r = Bun.spawnSync(["git", ...args], { env: gitEnv(home), cwd: home, stdin: input === undefined ? "ignore" : Buffer.from(input) });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** A bare repository built with plumbing, so every commit is exactly the files given. */
export class TestRepo {
  constructor(readonly dir: string, readonly home: string) {
    git(home, ["init", "--quiet", "--bare", "--template=", "--initial-branch=main", dir]);
  }

  private g(args: string[], input?: Uint8Array | string) {
    return git(this.home, ["--git-dir", this.dir, ...args], input);
  }

  /** A commit holding exactly `files` (flat names), on top of `parents`; returns its hash. */
  commit(files: Record<string, string | Uint8Array>, message: string, parents: string[] = []): string {
    const entries = Object.entries(files).map(([name, body]) => `100644 blob ${this.g(["hash-object", "-w", "--stdin"], body)}\t${name}`);
    const tree = this.g(["mktree"], entries.join("\n") + "\n");
    return this.g(["commit-tree", tree, "-m", message, ...parents.flatMap((p) => ["-p", p])]);
  }

  /** Points `ref` (a full ref name) at `hash`, moving it if it exists. */
  ref(ref: string, hash: string) {
    this.g(["update-ref", ref, hash]);
  }

  /** An annotated tag object named `name` pointing at `hash`, under refs/tags/. */
  annotatedTag(name: string, hash: string) {
    this.g(["tag", "-a", name, hash, "-m", `tag ${name}`]);
  }
}

/** A certificate and key for `host`, self-signed, so it can be passed to git as its own CA. */
export function certificate(dir: string, host: string): { cert: string; key: string } {
  mkdirSync(dir, { recursive: true });
  const cert = join(dir, "cert.pem");
  const key = join(dir, "key.pem");
  const r = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${host}`,
    "-addext", `subjectAltName=DNS:${host}`, "-addext", "basicConstraints=critical,CA:TRUE"], { stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(`openssl could not make a test certificate: ${r.stderr.toString()}`);
  return { cert, key };
}

type Handler = (req: Request) => Response | Promise<Response>;

/** An https server on loopback, port 0, with the given certificate. */
export function serveHttps(tls: { cert: string; key: string }, handler: Handler, hostname = "127.0.0.1") {
  return Bun.serve({ hostname, port: 0, idleTimeout: 0, tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) }, fetch: handler });
}

/**
 * Serves every bare repository under `root` with `git http-backend`. The backend lets a client ask
 * for any object by hash (`uploadpack.allowAnySHA1InWant`), as GitHub does, so a commit that no
 * branch points at any longer can still be fetched by its hash.
 */
export function gitBackend(root: string, home: string): Handler {
  return async (req) => {
    const u = new URL(req.url);
    const body = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : new Uint8Array(0);
    const env: Record<string, string> = {
      ...gitEnv(home), GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "uploadpack.allowAnySHA1InWant", GIT_CONFIG_VALUE_0: "true",
      REQUEST_METHOD: req.method, PATH_INFO: decodeURIComponent(u.pathname), QUERY_STRING: u.search.slice(1),
      CONTENT_TYPE: req.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length), REMOTE_ADDR: "127.0.0.1",
      HTTP_CONTENT_ENCODING: req.headers.get("content-encoding") ?? "", HTTP_GIT_PROTOCOL: req.headers.get("git-protocol") ?? "",
    };
    const proc = Bun.spawn(["git", "http-backend"], { env, cwd: home, stdin: body, stdout: "pipe", stderr: "ignore" });
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    const split = Buffer.from(out).indexOf("\r\n\r\n");
    const head = new TextDecoder().decode(out.subarray(0, split));
    const headers = new Headers();
    let status = 200;
    for (const line of head.split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
      else headers.append(name, value);
    }
    return new Response(out.subarray(split + 4), { status, headers });
  };
}

/** Writes a git configuration file holding `text` and returns its path. */
export function configFile(dir: string, text: string): string {
  const path = join(dir, "gitconfig");
  writeFileSync(path, text);
  return path;
}
