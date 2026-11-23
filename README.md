# School

A framework for learning something properly, with an AI teacher that adapts to evidence of what you have actually learned.

The organizing idea is one sentence: **the next lesson responds to evidence from the previous one.** Not "did you open the page" — whether you answered correctly, whether you still could a week later without help, and whether you could explain it to someone else. School records that evidence so the teacher has something real to plan from.

It aims at long-term retention rather than the feeling of having covered something. Answering correctly today is weak evidence; still knowing it next month is the goal, and getting there means practice that is harder in useful ways — retrieval, spacing, interleaving.

## Status

**Early, and not usable yet.** Be warned:

- The design is in [RFC 1](docs/rfc/0001-school.md). It is a **draft and has not been accepted**, and two of its open questions are unanswered.
- The server serves a configured course: its index, lessons, reference documents and any source material it cites. Verified against two unrelated courses with no code changes between them.
- **Progress is kept in Postgres and is append-only.** Every answer names what was shown and where. The database refuses to update or delete one, and a reload or a server restart resumes where the learner left off ([ADR 9](docs/adr/0009-the-learning-record-is-enforced-by-the-database.md)).
- **Lesson *conversion* is unfinished.** Lessons must be block JSON; the AIΩN course's lessons are still the static HTML that predates the format, so that course serves an empty lesson list until increment 3 converts them.
- The AIΩN Foundations Series has moved to its own repository as the first course, alongside a private learner-state directory. This repository is now framework only.

Nothing here is stable. There are no releases.

## Running it

[Bun](https://bun.com) runs the TypeScript directly, with no build step (ADR 2). Install the server's packages once with `bun install` in `server/`.

On a Postgres server, run the migrate job first, with the owner's (superuser's) URL and the
password `school_app` is to log in with; then start the server with `school_app`'s URL, never the
superuser's (illustrative values):

```sh
SCHOOL_MIGRATE_URL=postgres://postgres:superuser-password@127.0.0.1:5432/school \
SCHOOL_APP_PASSWORD=aLongRandomSecretOfLettersAndDigits \
  bun server/migrate.ts

SCHOOL_COURSE=/path/to/a-course \
SCHOOL_STATE=/path/to/your-state \
SCHOOL_DATABASE_URL=postgres://school_app:aLongRandomSecretOfLettersAndDigits@127.0.0.1:5432/school \
SCHOOL_MOUNTS="papers=/path/to/source-material" \
  bun server/server.ts
```

| Variable | Meaning |
| --- | --- |
| `SCHOOL_COURSE` | The course to serve. Omit it and the index says so rather than crashing. |
| `SCHOOL_STATE` | Your private state: `settings.json`. Must not be inside the course; the server refuses to start if it is. If an old SQLite `progress.db` here still holds answers, explanations or views, the server refuses to start rather than leave them behind; nothing migrates from SQLite. |
| `SCHOOL_DATABASE_URL` | Where your answers and progress go: `school_app`'s URL on a Postgres server, or `pglite:<dir>` for development. Required; see below. The server refuses the superuser, the owner, and a `school_app` login with any of the extra privileges the login check lists (docs/topics/architecture/README.md, "The login check"). Never grant `school_app` anything by hand. |
| `SCHOOL_MIGRATE_URL`, `SCHOOL_APP_PASSWORD` | For `bun server/migrate.ts` only: the owner's (superuser's) URL, and the password it gives `school_app`. The server never needs either. |
| `SCHOOL_MOUNTS` | `name=path` pairs, served read-only at `/name/...`, for source material a course cites. |
| `HOST`, `PORT` | Default `127.0.0.1:4747`. |
| `SCHOOL_ALLOWED_HOSTS` | Comma-separated host names School answers to, besides `127.0.0.1`, `localhost`, `::1` and `HOST`: set it to your tailnet name, such as `school.example.ts.net`. Names only, no port or wildcard. Any other `Host` header gets a 403, which is what stops a DNS-rebinding page from reaching School. |
| `SCHOOL_BRIDGE_URL`, `SCHOOL_BRIDGE_TOKEN` | Where the bridge listens, and the secret it shares with the server. Unset, explanations are saved but not graded. The token is never stored or logged. |

### Grading explanations: the bridge

Written explanations are graded by LLM agents that the **bridge** runs on the host, outside Docker. Each agent is a command template, tried in order until one returns a usable answer. `{prompt}` becomes the prompt as a single argument; a template without it gets the prompt on stdin. `{output_file}` is a file the agent may write its answer to. Templates are split like a shell would split them, but never run through a shell.

The easiest way to set it up is School's **Settings** page: the cog at the top right of every page, or **Esc** when you aren't typing. There you can:

- **generate a token**, which comes with the exact command to start the bridge;
- **connect** the bridge's address and token;
- **check** that it answers and that each agent's program is found;
- **order the agents**: reorder the agents declared in the bridge's file, turn them on or off, and **Test** one for real.

The agents themselves, and their commands, are written only in the bridge's configuration file on the bridge's computer. No request to School or to the bridge can add an agent or set or change a command; the page can only reorder, switch and test what the file declares. The bridge starts without the file and reports itself unconfigured until you write one. Start from the example:

```sh
mkdir -p ~/.config/school
cp bridge/bridge.example.json ~/.config/school/bridge.json   # then edit the agents
bun bridge/bridge.ts
```

The bridge takes `SCHOOL_BRIDGE_TOKEN` from its environment, or else from the Keychain item `./school up` stores, the same token the server gets (run `bun install` in `host/` first).

The file is re-read on every request, so an edit takes effect without a restart.

The connection is saved in `settings.json` in your state directory, mode 0600. `SCHOOL_BRIDGE_URL` and `SCHOOL_BRIDGE_TOKEN` in the server's environment override it, and the page says when they do. Under `./school up` the server always has the Keychain's token, which the bridge reads too, so set `SCHOOL_BRIDGE_URL` in `server/.env` (for example `http://host.docker.internal:4748`); the page then shows both as set by the environment, and its generate and connect fields are locked. The page never shows a saved token. A token is only ever sent to the address it was saved with: changing the address clears a saved token, so connect the new address with its token (or generate one) again; with `SCHOOL_BRIDGE_TOKEN` in the environment the address can only be changed there, with `SCHOOL_BRIDGE_URL`. School follows no redirect from the bridge. **Anyone who can open School can reorder, switch off and test your agents and point School at another bridge, given that bridge's token**, so School must stay on a network only you can reach, such as your tailnet, with its name in `SCHOOL_ALLOWED_HOSTS`. They cannot change what an agent runs.

What an agent may do is set by its own command: the example turns off Claude Code's tools and MCP servers, and runs Codex in a read-only sandbox. Whether your plan for each CLI permits this use is yours to check. Each run gets an empty working directory and is killed, with everything it started, at its timeout. The bridge logs JSON Lines, never the prompt or the answer.

| Variable | Meaning |
| --- | --- |
| `SCHOOL_BRIDGE_TOKEN` | At least 16 characters, the same value the server has. Unset, the Keychain item `./school up` stores (account `school`, or `SCHOOL_KEYCHAIN_ACCOUNT`). |
| `SCHOOL_BRIDGE_CONFIG` | Default `~/.config/school/bridge.json`. Re-read on every request. |
| `SCHOOL_BRIDGE_HOST`, `SCHOOL_BRIDGE_PORT` | Default `127.0.0.1:4748`. Port `0` lets the OS choose; the `bridge.listening` log line gives the port. |

The record lives in Postgres, and `SCHOOL_DATABASE_URL` says where; the server refuses to start without it. For a learner's record, use a Postgres server, as `server/compose.yaml` does: the migrate job applies the migrations as the owner and sets `school_app`'s password, and the server logs in as `school_app` (`postgres://school_app:password@host:5432/db`). `pglite:<dir>` keeps it in PGlite, a Postgres inside the server's process, for development and tests only: PGlite does not fsync, so a power cut can lose answers, and the server says so when it starts.

`bun test` runs the suite (run `bun install` in `host/` as well as `server/` first). `server/compose.yaml` runs School in Docker behind `tailscale serve` (ADR 4), with a Postgres server beside it. Copy `server/compose.example.env` to `server/.env` and set your course, state and source paths; no secret goes there. Then, from the checkout:

```sh
(cd host && bun install)
./school up
```

`./school up` keeps School's three secrets (the Postgres superuser's password, `school_app`'s and the bridge token) in the macOS Keychain: the first run asks for the superuser's password (press Enter to generate one for a new deployment) and generates the other two, and later runs read them silently. It starts compose with them in compose's environment only, and compose mounts each as a file into only the services that need it, so none is in a file on disk, in argv or in `docker inspect`. `./school down` stops it. [School's secrets](docs/topics/secrets/README.md) has the details. To take a new version into a running deployment, or to move secrets out of an older `server/.env`, follow [docs/workflows/upgrade/README.md](docs/workflows/upgrade/README.md).

## How it is put together

Four parts, kept deliberately separate, because they have different audiences and opposite privacy needs:

| Part | What it is | Visibility |
| --- | --- | --- |
| **The framework** | This repository: the server, the block model, the renderers, the shared components. Subject-agnostic — it renders, records and runs assessments without knowing what any course is about. | public |
| **The School skill** | The agent-side teacher: interviews for a mission, works out what to teach next, authors courses, generates each lesson. | public |
| **A course** | Its own git repository: objectives, a sequence of lessons, quizzes, exams, reference documents, resources, a glossary, components. Shareable — that is the point. | public |
| **Learner state** | One person's mission, notes, learning records, answers, gradings and position. Never written into a course. | **private** |

Two distinctions do most of the work:

- **A lesson is declared; a lesson rendering is generated.** A course declares what lesson 3 teaches. The page you actually read is built for you, from that declaration plus what you have already shown you know.
- **Declared for measurement, generated for practice.** Practice questions inside a lesson may be generated. A quiz or an exam is declared in the course and identical for everyone, or its results mean nothing across two learners.

The [glossary](docs/glossary.md) is the authority on these terms. It exists because we crossed these wires more than once.

## Design documents

- [Glossary](docs/glossary.md) — the vocabulary. Read this first.
- [RFC 1: School](docs/rfc/0001-school.md) — the whole design, including the learning record contract. Draft.
- [ADRs](docs/adr/) — the decisions, in order, with what each one cost.

## Credit

School started from the [`teach` skill](https://github.com/mattpocock/skills/tree/main/skills/productivity/teach) in **[Matt Pocock](https://github.com/mattpocock)**'s [skills repository](https://github.com/mattpocock/skills). Thank you — that skill is where this whole idea came from.

To be clear about the relationship: School is **not** a fork or an extension of it, and no code was taken from it. What carries over is the teaching model — grounding every lesson in a stated mission, drawing knowledge from high-trust sources rather than an agent's memory, building skills through tight feedback loops, aiming at the zone of proximal development, and separating fluency from storage strength. School then adds what that skill has no notion of: courses you can share, quizzes and exams, and a server that records what actually happened. Go read the original; it is good, and it is useful on its own.

That skill is MIT licensed. This project is Apache-2.0.

## License

[Apache-2.0](LICENSE).
