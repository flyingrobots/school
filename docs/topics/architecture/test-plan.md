# Architecture test plan

The contract ledger for [School's architecture](README.md). Every case runs in `bun test`.

## The bridge's output

The cases run the bridge as a real process.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| BRIDGE-OUT-1 | Logs | Every stdout line parses as JSON with a string `kind`; no line contains the prompt | implemented | `bridge/bridge.test.ts`: `logs are JSON Lines and never contain the prompt` |
| BRIDGE-OUT-2 | Port taken | With the port held by another socket: every line on stdout and stderr parses as JSON with a string `kind`; exactly one `bridge.error`, last on stdout, naming `host:port` and carrying `host` and `port`; no token in the output; exit 2 | implemented | `bridge/bridge.test.ts`: `a bridge whose port is taken writes one bridge.error line naming it, nothing but JSON Lines, and exits 2` |

## Asking the bridge a question

The bridge's `POST /ask` and its `ask` list (RFC 6 §5.4, flyingrobots/school#226). The oracle for
each case is RFC 6 Table 5.4. Fake agents are shell scripts printing Claude Code's stream-json lines
(`bridge/testing/fake-agent.ts`); none contacts a model. The `bridge/ask.test.ts` cases run the
ask list in the test's process; the `bridge/ask-route.test.ts` cases run the bridge as a real process.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| ASK-1 | Golden | Three deltas each reach the caller while the agent waits at a gate that only the delta's arrival opens; the end names the agent and its token counts | implemented | `bridge/ask.test.ts`: `golden: three deltas each reach the caller before the agent goes on, then the end names the agent and its usage` |
| ASK-2 | Over HTTP | The same, as `application/x-ndjson`: three `delta` lines before the agent exits, then one `end` line | implemented | `bridge/ask-route.test.ts`: `POST /ask streams each delta to the caller as NDJSON before the agent exits, then one end line` |
| ASK-3 | Exits before any delta | The next agent answers; only its words are passed on | implemented | `bridge/ask.test.ts`: `an agent that exits before any delta hands over to the next, whose answer is the only one passed on`; `a CLI error result before any delta hands over to the next agent` |
| ASK-4 | Fails after a delta | The reply ends as failed, naming that agent; no other agent runs | implemented | `bridge/ask.test.ts`: `a failure after the first delta ends the reply as failed, naming that agent, and no other agent runs`; `a CLI error result after a delta ends the reply as failed` |
| ASK-5 | Hangs | Before any delta: killed at its timeout, the next agent answers. After a delta: killed, the reply fails. A passed overall deadline skips the rest | implemented | `bridge/ask.test.ts`: `an agent that hangs before any delta is killed at its timeout and the next agent answers`; `an agent that hangs after a delta is killed at its timeout and the reply ends as failed`; `an overall deadline stops the list rather than running past it` |
| ASK-6 | Its own queue | A question is answered while a grading is still running | implemented | `bridge/ask-route.test.ts`: `a grading in progress does not delay a question` |
| ASK-7 | Interleaved | Eight gradings and eight questions at once: each reply holds its own question's words, every grading succeeds, no log line holds a prompt or an answer | implemented | `bridge/ask-route.test.ts`: `interleaved gradings and questions: each reply is its own, every grading succeeds, no log line holds a prompt or an answer` |
| ASK-8 | Hang-up | A caller that hangs up stops its agent, and the next question runs | implemented | `bridge/ask-route.test.ts`: `a caller that hangs up stops the agent, which frees the ask queue for the next question`; `bridge/ask.test.ts`: `a caller that goes away stops the agent, and the reply ends as failed` |
| ASK-9 | Other output kinds | `text`, `claude-json`, `{output_file}` and stream-json without partial messages answer as one delta at the end; no answer at all hands over | implemented | `bridge/ask.test.ts`: `an agent with output text still answers, as one delta at the end, with no usage`, and the four cases after it |
| ASK-10 | Configuration | The `ask` list is optional, its timeout defaults to 90 s, it is checked like the grading list, and the example file loads | implemented | `bridge/ask.test.ts`: `the ask list is optional, its own timeout defaults to 90 s, and it is checked like the grading list`; `the example configuration loads, its first ask agent streaming` |
| ASK-11 | Refusals | No token 401, not JSON 415 or 400, a bad prompt or deadline 400, a GET 405, no agent run; no ask list is one failed `end` line naming the file | implemented | `bridge/ask-route.test.ts`: `POST /ask refuses a request without the token, a body that is not JSON, and a bad prompt or deadline`; `with no ask list, POST /ask is one failed end line naming the configuration file` |
