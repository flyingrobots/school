# 4. Run in Docker on this Mac, reachable only over Tailscale

Date: 2026-11-18 · Status: Accepted

## Context
This Mac is the learner's home server. They want to take lessons from their phone wherever they are, over their tailnet.

## Decision
- Run the server with `docker compose` (`server/compose.yaml`, `restart: unless-stopped`) from the `oven/bun:1.4.4-alpine` image, as the non-root `bun` user.
- Publish the port on `127.0.0.1:4747` only. `tailscale serve` exposes it to the tailnet over HTTPS.
- No login: the tailnet is the access control.
- Bind-mount `lessons/`, `reference/`, `assets/` and `../aion` read-only, and `progress/` read-write. The image contains only `server.ts`.

## Alternatives
- Run `bun server/server.ts` directly: simpler, but does not survive reboots or crashes without extra setup.
- Listen on all interfaces: would expose an unauthenticated server to any network the Mac joins.

## Consequences
- New lessons appear without a rebuild, because the folders are mounted.
- The database lives on the host, so the agent reads the same file the container writes.
- Docker Desktop must start at login for the server to come back after a reboot.
