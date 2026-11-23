---
title: "RFC 4: Publishing courses"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-22
updated: 2026-11-22
version: 0.1.0
status: "Proposal, awaiting the maintainer's decision. Answers flyingrobots/school#24. Builds on flyingrobots/school at commit df27689."
---

# RFC 4: Publishing courses

> **How to read this.** **Built** means it exists at commit `df27689`. **Proposed** means this RFC
> asks for it. **Open** means it needs the maintainer's decision. Nothing here is decided. How
> School works today is in the [architecture reference](../topics/architecture/README.md); this
> RFC describes only what would change.

## Executive Summary

The maintainer wants a public place where people publish School courses and others find and start
them: a storefront, working names the Library, the University or the Forum
(flyingrobots/school#24).

This RFC recommends **a public index of course repositories, and a static catalog generated from
it.** A course stays in its own git repository, as [ADR 6](../adr/0006-separate-framework-lessons-and-learner-state.md)
already requires. The index is one public repository that lists courses, each pinned to a commit.
A static site built from the index lets anyone browse, search and read about a course, and tells
them how to install it. Installing is a pull into the learner's own School, which stays private
behind Tailscale. Nothing published runs School, holds an account, or receives anything from a
learner.

| Question from #24 | Recommendation |
| --- | --- |
| What is published | A course repository at a pinned commit: what the course declares, never a learner's prepared lessons, answers or record |
| Where it runs | The catalog is static files on a public host. School itself is never on the open internet |
| Identity and trust | The author is the owner of the course repository; provenance is the repository URL and the commit; listing is by reviewed pull request to the index |
| Storefront | Browse, search, a page per course, and an install instruction; no cart and no button that reaches into a learner's School |
| Free or paid | Free only. Paid is out of scope (§6) |
| Name | Open (§8). This RFC suggests **the Library** |

In short: publish by listing a git repository, browse a static page, install by pulling. School's
network posture does not change.

## Contents

1. [The problem and who it serves](#1-the-problem-and-who-it-serves)
2. [Constraints](#2-constraints)
3. [Options](#3-options)
4. [Recommendation](#4-recommendation)
5. [Order of work](#5-order-of-work)
6. [Out of scope](#6-out-of-scope)
7. [Risks](#7-risks)
8. [Open questions](#8-open-questions)

## 1. The problem and who it serves

**Built:** a course is a git repository, served by naming its path in `SCHOOL_COURSE` or
`SCHOOL_COURSES`. There is no way to publish a course, and no way to find someone else's. Sharing
one today means sending a repository link and explaining how to clone it and edit an environment
variable. The first real course, `flyingrobots/school-aion`, is private and has no license.

Three people would use a publishing place:

| Who | What they need |
| --- | --- |
| A **course author** | A way to say "this course exists, here is the version", without running a server |
| A **learner looking for a course** | To browse, search, and judge a course before installing it: what it teaches, who wrote it, its license, which School it needs |
| A **learner installing a course** | To get exactly the version they chose into their own School, and to know it has not been altered |

It does not serve anyone who wants to study without running School. A School course is played by
a School server; publishing a course does not change that.

In short: authors need to announce a course, learners need to find and trust one, and both already
have git.

## 2. Constraints

Each option is weighed against these. They come from existing decisions, not from this RFC.

| # | Constraint | Source |
| --- | --- | --- |
| C1 | School is self-hosted, one learner, on the maintainer's Mac | [ADR 4](../adr/0004-docker-on-this-mac-behind-tailscale.md) |
| C2 | No logins: the tailnet is the access control | ADR 4; the [trust section](../topics/architecture/README.md#trust-and-known-defects) |
| C3 | Learner state never leaves the learner's machine and is never written into a course | [ADR 6](../adr/0006-separate-framework-lessons-and-learner-state.md); [RFC 2 §1](0002-lessons-written-for-each-learner.md#1-where-things-live) |
| C4 | School is reachable only over Tailscale or localhost | ADR 4 |
| C5 | A course is its own git repository, with its own history and license | ADR 6; the [glossary](../glossary.md) |
| C6 | An installed course is trusted code: its HTML renders on School's origin with School's authority | [RFC 1, proposal 2a](0001-school.md); the trust section |
| C7 | Our own work is Apache-2.0; a public repository without a license grants nothing; work built on someone else's keeps their license | The maintainer's licensing rules |

C6 matters most here. Today a course is trusted because the learner chose it, and so far every
course was written by the person running School. A catalog of strangers' courses breaks that
assumption: installing one would let a stranger's HTML run with School's authority, which
includes the settings API and the bridge that runs the learner's agents. RFC 1 already names the
answer for this case: render courses from strangers as sanitised Markdown with raw HTML stripped.

The course format is also not settled. The glossary marks the format version **unsettled**, and
RFC 2 changes what a course contains (a curriculum and exams, not finished lessons). A catalog
that pins courses needs a format version to say which School can play which course.

## 3. Options

### Option A: do nothing

Courses stay git repositories, shared by link.

| For | Against |
| --- | --- |
| No work; no new surface; every constraint holds | Nobody can find a course; there is no provenance beyond "a link someone sent"; installing means editing environment variables |
| Learners already get the exact bytes they clone | The idea in #24 is not served at all |

### Option B: public course repositories plus an index

One public repository holds an index: a small file per course naming its repository URL, a pinned
commit, its license, its author and the course format version it uses. Authors list a course, or
a new version of one, by pull request; the maintainer reviews and merges. School gains a way to
install a course from a repository URL at a pinned commit.

| For | Against |
| --- | --- |
| Uses what already exists: course repositories (C5) and git hosting for identity | Browsing an index of files is not a storefront |
| Nothing new on the internet: the index is a public repository, School stays private (C1, C2, C4) | Someone must review submissions |
| Provenance is a commit hash, which a learner's School can verify on install | Needs a declared course format version first |
| Nothing flows from the learner: installing is a pull (C3) | |

### Option C: a static catalog site generated from the index

Option B, plus a static site built from the index on every merge: a browsable, searchable page per
course, with its summary, objectives, author, license, format version and an install instruction.
It is hosted as static files, for example GitHub Pages from the index repository.

| For | Against |
| --- | --- |
| This is the storefront #24 asks for, without a server | A public website is new: a name, a host, and something to keep working |
| Static files hold no data and run no School code, so there is nothing on it to attack or leak | Search is client-side, which limits it to a catalog of modest size (fine for years) |
| Everything in it is derived from the index, so the index stays the one source of truth | It cannot offer a one-click install into a private School (see below) |
| No logins anywhere: authors are identified by their git host account, readers need none (C2) | |

**Why no install button.** A public page that sends a request to a learner's School would be a
cross-site request to a server with no login. School's `SCHOOL_ALLOWED_HOSTS` check stops a
DNS-rebinding page, but a deliberate install endpoint that a public page can trigger is exactly
the kind of write that should need the learner at their own School. The catalog shows the
repository URL and commit; the learner pastes them into their own School.

### Option D: a hosted storefront with accounts and payments

A server on the public internet with author and learner accounts, uploads, payments and paid
access.

| For | Against |
| --- | --- |
| Authors could be paid | It is the opposite of School: a public server (C4), logins (C2), and a store of who bought what, which is personal data about learners (C3) |
| | A paid course is a git repository the buyer clones; nothing stops it being shared, so payment buys a hosting and enforcement problem with no enforcement |
| | Payments bring tax, refunds, fraud, terms of service and a legal entity; none of it is a learning problem |
| | Licensing paid content conflicts with publishing our own work as Apache-2.0 (C7) |

### Option E: a public School instance that hosts courses

Run School itself on the open internet as the catalog and a place to try courses.

| For | Against |
| --- | --- |
| Try a course without installing | Puts School, which has no login and trusts installed courses, on the internet (C2, C4, C6) |
| | Whoever studies on it leaves a learning record on someone else's server (C3) |

### Comparison

| | A: nothing | B: index | C: index + static catalog | D: hosted store | E: public School |
| --- | --- | --- | --- | --- | --- |
| Self-hosted, one learner (C1) | holds | holds | holds | breaks | breaks |
| No logins (C2) | holds | holds | holds | breaks | holds, unsafely |
| Learner state stays local (C3) | holds | holds | holds | breaks | breaks |
| School on Tailscale only (C4) | holds | holds | holds | breaks | breaks |
| Courses as their own repos (C5) | holds | holds | holds | replaced by uploads | holds |
| Strangers' courses safe (C6) | n/a | needs sanitising | needs sanitising | needs sanitising | breaks |
| Licensing (C7) | holds | holds | holds | conflicts | holds |
| Serves #24 | no | partly | yes | yes | partly |

In short: B and C keep every constraint; D and E break the ones School is built on; A keeps them by
not doing the thing.

## 4. Recommendation

**Option C: an index repository with a static catalog generated from it.** Proposed.

### 4.1 What is published

A listing names a course repository and one commit of it. The catalog reads only what the course
declares about itself: its title, summary, objectives, author, license and format version. Under
RFC 2 a course is a curriculum and declared exams; under what is built today it is lessons and
reference documents. The index does not care which, as long as the course declares a format
version that some School release can play.

Never published, by construction: a learner's prepared lessons, answers, gradings, decision notes,
mission or position. These live in learner state, which is a different directory that the server
refuses to place inside a course (C3). Neither the catalog nor the install step has any way to
read it.

### 4.2 The index

- **One public repository**, our own work, so Apache-2.0 (C7).
- **One file per course**, validated in CI against a JSON Schema kept in the index repository's
  `schemas/`: repository URL, pinned commit, the course's declared license as an SPDX identifier,
  the format version, and the author's git host account.
- **CI checks each entry**: the repository is public, the commit exists, the course's manifest at
  that commit matches the entry, the license is declared, and the format version is one School
  supports.
- **A new version is a new commit in an entry**, by pull request. History of the index is the
  history of what was listed and when.
- **Listing is curated.** The maintainer merges entries. This is the trust gate, and it is a
  social one: CI checks shape, a person decides whether to list.
- **The index never copies a course.** It links and pins. A course's license governs the course;
  the index's license governs the index.

### 4.3 The catalog

- Static files built from the index on every merge and published to a static host.
- Built with School's stack: Vite and React, shadcn components from the registry, the theme-book
  light, dark and system theme, keyboard navigation with visible key hints.
- Browse, client-side search, and a page per course with an install instruction: the repository
  URL and commit to give one's own School.
- No analytics, no cookies, no forms, no comments, no ratings, no install counts.

### 4.4 Installing, in School

- School's Settings page gains **add a course from a repository URL and commit**. School clones it
  read-only into a configured courses directory, checks out the pinned commit, verifies it, and
  serves it. It runs nothing from the course: no build step, no scripts, no hooks.
- A course installed this way is **untrusted** until the learner marks it trusted: it renders as
  sanitised Markdown with raw HTML stripped, as RFC 1 prescribes for courses from strangers. A
  course the learner configures by path, as today, stays trusted.
- Updating a course is installing a newer commit. Learner state recorded against the older one
  stays readable, which the learning record contract already requires.
- School sends nothing anywhere to install: one outbound fetch of a public repository, made when
  the learner asks.

### 4.5 Identity and provenance

The author is whoever controls the course repository; the git host already authenticates them.
Provenance is the repository URL plus a full commit hash, checked by School on install. Signed
commits or tags would add a check that the commit came from the author and not from anyone with
push access; this RFC leaves them optional (§8).

### 4.6 The first listing

`flyingrobots/school-aion` is the first course. Before it is listed it needs a `LICENSE`
(Apache-2.0, as our own work, C7), a declared format version and a manifest, and the maintainer's
decision to make it public. A public repository with no license grants nobody anything, so
publishing it as it is now would list a course nobody may use.

In short: a curated index pins public course repositories, a static site shows it, and School
installs a pinned commit as untrusted until the learner says otherwise.

## 5. Order of work

Each step is small enough to be one issue. None is created by this RFC. Steps 1 and 2 are
prerequisites in School itself and are worth doing whatever is decided about publishing.

| # | Step | Depends on | Done when |
| --- | --- | --- | --- |
| 1 | **Declare a course manifest and format version.** A file at a course's root naming its title, summary, author, license (SPDX) and format version; validated at load. | RFC 2's course layout, or today's | The server refuses a course without a valid manifest, and says why |
| 2 | **Render untrusted courses safely.** A per-course trust flag; untrusted courses render sanitised Markdown with raw HTML stripped. | none | A course marked untrusted cannot execute script on School's origin, shown by a test |
| 3 | **Install a course from a repository URL and commit.** Clone read-only into a configured courses directory, verify the commit, register it untrusted. | 1, 2 | A learner adds a course from Settings without editing the environment |
| 4 | **License and prepare `school-aion`.** `LICENSE`, `NOTICE`, the manifest from step 1. | 1 | The repository is ready to be made public |
| 5 | **Create the index repository.** Apache-2.0, the entry JSON Schema, CI that checks each entry, contributing notes for authors. | 1 | A pull request with a bad entry fails CI; a good one passes |
| 6 | **Generate the static catalog.** Built from the index on merge, published to a static host. | 5 | The catalog lists every entry, searches, and shows each course's install instruction |
| 7 | **List `school-aion`.** | 4, 5, 6, and the maintainer making it public | It appears in the catalog and installs into a fresh School |
| 8 | **Document it.** Living references for installing and for the trust flag, a workflow page for publishing a course, the architecture trust section updated. | each step as it lands | Each page describes only what exists |

In short: two School changes, one course prepared, one index, one generated site, one listing.

## 6. Out of scope

- **Payments, paid courses and accounts.** Option D, for the reasons there.
- **Hosting course content.** The catalog links to course repositories; it never mirrors them.
- **Running School for anyone else.** No public instance, no trial mode.
- **Anything about learners.** No profiles, install counts, progress sharing, leaderboards,
  certificates or claims that someone passed a course.
- **Discussion.** No comments, reviews, ratings or a forum. "The Forum" as a name is a separate
  question from building one.
- **Federation or several indexes.** One index; nothing stops someone forking it.
- **A one-click install from the catalog into a learner's School** (§3, option C).

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| A listed course carries hostile HTML | Installed courses are untrusted by default (step 2); listing is curated |
| A course repository is rewritten or deleted after listing | Entries pin a commit; School verifies it on install; a missing commit fails the index CI and the entry is removed |
| The format changes and old listings stop playing | Every entry names its format version; the catalog shows which School plays it |
| Curation becomes a burden | It is one person reviewing small pull requests; if it grows, that is a good problem and a later RFC |
| A course is listed under a license that does not permit use | CI requires a declared SPDX license; the catalog shows it on the course page |

## 8. Open questions

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Which option? | C, as §4 describes |
| Q2 | What is it called: the Library, the University, the Forum, or another? | **The Library.** It lends freely, which fits free-only; "the University" suggests accreditation School does not offer; "the Forum" suggests discussion, which is out of scope |
| Q3 | Will `school-aion` be made public, and when? | When steps 1 and 4 are done; listing it is the test that the whole path works |
| Q4 | Which license for course content we write? | Apache-2.0, per the licensing rule. Note that Creative Commons licenses are more usual for prose, if the maintainer wants an exception for courses |
| Q5 | Is listing open to anyone's course from the start, or only the maintainer's own at first? | The maintainer's own first, until step 2 has been used for real |
| Q6 | Where is the catalog hosted, and under what domain? | GitHub Pages from the index repository; a domain later, if at all |
| Q7 | Are signed commits or tags required for a listing? | Optional at first; required if strangers' courses are listed |
| Q8 | Should School also browse the index from inside the app? | Not at first. The public catalog and a pasted URL are enough; an in-app page is a later issue |

In short: the maintainer decides the option, the name, when the first course goes public, and how
open listing is. The rest has a recommendation that holds until someone objects.
