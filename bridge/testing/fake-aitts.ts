// A synthetic AI-TTS daemon on a Unix socket, for tests (flyingrobots/school#175). It never plays
// audio and never touches the real daemon: it listens on a socket in a fresh temporary directory,
// which a test hands the bridge as AI_TTS_SOCKET.
//
// It speaks the subset of the daemon's JSON Lines protocol the bridge uses, one request line and
// one reply line per connection, with the daemon's reply shapes (as ~/git/reader/tests/fake_aitts.py
// does for Reader): `status` (with `version`), `submit`, `get` (an item with `segments[]`, each
// with `index`, `state`, `duration_ms`, `audio_ready`, `audio_path`) and `cancel`. A submission is
// split into `segments` segments; segment i is synthesized `stepMs × (i + 1)` after it was
// submitted, as a silent WAV of `seconds` seconds written into the directory. Every request is
// kept, in order, in `requests`.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeDaemonOptions = {
  /** Segments per submission. Default 3. */
  segments?: number;
  /** Milliseconds between one segment being ready and the next. 0, the default, makes all ready at once. */
  stepMs?: number;
  /** Each segment's length in seconds. Default 0.15. */
  seconds?: number;
  /** What `status` reports as the daemon's version. Default 0.2.0. */
  version?: string;
};

export type FakeDaemon = {
  /** The socket's path, for AI_TTS_SOCKET. */
  path: string;
  /** The temporary directory holding the socket and the WAVs. */
  dir: string;
  /** Every request received, in order. */
  requests: Record<string, unknown>[];
  /** Changes what `status` reports from now on. */
  setVersion(v: string): void;
  /** When true, the daemon reads each request and closes the connection without answering. */
  setDown(down: boolean): void;
  close(): void;
};

/** A silent mono 16-bit WAV of `seconds` at 8 kHz. */
export function silentWav(seconds: number, rate = 8000): Uint8Array {
  const samples = Math.round(rate * seconds);
  const data = samples * 2;
  const b = new ArrayBuffer(44 + data);
  const v = new DataView(b);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + data, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, data, true);
  return new Uint8Array(b);
}

/** A directory whose socket path fits the 104-byte limit of a Unix socket's address on macOS. */
function socketDir(): string {
  const base = tmpdir();
  return mkdtempSync(join(base.length > 60 ? "/tmp" : base, "aitts-"));
}

type Entry = { id: string; at: number; state: string; count: number };

export function fakeDaemon(options: FakeDaemonOptions = {}): FakeDaemon {
  const segments = options.segments ?? 3;
  const stepMs = options.stepMs ?? 0;
  const seconds = options.seconds ?? 0.15;
  let version = options.version ?? "0.2.0";
  let down = false;
  const dir = socketDir();
  const path = join(dir, "ai-tts.sock");
  const requests: Record<string, unknown>[] = [];
  const items = new Map<string, Entry>();
  const wav = silentWav(seconds);

  const readyCount = (e: Entry) => (e.state === "Cancelled" ? 0 : Math.min(e.count, Math.floor((Date.now() - e.at) / Math.max(stepMs, 1)) + (stepMs === 0 ? e.count : 0)));
  const audioPath = (e: Entry, i: number) => join(dir, `${e.id}-${i}.wav`);
  const view = (e: Entry) => {
    const ready = readyCount(e);
    for (let i = 0; i < ready; i++) if (!existsSync(audioPath(e, i))) writeFileSync(audioPath(e, i), wav);
    const state = e.state === "Cancelled" ? "Cancelled" : ready >= e.count ? "Ready" : ready > 0 ? "Synthesizing" : "Queued";
    return {
      id: e.id, text: "(not repeated)", state, source: "School", error: null, composite: e.count > 1,
      segment_count: e.count, completed_segments: 0, playback: false,
      segments: Array.from({ length: e.count }, (_, i) => ({
        index: i, state: i < ready ? "Ready" : "Queued", duration_ms: i < ready ? Math.round(seconds * 1000) : null,
        audio_ready: i < ready, audio_path: i < ready ? audioPath(e, i) : null, error: null,
      })),
    };
  };

  const dispatch = (p: Record<string, unknown>): Record<string, unknown> => {
    switch (p.op) {
      case "status":
        return { ok: true, version, state: "accepting", playback_held: false, playback_state: "idle", current: null };
      case "submit": {
        if (typeof p.text !== "string" || p.text.trim() === "") return { ok: false, error: { type: "bad_request", message: "submit requires non-empty 'text'" } };
        const id = `utt_${crypto.randomUUID().replaceAll("-", "")}`;
        items.set(id, { id, at: Date.now(), state: "Queued", count: segments });
        return { ok: true, accepted: true, id, state: "Queued", voice: "fake", sensitivity: p.sensitivity, segment_count: segments, composite: segments > 1,
          playback: p.playback !== false, accepting_speech: true, playback_held: false, submission_disposition: "queued_for_playback" };
      }
      case "get":
      case "cancel": {
        const e = items.get(String(p.id));
        if (e === undefined) return { ok: false, error: { type: "not_found", message: `no utterance '${String(p.id)}'` } };
        if (p.op === "get") return { ok: true, item: view(e) };
        e.state = "Cancelled";
        return { ok: true, id: e.id, state: "Cancelled" };
      }
      default:
        return { ok: false, error: { type: "bad_request", message: `unknown op '${String(p.op)}'` } };
    }
  };

  const buffers = new WeakMap<object, string>();
  const listener = Bun.listen({
    unix: path,
    socket: {
      data(socket, chunk) {
        const text = (buffers.get(socket) ?? "") + new TextDecoder().decode(chunk);
        const nl = text.indexOf("\n");
        if (nl === -1) {
          buffers.set(socket, text);
          return;
        }
        if (down) {
          socket.end();
          return;
        }
        let reply: Record<string, unknown>;
        try {
          const payload = JSON.parse(text.slice(0, nl)) as Record<string, unknown>;
          requests.push(payload);
          reply = dispatch(payload);
        } catch {
          reply = { ok: false, error: { type: "bad_request", message: "not JSON" } };
        }
        socket.end(JSON.stringify(reply) + "\n");
      },
    },
  });

  return {
    path, dir, requests,
    setVersion: (v) => { version = v; },
    setDown: (d) => { down = d; },
    close: () => {
      listener.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
