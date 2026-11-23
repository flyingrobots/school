// An exclusive lock on a PGlite folder for the life of the process that opened it.
//
// PGlite is one process's database and takes no lock of its own: two servers on one folder each
// serve from their own copy, and answers one of them acknowledged are lost when both close. So the
// opener takes flock(2) on `<dir>.lock` before PGlite.create. The kernel releases it when the
// descriptor closes or the process dies, even by SIGKILL, so a crash never leaves a stale lock.
// The lock file sits beside the folder, not in it: the folder is PGlite's data directory.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;

const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/** Thrown when another process (or another open in this one) holds the folder. */
export class InUse extends Error {}

/** The lock on `dir`, held until `release`. Throws InUse if it is already held. */
export function lockFolder(dir: string): { release(): void } {
  const path = `${dir}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a");
  if (libc.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    throw new InUse(`the PGlite record ${dir} is in use by another School server (its lock ${path} is held); ` +
      "stop that server first: two servers on one PGlite folder would lose each other's answers");
  }
  let held = true;
  return { release: () => { if (held) { held = false; closeSync(fd); } } };
}
