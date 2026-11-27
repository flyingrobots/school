# Architecture test plan

The contract ledger for [School's architecture](README.md). Every case runs in `bun test`.

## The bridge's output

The cases run the bridge as a real process.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| BRIDGE-OUT-1 | Logs | Every stdout line parses as JSON with a string `kind`; no line contains the prompt | implemented | `bridge/bridge.test.ts`: `logs are JSON Lines and never contain the prompt` |
| BRIDGE-OUT-2 | Port taken | With the port held by another socket: every line on stdout and stderr parses as JSON with a string `kind`; exactly one `bridge.error`, last on stdout, naming `host:port` and carrying `host` and `port`; no token in the output; exit 2 | implemented | `bridge/bridge.test.ts`: `a bridge whose port is taken writes one bridge.error line naming it, nothing but JSON Lines, and exits 2` |

## The course store (flyingrobots/school#233)

`SCHOOL_COURSE_STORE`, RFC 7 §5.1. The oracle for every refusal is §5.1's: start refuses, with exit 2 naming both paths, a store that is, holds or sits inside a course or learner state. This page extends it to mounts and the web folder, which School serves and must not write into.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| STORE-1 | A store beside every other folder | `config.store` is the path; the server starts | implemented | `server/config.test.ts`: `SCHOOL_COURSE_STORE names the course store`, `a store beside every other folder, over none of them, is accepted`; `server/startup.test.ts`: `a course store beside the course and the state starts` |
| STORE-2 | Unset or empty | `config.store` is null: no store, so installing is off | implemented | `server/config.test.ts`: `SCHOOL_COURSE_STORE %s means no store, so installing is off` |
| STORE-3 | A relative path | Resolved against the working directory, as every other path is, never the framework's; refused when that lands in a relative course | implemented | `server/config.test.ts`: `a relative SCHOOL_COURSE_STORE resolves against the working directory, as every other path does, not the framework's`, `a relative SCHOOL_COURSE_STORE inside a relative course is refused, both resolved from the working directory` |
| STORE-4 | Is or sits inside a trusted or untrusted course, `SCHOOL_STATE`, the PGlite record, a mount or `SCHOOL_WEB`; holds `DB_PATH` or the record | Refused, naming both paths | implemented | `server/config.test.ts`: `a store that %s is refused, naming both paths` |
| STORE-5 | Holds a course, `SCHOOL_STATE`, a mount or `SCHOOL_WEB` | Refused, naming both paths | implemented | `server/config.test.ts`: `a store that holds %s is refused, naming both paths` |
| STORE-6 | A symlink into a course or into the state | Refused, since paths are compared resolved | implemented | `server/config.test.ts`: `a store that is a symlink into a course is refused, since paths are compared resolved`, `a store that is a symlink into SCHOOL_STATE is refused, since paths are compared resolved` |
| STORE-7 | One folder under two names (a bind mount), by `(st_dev, st_ino)` | Refused, naming both paths; a folder with its own identity is accepted | implemented | `server/config.test.ts`: `a store that is %s, by device and inode, is refused, naming both paths`, `a store with its own device and inode is accepted under the same fake stat` |
| STORE-8 | Through the real server: inside the course, inside the state, a symlink into either | Exit 2, both paths on stderr, no record made | implemented | `server/startup.test.ts`: `a course store %s stops startup, naming both paths`, `a course store that is a symlink into %s stops startup, naming both paths` |
| STORE-9 | The image and compose | The Dockerfile installs `git` and `ca-certificates` and makes `/store` owned by `school`; compose mounts `course-store` at `/store` with `SCHOOL_COURSE_STORE: ${SCHOOL_COMPOSE_COURSE_STORE-/store}`, so a host export never reaches the container | implemented | `server/docker.test.ts`: `the image has git, and the CA certificates an https fetch needs`, `the image makes /store owned by the server's user, so a new course-store volume is writable`, `compose mounts the course-store volume at /store and points SCHOOL_COURSE_STORE at it through SCHOOL_COMPOSE_COURSE_STORE, which .env may set empty and a host export never reaches` |
| STORE-10 | Is, holds or sits inside the framework folder (`SCHOOL_ROOT`), which holds the server source | Refused, naming both paths | implemented | `server/config.test.ts`: `a store that %s is refused, naming both paths` (framework cases) |
| STORE-11 | A path that exists but is a file | Refused, naming the path | implemented | `server/config.test.ts`: `a store path that exists but is a file, not a folder, is refused, naming it` |

_Table 2. The course store's cases. STORE-9 reads the Dockerfile; no test builds the image._

## Fetching one commit (flyingrobots/school#236)

`fetchCommit` in `server/fetch-commit.ts`, RFC 7 §6, task 6. The oracle for every refusal is §6 and Table 6.1; the limits are Table 6.2's. Every network case runs against a local https server (`server/testing/https-git.ts`: `git http-backend` on loopback, port 0, with a certificate made for `course.test`), never the internet. `course.test` never resolves (RFC 6761), so a good fetch reaching that server shows git used the pinned address.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| FETCH-1 | A full hash | Fetched as given into a bare `<staging>/repo.git` holding that commit alone | implemented | `server/fetch-commit.test.ts`: `FETCH-1: a full hash is fetched as given, alone, into a bare repository in staging` |
| FETCH-2 | A hash no branch points at | Fetched by its hash | implemented | `FETCH-2: a commit no branch points at is fetched by its hash` |
| FETCH-3 | A branch, a lightweight tag, an annotated tag, `HEAD` | Each resolves to its full hash (the annotated tag to its commit), which is fetched | implemented | `FETCH-3: %s resolves to its full hash, which is fetched` |
| FETCH-4 | A branch force-moved between two fetches | Each fetch gets where the branch points then | implemented | `FETCH-4: a branch force-moved between two fetches resolves to where it points now` |
| FETCH-5 | A host pinned to an IPv6 address | Fetched through `[::1]` | implemented | `FETCH-5: the pin works for an IPv6 address too` |
| FETCH-6 | `http`, `ssh`, scp-like, `git://`, `file://`, `ext::`, a path, an option, credentials, a non-default port, a query, a fragment, whitespace, no host, an overlong URL, loopback, private and metadata literals in IPv4 and IPv6, and a host that is not a plain host name (a label starting with `-` or `+` or ending with `-`, a label of 64 characters, a host of 254, an empty label, two trailing dots, `,` `;` `*` `=` `_`) | Each refused with its reason before git runs (git is a missing program); no staging folder. A 63-character label, a 253-character host, a punycode label and inner hyphens pass the URL check and are looked up | implemented | `FETCH-6: %s is refused`, `FETCH-6: a host at the edge of the rules, %s, passes the URL check and is looked up` |
| FETCH-7 | A host resolving to loopback, private, CGNAT, link-local, IPv6 loopback, unique-local or IPv4-mapped loopback, or to one private address among public ones | `private-address`; no staging folder | implemented | `FETCH-7: a host resolving to %s is refused` |
| FETCH-8 | A host that does not resolve, or resolves to nothing | `unresolved` | implemented | `FETCH-8: a host that does not resolve is refused`, `FETCH-8: a host that resolves to no address is refused` |
| FETCH-9 | A commit given as an option, a range, an empty name, a space, a trailing slash, a `.lock` name | `bad-commit`; no staging folder | implemented | `FETCH-9: a commit given as %s is refused` |
| FETCH-10 | A branch or tag the repository lacks | `no-such-ref`; staging deleted | implemented | `FETCH-10: a branch or tag the repository lacks is refused` |
| FETCH-11 | A name that is both a branch and a tag | `ambiguous-ref`; staging deleted | implemented | `FETCH-11: a name that is both a branch and a tag is refused as ambiguous` |
| FETCH-12 | A hash the repository lacks | `git-failed`; staging deleted | implemented | `FETCH-12: a hash the repository lacks is refused` |
| FETCH-13 | A commit larger than the pack limit | `too-large`; staging deleted | implemented | `FETCH-13: a fetch over the size limit is stopped and its staging folder deleted` |
| FETCH-14 | A server that never answers | `timeout` at the time limit; staging deleted | implemented | `FETCH-14: a server that never answers is stopped at the time limit and its staging folder deleted` |
| FETCH-15 | A redirect to the same pinned host and port | Not followed: `git-failed`; staging deleted | implemented | `FETCH-15: a redirect is not followed` |
| FETCH-16 | A staging folder that exists | `bad-staging`; its contents left alone | implemented | `FETCH-16: a staging folder that already exists is refused and left alone` |
| FETCH-17 | A server asking for a password, with the user's global config, `GIT_CONFIG_COUNT`, askpass and `.netrc` all offering credentials or a header | `git-failed`; no helper or askpass ran and no `Authorization` or configured header reached the server | implemented | `FETCH-17: asked for a password, git uses no credential helper, askpass, netrc or configured header` |
| FETCH-18 | `isPublicAddress` on IANA special-purpose ranges, their boundaries, IPv4-mapped, NAT64, 6to4, Teredo and malformed input | Refused; public addresses on each side of every boundary accepted | implemented | `isPublicAddress`: `%p is not public`, `%p is public` |
| FETCH-19 | The host, the host with a trailing dot, and a host starting with `-`, with a resolver that answers every name | The first two are looked up once as `course.test` and fetched through the pin; the third is `bad-url` with no lookup. git never reports "Could not resolve host" | implemented | `FETCH-19: %s is looked up by School only, and git uses the pin` |
| FETCH-20 | A staging folder inside another git work tree whose configuration sets `http.extraHeader` and `url.insteadOf`, for a branch and for a full hash | Fetched; neither the header nor the rewritten URL reaches the server | implemented | `FETCH-20: fetching %s inside another repository uses none of its configuration` |
| FETCH-21 | A relative staging path | `bad-staging`; nothing made | implemented | `FETCH-21: a relative staging path is refused, and nothing is made` |
| FETCH-22 | A 2 MiB pack sent at 26 KiB per 100 ms against a 256 KiB limit | `too-large` before the server has sent the whole pack; staging deleted | implemented | `FETCH-22: a large pack sent slowly is stopped while it arrives, not after` |
| FETCH-23 | A git that leaves a child running in its process group and exits | No child is alive after the fetch | implemented | `FETCH-23: a process git leaves running when it exits is killed` |
| FETCH-24 | A proxy in git's environment (`https_proxy`, `all_proxy`) | Fetched directly; the proxy receives nothing | implemented | `FETCH-24: a proxy in git's environment is not used` |
| FETCH-25 | git configuration that rewrites the URL to `file://` | `git-failed` with `transport 'file' not allowed`; staging deleted | implemented | `FETCH-25: a configuration that rewrites the URL to file:// does not reach the file` |
| FETCH-26 | The hash of a tree or a blob the server serves | `not-a-commit`; staging deleted | implemented | `FETCH-26: the hash of %s, which the server serves, is refused as not a commit` |
| FETCH-27 | A good fetch | `refs/heads/course` points at the commit | implemented | `FETCH-27: the fetched commit is held by refs/heads/course, so nothing prunes it before it is read` |
| FETCH-28 | A SHA-256 repository, by branch and by full hash | Fetched by its 64-digit hash | implemented | `FETCH-28: a SHA-256 repository's commit, named by %s, is fetched by its 64-digit hash` |
| FETCH-29 | A request carrying `git`, `limits` and `network` fields, as a spread JSON body would | The fields are ignored; fetched with the test seams given as the second argument | implemented | `FETCH-29: the test seams carried on a request, as a JSON body spread into it would carry them, are ignored` |

_Table 3. The fetch's cases. FETCH-2 to FETCH-29 are in `server/fetch-commit.test.ts`. FETCH-22 to FETCH-27 each fail when the protection they name is deleted. None runs the server image's git; CI runs them on the runner's git._
