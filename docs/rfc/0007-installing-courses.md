---
title: "RFC 7: Installing courses"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-26
updated: 2026-11-26
version: 0.2.0
status: "Decided, 2026-11-26: a course store, install by git URL or git bundle, every open question answered as recommended. Decided by an agent under the maintainer's delegated authority; the maintainer may overturn it. Answers flyingrobots/school#188. Builds on flyingrobots/school at commit 5baffd2."
---

# RFC 7: Installing courses

> **How to read this.** **Built** means it exists at commit `5baffd2` (the branch of flyingrobots/school#212, which decides RFC 4), with the file that shows it. **Proposed** means this RFC asks for it. **Open** means it needs the maintainer's decision; §12 lists those. How School works today is in the [architecture reference](../topics/architecture/README.md); this RFC describes only what would change.

## Executive summary

The maintainer wants a learner to add a course from School's own pages, by git repository URL or by uploading a bundle, without a shell on the server (flyingrobots/school#188). RFC 4 decided that a course published in the Library is installed by pasting its repository URL and pinned commit into one's own School, and handed that step to this issue ([RFC 4 §9](0004-publishing-courses.md#9-decision)).

This RFC recommends **one install pipeline with two doors.** A git URL and an uploaded bundle both become a git commit in a scratch bare repository. School then walks that commit's tree itself, writes only the files it reads (`course.json`, `lessons/*.json`, `reference/**`) into a staging folder, refusing anything hostile, and runs the same checks as `school check`. The learner sees what was found and picks the course's name. Only then is the folder moved into a course store and the install recorded in Postgres, untrusted. School runs nothing from the course, and the course store holds content that the record says how to rebuild.

| Open question in flyingrobots/school#188 | Recommendation |
| --- | --- |
| Where installed courses live beside `SCHOOL_COURSES` | A new **course store**, `SCHOOL_COURSE_STORE`, a writable folder (a `course-store` volume at `/store` under compose), separate from configured courses and from learner state. Each install is an immutable folder `courses/<install id>/`; the record says which one is current for each name |
| How a course's name (its progress key) is chosen and kept stable | The learner chooses it at install, from a suggestion; the record binds it to the install. An update is addressed by name and never re-derives it. Renaming stays the migrate job's `--rename-course`, which also moves install rows |
| What an update does to existing progress | Nothing is rewritten. The record is append-only and keyed by course name, lesson id and block id, with a snapshot of what was shown. Kept ids keep their credit; removed ids keep their history but stop counting and stop coming back for review. The update preview counts what would stop counting before the learner agrees |
| What a bundle is | A **git bundle** (`git bundle create course.bundle HEAD`): one head, no prerequisites. It enters the same pipeline as a URL, so the same commit installs identical content either way. Not zip or tar; signing optional, as RFC 4 Q7 decided for listings |

_Table 0.1. The four open questions and this RFC's answer to each. Every answer keeps the record as the one authority and the course as untrusted input._

The first build slice is installing from a git URL at a pinned commit, validated before anything is installed, and recorded in the database: tasks 1 to 9 in [§10](#10-order-of-work). In short: fetch or upload into scratch, check as `school check` does, ask the learner, then install and record.

## Contents

1. [The problem and who it serves](#1-the-problem-and-who-it-serves)
2. [Constraints](#2-constraints)
3. [What exists today](#3-what-exists-today)
4. [The install pipeline](#4-the-install-pipeline)
5. [The four questions](#5-the-four-questions)
6. [Hostile input](#6-hostile-input)
7. [The record](#7-the-record)
8. [Who can ask for an install](#8-who-can-ask-for-an-install)
9. [The Settings page](#9-the-settings-page)
10. [Order of work](#10-order-of-work)
11. [Out of scope](#11-out-of-scope)
12. [Risks and open questions](#12-risks-and-open-questions)
13. [Decision](#13-decision)

## 1. The problem and who it serves

Adding a course today means a shell on the server, so a learner who studies from a phone over the tailnet cannot do it, and nobody can act on a Library listing without one. This section names who would install a course and what each needs.

**Built:** a course is a folder named in `SCHOOL_COURSES` or `SCHOOL_COURSE`, parsed once at start (`server/config.ts`, `parsePairs`). Under compose the folders are bind mounts, read-only (`server/compose.yaml`, `/course` and `/library`). Adding one means editing `server/.env` and running `./school up` again ([a course's folder](../topics/course-format/README.md#more-than-one-course-under-school-up)).

| Who | What they need |
| --- | --- |
| A **learner acting on a Library listing** | To paste a repository URL and commit into Settings and get exactly that commit, checked, with no shell |
| A **learner with a private course** | To install a course whose repository School cannot reach or has no credentials for, such as `flyingrobots/school-aion` today |
| A **learner updating a course** | To move to a newer commit and know beforehand what happens to what they have already answered |
| A **course author** | A course that installs the same way from a URL and from a file, refused with the same message `school check` gives them |

_Table 1.1. Who installs courses and what each needs. The private-course case is why a bundle upload is worth having beside the URL._

In short: the URL serves the Library, the bundle serves private and offline courses, and both need a safe update.

## 2. Constraints

Each recommendation is weighed against these. They come from existing decisions, not from this RFC.

| # | Constraint | Source |
| --- | --- | --- |
| C1 | The Postgres record is the only authoritative store; nothing that matters lives in browser storage or in a file the record cannot vouch for | [ADR 9](../adr/0009-the-learning-record-is-enforced-by-the-database.md); [RFC 3](0003-postgres-functions-and-generated-types.md) |
| C2 | The record is reached only through `school.<function>` calls, and its tables are append-only | `server/adapters/database.ts`, `functionCalls`; `server/db/migrations/0001_init.sql`, `refuse_change` |
| C3 | School reads a course and never writes into it; learner state never lives inside a course | [ADR 6](../adr/0006-separate-framework-lessons-and-learner-state.md); `server/config.ts` containment checks |
| C4 | School is reachable only over Tailscale or localhost, with no login | [ADR 4](../adr/0004-docker-on-this-mac-behind-tailscale.md); the [trust section](../topics/architecture/README.md#trust-and-known-defects) |
| C5 | No install endpoint that a public page can trigger | [RFC 4 §3](0004-publishing-courses.md#option-c-a-static-catalog-site-generated-from-the-index), "Why no install button" |
| C6 | Installed courses are untrusted by default: their files are served with a sandbox CSP and their blocks sanitised | RFC 4 §4.4; flyingrobots/school#210 |
| C7 | A course's declared summary, author, license and format version are optional `course.json` keys; an invalid value or an unplayable format is refused | flyingrobots/school#209 |
| C8 | The UI is built from shadcn registry components with theme-book colours, light and dark; copy is encouraging or neutral and invites with questions | [The settings page](../topics/settings-page/README.md#built-from); [School's voice](../topics/voice/README.md) |

_Table 2.1. Constraints every part of this RFC keeps. C1, C5 and C6 shape the design most._

In short: the record decides, the course is hostile until trusted, and nothing outside the learner's own School can start an install.

## 3. What exists today

Most of what an install needs is built: a loader that checks a course, a rename job for its progress key, path containment for served files and a guard on writes. What is missing is a writable place for courses, a way to change the course list while School runs, and any code that fetches. This section grounds each in the code.

| Piece | Built, at `5baffd2` | What installing needs from it |
| --- | --- | --- |
| Checking a course | `school check` loads a folder with the server's own loader: `readCourseFile` (`server/course-file.ts`) and `loadLibrary` (`server/blocks.ts`), in `server/check-course.ts` | The same checks, called as a function on a staging folder |
| Course names | `NAME` is `^[a-z0-9][a-z0-9-]*$` and `RESERVED` is `assets`, `courses`, `lessons`, `reference`, `api` (`server/config.ts`); `badCourseName` applies both (`server/db/rename-course.ts`) | The rule an installed name must pass |
| Renaming progress | `bun migrate.ts --rename-course <from>=<to>` moves every `encounters`, `views` and `decision_notes` row in one checked transaction, with School stopped ([the migrate job](../topics/migrate-job/README.md#renaming-a-course)) | Install rows must move with it |
| The course list | Read once at start: `served` and each title (`server/server.ts`, lines 41 to 50); `course(config, name)` looks only in `config.courses` | A list that changes after an install, without a restart |
| Lessons | Read on every request, falling back to the last valid set (`lastValidLoader`, `server/server.ts`) | Nothing: an installed folder never changes |
| Served files | `serveFrom` checks containment lexically and after resolving symlinks; `referenceDir` refuses a `reference/` that resolves outside its course (`server/server.ts`) | Kept; the installer also refuses symlinks before writing |
| The write guard | Every `POST /api/*` needs `Content-Type: application/json` and is refused when `Sec-Fetch-Site` is `cross-site` (`guardApi`, `server/server.ts`); every request's `Host` must be one of School's names (`server/hosts.ts`) | Kept for installs; the bundle upload needs its own non-safelisted type (§8) |
| Settings in the record | The time zone choice is an append-only table with two functions (`server/db/migrations/0009_time_zone_choices.sql`) | The pattern for install, removal and trust rows |
| Fetching | Nothing. The server starts no child process, and the image has no `git` (`server/Dockerfile` installs Bun and School only) | New: a hardened `git`, run by the server |
| A writable place for courses | None. Every course mount is `:ro` (`server/compose.yaml`) | New: the course store |

_Table 3.1. What installing reuses and what it adds. The checks, names, rename and guards exist; fetching, a writable store and a live course list do not._

In short: the hard rules exist; this RFC adds a store, a fetch, and a course list that can grow.

## 4. The install pipeline

Every install, from a URL or from a file, goes through the same five stages, and only the last two touch anything outside scratch space. This section shows the pipeline, then explains why School reads a commit's tree itself instead of checking it out.

```mermaid
flowchart TD
    url["Repository URL and commit"] --> fetch["1. Fetch one commit into a bare repository in staging"]
    bundle["Uploaded git bundle"] --> verify["1. Verify the bundle and fetch its one head into staging"]
    fetch --> walk["2. Walk the commit's tree; write only course.json, lessons/*.json, reference/** into staging/course"]
    verify --> walk
    walk --> check["3. Check staging/course as school check does"]
    check -->|refused| tell["Answer the first problem; delete staging"]
    check -->|ok| preview["Preview: title, lessons, quizzes, license, format, suggested name"]
    preview -->|learner confirms a name| move["4. Move staging/course to courses/&lt;install id&gt;"]
    move --> record["5. Record the install in Postgres, untrusted; refresh the course list"]
```

_Figure 4.1. The install pipeline. Stages 1 to 3 write only inside `staging/`, which School sweeps at every start; the course store's `courses/` and the record change only after the learner confirms._

**Proposed.** "Validated before anything is written" in flyingrobots/school#188 means: before anything is written where School serves from or into the record. The loader reads a folder (`loadLibrary(dir)`), so stages 1 to 3 need scratch files; those live in `staging/<preview id>/` and are deleted on refusal, on a preview that is never confirmed (after one hour), and at every start.

**Why not `git clone` and a checkout.** A checkout writes whatever the tree holds: symlinks, a `.gitattributes` that changes line endings, submodule placeholders, and files School never reads. Reading the tree with `git ls-tree -r -l` gives every entry's mode, size and name before a single byte is written, so School refuses a symlink or an oversized file instead of finding it on disk. The fetch is into a bare repository, which has no working tree, so no checkout filter, hook or attribute is ever consulted. School writes each file itself, with exclusive creation, into a folder it has just made.

**Only what School reads is installed.** [A course's folder](../topics/course-format/README.md) lists what School reads: `course.json`, `lessons/*.json` and `reference/`. A `README.md`, `OBJECTIVES.md` or build script in the repository is never written, so it cannot be served or run. If School later reads more of a course (RFC 2's curriculum), the list grows in the same change.

In short: one pipeline for both sources, a tree School reads before it writes, and nothing installed until the learner says yes.

## 5. The four questions

Each open question in flyingrobots/school#188 has a recommendation here, with the alternatives weighed. They fit together: the store holds immutable folders, the record maps a name to one of them, and an update is a new folder under the same name.

### 5.1 Where installed courses live

**Proposed: a course store**, a folder named by a new variable `SCHOOL_COURSE_STORE`, which School may write and which holds nothing else. Without it, installing is switched off and Settings says so; a School configured only by `SCHOOL_COURSES` behaves as today.

```text
<SCHOOL_COURSE_STORE>/
  staging/<preview id>/repo.git/   bare repository for one fetch or bundle (scratch)
  staging/<preview id>/course/     the extracted, checked course awaiting confirmation (scratch)
  courses/<install id>/            one installed version: course.json, lessons/, reference/
```

_Listing 5.1. The course store's layout. Only `courses/` is served, and each folder there is written once and never changed._

| Option | For | Against |
| --- | --- | --- |
| **A separate course store** (recommended) | Configured courses stay read-only mounts, as today; installs have one writable place; ADR 6's three parts stay apart | One more setting and volume |
| Inside `SCHOOL_STATE` | No new setting | Learner state is private and backed up as such; a course is shared content. Mixing them is what ADR 6 forbids in the other direction |
| A writable `/library` | Reuses a mount | `/library` is the learner's own folder of courses, bound read-only; School writing there would write into the learner's working trees |

_Table 5.1. Where installed courses could live. A separate store keeps courses, state and configured mounts apart._

Under compose, the store is a named volume, `course-store`, mounted at `/store`, and the server's environment sets `SCHOOL_COURSE_STORE=/store`. Start refuses (exit 2, naming both paths, as `server/config.ts` does for state) a store inside a configured course, inside `SCHOOL_STATE`, holding `SCHOOL_STATE` or a PGlite record, or the same as a configured course.

**Folders are named by install id, not by course name.** The record maps a name to its current install id (§7), so `--rename-course` changes only rows, and an update writes a new folder while the old one keeps serving until the record switches. School marks each installed file read-only. At start it deletes `staging/` and every folder in `courses/` that is not some name's current install, which is the only deletion School does, and only inside the store.

**The store is content, not state.** If the volume is lost, nothing about the learner is lost: the record still names each install's source and commit. A git install can be fetched again from its recorded URL and commit, and School verifies the result against the recorded content digest; a bundle install asks for the bundle again and checks its recorded SHA-256. School never stores uploaded bundles.

In short: a store of immutable folders that School may write, named by install id, rebuildable from the record.

### 5.2 How a course's name is chosen and kept stable

A course's name is its progress key: every encounter, view and decision note files under it (`COURSE_TABLES` in `server/db/rename-course.ts`). **Proposed: the learner chooses it once, at install, and the record keeps it.**

1. The preview suggests a name. From a URL, the last path segment without `.git`; from a bundle, the course's title. Either is lowercased, every run of other characters becomes one hyphen, and leading or trailing hyphens are dropped. `https://github.com/flyingrobots/school-bells.git` suggests `school-bells`.
2. The learner may change it. It must pass `badCourseName`, must not be a configured course, and must not be another current install.
3. If the record already has progress under that name (a course removed earlier, or one that was configured before), the preview says so and asks whether this course should continue it. That is how a configured course moves into the store without losing progress: take it out of `SCHOOL_COURSES`, restart, then install it under the same name.
4. The install row binds the name to the source and commit. An update is asked for by name (§5.3); its new row carries the same name, whatever the new commit's `course.json` says.
5. Renaming stays an operator's act: `--rename-course` with School stopped, as today, extended to move install, removal and trust rows too.

| Option | For | Against |
| --- | --- | --- |
| **Chosen by the learner, kept by the record** (recommended) | The key never moves unless the learner renames it; two courses that would pick the same slug cannot collide | The learner sees one more field |
| Declared by the author, an `id` in `course.json` | No question to ask | An author who changes it moves the learner's progress without asking; two authors can declare the same id; flyingrobots/school#209 adds no such key |
| Derived from the URL each time | Nothing stored | A repository renamed or moved to a fork changes the key, and progress is orphaned |

_Table 5.2. How a course's name could be chosen. The learner owns the key because the progress it files is theirs._

Configured and installed courses share one namespace on purpose: the record does not care where a course's files came from. Start refuses (exit 2) a name that is both configured and a current install, naming both, so one name never means two folders.

In short: suggested, confirmed once, kept by the record, and changed only by the rename job.

### 5.3 What an update does to existing progress

**Proposed: an update never touches the record.** It installs another commit under the same name, as a new install row and a new folder, and the record goes on meaning what it meant. This works because of how the record is keyed, which is built:

| What the author changed | What the learner's record does | Built, at `5baffd2` |
| --- | --- | --- |
| Nothing in a lesson | The next visit resumes its open encounter | `open_lesson_encounter` resumes by the hash of the lesson as written (`0006_due_review.sql`) |
| A lesson's text, same ids | The next visit opens a new encounter with a new snapshot; earlier answers stay tied to the snapshot they were given against | `snapshots` holds each page by hash; `encounters.snapshot_hash` (`0001_init.sql`) |
| A quiz kept under its id | Its correct answers still count: progress is counted by lesson id and block id | `lesson_progress` groups by `encounters.lesson` and `answers.block_id` (`0001_init.sql`) |
| A quiz or lesson removed, or its id changed | Its answers stay in the record and readable through their snapshots, but stop counting toward the course's progress, and the quiz stops coming back for review | `reviewJson` and `activityJson` pass only the current quiz ids to the record (`server/server.ts`) |

_Table 5.3. What each kind of course change does to the learner's record. Nothing is lost; credit follows ids._

So the only visible cost of an update is credit for ids that disappear, and the learner should see it before agreeing. **Proposed:** the update preview compares the installed commit's lessons and quizzes with the new one's, by id, and shows lessons and quizzes added, changed and removed, and how many recorded answers belong to quizzes that would stop counting. With no removals it says so plainly. The course-format reference gains one sentence for authors: keep lesson and quiz ids stable across versions, because ids are what a learner's progress is filed under.

**An update is chosen, never automatic.** Settings can ask the source whether a newer commit exists (`git ls-remote` on the recorded URL's default branch) and offer it; the learner previews and confirms. Moving back to an older commit is the same operation with an older commit.

**Trust resets on update.** Trust is recorded per install (§7), so a new commit is untrusted until the learner says otherwise; the update preview of a trusted course asks whether to keep trusting it at the new commit, defaulting to no. A newer commit is new code from someone else.

In short: an update is a new install under the same name, the record is never rewritten, and the preview counts what would stop counting.

### 5.4 What a bundle is

**Proposed: a bundle is a git bundle** with exactly one head and no prerequisites, made by `git bundle create course.bundle HEAD` in the course repository. School verifies it (`git bundle verify`), fetches its head into the same kind of scratch bare repository as a URL install, and from there the pipeline is identical. The commit hash inside is the course's real commit, so a bundle of `school-aion` at `abc1234` installs byte-identical content to a URL install of `abc1234`, and the record can say so.

| Option | For | Against |
| --- | --- | --- |
| **Git bundle** (recommended) | One pipeline, one set of refusals, one parser (git's own); carries the commit, so provenance matches a URL install; every course is already a git repository ([ADR 6](../adr/0006-separate-framework-lessons-and-learner-state.md)) | An author runs one git command they may not know; a bundle carries history unless made shallow, so it is larger than the files |
| Zip | Familiar; any tool makes one | A second hostile-input parser: path traversal (`../`), absolute paths, symlink entries, duplicate names, and compression bombs; no commit, so no provenance beyond a digest |
| Tar (`.tar.gz`) | Familiar to developers | The same as zip, plus hard links and device entries |
| A signed archive | Proves who made it | Needs keys and a trust list School does not have; RFC 4 Q7 made signatures optional at first |

_Table 5.4. What a bundle could be. A git bundle reuses the URL pipeline and keeps the commit as provenance._

**Signing is optional.** A signed commit or tag in a bundle or repository is verifiable later with `git verify-commit` against keys the learner provides; this RFC records nothing about signatures and leaves that to the step RFC 4 Q7 named: required before strangers' courses are listed. The record keeps the bundle's SHA-256 and the commit, which is enough to say later exactly what was installed.

In short: a bundle is a git bundle, so a file and a URL are one path, and the commit is the version either way.

## 6. Hostile input

A fetched repository and an uploaded bundle are both hostile until checked: they can try to escape the folder, exhaust the disk or memory, run code, or reach somewhere they should not. This section lists each attack and where the pipeline stops it; every row becomes a test in tasks 5, 6 and 13.

**How git runs.** School runs the system `git` as a child process with a clean environment: `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `HOME` set to the staging folder, `GIT_TERMINAL_PROMPT=0`, no credential helper, and on the command line `-c protocol.allow=never -c protocol.https.allow=always -c core.hooksPath=/dev/null -c transfer.fsckObjects=true -c submodule.recurse=false`. It fetches with `git fetch --depth=1 --no-tags --no-recurse-submodules <url> <commit>` into `git init --bare`. A branch or tag the learner gives is resolved once with `git ls-remote` to a full hash, which the preview shows and the record keeps. A host that refuses to serve a commit by its hash is answered with that reason; GitHub serves one. The bundle task confirms which `protocol.*.allow` setting reading a local bundle needs, and allows nothing else.

| Attack | Stopped by |
| --- | --- |
| Path traversal (`..`, absolute paths, `.git` entries) | School refuses any tree entry whose name is `.`, `..`, starts with `.git` in any case, or holds `/`, `\`, a NUL or a control character, before writing anything; `transfer.fsckObjects` also rejects malformed trees at fetch |
| Names that collide on a case-insensitive or normalising filesystem (macOS) | Refused: two entries equal after case folding and Unicode NFC |
| Symlinks (mode `120000`) | Refused anywhere under the paths School installs |
| Submodules (mode `160000`) | Refused; never fetched |
| Git LFS pointers | Refused, by the pointer's first line (`version https://git-lfs.github.com/spec/v1`): School does not fetch LFS objects, and says so |
| Hooks, filters, attributes | Never consulted: the repository is bare and nothing is checked out; `core.hooksPath=/dev/null` |
| Archive and compression bombs | Sizes come from `git ls-tree -l` before any blob is read; limits on the fetched pack, the upload, the file count, each file and the total (Table 6.2) |
| A slow or endless remote | A time limit on every git process; on expiry it is killed and its staging folder deleted |
| Other protocols (`ssh`, `git`, `file`, `ext::`) | `https://` only, checked before git runs and again by `protocol.allow` |
| Credentials in the URL | Refused (`https://user:token@...`): School stores no secret for a course; a private course is a bundle |
| Reaching School's own host or a cloud metadata address | Hosts resolving to loopback or link-local addresses are refused; the fetch pins git to the address School checked (`http.curloptResolve`), which task 6 verifies against the image's git |
| Code in the course | Nothing from the course is executed: no build, no script, no hook. Its HTML is served untrusted (flyingrobots/school#210) |
| Invalid content | The same checks as `school check` (task 1), plus flyingrobots/school#209's manifest checks, including a format this School does not play |

_Table 6.1. Attacks on the installer and what stops each. Most are refused before any file is written; the rest are bounded by limits._

| Limit | Proposed starting value |
| --- | --- |
| Uploaded bundle | 64 MiB, enforced by the server before reading the body |
| Fetched pack | 64 MiB, enforced by watching the bare repository's size and killing git |
| Files installed | 2,000 |
| One file | 8 MiB |
| All files installed | 64 MiB |
| Path | 255 bytes, 8 directories deep |
| Each git process | 60 seconds |

_Table 6.2. Proposed limits. They are starting values, an estimate several times larger than `school-aion`; Open question Q5 asks the maintainer to confirm them._

In short: git fetches into a bare repository under a clean configuration, School reads the tree before it writes, and everything has a limit.

## 7. The record

Each install, removal and trust choice is a row in Postgres, appended through a function and never changed, so the record can say which commit of which course a learner had at any moment. This section names the tables and functions; task 2 builds them as migration `0010_course_installs.sql`.

| Table | Columns | Rules |
| --- | --- | --- |
| `school.course_installs` | `id` (uuid), `seq`, `course`, `source` (`git` or `bundle`), `url`, `bundle_sha256`, `commit`, `content_sha256`, `title`, `format`, `at` | `course` matches the name rule; `url` is `https://` and set exactly when `source` is `git`; `bundle_sha256` is 64 hex and set exactly when `source` is `bundle`; `commit` is 40 or 64 hex |
| `school.course_removals` | `id`, `seq`, `course`, `at` | Refused when the course has no current install |
| `school.course_trust_choices` | `id`, `seq`, `install_id`, `trusted`, `at` | `install_id` references `course_installs` |

_Table 7.1. The proposed tables. Each is append-only with the same triggers as every record table (`refuse_change`)._

| Function | Does |
| --- | --- |
| `school.install_course(id, course, source, url, bundle_sha256, commit, content_sha256, title, format, at)` | Appends an install; it is the course's current one. Answers `installed`, `updated` (the name had a current install) or `duplicate` (this id already holds this row) |
| `school.remove_installed_course(course, at)` | Appends a removal; the course is no longer current. Its progress is untouched |
| `school.choose_course_trust(install_id, trusted, at)` | Appends a trust choice for one install |
| `school.installed_courses()` | Each name's current install: its latest install with no later removal, with its source, commit, digest and latest trust choice (none means untrusted) |

_Table 7.2. The proposed functions, granted to `school_app` and listed in `GRANTED_FUNCTIONS` (`server/adapters/database.ts`)._

`content_sha256` is the SHA-256 of the installed files' manifest: one line per file, `<sha256 of the file> <path>`, sorted by path. At start School recomputes it for every current install; a missing folder or a different digest is listed by `/api/courses` with `lessons: null` and the reason in `lessonsError`, the shape a course with unreadable lessons already has, and is not served. Settings then offers to install it again from its recorded source.

The trust a course has is read from one place per kind of course: a configured course's from its configuration (flyingrobots/school#210), an installed course's from `installed_courses()`. `/api/courses` reports `trusted` for both.

In short: three append-only tables, four functions, and a digest that lets the record vouch for the files.

## 8. Who can ask for an install

An install endpoint is a write that makes School fetch a URL, so it must be reachable only by the learner at their own School, never by a public page (C5). This section shows that the existing guards already give that for a URL install, and what the bundle upload adds.

**Built:** every request must carry one of School's names as its `Host` (`server/hosts.ts`), which stops a DNS-rebinding page; every `POST /api/*` must be `application/json`, which forces a CORS preflight the server never answers; and a request the browser marks `Sec-Fetch-Site: cross-site` is refused (`guardApi`, `server/server.ts`).

**Proposed:**

- `POST /api/installs/preview` and `POST /api/installs` are JSON, under `/api/`, and inherit the guard unchanged. Both additionally refuse any `Sec-Fetch-Site` other than `same-origin` when the header is present, so a sibling page on the tailnet cannot install either.
- `POST /api/installs/bundle` carries the bundle as its body with `Content-Type: application/x-git-bundle`. That type is not one of the three a browser may send cross-origin without a preflight (`text/plain`, `multipart/form-data`, `application/x-www-form-urlencoded`), so the guard's reasoning holds; `guardApi` gains this one route and type explicitly, and a test proves `multipart/form-data` and `text/plain` uploads are refused. The body is never base64 in JSON, which would cost a third more memory for nothing.
- The Library catalog shows a URL and commit to paste and never links into a School, as RFC 4 decided.

In short: the same guards as every write, a little stricter, and a non-safelisted type for the upload.

## 9. The Settings page

Installing lives on the Settings page as one new card, built from shadcn registry components with theme-book colours in light and dark, and worded as invitations. This section describes the card; task 9 builds it, and the visuals are a gap until it exists.

**Proposed:** a **Courses** card lists every course School serves: its title and name, where it came from (configured, a repository at a short commit, or a bundle), and a `Badge` for an untrusted one. **Add a course** opens a `Dialog` with `Tabs` for **Repository** and **Bundle**: `Field` and `Input` for the URL and commit, or a file input for the bundle. While School fetches and checks, a `Spinner`; then the preview, a `Card` with the title, summary, author, license and format, and a `Table` of lessons with their quiz counts, and an `Input` for the name. A refusal is an `Alert` with the check's own message. Installed courses gain **Check for a newer commit**, a trust `Switch` (task 10) and **Remove** (task 12). Components: `Card`, `Dialog`, `Tabs`, `Field`, `Input`, `Button`, `Badge`, `Alert`, `Table`, `Switch`, `Spinner`, `Skeleton`, all from the registry, as the rest of the page is.

| Moment | Copy (illustrative) |
| --- | --- |
| The card, empty | "No installed courses yet. Would you like to add one from a repository or a bundle?" |
| Commit field | "Which commit would you like? A full hash, or a branch or tag that School pins for you." |
| Preview | "Found Bells: 4 lessons, 9 quizzes, Apache-2.0. Install it as `bells`?" |
| Progress already under the name | "Your record already has progress under `bells`. Should this course continue it?" |
| Refused | "School can't play this course yet: lessons/0002-rounds.json > q1: exactly one choice must be correct. Would you like to try another commit?" |
| Update | "Commit def4567 is newer. Would you like to see what changes?" |
| Update preview | "2 lessons change and 1 quiz is no longer in the course; your 3 answers to it stay in your record. Update to def4567?" |
| Untrusted note | "This course's pages can't run scripts. Trust it?" |
| Store not configured | "Installing courses needs a course store. It is set with `SCHOOL_COURSE_STORE`, described in Configuration." |

_Table 9.1. Illustrative copy for each moment. Every message is neutral or encouraging and asks rather than tells._

Every reply is parsed with Zod before the page reads it, as the rest of Settings does (`web/src/lib/settings-api.ts`), and nothing about an install is kept in browser storage: a reload asks the server.

In short: one card, stock components, questions instead of commands, and the server as the only memory.

## 10. Order of work

Each row is one task issue with one observable outcome. None is filed by this RFC. Tasks 1 to 9 are the first build slice: install from a git URL at a pinned commit, validated before anything is installed, recorded in the database, from Settings. Each task's definition of done includes updating the living docs it changes: [a course's folder](../topics/course-format/README.md), [the settings page](../topics/settings-page/README.md), the architecture's trust and configuration sections, and [the migrate job](../topics/migrate-job/README.md) for task 2.

| # | Task | Depends on | Done when |
| --- | --- | --- | --- |
| 1 | **Share `school check`'s checks as a function.** `checkCourse(folder)` in `server/check-course.ts` returns what the `done` line reports or the first refusal; the CLI prints from it. | none | `school check`'s existing tests pass unchanged, and a unit test calls `checkCourse` on a good and a bad course |
| 2 | **Record installs in the database.** Migration `0010_course_installs.sql`: the three append-only tables and four functions of §7, granted and listed in `GRANTED_FUNCTIONS`; `--rename-course` moves their rows. | none | The contract suite covers each function on PGlite and Bun.SQL, an UPDATE or DELETE on each table is refused, and a rename moves install rows |
| 3 | **Configure a course store.** `SCHOOL_COURSE_STORE` with its containment checks; a `course-store` volume at `/store` in compose; `git` in the server image. | none | Start refuses each bad placement with exit 2 naming both paths, and `server/docker.test.ts` finds `git` in the image |
| 4 | **Serve configured and installed courses together.** The course list becomes a registry read at start from config and `installed_courses()`, refreshed after a change without a restart; a name both configured and installed is refused at start; a missing or altered install is listed with `lessons: null` and not served. | 2, 3 | A test that adds a folder and its row sees the course in `/api/courses` with no restart, and an altered folder is reported, not served |
| 5 | **Extract a commit's tree safely.** Walk a commit in a bare repository and write only `course.json`, `lessons/*.json` and `reference/**` regular files into a new folder, refusing every entry Table 6.1 lists and enforcing Table 6.2. | none | A corpus of hostile repositories, one per refusal, is each refused with its reason and leaves nothing outside its staging folder |
| 6 | **Fetch one commit from an https URL.** Hardened git as §6 describes, a branch or tag resolved to its full hash, the time and size limits. | 3 | Each refused URL form has a test, a fetch over a limit is stopped and its staging folder deleted, and a good fetch yields the commit asked for |
| 7 | **Preview an install from a repository.** `POST /api/installs/preview` `{url, commit}` fetches (6), extracts (5) and checks (1) in staging, and answers what was found, the suggested name and any progress already under it. | 1, 5, 6, flyingrobots/school#209 | A good course answers its title, lessons, quizzes, license and format; a bad one answers the check's message; `courses/` and the record are unchanged either way |
| 8 | **Install a previewed course.** `POST /api/installs` `{preview, name}` checks the name, moves the folder to `courses/<install id>`, records it, and serves it untrusted. | 2, 4, 7, flyingrobots/school#210 | The course is served at `/courses/<name>` with `trusted: false`, its row names the URL and commit, and a crash between the move and the record serves nothing (the folder is swept at the next start) |
| 9 | **Add a course from Settings.** The **Courses** card and the add dialog's **Repository** tab, with the preview. | 8 | A browser test adds a course from Settings, in light and dark, and finds it in the sidebar |
| 10 | **Trust an installed course.** A switch on the card appends a trust choice; `trusted` and the served headers follow it. | 2, 9, flyingrobots/school#210 | A test marks an installed course trusted and back, and its reference responses lose and regain the sandbox header |
| 11 | **Update an installed course.** Check for a newer commit, preview lessons and quizzes added, changed and removed by id with the count of answers that would stop counting, then install under the same name. | 8, 9 | An update keeps the name and every record row, the preview's counts match a fixture with one removed quiz, and trust resets unless the learner keeps it |
| 12 | **Remove an installed course.** Stop serving it and record the removal; its progress stays and returns if it is installed again under its name. | 8, 9 | After removal the course is gone from `/api/courses` with its answers still in the record, and reinstalling shows them |
| 13 | **Install from an uploaded git bundle.** `POST /api/installs/bundle` with `application/x-git-bundle`, the size limit, `git bundle verify`, one head and no prerequisites, then the same extraction, check and preview as task 7. | 5, 7, 8 | A bundle previews exactly as its repository at the same commit; a multipart or `text/plain` upload, a bundle with prerequisites and an oversized one are refused |
| 14 | **Upload a bundle from Settings.** The add dialog's **Bundle** tab. | 9, 13 | A browser test installs a bundle from Settings, and its row records the bundle's SHA-256 and commit |

_Table 10.1. The build, as task issues. Tasks 1, 2, 3 and 5 can start at once; flyingrobots/school#209 gates the preview and flyingrobots/school#210 gates serving an install._

In short: nine tasks reach a URL install from Settings, and five more add trust, updates, removal and bundles.

## 11. Out of scope

These are left out deliberately; each could be a later issue.

| Left out | Why |
| --- | --- |
| Private repositories over https with credentials | School would hold a secret per course; a bundle serves private courses without one |
| Automatic updates | An update can change what counts; the learner chooses each one (§5.3) |
| Browsing the Library inside School | RFC 4 Q8 decided not at first |
| Verifying signed commits or tags | RFC 4 Q7: optional until strangers' courses are listed |
| A compile step or compiled course file | ADR 6 leaves it open; installing reads the folder School reads today |
| Keeping old versions for instant rollback | Going back is installing the older commit again |
| An install from the command line | The pipeline's modules (tasks 1, 5, 6) would serve one, but the issue's goal is no shell |

_Table 11.1. What this RFC leaves out, and why. None of it is needed for the first slice._

In short: no secrets, no surprises, and nothing RFC 4 already deferred.

## 12. Risks and open questions

The main risks are a gap in the hostile-input checks and a new kind of code in the server, a child process that talks to the internet. This section pairs each risk with its mitigation, then lists what the maintainer decides.

| Risk | Mitigation |
| --- | --- |
| A refusal is missed and a hostile file is installed | Only three paths are ever written, each entry is checked before any write, and installed courses are untrusted (flyingrobots/school#210); task 5's corpus is a test per refusal |
| A git vulnerability in parsing a hostile pack | The image pins its git package and runs it as the unprivileged `school` user with no credentials; `transfer.fsckObjects` is on |
| The store fills the disk | Per-install limits; non-current folders are swept at start |
| A learner continues old progress under a reused name by mistake | The preview asks first (§5.2); the rename job can move it afterwards |
| Running git from the server is new surface for a feature used rarely | It is the cost of installing without a shell; the bundle path shares it, so there is one surface, not two |

_Table 12.1. Risks and their mitigations. The hostile-input checks carry most of the weight, backed by untrusted serving._

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Where do installed courses live? | A course store, `SCHOOL_COURSE_STORE` (§5.1) |
| Q2 | How is the name chosen and kept? | By the learner at install, kept by the record (§5.2) |
| Q3 | What does an update do to progress? | Nothing; the preview counts what stops counting (§5.3) |
| Q4 | What is a bundle? | A git bundle, one head, no prerequisites; signing optional (§5.4) |
| Q5 | Are the limits in Table 6.2 right? | Yes, as starting values, revisited if a real course exceeds them |
| Q6 | Does trust survive an update? | No; the learner is asked to keep it (§5.3) |
| Q7 | System `git` in the image, or a JavaScript git library? | System `git`: maintained, with `fsck` and bundle support; a library would be a new dependency parsing hostile packs |
| Q8 | Should private repositories with credentials come later? | Only if bundles prove awkward in real use |

_Table 12.2. Open questions for the maintainer, each with a recommendation. Q1 to Q4 are flyingrobots/school#188's own._

In short: the maintainer decides the four questions and four smaller ones; each has a recommendation that holds until someone objects.

## 13. Decision

Decided on 2026-11-26 by an agent under the maintainer's delegated authority for that run. The decision record, with each option's pros, cons and why it was rejected, was delivered to Reader's inbox (receipt `425a7630-8ffa-4315-adcc-a41f6b6fbcf7`). The maintainer may overturn any part.

Every recommendation is accepted as written. The limits in Table 6.2 are accepted as starting values, to be revisited with measurements (Q5). Address pinning is verified in task 6, and the bundle protocol setting in task 13.

| Task | Issue |
| --- | --- |
| 1 | flyingrobots/school#231 |
| 2 | flyingrobots/school#232 |
| 3 | flyingrobots/school#233 |
| 4 | flyingrobots/school#234 |
| 5 | flyingrobots/school#235 |
| 6 | flyingrobots/school#236 |
| 7 | flyingrobots/school#237 |
| 8 | flyingrobots/school#238 |
| 9 | flyingrobots/school#239 |
| 10 | flyingrobots/school#240 |
| 11 | flyingrobots/school#241 |
| 12 | flyingrobots/school#242 |
| 13 | flyingrobots/school#243 |
| 14 | flyingrobots/school#244 |

In short: RFC 7 is decided as written, and its fourteen tasks are filed; tasks 1 to 9 are the first slice.
