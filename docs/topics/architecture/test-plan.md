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

## The course list (flyingrobots/school#234)

[The course list](README.md#the-course-list), RFC 7 task 4. The oracle is the issue's sections 2b and 2d and RFC 7 §7: configured and installed courses are served together, an install's trust comes from the record, a name in both places stops start with exit 2, and an install whose folder is missing or altered is listed with `lessons: null` and not served. The registry cases stand a list in for the `installedCourses` port, whose answers the LearningRecord contract checks on both drivers.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| REGISTRY-1 | One configured and one installed course | Both listed by name; the installed one untrusted, served from `courses/<install id>/` in the store | implemented | `server/course-registry.test.ts`: `lists a configured and an installed course together, by name, the installed one untrusted`, `serves an installed course from its install's folder in the course store`; `server/installed-courses.test.ts`: `a configured and an installed course are listed together, the installed one untrusted` |
| REGISTRY-2 | An installed course's files | Its lesson JSON and reference files carry `Content-Security-Policy: sandbox` | implemented | `server/installed-courses.test.ts`: `an installed course's lesson and reference files are served sandboxed` |
| REGISTRY-3 | A recorded trust choice | Served trusted | implemented | `server/course-registry.test.ts`: `an installed course the learner chose to trust is served trusted` |
| REGISTRY-4 | A name both configured and installed | Start refused, naming the name, the configured folder and the install id; through the real server, exit 2 | implemented | `server/course-registry.test.ts`: `refuses to start when a name is both configured and installed, naming both`; `server/installed-courses.test.ts`: `a name both configured and installed stops start with exit 2, naming both` |
| REGISTRY-5 | Install folder deleted | Listed with `lessons: null` and a reason naming the missing files; not served | implemented | `server/course-registry.test.ts`: `an install whose folder is gone is listed with its reason and not served`; `server/installed-courses.test.ts`: `an install whose folder is gone or whose files changed is listed with lessons null and its reason` |
| REGISTRY-6 | A file changed, or one added | Listed with `lessons: null` and the reason; the course JSON answers `reference: []`, its lesson and reference files 404 | implemented | `server/course-registry.test.ts`: `an install whose files changed is listed with its reason and not served`, `an install with a file added to its folder is listed and not served`; `server/installed-courses.test.ts`: `an install whose folder is gone or whose files changed is listed with lessons null and its reason`, `an install whose files changed is not served: its course answers lessons null, its lesson and reference files 404` |
| REGISTRY-7 | Installs with no `SCHOOL_COURSE_STORE` | Listed, not served, the reason naming the variable | implemented | `server/course-registry.test.ts`: `installs with no course store configured are listed and not served` |
| REGISTRY-8 | A stale registry (the known failure mode) | An install, a trust choice, a removal and a deleted folder after start each show on the next read; an install under a configured name after start is logged and not served in its place | implemented | `server/course-registry.test.ts`: `a course installed after start is served on the next read, with no restart`, `a trust choice made after start is served on the next read`, `a course removed after start is gone on the next read`, `an install whose folder goes missing after start is no longer served on the next read`, `an install under a configured name after start is not served in its place, and says so` |
| REGISTRY-9 | The acceptance test: a folder and its row added while School runs | In `/api/courses` with no restart, the row written through `school_app`'s own connection | implemented | `server/installed-courses.test.ts`: `a course whose folder and row are added while School runs is in /api/courses with no restart (Bun.SQL)` |
| REGISTRY-10 | The content digest | The SHA-256 of one `<sha256> <path>\n` line per file, sorted by path, over the FIPS 180-2 vectors; a symlink has no digest | implemented | `server/course-registry.test.ts`: `is the SHA-256 of one line per file, its hash and its path, sorted by path`, `refuses a folder holding anything but regular files and folders` |
