// Reading aloud through the AI-TTS daemon (flyingrobots/school#175), as Reader does
// (~/git/reader/src/reader_mcp/speech.py). The bridge never plays audio: it writes one JSON line to
// the daemon's Unix socket and reads one line back. It submits with `playback: false`, so the
// daemon only synthesizes, and the browser fetches each segment's WAV through School and plays it
// there; nothing plays on the host's speakers. It serves only utterances it submitted itself, the
// last TRACKED of them.
import { lstatSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_TEXT = 512 * 1024; // UTF-8 bytes of text per submission, as Reader's
const MAX_REQUEST = 1024 * 1024; // the daemon's longest request line
const MAX_RESPONSE = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;
export const TRACKED = 50;
export const UTTERANCE_ID = /^utt_[0-9a-f]{32}$/;
export const MIN_VERSION = "0.2.0";

/** The daemon is not running, not a socket we will use, too old, or not answering. */
export class SpeechUnavailable extends Error {}
/** The daemon answered and refused the request. */
export class SpeechRefused extends Error {
  constructor(message: string, readonly type: string) { super(message); }
}
/** The utterance is not one this bridge submitted. */
export class NotOurs extends Error {}
/** The segment does not exist, or its audio is not ready yet. */
export class NoSegment extends Error {
  constructor(message: string, readonly notReady: boolean) { super(message); }
}

/** `$AI_TTS_SOCKET`, else `$AI_TTS_HOME/ai-tts.sock`, else the daemon's default under Application Support. */
export function socketPath(env: Record<string, string | undefined>): string {
  const expand = (p: string) => (p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p);
  if (env.AI_TTS_SOCKET) return expand(env.AI_TTS_SOCKET);
  const home = env.AI_TTS_HOME ? expand(env.AI_TTS_HOME) : join(homedir(), "Library", "Application Support", "ai-tts");
  return join(home, "ai-tts.sock");
}

/** The socket's path, if it is a socket and not a symlink. */
function checked(path: string): string {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new SpeechUnavailable("AI-TTS isn't running: its socket is missing. Start AI-TTS, then try again.");
  }
  if (info.isSymbolicLink()) throw new SpeechUnavailable("The AI-TTS socket path is a symlink, which the bridge refuses.");
  if (!info.isSocket()) throw new SpeechUnavailable("The AI-TTS socket path is not a socket.");
  return path;
}

/** One request line out, one reply line back. A refusal throws SpeechRefused; anything else wrong, SpeechUnavailable. */
export function request(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const line = JSON.stringify(payload) + "\n";
  if (Buffer.byteLength(line) > MAX_REQUEST) return Promise.reject(new SpeechRefused("The text is longer than AI-TTS takes in one request.", "too_large"));
  let at: string;
  try {
    at = checked(path);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise((resolve, reject) => {
    let got = "";
    let done = false;
    const finish = (e: Error | null, value?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (e === null) resolve(value!);
      else reject(e);
    };
    const socket = createConnection({ path: at });
    const timer = setTimeout(() => finish(new SpeechUnavailable(`AI-TTS did not answer within ${TIMEOUT_MS / 1000} seconds.`)), TIMEOUT_MS);
    socket.on("connect", () => socket.write(line));
    socket.on("data", (chunk) => {
      got += chunk.toString("utf8");
      if (got.length > MAX_RESPONSE) return finish(new SpeechUnavailable("AI-TTS answered with an oversized reply."));
      const nl = got.indexOf("\n");
      if (nl === -1) return;
      let reply: unknown;
      try {
        reply = JSON.parse(got.slice(0, nl));
      } catch {
        return finish(new SpeechUnavailable("AI-TTS answered with something that is not JSON."));
      }
      if (typeof reply !== "object" || reply === null || Array.isArray(reply)) return finish(new SpeechUnavailable("AI-TTS answered with something that is not JSON."));
      const r = reply as Record<string, unknown>;
      if (r.ok !== true) {
        const error = (typeof r.error === "object" && r.error !== null ? r.error : {}) as Record<string, unknown>;
        return finish(new SpeechRefused(`AI-TTS refused: ${String(error.message ?? error.type ?? "no reason given")}`, String(error.type ?? "unknown")));
      }
      finish(null, r);
    });
    socket.on("end", () => finish(new SpeechUnavailable("AI-TTS closed the connection without answering.")));
    socket.on("close", () => finish(new SpeechUnavailable("AI-TTS closed the connection without answering.")));
    socket.on("error", (e: NodeJS.ErrnoException) => finish(new SpeechUnavailable(`AI-TTS isn't running (${e.code ?? e.message}). Start AI-TTS, then try again.`)));
  });
}

/** Whether the version in `found` is older than `min` (both `x.y.z`), or null when `found` holds no version. */
function older(found: string, min: string): boolean | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(found);
  if (m === null) return null;
  const want = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const v = Number(m[i + 1]);
    if (v !== want[i]) return v < want[i]!;
  }
  return false;
}

export type Progress = { id: string; state: string | null; error: string | null; segments: { index: number; ready: boolean; durationMs: number | null }[] };

/** A client for one daemon socket, remembering the utterances it submitted. */
export function speech(path: () => string) {
  const submitted = new Set<string>(); // insertion order: the oldest first
  const ours = (id: string) => {
    if (!UTTERANCE_ID.test(id) || !submitted.has(id)) throw new NotOurs("The bridge serves only speech it submitted.");
    return id;
  };
  const item = async (id: string) => {
    const r = await request(path(), { op: "get", id: ours(id) });
    return (typeof r.item === "object" && r.item !== null ? r.item : {}) as Record<string, unknown>;
  };
  const rawSegments = (i: Record<string, unknown>) => (Array.isArray(i.segments) ? i.segments : []).filter(
    (s): s is Record<string, unknown> => typeof s === "object" && s !== null && Number.isInteger((s as Record<string, unknown>).index));

  return {
    /** Checks the daemon is 0.2.0 or later, then submits `text` for synthesis only. */
    async submit(text: string): Promise<{ id: string; state: string | null; segments: number | null }> {
      const status = await request(path(), { op: "status" });
      const version = typeof status.version === "string" ? status.version : "";
      if (older(version, MIN_VERSION) !== false) {
        throw new SpeechUnavailable(`AI-TTS ${MIN_VERSION} or newer is needed to read aloud (found ${version === "" ? "an older version" : version}). Update and restart AI-TTS, then try again.`);
      }
      const r = await request(path(), {
        op: "submit", text, playback: false, origin: "School", source: "School",
        sensitivity: "confidential", content_format: "markdown", priority: "normal",
      });
      const id = r.id;
      if (typeof id !== "string" || !UTTERANCE_ID.test(id)) throw new SpeechUnavailable("AI-TTS took the text without a usable utterance id.");
      submitted.add(id);
      while (submitted.size > TRACKED) submitted.delete(submitted.values().next().value!);
      return { id, state: typeof r.state === "string" ? r.state : null, segments: Number.isInteger(r.segment_count) ? (r.segment_count as number) : null };
    },

    /** Each segment's progress, never the text. */
    async progress(id: string): Promise<Progress> {
      const i = await item(id);
      return {
        id, state: typeof i.state === "string" ? i.state : null, error: typeof i.error === "string" ? i.error : null,
        segments: rawSegments(i).map((s) => ({ index: s.index as number, ready: s.audio_ready === true, durationMs: Number.isInteger(s.duration_ms) ? (s.duration_ms as number) : null })),
      };
    },

    /** The path of a ready segment's audio: a regular file, not a symlink. */
    async segmentFile(id: string, index: number): Promise<string> {
      const segment = rawSegments(await item(id)).find((s) => s.index === index);
      if (segment === undefined) throw new NoSegment("There is no such segment.", false);
      const file = segment.audio_path;
      if (segment.audio_ready !== true || typeof file !== "string" || file === "") throw new NoSegment("This segment is not ready yet.", true);
      try {
        if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) throw new Error();
      } catch {
        throw new NoSegment("This segment's audio is not available.", false);
      }
      return file;
    },

    async cancel(id: string): Promise<{ id: string; state: string | null }> {
      const r = await request(path(), { op: "cancel", id: ours(id) });
      return { id, state: typeof r.state === "string" ? r.state : null };
    },
  };
}

/**
 * A file's bytes as a Response, honouring one `bytes=start-end` range (Reader's send_file): 200
 * whole, 206 for a range, 416 for one outside the file.
 */
export function fileResponse(path: string, range: string | null, type: string): Response {
  const size = statSync(path).size;
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-store" };
  if (range === null) return new Response(Bun.file(path), { headers: { ...headers, "content-length": String(size) } });
  const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (m === null) return Response.json({ status: "invalid", error: "send one byte range, bytes=start-end" }, { status: 416, headers: { "content-range": `bytes */${size}` } });
  const start = Number(m[1]);
  const end = Math.min(m[2] === "" ? size - 1 : Number(m[2]), size - 1);
  if (!(start <= end && start < size)) return Response.json({ status: "invalid", error: "that range is outside the audio" }, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(Bun.file(path).slice(start, end + 1), {
    status: 206, headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` },
  });
}
