# Working in this repository

Practical notes for anyone — human or agent — changing the framework.

- The maintainer's shell `ls` is aliased to `eza` and prints **nothing** when run
  non-interactively, which once made an agent read this workspace as empty and rewrite
  another session's work. Use `/bin/ls`, or `git ls-files`.
- Captured `/teach`-style session transcripts (`*command-message*.txt`) are gitignored on
  purpose. Keep them local; never commit them. They were committed once and had to be
  removed from the published history.
- `server/.dockerignore` admits server modules by pattern (`*`, `!*.ts`, `*.test.ts`) and the
  Dockerfile copies `*.ts`, so a new module ships without any list to update. The old per-file
  allowlist broke the image twice; `server/docker.test.ts` keeps the pattern from regressing.
  A server file that is not TypeScript still needs adding explicitly.
- `server/compose.yaml` names no course. Its paths come from a gitignored `server/.env`; copy
  `server/compose.example.env` to start one.
- Every `POST /api/*` needs `Content-Type: application/json` and is refused when the browser
  says it is cross-site. A new endpoint under `/api/` inherits that guard; one outside it does
  not, so keep state-changing routes under `/api/`.
- Tests are `bun test` from the repository root. No `package.json`, no build step (ADR 2).
- The bridge (`bridge/`) is a separate host process, deliberately outside the Docker image
  and its allowlist. It has no dependencies beyond Bun and is started by hand:
  `SCHOOL_BRIDGE_TOKEN=... bun bridge/bridge.ts`. Its tests write fake agent scripts and
  never contact a model.
