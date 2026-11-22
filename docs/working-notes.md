# Working in this repository

Practical notes for anyone — human or agent — changing the framework.

- The maintainer's shell `ls` is aliased to `eza` and prints **nothing** when run
  non-interactively, which once made an agent read this workspace as empty and rewrite
  another session's work. Use `/bin/ls`, or `git ls-files`.
- Captured `/teach`-style session transcripts (`*command-message*.txt`) are gitignored on
  purpose. Keep them local; never commit them. They were committed once and had to be
  removed from the published history.
- `server/.dockerignore` is `*` plus an allowlist. **Adding a new file under `server/` means
  adding it there and to the Dockerfile `COPY`**, or the image silently ships without it and
  the server dies on an import it cannot resolve. This has broken the image twice.
- Tests are `bun test` from the repository root. No `package.json`, no build step (ADR 2).
