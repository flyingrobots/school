// The one hardened git runner (flyingrobots/school#314). Stub for the red commit.
export type GitSpec = { bin: string; home: string; cwd: string; ceiling: string; ms: number; config?: readonly string[]; repository?: string };
export type GitOptions = { input?: Uint8Array; maxStdout?: number; maxStderr?: number; onChunk?: (chunk: Uint8Array) => void; watch?: () => void };
export type GitResult = { code: number; stdout: Uint8Array; stderr: string };
export class GitRunError extends Error {
  constructor(readonly kind: "start-failed" | "timeout" | "output-too-large", message: string) {
    super(message);
  }
}
export function gitEnvironment(_spec: Pick<GitSpec, "home" | "ceiling">): Record<string, string> {
  throw new Error("not implemented");
}
export function gitArguments(_spec: Pick<GitSpec, "config" | "repository">, _args: string[]): string[] {
  throw new Error("not implemented");
}
export async function runGit(_spec: GitSpec, _args: string[], _options?: GitOptions): Promise<GitResult> {
  throw new Error("not implemented");
}
