// Compose secrets (flyingrobots/school#123): every secret is declared once under top-level
// `secrets:`, sourced from the launcher's environment (host/school.ts), and mounted as a file only
// into the services that need it. No service's `environment:` carries a secret, so none shows in
// `docker inspect`. docs/topics/secrets/test-plan.md lists these cases by ID.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Mount = string | { source: string; target?: string; uid?: string; gid?: string; mode?: number };
type Service = { user?: string; environment?: Record<string, string>; secrets?: Mount[] };
const compose = Bun.YAML.parse(readFileSync(join(import.meta.dir, "compose.yaml"), "utf8")) as {
  services: Record<string, Service>;
  secrets?: Record<string, { environment?: string; file?: string }>;
};

/** Each secret, the host variable the launcher puts it in, and who may read it. */
const EXPECTED = {
  postgres_password: { variable: "SCHOOL_POSTGRES_PASSWORD", services: ["backup", "migrate", "postgres"] },
  app_password: { variable: "SCHOOL_APP_PASSWORD", services: ["migrate", "school"] },
  bridge_token: { variable: "SCHOOL_BRIDGE_TOKEN", services: ["school"] },
} as const;

const mounted = (s: Service) => (s.secrets ?? []).map((m) => (typeof m === "string" ? m : m.source)).sort();

test("SEC-C1: the three secrets are declared under top-level `secrets:`, each from the launcher's environment, never from a file", () => {
  expect(Object.keys(compose.secrets ?? {}).sort()).toEqual(Object.keys(EXPECTED).sort());
  for (const [name, { variable }] of Object.entries(EXPECTED)) expect(compose.secrets![name]).toEqual({ environment: variable });
});

test("SEC-C2: each secret is mounted only into the services that need it", () => {
  for (const [name, { services }] of Object.entries(EXPECTED)) {
    const holders = Object.entries(compose.services).filter(([, s]) => mounted(s).includes(name)).map(([n]) => n).sort();
    expect({ name, holders }).toEqual({ name, holders: [...services] });
  }
});

test("SEC-C3: no service's environment carries a secret, by value, by interpolation, or under a plain secret name", () => {
  const variables = Object.values(EXPECTED).map((e) => e.variable);
  const plain = ["POSTGRES_PASSWORD", "PGPASSWORD", "SCHOOL_APP_PASSWORD", "SCHOOL_BRIDGE_TOKEN", "SCHOOL_DATABASE_PASSWORD", "SCHOOL_MIGRATE_PASSWORD"];
  for (const [service, s] of Object.entries(compose.services)) {
    for (const [k, v] of Object.entries(s.environment ?? {})) {
      for (const variable of variables) expect({ service, k, v: String(v).includes(variable) }).toEqual({ service, k, v: false });
      expect({ service, k, plain: plain.includes(k) }).toEqual({ service, k, plain: false });
      // A URL in the environment has no password in it.
      if (/^postgres(ql)?:\/\//.test(String(v))) expect(new URL(String(v)).password).toBe("");
    }
  }
});

test("SEC-C4: every *_FILE variable names a secret mounted into that same service, at /run/secrets/<name>", () => {
  const files: Record<string, Record<string, string>> = {
    postgres: { POSTGRES_PASSWORD_FILE: "postgres_password" },
    migrate: { SCHOOL_MIGRATE_PASSWORD_FILE: "postgres_password", SCHOOL_APP_PASSWORD_FILE: "app_password" },
    backup: { PGPASSWORD_FILE: "postgres_password" },
    school: { SCHOOL_DATABASE_PASSWORD_FILE: "app_password", SCHOOL_BRIDGE_TOKEN_FILE: "bridge_token" },
  };
  for (const [service, s] of Object.entries(compose.services)) {
    const declared = Object.fromEntries(Object.entries(s.environment ?? {}).filter(([k]) => k.endsWith("_FILE")));
    const want = Object.fromEntries(Object.entries(files[service] ?? {}).map(([k, name]) => [k, `/run/secrets/${name}`]));
    expect({ service, declared }).toEqual({ service, declared: want });
    for (const name of Object.values(files[service] ?? {})) expect(mounted(s)).toContain(name);
  }
});

test("SEC-C5: the URLs name their user and host only; the password comes from the file", () => {
  expect(compose.services.migrate!.environment!.SCHOOL_MIGRATE_URL).toBe("postgres://postgres@postgres:5432/school");
  expect(compose.services.school!.environment!.SCHOOL_DATABASE_URL).toBe("postgres://school_app@postgres:5432/school");
});

test("SEC-C6: every mounted secret file is readable by its service's user only (mode 0400)", () => {
  // The server's image runs as `school` (uid 1000, server/Dockerfile); the postgres image's entrypoint
  // and the backup script read theirs as root before anything else runs.
  const owner: Record<string, string> = { migrate: "1000", school: "1000", postgres: "0", backup: "0" };
  for (const [service, s] of Object.entries(compose.services)) {
    for (const m of s.secrets ?? []) {
      expect(typeof m).toBe("object");
      const long = m as Exclude<Mount, string>;
      expect({ service, source: long.source, uid: long.uid ?? "0", gid: long.gid ?? "0", mode: long.mode })
        .toEqual({ service, source: long.source, uid: owner[service]!, gid: owner[service]!, mode: 0o400 });
    }
  }
});

test("SEC-C7: compose.example.env assigns no secret, so a copy of it puts none in server/.env", () => {
  const example = readFileSync(join(import.meta.dir, "compose.example.env"), "utf8");
  for (const { variable } of Object.values(EXPECTED)) expect(example).not.toMatch(new RegExp(`^\\s*(export\\s+)?#?\\s*${variable}\\s*=`, "m"));
});
