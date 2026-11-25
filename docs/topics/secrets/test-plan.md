# Secrets test plan

The contract ledger for [School's secrets](README.md) (flyingrobots/school#123). Every case runs
in `bun test`; none reads or writes a real Keychain item. The cases on the real Postgres skip
without `SCHOOL_TEST_POSTGRES_URL`, and CI's gate fails a run that skips them. Each test's title
states its case and oracle.

## The launcher, `./school`

`host/launcher.test.ts`, with a fake vault and a fake compose; SEC-L22 is `host/prompt.test.ts`, with a fake terminal, and SEC-L27 `host/lock.test.ts`, with a real lock directory.

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-L1 | From a clean Keychain on a terminal it asks for the superuser password, generates the rest, stores all three, and starts compose with them in its environment only | implemented | `host/launcher.test.ts`: `SEC-L1: from a clean Keychain on a terminal it asks for the superuser password, generates the rest, stores all three, and starts compose with them in its environment only` |
| SEC-L2 | A second run reads every secret from the Keychain silently: no prompt, nothing stored | implemented | `host/launcher.test.ts`: `SEC-L2: a second run reads every secret from the Keychain silently: no prompt, nothing stored` |
| SEC-L3 | A superuser password typed at the prompt is stored as typed | implemented | `host/launcher.test.ts`: `SEC-L3: a superuser password typed at the prompt is stored as typed` |
| SEC-L4 | The environment comes first: a secret set there is used and never read from or written to the Keychain | implemented | `host/launcher.test.ts`: `SEC-L4: the environment comes first: a secret set there is used and never read from or written to the Keychain` |
| SEC-L5 | Without a terminal a missing superuser password is an error line, exit 2, and nothing is stored or started | implemented | `host/launcher.test.ts`: `SEC-L5: without a terminal a missing superuser password is an error line, exit 2, and nothing is stored or started` |
| SEC-L6 | A typed password the Keychain cannot take safely (space, quote, backslash) is refused, and nothing is stored | implemented | `host/launcher.test.ts`: `SEC-L6: a typed password the Keychain cannot take safely (space, quote, backslash) is refused, and nothing is stored` |
| SEC-L7 | A secret still in server/.env stops it before anything is read, stored or started, naming the key and never the value | implemented | `host/launcher.test.ts`: `SEC-L7: a secret still in server/.env stops it before anything is read, stored or started, naming the key and never the value` |
| SEC-L8 | Compose's own output is streamed as JSON lines, scrubbed of every secret, and its failure is an error line, exit 1 | implemented | `host/launcher.test.ts`: `SEC-L8: compose's own output is streamed as JSON lines, scrubbed of every secret, and its failure is an error line, exit 1` |
| SEC-L9 | The Keychain account defaults to `school` and SCHOOL_KEYCHAIN_ACCOUNT changes it; an unsafe account name is refused | implemented | `host/launcher.test.ts`: `SEC-L9: the Keychain account defaults to `school` and SCHOOL_KEYCHAIN_ACCOUNT changes it; an unsafe account name is refused` |
| SEC-L10 | --human prints prose instead, still without a secret | implemented | `host/launcher.test.ts`: `SEC-L10: --human prints prose instead, still without a secret` |
| SEC-L11 | Runs `docker compose down` with no secret resolved, read or passed | implemented | `host/launcher.test.ts`: `SEC-L11: runs `docker compose down` with no secret resolved, read or passed` |
| SEC-L12 | Moves each secret from server/.env into the Keychain and removes only those lines | implemented | `host/launcher.test.ts`: `SEC-L12: moves each secret from server/.env into the Keychain and removes only those lines` |
| SEC-L13 | Refuses, changing nothing, when the Keychain already holds a different value | implemented | `host/launcher.test.ts`: `SEC-L13: refuses, changing nothing, when the Keychain already holds a different value` |
| SEC-L14 | With no secret in server/.env it changes nothing and says so | implemented | `host/launcher.test.ts`: `SEC-L14: with no secret in server/.env it changes nothing and says so` |
| SEC-L15 | --help is JSON lines naming every command; an unknown command is an error line, exit 2 | implemented | `host/launcher.test.ts`: `SEC-L15: --help is JSON lines naming every command; an unknown command is an error line, exit 2` |
| SEC-L16 | A Keychain that throws is an error line, exit 1, never a stack trace | implemented | `host/launcher.test.ts`: `SEC-L16: a Keychain that throws is an error line, exit 1, never a stack trace` |
| SEC-L17 | Passes its arguments to `docker compose` as they are, with the secrets resolved as for up and in the environment only, and stdin inherited | implemented | `host/launcher.test.ts`: `SEC-L17: passes its arguments to `docker compose` as they are, with the secrets resolved as for up and in the environment only, and stdin inherited` |
| SEC-L18 | `school compose` with nothing after it is an error line, exit 2 | implemented | `host/launcher.test.ts`: `SEC-L18: `school compose` with nothing after it is an error line, exit 2` |
| SEC-L19 | A secret with a double quote or backslash is scrubbed from compose's output before it is serialised, not after | implemented | `host/launcher.test.ts`: `SEC-L19: a secret with a double quote or backslash is scrubbed from compose's output before it is serialised, not after` |
| SEC-L20 | A `KEY: value` line in server/.env, which compose also reads, is a leak to `school up` and is moved by `school import` | implemented | `host/launcher.test.ts`: `SEC-L20: a `KEY: value` line in server/.env, which compose also reads, is a leak to `school up` and is moved by `school import`` |
| SEC-L21 | `school import` refuses a value compose would interpolate (a `$` unquoted or in double quotes), changing nothing; a single-quoted one is literal | implemented | `host/launcher.test.ts`: `SEC-L21: `school import` refuses a value compose would interpolate (a `$` unquoted or in double quotes), changing nothing; a single-quoted one is literal` |
| SEC-L22 | The prompt reads a line unechoed, restores the terminal, and writes nothing to stderr, not even a newline | implemented | `host/prompt.test.ts`: `SEC-L22: the prompt reads a line unechoed, restores the terminal, and writes nothing to stderr, not even a newline` |
| SEC-L23 | A quoted value whose quote does not close on its line (unclosed, or spanning lines) is refused; the Keychain and server/.env are unchanged | implemented | `host/launcher.test.ts`: `SEC-L23: a quoted value whose quote does not close on its line (unclosed, or spanning lines) is refused; the Keychain and server/.env are unchanged` |
| SEC-L24 | `school up` resolves and stores under the account's lock, released before compose starts and on a refusal too | implemented | `host/launcher.test.ts`: `SEC-L24: `school up` resolves and stores under the account's lock, released before compose starts and on a refusal too` |
| SEC-L25 | Two overlapping first runs leave one superuser password, the one both start compose with | implemented | `host/launcher.test.ts`: `SEC-L25: two overlapping first runs leave one superuser password, the one both start compose with` |
| SEC-L26 | A generated or prompted secret never replaces an item that appeared since it was read; the run uses that item | implemented | `host/launcher.test.ts`: `SEC-L26: a generated or prompted secret never replaces an item that appeared since it was read; the run uses that item` |
| SEC-L27 | The lock is exclusive, waits for its holder, takes over a dead holder's lock, and gives up on a live one naming its pid | implemented | `host/lock.test.ts`: `SEC-L27: the lock is exclusive, waits for its holder, takes over a dead holder's lock, and gives up on a live one naming its pid` |
| SEC-L28 | Every line the launcher prints (prose and `check`'s pass-through aside) names a schema in `host/schemas/` and validates against it, in every launcher test; `--schema` prints them all; one run id per invocation | implemented | `host/launcher.test.ts`: `the command line > SEC-L28: --schema prints every published schema, and every line of one run shares one run id`, and the check in its `run` helper |

## The Keychain adapter and the shared rule

`host/keychain.test.ts`, with a fake `security`.

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-K1 | Storing a secret runs `security -i` with the command on stdin: no argv of any call holds the value | implemented | `host/keychain.test.ts`: `SEC-K1: storing a secret runs `security -i` with the command on stdin: no argv of any call holds the value` |
| SEC-K2 | Reading uses the vault's `find-generic-password ... -w`, with the secret only on the child's stdout | implemented | `host/keychain.test.ts`: `SEC-K2: reading uses the vault's `find-generic-password ... -w`, with the secret only on the child's stdout` |
| SEC-K3 | A value the stdin line could not carry exactly is refused before `security` runs | implemented | `host/keychain.test.ts`: `SEC-K3: a value the stdin line could not carry exactly is refused before `security` runs` |
| SEC-K4 | A store the Keychain did not keep is an error, not a silent success | implemented | `host/keychain.test.ts`: `SEC-K4: a store the Keychain did not keep is an error, not a silent success` |
| SEC-K5 | The runner passes every other command through unchanged | implemented | `host/keychain.test.ts`: `SEC-K5: the runner passes every other command through unchanged` |
| SEC-K6 | Generated secrets are 32 letters and digits, and differ | implemented | `host/keychain.test.ts`: `SEC-K6: generated secrets are 32 letters and digits, and differ` |
| SEC-K7 | ResolveSecret takes the environment first, then the store, and says which; an empty variable counts as unset | implemented | `host/keychain.test.ts`: `SEC-K7: resolveSecret takes the environment first, then the store, and says which; an empty variable counts as unset` |
| SEC-K8 | A read returns nothing only for a missing item (exit 44); any other failure is an error, so no caller takes a locked Keychain for an empty one | implemented | `host/keychain.test.ts`: `SEC-K8: a read returns nothing only for a missing item (exit 44); any other failure is an error, so no caller takes a locked Keychain for an empty one` |
| SEC-K9 | Storing updates the item in place: no delete runs first, so a failed store leaves the old secret where it was | implemented | `host/keychain.test.ts`: `SEC-K9: storing updates the item in place: no delete runs first, so a failed store leaves the old secret where it was` |
| SEC-K10 | A `security` that cannot be run at all is a failed read, not a missing item; an absent `secret-tool` on Linux still reads as missing | implemented | `host/keychain.test.ts`: `SEC-K10: a `security` that cannot be run at all is a failed read, not a missing item; an absent `secret-tool` on Linux still reads as missing` |
| SEC-K11 | Create stores only when no item is there: no `-U`, so an existing item is kept and reported, never replaced | implemented | `host/keychain.test.ts`: `SEC-K11: create stores only when no item is there: no `-U`, so an existing item is kept and reported, never replaced` |

## Compose

`server/compose-secrets.test.ts`, reading `server/compose.yaml`.

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-C1 | The three secrets are declared under top-level `secrets:`, each from the launcher's environment, never from a file | implemented | `server/compose-secrets.test.ts`: `SEC-C1: the three secrets are declared under top-level `secrets:`, each from the launcher's environment, never from a file` |
| SEC-C2 | Each secret is mounted only into the services that need it | implemented | `server/compose-secrets.test.ts`: `SEC-C2: each secret is mounted only into the services that need it` |
| SEC-C3 | No service's environment carries a secret, by value, by interpolation, or under a plain secret name | implemented | `server/compose-secrets.test.ts`: `SEC-C3: no service's environment carries a secret, by value, by interpolation, or under a plain secret name` |
| SEC-C4 | Every *_FILE variable names a secret mounted into that same service, at /run/secrets/<name> | implemented | `server/compose-secrets.test.ts`: `SEC-C4: every *_FILE variable names a secret mounted into that same service, at /run/secrets/<name>` |
| SEC-C5 | The URLs name their user and host only; the password comes from the file | implemented | `server/compose-secrets.test.ts`: `SEC-C5: the URLs name their user and host only; the password comes from the file` |
| SEC-C6 | Every mounted secret file is readable by its service's user only (mode 0400) | implemented | `server/compose-secrets.test.ts`: `SEC-C6: every mounted secret file is readable by its service's user only (mode 0400)` |
| SEC-C7 | Compose.example.env assigns no secret, so a copy of it puts none in server/.env | implemented | `server/compose-secrets.test.ts`: `SEC-C7: compose.example.env assigns no secret, so a copy of it puts none in server/.env` |

## `*_FILE` in School's processes

`server/secrets.test.ts`.

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-F1 | X_FILE is read into X, preferred over a plain X, with one trailing newline dropped | implemented | `server/secrets.test.ts`: `SEC-F1: X_FILE is read into X, preferred over a plain X, with one trailing newline dropped` |
| SEC-F2 | Without X_FILE, a plain X is used as it is, so CI and development keep plain variables | implemented | `server/secrets.test.ts`: `SEC-F2: without X_FILE, a plain X is used as it is, so CI and development keep plain variables` |
| SEC-F3 | A missing, unreadable or empty secret file is refused, naming the variable and the path, never the contents | implemented | `server/secrets.test.ts`: `SEC-F3: a missing, unreadable or empty secret file is refused, naming the variable and the path, never the contents` |
| SEC-F4 | WithPassword puts a password into a postgres URL that has none, and refuses a URL that already has one | implemented | `server/secrets.test.ts`: `SEC-F4: withPassword puts a password into a postgres URL that has none, and refuses a URL that already has one` |
| SEC-F5 | The server's record URL takes school_app's password from SCHOOL_DATABASE_PASSWORD_FILE | implemented | `server/secrets.test.ts`: `SEC-F5: the server's record URL takes school_app's password from SCHOOL_DATABASE_PASSWORD_FILE` |
| SEC-F6 | The server, the migrate job and the bridge settings read every secret through withSecretFiles | implemented | `server/secrets.test.ts`: `SEC-F6: the server, the migrate job and the bridge settings read every secret through withSecretFiles` |

## The migrate job

`server/adapters/app-login.test.ts`, on the real Postgres (`SCHOOL_TEST_POSTGRES_URL`).

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-M1 | The migrate command reads both passwords from *_FILE, preferred over the plain variables, and prints neither | implemented | `server/adapters/app-login.test.ts`: `SEC-M1: the migrate command reads both passwords from *_FILE, preferred over the plain variables, and prints neither` |

## The server

`server/adapters/app-login.test.ts`, on the real Postgres; SEC-S2 and SEC-S3 are `server/settings.test.ts`, the second with a real server and a listener standing in for a saved address.

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-S1 | The server process starts on school_app's URL with its password from SCHOOL_DATABASE_PASSWORD_FILE, and prints no password | implemented | `server/adapters/app-login.test.ts`: `SEC-S1: the server process starts on school_app's URL with its password from SCHOOL_DATABASE_PASSWORD_FILE, and prints no password` |
| SEC-S2 | A token from the environment is paired only with a URL from the environment, never with a saved one | implemented | `server/settings.test.ts`: `SEC-S2: a token from the environment is paired only with a URL from the environment, never with a saved one` |
| SEC-S3 | A mounted token never reaches a URL saved in settings.json; the status names SCHOOL_BRIDGE_URL as the fix | implemented | `server/settings.test.ts`: `SEC-S3: a mounted token never reaches a URL saved in settings.json; the status names SCHOOL_BRIDGE_URL as the fix` |

## The backup script

`server/backup/backup.test.ts`, in the database's image on the real Postgres.

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-B1 | PGPASSWORD_FILE is read and wins over a plain PGPASSWORD; a missing or empty file is refused, exit 2, naming no password | implemented | `server/backup/backup.test.ts`: `Bun.SQL: SEC-B1: PGPASSWORD_FILE is read and wins over a plain PGPASSWORD; a missing or empty file is refused, exit 2, naming no password` |

## The bridge

`bridge/bridge.test.ts`, as the real process, with an empty throwaway Keychain account.

| ID | Case and oracle | Status | Test |
| --- | --- | --- | --- |
| SEC-T1 | With no token in the environment or the Keychain the bridge refuses to start, exit 2, naming both places | implemented | `bridge/bridge.test.ts`: `SEC-T1: with no token in the environment or the Keychain the bridge refuses to start, exit 2, naming both places` |

## Evidence on the Mac

| ID | Case | Status | Evidence |
| --- | --- | --- | --- |
| SEC-R1 | A real `./school up` from a clean Keychain asks for the superuser password, generates the rest, stores them and starts School; a second run reads them silently | verified by hand on 2026-11-23 | flyingrobots/school#132, with a throwaway Keychain account, deleted afterwards |
| SEC-R2 | `docker inspect` of every container, compose's logs, both transcripts and `server/.env` hold no secret value; argv sampled during a run holds none | verified by hand on 2026-11-23 | flyingrobots/school#132 |
| SEC-R3 | The bridge starts with its token from the Keychain | verified by hand on 2026-11-23 | flyingrobots/school#132: the bridge's `bridge.listening` line, with no token in its environment |
| SEC-R4 | The server's Settings status, under `./school up`, reaches that bridge authorised | not verified | Not checked on 2026-11-23: the run could not publish the server on 127.0.0.1:4747, which another School held |
