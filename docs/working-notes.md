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
  PGlite (`server/db/*.test.ts`). The server runs it at every startup, before serving.
  - **Applied** means applied to any database that holds or will hold learner data. Never edit an
    applied migration; the runner refuses a changed or missing file, so add a new one. Until the
    first such database applies a file, it may still be corrected in place, and the pull request
    says so.
  - The runner creates the roles `school_owner` and `school_app` and schema `school` if absent,
    then runs every file as `school_owner`, which may create objects only in `school`. A file
    may not contain `BEGIN`, `COMMIT`, `ROLLBACK`, `SET ROLE` or similar; the runner owns the
    transaction and the role. Apply migrations only through the runner, never with `psql -f`.
  - The runner connects as the database's superuser: it creates roles and switches to them. So
    the server's `SCHOOL_DATABASE_URL` names the superuser (compose: `postgres`).
  - Both roles are created `NOLOGIN`, and School's server needs neither to log in: it logs in as
    the superuser and takes `school_app`'s role for requests (`SET ROLE` on PGlite's one session,
    `SET LOCAL ROLE` per transaction on the `Bun.SQL` pool; `server/adapters/database.ts`). Any
    other client that should log in as `school_app` needs `ALTER ROLE school_app LOGIN PASSWORD ...`
    from the deployment, not a migration, so no secret lives in the repository. The roles are
    cluster-wide: do not pre-create them with other memberships.
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
  `POST /api/exposure`, every exposure it shows; the pages do not yet (flyingrobots/school#51).
- `LearningRecord.recordsExposures` says whether an adapter stores exposures. The contract's aid
  cases run only for one that does; one that does not must refuse every exposure as `unsupported`
  and report every aid as unknown. SQLite does not, and is not getting them (flyingrobots/school#49).
  The server runs on Postgres, which does, so `POST /api/exposure` records them.
- `SCHOOL_DATABASE_URL` picks the record: `postgres://...` is `Bun.SQL`, `pglite:<dir>` is PGlite on
  disk, and unset the server refuses to start (exit 2): there is no default. `pglite:` is for
  development and tests, and the server warns at startup that it is not crash-durable; every test
  that starts School sets its own `pglite:` folder. Startup refuses a SQLite `DB_PATH`
  (`<SCHOOL_STATE>/progress.db`) holding any answer, explanation or view, before opening Postgres
  (`server/legacy.ts`, RFC 3 §3.3).
- PGlite is one process's database and takes no lock of its own, so `openPglite` takes `flock` on
  `<dir>.lock` beside the folder for as long as it is open (`server/adapters/lock.ts`); a second
  server on the same folder exits 2 naming it, and the kernel drops the lock when the holder dies.
  The HTTP tests read the record by stopping the server, reading as the superuser
  (`server/testing/record.ts`, which takes the same lock), then starting it again. PGlite also does not `fsync` (its Node
  filesystem has no fsync), so it survives the server being killed but not necessarily a power cut.
- The real-Postgres tests (`server/adapters/bunsql.test.ts`, and the `Bun.SQL` registration of the
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
  `bun run server/testing/postgres-gate.ts junit.xml`. Every `DROP DATABASE` waits for a checkpoint,
  about three seconds under Docker on macOS on a loaded machine, so each test's database is
  dropped in the background while the next test runs, and the file's teardown waits for them.
- Typecheck the server with `bunx tsc -p server` after `bun install` in `server/`.
  A server file that is not TypeScript still needs adding explicitly.
- `server/compose.yaml` names no course. Its paths come from a gitignored `server/.env`; copy
  `server/compose.example.env` to start one. It runs Postgres (`postgres:18.7`, pinned by digest)
  with its data in the named volume `postgres`; `docker compose down -v` deletes the record.
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
- The bridge (`bridge/`) is a separate host process, deliberately outside the Docker image
  and its allowlist. It has no dependencies beyond Bun and is started by hand:
  `SCHOOL_BRIDGE_TOKEN=... bun bridge/bridge.ts`. Its tests write fake agent scripts and
  never contact a model.
