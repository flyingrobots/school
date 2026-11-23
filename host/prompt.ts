// The terminal prompt `school up` asks at (flyingrobots/school#123): one line, not echoed. It
// writes nothing itself: the launcher has already written the prompt as a whole JSON line (or a
// prose line with --human), and any byte of its own here, even a newline, would be a line on
// stderr that is not JSON. host/school.ts passes the real terminal; host/prompt.test.ts a fake.
import { SecretError } from "./secrets.ts";

/** process.stdin, as far as the prompt uses it. */
export type Terminal = {
  stdin: {
    setRawMode(on: boolean): unknown;
    resume(): unknown;
    pause(): unknown;
    on(event: "data", f: (chunk: Buffer) => void): unknown;
    off(event: "data", f: (chunk: Buffer) => void): unknown;
  };
};

/** One line from the terminal, not echoed. Ctrl-C or Ctrl-D cancels. */
export function readHidden({ stdin }: Terminal): Promise<string> {
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (f: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      f();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(typed));
        if (ch === "\u0003" || ch === "\u0004") return done(() => reject(new SecretError("the prompt was cancelled; nothing was stored")));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
