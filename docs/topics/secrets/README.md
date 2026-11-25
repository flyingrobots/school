---
title: "School's secrets"
author: "Claude (Opus 5.5), agent-written at the maintainer's request. Not yet reviewed by a human."
created: 2026-11-23
updated: 2026-11-23
status: "Living reference. Describes where School's secrets live and how they reach each process, since flyingrobots/school#123."
---

# School's secrets

This page is a reference for where School keeps its three secrets and how each one reaches the
processes that need it. Its [test plan](test-plan.md) lists the cases that pin it. To move an
existing deployment's secrets out of `server/.env`, follow
[upgrade a compose deployment](../../workflows/upgrade/README.md).

## The three secrets

| Secret | Held by | Missing from the Keychain |
| --- | --- | --- |
| `SCHOOL_POSTGRES_PASSWORD`, the Postgres superuser's password | the `postgres`, `migrate` and `backup` services | `./school up` asks for it at a terminal. Enter nothing to generate one; this is only right for a new deployment, because an existing database was created with a password of its own |
| `SCHOOL_APP_PASSWORD`, `school_app`'s password | the `migrate` and `school` services | generated: the migrate job sets it on every run |
| `SCHOOL_BRIDGE_TOKEN`, the token the server and the bridge share | the `school` service and the bridge on the host | generated: the bridge reads the same Keychain item |

None of them is in a file in the repository or in `server/.env`, in any process's argv, or in
any container's environment as `docker inspect` shows it.

## Where they live: the macOS Keychain

Each secret is a generic password in the login Keychain. The service is the secret's name and
the account is `school`, or `SCHOOL_KEYCHAIN_ACCOUNT` when that is set (letters, digits, dots,
dashes and underscores). `security find-generic-password -a school -s SCHOOL_APP_PASSWORD -w`
prints one, which is how to read a value when you need to.

School reaches the Keychain through [`@git-stunts/vault`](https://www.npmjs.com/package/@git-stunts/vault)
1.0.1 (`host/package.json`), using its service and its macOS adapter. School replaces one part of
the vault, its command runner (`host/keychain.ts`). The vault's adapter stores a secret with
`security add-generic-password ... -w <secret>`, which puts the secret in argv, where any process
of the same user can read it while `security` runs. School's runner sends that one command to
`security -i` on stdin instead, with `-U`, which updates an existing item in place; the vault's
adapter deletes the item first, and the runner skips that delete, so a store that fails leaves the
old secret where it was. It then reads the item back to check it was kept. Reads run as the vault
gives them: the secret comes back on the child's stdout, a pipe. Only `security`'s exit 44 (the
item could not be found) counts as a missing secret; any other failed read, such as a locked
Keychain or a denied prompt, is an error (exit 1), so `./school up` never generates a secret over
one it could not read.

A stored value must be printable ASCII with no space, double quote or backslash, because it is
written as one double-quoted word on that stdin. Generated secrets are 32 letters and digits.

Every host process resolves a secret the same way (`host/secrets.ts`): the environment variable
of the same name if it is set and not empty, otherwise the Keychain. So CI, and anyone who prefers
it, can still set plain variables, and the Keychain is never opened when they do.

## How they reach the containers: `./school up`

A Linux container cannot reach the Mac's Keychain, so a launcher on the host does. Run it from the
checkout:

```sh
./school up          # resolve the secrets, then docker compose up --detach --build
./school down        # docker compose down; needs no secret, keeps the volumes
./school compose ps  # docker compose <arguments>, with the secrets, for the how-tos
./school import      # move secrets still in server/.env into the Keychain
```

`./school` runs `host/school.ts` with Bun; run `bun install` in `host/` once first. `up`:

1. refuses (exit 2) while `server/.env` still assigns any of the three secrets, as `KEY=value` or
   `KEY: value` (compose reads both), naming the keys and never a value, and says to run
   `./school import`;
2. resolves every secret, asking or generating as the table above says; without a terminal, a
   missing superuser password is an error (exit 2), and nothing is stored or started;
3. stores what it asked for or generated, before compose starts, so a new database is created
   with the password the Keychain holds;
4. runs `docker compose up --detach --build` in `server/` with the secrets in that child's
   environment and nowhere else.

`server/compose.yaml` declares each secret under top-level `secrets:`, sourced from that
environment. Compose copies each one into the services that list it, as a file under
`/run/secrets/`, mode 0400, owned by the user that reads it:

| File | Mounted into | Read through |
| --- | --- | --- |
| `/run/secrets/postgres_password` | `postgres` (root) | `POSTGRES_PASSWORD_FILE`, the image's own |
| | `migrate` (uid 1000) | `SCHOOL_MIGRATE_PASSWORD_FILE` |
| | `backup` (root) | `PGPASSWORD_FILE`, read by `backup.sh` |
| `/run/secrets/app_password` | `migrate` (uid 1000) | `SCHOOL_APP_PASSWORD_FILE` |
| | `school` (uid 1000) | `SCHOOL_DATABASE_PASSWORD_FILE` |
| `/run/secrets/bridge_token` | `school` (uid 1000) | `SCHOOL_BRIDGE_TOKEN_FILE` |

The URLs in the environment name a user and a host only (`postgres://school_app@postgres:5432/school`);
the server and the migrate job put the password from the file into the URL. The file is copied into
the container, so a container that Docker restarts, after a reboot for example, still has it
without the launcher. Run without the launcher, `docker compose up` starts nothing and says:

```text
environment variable "SCHOOL_POSTGRES_PASSWORD" required by secret "server_postgres_password" is not set
```

Output is JSON Lines on stdout and stderr, and keeps [the programs' output
contract](../program-output/README.md#the-contract) (flyingrobots/school#200). Every line names its
schema, `_schema: {"id": "school.launcher.<event>", "version": ...}`, published in `host/schemas/`.
Each line also carries `kind` (`school.up`, `school.down`, `school.compose`, `school.import`,
`school.help`, `school.error`), `event`, and `run`, one UUID per invocation.

- **Compose's output** arrives as `compose` events, scrubbed of every secret. Each string is
  scrubbed before it is serialised, so a secret with a quote or backslash is caught too.
- **Errors** are `error` lines on stderr with a `code`.
- **Help and schemas:** `./school --help` lists the commands as `usage`, `command` and
  `exit-codes` lines. `./school --schema` prints every schema.
- **Prose:** `--human`, before the command, prints prose instead.
- **`./school check`** passes through the lines of its own program, which name `school.check.*`
  schemas.

Exit codes: 0 done, 2 a missing or invalid setting with nothing started, 1 any other failure, such
as compose failing.

`./school compose version` from a checkout on 2026-11-25, with throwaway values for all three
secrets in the environment, so the Keychain was not read:

```text
{"_schema":{"id":"school.launcher.keychain","version":"1.0.0"},"kind":"school.compose","event":"keychain","account":"school","run":"424fbd24-4c77-4020-95cc-81fc48577322"}
{"_schema":{"id":"school.launcher.secret","version":"1.0.0"},"kind":"school.compose","event":"secret","name":"SCHOOL_POSTGRES_PASSWORD","from":"environment","run":"424fbd24-4c77-4020-95cc-81fc48577322"}
{"_schema":{"id":"school.launcher.secret","version":"1.0.0"},"kind":"school.compose","event":"secret","name":"SCHOOL_APP_PASSWORD","from":"environment","run":"424fbd24-4c77-4020-95cc-81fc48577322"}
{"_schema":{"id":"school.launcher.secret","version":"1.0.0"},"kind":"school.compose","event":"secret","name":"SCHOOL_BRIDGE_TOKEN","from":"environment","run":"424fbd24-4c77-4020-95cc-81fc48577322"}
{"_schema":{"id":"school.launcher.compose","version":"1.0.0"},"kind":"school.compose","event":"compose","stream":"stdout","line":"Docker Compose version v5.5.0","run":"424fbd24-4c77-4020-95cc-81fc48577322"}
{"_schema":{"id":"school.launcher.done","version":"1.0.0"},"kind":"school.compose","event":"done","ok":true,"run":"424fbd24-4c77-4020-95cc-81fc48577322"}
```

A first `up` from a clean Keychain prints a `prompt` line on stderr for the superuser's password.
It then prints `"from":"generated"` (or `"prompted"`) for each secret it made. A second run asks
nothing and says `"from":"keychain"` for all three.

## Reading `*_FILE` in School's own processes

`server/secrets.ts` (`withSecretFiles`) gives the server and the migrate job one rule: when
`<NAME>_FILE` is set, `<NAME>` is that file's text less one trailing newline, and it wins over a
plain `<NAME>`. A missing, unreadable or empty file is refused (exit 2), naming the variable and
the path, never the contents. It covers `SCHOOL_DATABASE_PASSWORD`, `SCHOOL_MIGRATE_PASSWORD`,
`SCHOOL_APP_PASSWORD` and `SCHOOL_BRIDGE_TOKEN`. A password given both in a URL and beside it is
refused rather than one silently chosen. `backup.sh` follows the same rule for `PGPASSWORD_FILE`.

## The bridge

`bun bridge/bridge.ts` takes `SCHOOL_BRIDGE_TOKEN` from the environment, else from the Keychain
item `./school up` stored, under the same account. Its `bridge.listening` line says which, as
`tokenFrom`. With neither, it refuses to start (exit 2), naming both places. Run `bun install` in
`host/` before starting it.

The server sends its mounted token only to a `SCHOOL_BRIDGE_URL` from its environment, never to an
address saved on the Settings page, which anyone who could reach School might have saved before
the token was mounted. Under `./school up`, set `SCHOOL_BRIDGE_URL` in `server/.env`; without it
the Settings status is `none` and says so, and explanations are saved but not graded.

## What this does not cover

- A token saved through the Settings page still goes into `settings.json` in the state directory
  (mode 0600). Under `./school up` the server always has `SCHOOL_BRIDGE_TOKEN_FILE`, which
  overrides the saved token and locks the page's token and URL fields, as an environment token does.
- Inside a container, the service's own processes can read its secret files, and a process that
  reads one holds the value in its memory and, for `backup.sh` and the `postgres` image's
  entrypoint, its process environment. None of that is visible through `docker inspect`.
- `docker compose`, the launcher's child, holds the secrets in its environment while it runs; a
  process of the same user can read another's environment.
- Linux and Windows hosts: the vault has adapters for both, but School has only been run on macOS.
