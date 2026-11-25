// Reading aloud through AI-TTS (flyingrobots/school#175), as the real bridge process, against a
// fake daemon (bridge/testing/fake-aitts.ts) on a temporary Unix socket that writes silent WAVs.
// The real daemon's socket is never used: every bridge here is given AI_TTS_SOCKET.
// Oracles are the issue's acceptance items: the submit payload (`playback: false`), progress,
// segment bytes with byte ranges, 403 for an utterance this bridge did not submit, an unreachable
// daemon, and a daemon older than 0.2.0 refused.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, timeout, type Started } from "../server/testing/processes.ts";
import { publishedIn } from "../server/testing/schemas.ts";
import { fakeDaemon, silentWav, type FakeDaemon } from "./testing/fake-aitts.ts";

const TOKEN = "speech-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const bridgeSchemas = publishedIn(join(import.meta.dir, "schemas"));

let daemon: FakeDaemon | null = null;
let bridge: Started | null = null;
let dir = "";

afterEach(async () => {
  bridge?.proc.kill();
  await bridge?.proc.exited;
  bridge = null;
  daemon?.close();
  daemon = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** A bridge whose daemon socket is `socket` (the fake daemon's unless given). */
async function start(socket?: string): Promise<Started> {
  dir = mkdtempSync(join(tmpdir(), "school-bridge-speech-"));
  bridge = await startBridge({ PATH: process.env.PATH, HOME: dir, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "none.json"),
    AI_TTS_SOCKET: socket ?? daemon!.path });
  return bridge;
}

const speak = (b: Started, text: unknown, headers: Record<string, string> = { ...auth, "content-type": "application/json" }) =>
  fetch(b.url + "/speak", { method: "POST", headers, body: JSON.stringify({ text }) });
const get = (b: Started, path: string, headers: Record<string, string> = {}) => fetch(b.url + path, { headers: { ...auth, ...headers } });

/** Asks the daemon itself to speak, as another program on the host would: an utterance this bridge never submitted. */
async function submitElsewhere(path: string): Promise<string> {
  const { createConnection } = await import("node:net");
  return new Promise((resolve, reject) => {
    const s = createConnection({ path });
    let got = "";
    s.on("data", (d) => { got += d.toString(); });
    s.on("end", () => resolve(JSON.parse(got).id));
    s.on("error", reject);
    s.write(JSON.stringify({ op: "submit", text: "someone else's", playback: false }) + "\n");
  });
}

describe("the bridge reads aloud through AI-TTS", () => {
  test("speech-submit: POST /speak asks the daemon's version, then submits with playback false, as School, confidential markdown", async () => {
    daemon = fakeDaemon({ segments: 3 });
    const b = await start();
    const r = await speak(b, "# Orbits\n\nWhy do planets keep going?");
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ state: "Queued", segments: 3 });
    expect(body.id).toMatch(/^utt_[0-9a-f]{32}$/);
    expect(daemon.requests.map((q) => q.op)).toEqual(["status", "submit"]);
    expect(daemon.requests[1]).toEqual({
      op: "submit", text: "# Orbits\n\nWhy do planets keep going?", playback: false, origin: "School", source: "School",
      sensitivity: "confidential", content_format: "markdown", priority: "normal",
    });
  }, timeout(1));

  test("speech-progress: GET /speak/:id reports each segment as it is synthesized, with its duration", async () => {
    daemon = fakeDaemon({ segments: 2, stepMs: 400, seconds: 0.25 });
    const b = await start();
    const { id } = await (await speak(b, "Two parts.")).json();
    const first = await (await get(b, `/speak/${id}`)).json();
    expect(first).toEqual({ id, state: "Queued", error: null, segments: [{ index: 0, ready: false, durationMs: null }, { index: 1, ready: false, durationMs: null }] });
    await Bun.sleep(900);
    const later = await (await get(b, `/speak/${id}`)).json();
    expect(later).toEqual({ id, state: "Ready", error: null, segments: [{ index: 0, ready: true, durationMs: 250 }, { index: 1, ready: true, durationMs: 250 }] });
  }, timeout(1));

  test("speech-segment: GET /speak/:id/segments/:n is the segment's WAV, whole or by a byte range", async () => {
    daemon = fakeDaemon({ segments: 2, seconds: 0.1 });
    const b = await start();
    const { id } = await (await speak(b, "Bytes.")).json();
    const wav = silentWav(0.1);
    const whole = await get(b, `/speak/${id}/segments/0`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/wav");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(wav);
    const head = await get(b, `/speak/${id}/segments/1`, { range: "bytes=0-11" });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe(`bytes 0-11/${wav.length}`);
    expect(head.headers.get("content-length")).toBe("12");
    expect(new TextDecoder().decode(new Uint8Array(await head.arrayBuffer()).slice(8, 12))).toBe("WAVE");
    const tail = await get(b, `/speak/${id}/segments/1`, { range: "bytes=40-" });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(wav.slice(40));
    expect((await get(b, `/speak/${id}/segments/1`, { range: `bytes=${wav.length}-` })).status).toBe(416);
    expect((await get(b, `/speak/${id}/segments/2`)).status).toBe(404);
    expect((await get(b, `/speak/${id}/segments/x`)).status).toBe(404);
  }, timeout(1));

  test("speech-segment-not-ready: a segment still being synthesized is a 409 that says so", async () => {
    daemon = fakeDaemon({ segments: 2, stepMs: 5_000 });
    const b = await start();
    const { id } = await (await speak(b, "Slow.")).json();
    const r = await get(b, `/speak/${id}/segments/0`);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("not ready");
  }, timeout(1));

  test("speech-cancel: POST /speak/:id/cancel cancels it at the daemon", async () => {
    daemon = fakeDaemon();
    const b = await start();
    const { id } = await (await speak(b, "Stop me.")).json();
    const r = await fetch(`${b.url}/speak/${id}/cancel`, { method: "POST", headers: auth });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id, state: "Cancelled" });
    expect(daemon.requests.at(-1)).toEqual({ op: "cancel", id });
  }, timeout(1));

  test("speech-foreign: an utterance this bridge did not submit is a 403 on every route, and so is the 51st-oldest", async () => {
    daemon = fakeDaemon({ segments: 1 });
    const b = await start();
    const other = await submitElsewhere(daemon.path);
    for (const path of [`/speak/${other}`, `/speak/${other}/segments/0`, "/speak/utt_nonsense"]) {
      const r = await get(b, path);
      expect([path, r.status]).toEqual([path, 403]);
    }
    const c = await fetch(`${b.url}/speak/${other}/cancel`, { method: "POST", headers: auth });
    expect(c.status).toBe(403);
    expect(daemon.requests.filter((q) => q.op === "cancel")).toEqual([]);
    // It keeps the last 50 it submitted.
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push((await (await speak(b, `Number ${i}.`)).json()).id);
    expect((await get(b, `/speak/${ids[0]}`)).status).toBe(403);
    expect((await get(b, `/speak/${ids[1]}`)).status).toBe(200);
    expect((await get(b, `/speak/${ids[50]}`)).status).toBe(200);
  }, timeout(1));

  test("speech-unreachable: no socket, a file that is not one, a symlink, or a daemon that hangs up is a 503 in words", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "school-no-daemon-"));
    try {
      writeFileSync(join(elsewhere, "plain"), "not a socket");
      daemon = fakeDaemon();
      symlinkSync(daemon.path, join(elsewhere, "link.sock"));
      const cases: [string, RegExp][] = [
        [join(elsewhere, "missing.sock"), /AI-TTS isn.t running/],
        [join(elsewhere, "plain"), /not a socket/],
        [join(elsewhere, "link.sock"), /symlink/],
      ];
      for (const [socket, words] of cases) {
        const b = await start(socket);
        const r = await speak(b, "Hello.");
        expect([socket, r.status]).toEqual([socket, 503]);
        const body = await r.json();
        expect(body.status).toBe("unavailable");
        expect(body.error).toMatch(words);
        b.proc.kill();
        await b.proc.exited;
        rmSync(dir, { recursive: true, force: true });
      }
      const b = await start();
      daemon.setDown(true);
      const r = await speak(b, "Hello.");
      expect(r.status).toBe(503);
      expect((await r.json()).error).toContain("without answering");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  }, timeout(4));

  test("speech-version: a daemon older than 0.2.0 is refused, naming both versions, and nothing is submitted", async () => {
    daemon = fakeDaemon({ version: "0.1.9" });
    const b = await start();
    const r = await speak(b, "Hello.");
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error).toContain("0.2.0");
    expect(body.error).toContain("0.1.9");
    expect(daemon.requests.map((q) => q.op)).toEqual(["status"]);
  }, timeout(1));

  test("speech-input: the token is required, and a body that is not text to speak is a 400", async () => {
    daemon = fakeDaemon();
    const b = await start();
    expect((await speak(b, "Hello.", { "content-type": "application/json" })).status).toBe(401);
    expect((await fetch(b.url + "/speak/utt_00000000000000000000000000000000")).status).toBe(401);
    expect((await speak(b, "Hello.", { ...auth, "content-type": "text/plain" })).status).toBe(415);
    for (const text of ["", "   ", 7, "nul\u0000byte", "x".repeat(512 * 1024 + 1)]) expect((await speak(b, text)).status).toBe(400);
    expect(daemon.requests.filter((q) => q.op === "submit")).toEqual([]);
  }, timeout(1));

  test("speech-log: submitting, cancelling and a refusal are logged as valid JSON Lines, never with the text or the token", async () => {
    daemon = fakeDaemon();
    const b = await start();
    const { id } = await (await speak(b, "SECRET-LESSON-TEXT")).json();
    await fetch(`${b.url}/speak/${id}/cancel`, { method: "POST", headers: auth });
    daemon.setVersion("0.1.0");
    expect((await speak(b, "SECRET-LESSON-TEXT")).status).toBe(503);
    b.proc.kill();
    const { stdout, stderr } = await b.output();
    bridge = null;
    expect(stderr).toBe("");
    const out = bridgeSchemas.validated(stdout);
    expect(out.map((l) => l.kind)).toEqual(["bridge.start", "bridge.listening", "bridge.speak.submit", "bridge.speak.cancel", "bridge.speak.failed"]);
    expect(out[2]).toMatchObject({ id, segments: 3 });
    expect(out[4]).toMatchObject({ op: "submit", status: "unavailable" });
    expect(stdout).not.toContain("SECRET-LESSON-TEXT");
    expect(stdout).not.toContain(TOKEN);
  }, timeout(1));
});

test("the fake daemon's WAV is a RIFF WAVE file of the length asked for", () => {
  const w = silentWav(0.5);
  expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
  expect(w.length).toBe(44 + 8000);
});
