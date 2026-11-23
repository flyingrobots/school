// Types for the parts of @git-stunts/vault 1.0.1 School uses (the package ships none). In 1.0.x
// every call is synchronous.
declare module "@git-stunts/vault" {
  export type CommandResult = { status: number | null; stdout?: string; stderr?: string };
  export interface CommandRunner {
    run(command: string, args?: string[], options?: Record<string, unknown>): CommandResult;
  }
  export interface KeychainAdapter {
    get(target: string): string | undefined;
    set(target: string, value: string): boolean;
    delete(target: string): boolean;
  }
  export function createBunKeychainAdapter(options: { account?: string; commandRunner?: CommandRunner; platformGetter?: () => string }): KeychainAdapter;
  export default class Vault {
    constructor(options?: { account?: string; adapterFactory?: (o: { account: string }) => KeychainAdapter });
    readonly account: string;
    getSecret(params: { target: string }): string | undefined;
    setSecret(params: { target: string; value: string }): void;
    deleteSecret(params: { target: string }): boolean;
    resolveSecret(params: { envKey: string; vaultTarget: string }): string | null;
  }
}
