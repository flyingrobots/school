// A fake agent that prints one text delta, then hangs, after starting a child that leaves its
// process group (as `setsid` does) while holding the agent's stdout and stderr open. A kill of the
// agent's group misses that child, so only a bridge that stops waiting on the pipes returns.
// Run as `bun escaping-agent.ts <pid file>`; the child's pid is written there so a test can end it.
import { writeFileSync } from "node:fs";

const child = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
child.unref();
writeFileSync(process.argv[2]!, String(child.pid));
console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } }));
await new Promise(() => setInterval(() => {}, 1000));
