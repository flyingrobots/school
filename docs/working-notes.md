# Working in this repository

Practical notes for anyone — human or agent — changing the framework.

- The maintainer's shell `ls` is aliased to `eza` and prints **nothing** when run
  non-interactively, which once made an agent read this workspace as empty and rewrite
  another session's work. Use `/bin/ls`, or `git ls-files`.
- Captured `/teach`-style session transcripts (`*command-message*.txt`) are gitignored on
  purpose. Keep them local; never commit them. They were committed once and had to be
  removed from the published history.
- `server/.dockerignore` admits the manifest, the lockfile, modules at any depth and the SQL
  migrations by pattern (`*`, `!package.json`, `!bun.lock`, `!**/*.ts`, `!db/**/*.sql`,
  `**/*.test.ts`, `contract/**`, `testing/**`, `node_modules/**`); the Dockerfile installs production
  dependencies and copies the filtered context, so a new module or migration ships without any
  list to update. `node_modules/**` keeps the host's dev dependencies' `.d.ts` files from being
  copied over the production install. The old per-file allowlist broke the image twice;
  `server/docker.test.ts` checks that every relative import is shipped, every package import is a
  dependency, and every migration is shipped.
- The Postgres record (RFC 3) is built by numbered migrations in `server/db/migrations/`
  (`NNNN_name.sql`, from 0001, no gaps), applied by `server/db/migrate.ts`, one transaction per
  file. `0001_init.sql` documents each public function's signature above it. Its tests run on
  PGlite (`server/db/*.test.ts`). On Postgres only the migrate job runs it (`server/migrate.ts`,
  the one-shot `migrate` service in `server/compose.yaml`); on PGlite the server runs it at
  startup, before serving.
  - **Applied** means applied to any database that holds or will hold learner data. Never edit an
    applied migration; the runner refuses a changed or missing file, so add a new one. Until the
    first such database applies a file, it may still be corrected in place, and the pull request
    says so.
  - The runner creates the roles `school_owner` and `school_app` and schema `school` if absent,
    then runs every file as `school_owner`, which may create objects only in `school`. A file
    may not contain `BEGIN`, `COMMIT`, `ROLLBACK`, `SET ROLE` or similar; the runner owns the
    transaction and the role. Apply migrations only through the runner, never with `psql -f`.
  - The runner connects as the database's superuser: it creates roles and switches to them. Only
    the migrate job holds that URL, `SCHOOL_MIGRATE_URL` (compose: `postgres`, in the `migrate`
    service alone). After the migrations it runs `ALTER ROLE school_app LOGIN ... PASSWORD` with a
    SCRAM-SHA-256 verifier of `SCHOOL_APP_PASSWORD` computed in the job, so the password itself never
    reaches Postgres or a log, and revokes `CREATE` and `TEMPORARY` on the database from `PUBLIC`.
    No secret lives in the repository or in a migration (flyingrobots/school#91).
  - Both roles are created `NOLOGIN`; the migrate job gives `school_app` `LOGIN` and clears its role
    settings. On Postgres the server's `SCHOOL_DATABASE_URL` is `school_app`'s own login, and before
    serving it runs the login check (`loginRefusals` in `server/adapters/database.ts`) and refuses to
    start (exit 2, `Refused`) on any failure. The exact checks, what they cannot detect and what
    `school_app` can still do are in docs/topics/architecture/README.md, "The login check". It still
    runs each statement with `SET LOCAL ROLE school_app` and only function calls, as defence in
    depth. PGlite (development and tests) keeps its single-process path: its one session is the
    superuser, migrates, then `SET ROLE school_app`; it has no login to check. The roles are
    cluster-wide: do not pre-create them with other memberships, and never grant `school_app`
    anything by hand.
  - A migration that grants `school_app` a new function also adds it to `GRANTED_FUNCTIONS` in
    `server/adapters/database.ts`; otherwise the server refuses to start, and
    `server/adapters/app-login.test.ts` fails.
  - The Bun.SQL tests do the same: `fresh()` in `server/testing/postgres.ts` runs the migrate job
    with the scratch server's superuser URL and opens the record with `school_app`'s URL. The test
    password is derived from `SCHOOL_TEST_POSTGRES_URL`, so none is kept in the repository.
- The server is a hexagon (RFC 3, §4): `server/core/` holds the model (Zod), the ports and the use
  cases, and imports nothing but itself and Zod (`server/core/boundary.test.ts`). Adapters live in
  `server/adapters/`; every `LearningRecord` adapter must pass `server/contract/learning-record.ts`.
- The Postgres adapter (`server/adapters/postgres.ts`) issues only `SELECT * FROM school.<function>($1, ...)`
  as `school_app`; its test refuses any other statement, and so does the server's record at run
  time (`functionCalls` in `server/adapters/database.ts`), so a new adapter query of another shape
  fails loudly. It talks to a driver through the `Sql` port (`server/adapters/sql.ts`): PGlite
  (`server/adapters/pglite.ts`; PGlite is a production dependency) or `Bun.SQL`
  (`server/adapters/bunsql.ts`). Pass jsonb arguments as values, not `JSON.stringify` text:
  `Bun.SQL` sends a string to a jsonb parameter as a JSON string. It opens an encounter with the
  `aid_tracking` its caller passes: the lesson API's `?aid=` capture version, or NULL (aid not
  observed) when the client sends none. A client may send `?aid=1` only if it records, through
  `POST /api/exposure`, every exposure it shows; the lesson page does (flyingrobots/school#51).
- Due review (`server/db/migrations/0006_due_review.sql`, `docs/topics/due-review/`) puts items in
  a section with id `school:review` at the top of a lesson, so authored block ids may not start
  `school:` (`server/blocks.ts`). The web view opens lessons through `open_lesson_encounter`, which
  finds the encounter to resume by the lesson as written, not by the snapshot's hash; the old
  `open_encounter` stays for the contract. A reason names a day in the server's time zone:
  `bun test` runs in UTC, but a School it starts inherits the host's `TZ` unless the test sets
  one, as `server/review.test.ts` does.
- Every `LearningRecord` adapter stores exposures and must pass the contract's aid cases; there is
  no "unsupported" answer since SQLite was deleted (flyingrobots/school#49).
- `SCHOOL_DATABASE_URL` picks the record: `postgres://...` is `Bun.SQL`, `pglite:<dir>` is PGlite on
  disk, and unset the server refuses to start (exit 2): there is no default. `pglite:` is for
  development and tests, and the server warns at startup that it is not crash-durable; every test
  that starts School sets its own `pglite:` folder. Startup refuses a SQLite `DB_PATH`
  (`<SCHOOL_STATE>/progress.db`) holding any answer, explanation or view, before opening Postgres
  (`server/legacy.ts`, RFC 3 §3.3).
- SQLite is deleted (flyingrobots/school#49). `server/legacy.ts`, that startup refusal, is the only
  module allowed to import `bun:sqlite`, read-only, and `server/startup.test.ts` the only test, to
  write its fixture; `server/docker.test.ts` fails on any other. Do not add SQLite back for
  convenience in a test: test the record through the contract suite on PGlite.
- PGlite is one process's database and takes no lock of its own, so `openPglite` takes `flock` on
  `<dir>.lock` beside the folder for as long as it is open (`server/adapters/lock.ts`); a second
  server on the same folder exits 2 naming it, and the kernel drops the lock when the holder dies.
  The HTTP tests read the record by stopping the server, reading as the superuser
  (`server/testing/record.ts`, which takes the same lock), then starting it again. PGlite also does not `fsync` (its Node
  filesystem has no fsync), so it survives the server being killed but not necessarily a power cut.
- The real-Postgres tests (`server/adapters/bunsql.test.ts`, the concurrency races in
  `server/adapters/bunsql.concurrency.test.ts`, and the `Bun.SQL` registration of the
  learner-history story in `server/contract/learner-history.test.ts`) need `SCHOOL_TEST_POSTGRES_URL`,
  a superuser URL to a scratch Postgres; without it they are skipped. Each test gets a database of its
  own, copied from a migrated template and dropped when its file ends (`server/testing/postgres.ts`:
  call `scratchPostgres()` once per file). CI starts the server, writes a JUnit report, and runs
  `server/testing/postgres-gate.ts` on it, which fails the build if any `Bun.SQL` test skipped or
  any `postgres (PGlite): <title>` case has no passing `postgres (Bun.SQL): <title>`: register a
  new story or contract on both drivers. Locally:
  `docker run -d --rm --name school-pg -e POSTGRES_PASSWORD=pw -p 127.0.0.1:5432:5432 postgres:18.7`, then
  `SCHOOL_TEST_POSTGRES_URL=postgres://postgres:pw@127.0.0.1:5432/postgres bun test`. To check
  the gate as CI does, add `CI=true`, `--reporter=junit --reporter-outfile=junit.xml`, then
  `bun run server/testing/postgres-gate.ts junit.xml` (its lines: [the programs' output](topics/program-output/README.md#the-postgres-gate)). Every `DROP DATABASE` waits for a checkpoint,
  about three seconds under Docker on macOS on a loaded machine, so each test's database is
  dropped in the background while the next test runs, and the file's teardown waits for them.
  A new race goes through `race()` in the concurrency file: it holds every caller at a table lock
  and opens it only once `pg_stat_activity` shows them all waiting, so the test proves overlap
  rather than hoping for it. Never synchronise a race with a sleep.
- Typecheck the server with `bunx tsc -p server` after `bun install` in `server/`.
  A server file that is not TypeScript still needs adding explicitly.
- Typecheck the bridge with `bunx tsc -p bridge` after `bun install` in `host/`: the bridge has
  no packages of its own and takes Bun's types from `host/node_modules`.
- `server/schema/school.graphql` describes the port shapes in `server/core/model.ts` for Wesley
  (RFC 3 §5). `server/schema/check.ts` asserts, at compile time under `bunx tsc -p server`, that
  each type Wesley generates equals the `z.infer` of its hand-written schema, so the two cannot
  drift. The Zod stays the source of runtime validation. Change both together, then regenerate
  with Wesley `0.3.0-alpha.4` (`bfff0f9a557d1061140ea9a40fdba13a01c7ccfe`) from a Wesley checkout:
  `cargo run --locked --bin wesley -- emit typescript --schema <school>/server/schema/school.graphql
  --out <school>/server/schema/school.generated.ts --metadata-out <school>/server/schema/school.metadata.json`.
  Never edit the generated file by hand. CI needs no Rust: it checks the committed output.
- `server/compose.yaml` names no course. Its paths come from a gitignored `server/.env`; copy
  `server/compose.example.env` to start one. It runs Postgres (`postgres:18.7`, pinned by digest)
  with its data in the named volume `postgres`; `docker compose down -v` deletes the record.
  The named volume `course-store` is mounted at `/store` for `SCHOOL_COURSE_STORE` (RFC 7 §5.1), set from the compose-only `SCHOOL_COMPOSE_COURSE_STORE` so a host export never reaches the container. Compose also mounts this checkout's `.agents/skills/school` at `/framework/skills/school` and `docs/topics/course-format` and `voice` under `/framework/docs`, read-only, for `SCHOOL_SKILL` (compose-only `SCHOOL_COMPOSE_SKILL`) and `SCHOOL_SKILL_DOCS`: the skill an authoring agent is given, hashed at start (RFC 9 §5.3). Renaming or moving any of those folders needs compose's mounts moved with it. The
  image installs `git` and `ca-certificates` from Ubuntu's archive for fetching courses, and makes
  `/store` owned by `school`, since Docker copies that owner into a new, empty named volume;
  `server/docker.test.ts` checks both in the Dockerfile.
- The `backup` service in `server/compose.yaml` runs `server/backup/backup.sh` on the database's image
  (same digest: bump both together, and the CI service's too). Its tests
  (`server/backup/backup.test.ts`) run the script, `pg_restore` and `server/backup/verify.sql` in that
  image with `docker run`, so they need Docker as well as `SCHOOL_TEST_POSTGRES_URL`; every case names
  Bun.SQL, so the Postgres gate fails CI if they skip. A failed `docker run` that mounts a missing
  path leaves a directory in its place: the test refuses to start without the script. The how-to
  is `docs/workflows/backup-and-restore/README.md`.
- Every `POST /api/*` needs `Content-Type: application/json` and is refused when the browser
  says it is cross-site. A new endpoint under `/api/` inherits that guard; one outside it does
  not, so keep state-changing routes under `/api/`.
- Every request is checked against the Host allowlist (`server/hosts.ts`) before routing, so a
  new route of any method inherits it. School behind a new name (another tailnet name, a LAN
  name) needs that name in `SCHOOL_ALLOWED_HOSTS`, or every request through it gets a 403.
- An agent's command is written only in the bridge's file on its host. `POST /api/settings/agents`
  (and the bridge's `PUT /config` behind it) takes `{ "agents": [{ "name", "enabled" }] }` naming
  every declared agent once, and nothing else; `server/agents.ts` rebuilds the body from those
  fields so no other field can reach the bridge. Do not add a way to write a command over HTTP.
- The bridge token is only ever sent to the address it was saved with. `POST /api/settings/bridge`
  with a new `url` drops a saved token unless the same request gives one, and is refused (409)
  when the token comes from `SCHOOL_BRIDGE_TOKEN`. Every request carrying the token uses
  `redirect: "error"`, because fetch keeps the Authorization header across a redirect. A new
  call to the bridge must do the same.
- Tests are `bun test` from the repository root. No `package.json`, no build step (ADR 2).
  The web app's browser tests (`web/test/shell.test.ts`) also need `npm ci` in `web/` and Google
  Chrome, which they drive through playwright-core; without either they fail rather than skip.
- A test that starts School or the bridge goes through `server/testing/processes.ts` and never picks a
  port: it reads `url` and `port` from what the helper returns. The bridge is started on port 0 and
  announces its port in `bridge.listening`; School refuses `PORT=0`, so the helper probes a free port
  and retries a start that exits with EADDRINUSE (flyingrobots/school#82). Start the bridge first
  when School needs its URL.
- A browser test closes its context with `close` from `web/test/routes.ts`, never `context.close()`.
  Its pages' `/api` requests are answered by route handlers that fetch from School, and a context
  closed while one is still running (the lesson a link has just opened, the sidebar's course list)
  disposes the fetch under it: the handler throws "Request context disposed" or "Fetch response has
  been disposed" into the run, on a loaded machine only (flyingrobots/school#121). `close` waits for
  the context's and its pages' handlers to finish first; `web/test/routes.test.ts` holds one across
  the close.
- A browser test file that starts the Vite dev server calls `warm` from `web/test/vite.ts` in its
  `beforeAll`, after launching Chrome. Vite transforms the app's modules on their first request, so
  without it the first page a file opens takes about twice as long as the rest and, on a loaded
  machine, runs past the test's 5 s page timeout (flyingrobots/school#121).
- The bridge (`bridge/`) is a separate host process, deliberately outside the Docker image
  and its allowlist. It has no dependencies beyond Bun and is started by hand:
  `SCHOOL_BRIDGE_TOKEN=... bun bridge/bridge.ts`. Its tests write fake agent scripts and
  never contact a model.
- The `school` skill lives in `.agents/skills/school/`. `.claude/skills/school` is a symlink to it,
  written by `sync-agents --project` and recorded in `.agents/sync.lock.json`, so an agent in any
  clone finds the skill. After adding or renaming a skill under `.agents/skills/`, run
  `sync-agents --project` and commit the link and the lockfile; `sync-agents --project --check`
  exits 0 when they match (flyingrobots/school#203).
- A course's `license` in `course.json` is checked against the SPDX License List copied into
  `server/spdx-license-ids.ts` from `spdx-license-ids` 3.0.24 and the exceptions list copied into
  `server/spdx-exception-ids.ts` from `spdx-exceptions` 2.5.0 (CC0-1.0 and CC-BY-3.0, the latter
  attributed in `NOTICE`), not dependencies
  (ADR 2). A license or exception SPDX adds later is refused until its file is updated: copy
  `index.json` and `deprecated.json` from a newer `spdx-license-ids` into the two lists of the
  first, and `index.json` from a newer `spdx-exceptions` into the second (flyingrobots/school#209).
