# Working in this repository

Practical notes for anyone — human or agent — changing the framework.

- The maintainer's shell `ls` is aliased to `eza` and prints **nothing** when run
  non-interactively, which once made an agent read this workspace as empty and rewrite
  another session's work. Use `/bin/ls`, or `git ls-files`.
- Captured `/teach`-style session transcripts (`*command-message*.txt`) are gitignored on
  purpose. Keep them local; never commit them. They were committed once and had to be
  removed from the published history.
- `server/.dockerignore` admits the manifest, the lockfile and modules at any depth by pattern
  (`*`, `!package.json`, `!bun.lock`, `!**/*.ts`, `**/*.test.ts`, `contract/**`); the Dockerfile
  installs production dependencies and copies the filtered context, so a new module ships without
  any list to update. The old per-file allowlist broke the image twice; `server/docker.test.ts`
  checks that every relative import is shipped and every package import is a dependency.
- The server is a hexagon (RFC 3, §4): `server/core/` holds the model (Zod), the ports and the use
  cases, and imports nothing but itself and Zod (`server/core/boundary.test.ts`). Adapters live in
  `server/adapters/`; every `LearningRecord` adapter must pass `server/contract/learning-record.ts`.
- Typecheck the server with `bunx tsc -p server` after `bun install` in `server/`.
  A server file that is not TypeScript still needs adding explicitly.
- `server/compose.yaml` names no course. Its paths come from a gitignored `server/.env`; copy
  `server/compose.example.env` to start one.
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
- Tests are `bun test` from the repository root. No `package.json`, no build step (ADR 2).
  The web app's browser tests (`web/test/shell.test.ts`) also need `npm ci` in `web/` and Google
  Chrome, which they drive through playwright-core; without either they fail rather than skip.
- The bridge (`bridge/`) is a separate host process, deliberately outside the Docker image
  and its allowlist. It has no dependencies beyond Bun and is started by hand:
  `SCHOOL_BRIDGE_TOKEN=... bun bridge/bridge.ts`. Its tests write fake agent scripts and
  never contact a model.
