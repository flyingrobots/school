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

## The pinned skill (flyingrobots/school#257)

RFC 9 §5.3 and [the pinned skill](README.md#the-pinned-skill). The manifest's oracle is its definition there, with FIPS 180-2's published SHA-256 vectors for `abc` and the empty message. The checkout's digest comes from an independent pipeline: `git ls-files`, `shasum -a 256`, `sed` and `sort` in the C locale. All cases are in `server/skill.test.ts` unless named.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| SKILLPIN-1 | The checkout's skill and references copied where compose mounts them, through the real server | `GET /api/settings/authoring` is on, with the digest and file count the pipeline computes from the checkout | implemented | `SKILLPIN-1: reports authoring on, with the mounted skill's digest equal to the checkout's` |
| SKILLPIN-2 | A fixture guide | The manifest is exactly the hand-written lines, sorted by path as bytes | implemented | ``SKILLPIN-2: is one `<sha256> <path>` line per file under guide/, sorted by path as bytes`` |
| SKILLPIN-3 | The same fixture | On, with the SHA-256 of that text and five files | implemented | `SKILLPIN-3: authoring is on with the SHA-256 of the manifest's text and the number of files` |
| SKILLPIN-4 | One byte changed | A different digest | implemented | `SKILLPIN-4: one changed byte in any file changes the digest` |
| SKILLPIN-5 | One file renamed, no byte changed | A different digest | implemented | `SKILLPIN-5: a renamed file changes the digest, though no byte changed` |
| SKILLPIN-6 | The skill folder named through a symlink | The same status as the folder itself | implemented | `SKILLPIN-6: a skill folder named through a symlink is hashed as the folder it names` |
| SKILLPIN-7 | `SCHOOL_SKILL` empty | Off: `SCHOOL_SKILL is empty` | implemented | `SKILLPIN-7: SCHOOL_SKILL is empty` |
| SKILLPIN-8 | No skill folder | Off, naming the path and `.agents/skills/school` | implemented | `SKILLPIN-8: the skill folder is not there, naming it and the folder to mount` |
| SKILLPIN-9 | The skill path is a file | Off: `<path> is not a folder` | implemented | `SKILLPIN-9: the skill path is a file, not a folder` |
| SKILLPIN-10 | No `SKILL.md` | Off: `<path> has no SKILL.md` | implemented | `SKILLPIN-10: the skill folder holds no SKILL.md` |
| SKILLPIN-11 | No `course-format/` or no `voice/` | Off, naming the path and `docs/topics/<name>` | implemented | `SKILLPIN-11: the %s reference is not there, naming it and the folder to mount` |
| SKILLPIN-12 | A symlink in the skill or a reference | Off: `<path> is a symlink` | implemented | `SKILLPIN-12: a symlink inside the %s folder, naming it: only regular files are hashed and sent` |
| SKILLPIN-13 | No mount, through the real server | It serves; `GET /api/settings/authoring` is off, naming the path | implemented | `SKILLPIN-13: still serves, and reports authoring off with the reason` |
| SKILLPIN-14 | The same start's output | `school: authoring off: the school skill is not at <path>` on stdout | implemented | `SKILLPIN-14: says at start that authoring is off, and why` |
| SKILLPIN-15 | Configuration | Defaults to the framework's `.agents/skills/school` and `docs/topics`; relative paths resolve against the working directory; empty `SCHOOL_SKILL` is null | implemented | `server/config.test.ts`: `SCHOOL_SKILL and SCHOOL_SKILL_DOCS default to the framework checkout's skill and its docs/topics`, `SCHOOL_SKILL and SCHOOL_SKILL_DOCS name the skill and its references, relative paths resolving against the working directory`, `an empty SCHOOL_SKILL means no skill, so authoring is off` |
| SKILLPIN-16 | Compose | The three read-only mounts under `/framework`; `SCHOOL_SKILL: ${SCHOOL_COMPOSE_SKILL-/framework/skills/school}` and `SCHOOL_SKILL_DOCS: /framework/docs`, so a host export never reaches the container | implemented | `server/docker.test.ts`: `compose mounts the checkout's school skill and its references read-only under /framework`, `compose points SCHOOL_SKILL at the mount through SCHOOL_COMPOSE_SKILL, which .env may set empty and a host export never reaches, and SCHOOL_SKILL_DOCS at the references with no variable at all` |

_Table 3. The pinned skill's cases. SKILLPIN-16 reads compose.yaml; no test builds the image or runs compose._
