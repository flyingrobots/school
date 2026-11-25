# Reading aloud test plan

The contract ledger for [reading aloud](README.md). Every case runs in `bun test`. No case uses the
real AI-TTS daemon or speaks: the bridge's cases run the bridge as a real process against a fake
daemon (`bridge/testing/fake-aitts.ts`) on a temporary Unix socket, given as `AI_TTS_SOCKET`, which
writes silent WAVs; the server's and the browser's cases fake the bridge.

## The bridge

In `bridge/speech.test.ts`.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| RA-B1 | Submit | `status` then `submit`, with exactly `playback: false`, `origin` and `source` `School`, `sensitivity: confidential`, `content_format: markdown`, `priority: normal` and the text; the answer is `{ id, state, segments }` | implemented | `speech-submit: POST /speak asks the daemon's version, then submits with playback false, as School, confidential markdown` |
| RA-B2 | Progress | Each segment not ready, then ready with its duration, as the daemon synthesizes it | implemented | `speech-progress: GET /speak/:id reports each segment as it is synthesized, with its duration` |
| RA-B3 | Segment bytes | The WAV whole (200, `audio/wav`, `Accept-Ranges: bytes`), by `bytes=0-11` (206, its `Content-Range` and length), by `bytes=40-`; a range past the end 416; no such segment 404 | implemented | `speech-segment: GET /speak/:id/segments/:n is the segment's WAV, whole or by a byte range` |
| RA-B4 | Not ready | A segment still being synthesized is 409, saying so | implemented | `speech-segment-not-ready: a segment still being synthesized is a 409 that says so` |
| RA-B5 | Cancel | The daemon is sent `cancel` with the id | implemented | `speech-cancel: POST /speak/:id/cancel cancels it at the daemon` |
| RA-B6 | Foreign ids | An utterance submitted to the daemon by another program, or a malformed id, is 403 on progress, segment and cancel, and no cancel reaches the daemon; after 51 submissions the oldest is 403 and the rest are served | implemented | `speech-foreign: an utterance this bridge did not submit is a 403 on every route, and so is the 51st-oldest` |
| RA-B7 | Unreachable daemon | A missing socket, a regular file, a symlink to the socket, and a daemon that closes without answering are each 503 `unavailable` with a reason in words | implemented | `speech-unreachable: no socket, a file that is not one, a symlink, or a daemon that hangs up is a 503 in words` |
| RA-B8 | Old daemon | Version 0.1.9 is 503, naming 0.2.0 and 0.1.9; only `status` was sent | implemented | `speech-version: a daemon older than 0.2.0 is refused, naming both versions, and nothing is submitted` |
| RA-B9 | Input | No token is 401; not JSON is 415; empty, blank, a number, a NUL, or over 512 KiB is 400, and nothing is submitted | implemented | `speech-input: the token is required, and a body that is not text to speak is a 400` |
| RA-B10 | Logs | `bridge.speak.submit`, `bridge.speak.cancel` and `bridge.speak.failed` lines validate against their schemas; nothing on stderr; neither the text nor the token on stdout | implemented | `speech-log: submitting, cancelling and a refusal are logged as valid JSON Lines, never with the text or the token` |
| RA-B11 | Schemas listed | `--help` lists the three new schemas and `AI_TTS_SOCKET`, `AI_TTS_HOME` | implemented | `bridge/output.test.ts`: `bridge --help: a help line, then every schema, exit 0, without a token or listening; --schema: every schema` |

## The server

In `server/speak.test.ts`.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| RA-S1 | A lesson's text | Contains the title, subtitle, section title, prose (entities decoded), aside, card, the quiz's question and the explain prompt, in page order; contains no choice (correct or not), `why`, model answer, source, nest label, script or tag | implemented | `speak-lesson: the title, subtitle, section titles, prose and each question, and never a choice, a why, a model answer or a source` |
| RA-S2 | HTML as text | Paragraphs and list items become paragraphs; `&nbsp;`, `&lt;`, `&#x41;`, `&#66;` decode; `style` and `svg` are dropped | implemented | `speak-html: tags are dropped, blocks become paragraphs, entities are decoded, and scripts, styles and drawings are not read` |
| RA-S3 | Feedback's text | The lesson, prompt, summary and each criterion in words; no contradiction | implemented | `speak-feedback: the lesson, the prompt, the summary and each criterion in words, and never a contradiction's quote` |
| RA-S4 | Lesson over HTTP | The bridge gets `POST /speak` with `Bearer <token>` and exactly the lesson's built text; the browser gets the utterance and never the token | implemented | `speak-lesson-http: the server builds the lesson's text, sends it to the bridge with its token, and answers with the utterance` |
| RA-S5 | Feedback over HTTP | `{ feedback: true }` sends the latest feedback's built text | implemented | `speak-feedback-http: { feedback: true } speaks the latest feedback` |
| RA-S6 | No text from the browser | A body with `text`, `feedback: false`, `{}` or `null` is 400; an unknown lesson or course, or no feedback, 404; not JSON 415; the bridge is asked nothing | implemented | `speak-no-text: the browser cannot send text, and an unknown lesson or a missing feedback is a 404` |
| RA-S7 | No bridge | With no bridge, or one not listening, all four routes are 503 with a reason naming the bridge, and no token; with none, the reason points to Settings | implemented | `speak-503: with no bridge, or a bridge that cannot be reached, every speak route is a 503 in words` |
| RA-S8 | No daemon | The bridge's 503 and its reason reach the browser | implemented | `speak-daemon-503: the bridge's own 503 (no AI-TTS) reaches the browser with its reason` |
| RA-S9 | Old bridge | A bridge with no `/speak` route is 503, asking for it to be updated | implemented | `speak-old-bridge: a bridge from before reading aloud, with no /speak route, is a 503 asking for it to be updated` |
| RA-S10 | Progress proxy | The bridge's progress, fetched with the token | implemented | `speak-progress-http: GET /api/speak/:id is the bridge's progress, fetched with the token` |
| RA-S11 | Segment proxy | The bytes whole and by range, the browser's `Range` passed on, `Content-Range` and `Accept-Ranges` back, any other bridge header (one holding the token) dropped | implemented | `speak-segment-http: a segment's WAV is passed through, with the browser's byte range, and none of the bridge's other headers` |
| RA-S12 | Cancel proxy | Reaches the bridge with the token | implemented | `speak-cancel-http: POST /api/speak/:id/cancel cancels at the bridge` |
| RA-S13 | Ids | A malformed id or segment is 400 and the bridge is asked nothing; the bridge's 403 is passed on | implemented | `speak-ids: an id that is not an utterance's is a 400 and never reaches the bridge; the bridge's 403 is passed on` |
| RA-S14 | Token never shown | Not in the server's stdout or stderr after speaking | implemented | `speak-token: the token is never in the server's output` |

## The browser

In `web/test/read-aloud.test.ts`, in Chrome, against a real School on `web/test/fixtures/course`
and a fake bridge serving three 30-second silent segments.

| ID | Case | Oracle | Status | Test |
| --- | --- | --- | --- | --- |
| RA-W1 | Read aloud, Next, Stop | The button shows `R`; clicking it shows the bar with **AI voice**, playing "Reading · 1 of 3" from segment 0; the text the server sent holds the quiz's question and not its `why`; Next plays "2 of 3" from segment 1; Stop removes the bar and cancels once | implemented | `Read aloud shows the bar with its AI label, plays the first segment, and Next and Stop work` |
| RA-W2 | Keys and the spinner | `r` starts; the bar shows `,` `.` `/` `Esc`; `/` pauses ("Paused · 1 of 3") and resumes; `.` twice reaches a part not made yet, shown with a spinner and "Getting part 3 of 3 ready", which plays once ready; `,` goes back; `Esc` stops and cancels once | implemented | `r starts it; / pauses and resumes; , and . step; a part still being made shows a spinner; Esc stops` |
| RA-W3 | No daemon | The bar shows the bridge's reason; `Esc` closes it | implemented | `with no AI-TTS, the bar says why in words, and Esc closes it` |
| RA-W4 | Feedback card | Read aloud on the home page's feedback card posts exactly `{ feedback: true }` | implemented | `the home page's feedback card has Read aloud, which asks School for the feedback, never sending text` |
| RA-W5 | Lost School | With every progress request refused, the bar turns to failed and says School stopped answering; `Esc` closes it | implemented | `three failed polls in a row stop reading, and the bar says School stopped answering` |
| RA-W6 | Back-off | Polls every 350 ms while the next segment is awaited, backing off to 2 s otherwise | planned | none |
