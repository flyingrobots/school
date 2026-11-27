// Fetching one commit of a course repository over https (RFC 7 §6, task 6; flyingrobots/school#236).
// Not implemented yet: the tests in fetch-commit.test.ts come first.

export type FetchLimits = { packBytes: number; gitMs: number };
const MiB = 1024 * 1024;
export const DEFAULT_FETCH_LIMITS: Readonly<FetchLimits> = Object.freeze({ packBytes: 64 * MiB, gitMs: 60_000 });

export type FetchRefusalReason =
  | "bad-url" | "not-https" | "credentials" | "bad-port" | "unresolved" | "private-address"
  | "bad-commit" | "no-such-ref" | "ambiguous-ref" | "not-a-commit" | "bad-staging" | "too-large" | "timeout" | "git-failed";
export type FetchRefusal = { reason: FetchRefusalReason; message: string };
export type Fetched = { ok: true; repository: string; commit: string } | { ok: false; refusal: FetchRefusal };

export type Network = {
  resolve: (host: string) => Promise<string[]>;
  publicAddress: (address: string) => boolean;
  ports: readonly number[];
  caFile: string | null;
};

export type FetchRequest = {
  url: string;
  commit: string;
  staging: string;
  limits?: Partial<FetchLimits>;
  git?: string;
  network?: Partial<Network>;
};

export function isPublicAddress(_address: string): boolean {
  throw new Error("not implemented");
}

export async function fetchCommit(_request: FetchRequest): Promise<Fetched> {
  throw new Error("not implemented");
}
