// The authoring record's storage rules (RFC 9 §5.5; flyingrobots/school#258), on PGlite. What the
// functions answer is the LearningRecord contract's (server/contract/learning-record.ts), where the
// adapter parses every input with the model first; this file calls the functions directly, as
// school_app, to show the record refuses on its own, storing nothing, what the model refuses.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { AuthoringDecision, AuthoringDraft, AuthoringRequest } from "../core/model.ts";
import { migrate } from "./migrate.ts";

const SLOW = 30_000; // PGlite starts a whole Postgres in process.
const at = "2001-02-03T04:05:06.789Z";
const uuid = () => crypto.randomUUID();

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}

/** "stored" when the function stored the row, else how it refused: an answer, or what it raised. */
const verdict = (p: Promise<{ rows: { s: string }[] }>) =>
  p.then((r) => (r.rows[0]?.s === "stored" ? "stored" : `answered ${r.rows[0]?.s}`), (e: Error) => `raised: ${e.message}`);
const stores = async (p: Promise<{ rows: { s: string }[] }>) => (await verdict(p)) === "stored";

const install = (db: PGlite, i: Record<string, unknown>) =>
  db.query<{ s: string }>("SELECT school.install_course($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) AS s",
    [i.id, i.course, i.source, i.url, i.bundleSha256, i.commit, i.contentSha256, i.title, i.format, i.parentInstallId ?? null, i.draftId ?? null, at]);
const request = (db: PGlite, q: Record<string, unknown>) =>
  db.query<{ s: string }>("SELECT school.request_authoring($1, $2, $3, $4, $5, $6, $7) AS s",
    [q.id, q.course, q.baseInstallId, q.text, q.skillSha256, q.schoolVersion, at]);
const draft = (db: PGlite, d: Record<string, unknown>) =>
  db.query<{ s: string }>("SELECT school.record_draft($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS s",
    [d.id, d.requestId, d.round, d.status, d.agent, d.commit, d.contentSha256, d.checkMessage, d.inputTokens, d.outputTokens, at]);
const decide = (db: PGlite, x: Record<string, unknown>) =>
  db.query<{ s: string }>("SELECT school.decide_draft($1, $2, $3, $4, $5, $6) AS s", [x.id, x.draftId, x.decision, x.installId, x.patch, at]);

/** A record with `bells` installed from git, a request on it, and a ready draft of that request, all through the functions. */
async function drafted() {
  const db = new PGlite();
  await migrate(db);
  const base = { id: uuid(), course: "bells", source: "git", url: "https://example.com/bells.git", bundleSha256: null,
    commit: "a".repeat(40), contentSha256: "c".repeat(64), title: "Bells", format: 1 };
  const req = { id: uuid(), course: "bells", baseInstallId: base.id, text: "Add a lesson on rounds.", skillSha256: "5".repeat(64), schoolVersion: "0.1.0" };
  const ready = { id: uuid(), requestId: req.id, round: 1, status: "ready", agent: "claude", commit: "7".repeat(40), contentSha256: "8".repeat(64),
    checkMessage: null, inputTokens: 10, outputTokens: 2 };
  await as(db, "school_app", async () => {
    expect((await install(db, base)).rows).toEqual([{ s: "installed" }]);
    expect((await request(db, req)).rows).toEqual([{ s: "stored" }]);
    expect((await draft(db, ready)).rows).toEqual([{ s: "stored" }]);
  });
  return { db, base, req, ready };
}

describe("the authoring record", () => {
  // Oracle: the model in server/core/model.ts. A row the table kept that the model refuses would
  // break every later read of the course's authoring; each case below is one the model refuses.
  test("the record refuses, on its own, each malformed request the model refuses", async () => {
    const { db, base } = await drafted();
    const good = { id: uuid(), course: "bells", baseInstallId: base.id, text: "Add a quiz.", skillSha256: "5".repeat(64), schoolVersion: "0.1.0" };
    const cases: [string, Record<string, unknown>][] = [
      ["empty text", { text: "" }], ["20,001 characters", { text: "x".repeat(20_001) }], ["a short skill digest", { skillSha256: "5".repeat(63) }],
      ["an uppercase skill digest", { skillSha256: "A".repeat(64) }], ["no School version", { schoolVersion: "" }], ["a reserved course name", { course: "api" }],
    ];
    const verdicts: string[] = [];
    for (const [why, o] of cases) {
      const q = { ...good, ...o, id: uuid() };
      verdicts.push(`${why}: model ${AuthoringRequest.safeParse(q).success}, record stores ${await as(db, "school_app", () => stores(request(db, q)))}`);
    }
    expect(verdicts).toEqual(cases.map(([why]) => `${why}: model false, record stores false`));
  }, SLOW);

  test("the record refuses, on its own, each malformed draft the model refuses", async () => {
    const { db, req } = await drafted();
    const other = { ...req, id: uuid() };
    await as(db, "school_app", () => request(db, other));
    const good = { id: uuid(), requestId: other.id, round: 1, status: "ready", agent: "claude", commit: "7".repeat(40), contentSha256: "8".repeat(64),
      checkMessage: null, inputTokens: 10, outputTokens: 2 };
    const failed = { ...good, status: "failed", agent: null, commit: null, contentSha256: null };
    const cases: [string, Record<string, unknown>][] = [
      ["round 0", { round: 0 }], ["round 3", { round: 3 }], ["an unknown status", { status: "running" }],
      ["a ready draft with no commit", { commit: null }], ["a ready draft with no digest", { contentSha256: null }],
      ["a ready draft with a check message", { checkMessage: "No." }], ["a refused draft with no check message", { status: "refused" }],
      ["a refused draft with an empty check message", { status: "refused", checkMessage: "" }],
      ["a failed draft with a commit", { ...failed, commit: "7".repeat(40) }], ["a failed draft with a digest", { ...failed, contentSha256: "8".repeat(64) }],
      ["a ready draft with no agent", { agent: null }], ["an empty agent", { agent: "" }], ["a short commit", { commit: "7".repeat(39) }],
      ["negative input tokens", { inputTokens: -1 }], ["negative output tokens", { outputTokens: -1 }],
    ];
    const verdicts: string[] = [];
    for (const [why, o] of cases) {
      const d = { ...good, ...o, id: uuid() };
      verdicts.push(`${why}: model ${AuthoringDraft.safeParse(d).success}, record stores ${await as(db, "school_app", () => stores(draft(db, d)))}`);
    }
    expect(verdicts).toEqual(cases.map(([why]) => `${why}: model false, record stores false`));
  }, SLOW);

  test("the record refuses, on its own, each malformed decision the model refuses", async () => {
    const { db, base, ready } = await drafted();
    // The draft's own authored install, so an accept is refused for its shape alone.
    const authored = { ...base, id: uuid(), source: "authored", url: null, commit: ready.commit, contentSha256: ready.contentSha256,
      parentInstallId: base.id, draftId: ready.id };
    expect(await as(db, "school_app", () => verdict(install(db, authored)))).toBe("answered updated");
    const cases: [string, Record<string, unknown>][] = [
      ["an unknown decision", { decision: "kept" }], ["a discard naming an install", { installId: authored.id }],
      ["a discard keeping a patch", { patch: "From x" }], ["an accept with no install", { decision: "accepted", patch: "From x" }],
      ["an accept with no patch", { decision: "accepted", installId: authored.id }],
      ["an accept with an empty patch", { decision: "accepted", installId: authored.id, patch: "" }],
    ];
    const verdicts: string[] = [];
    for (const [why, o] of cases) {
      const x = { id: uuid(), draftId: ready.id, decision: "discarded", installId: null, patch: null, ...o };
      verdicts.push(`${why}: model ${AuthoringDecision.safeParse(x).success}, record stores ${await as(db, "school_app", () => stores(decide(db, x)))}`);
    }
    expect(verdicts).toEqual(cases.map(([why]) => `${why}: model false, record stores false`));
  }, SLOW);

  // RFC 9 §5.5: an `authored` row has neither url nor bundle_sha256, and gains parent_install_id
  // and draft_id; no other row has either.
  test("the record refuses, on its own, an install whose parent and draft do not match its source", async () => {
    const { db, base, ready } = await drafted();
    const authored = { ...base, source: "authored", url: null, bundleSha256: null, commit: ready.commit, contentSha256: ready.contentSha256,
      parentInstallId: base.id, draftId: ready.id };
    const cases: [string, Record<string, unknown>][] = [
      ["an authored install with no parent", { ...authored, parentInstallId: null }], ["an authored install with no draft", { ...authored, draftId: null }],
      ["an authored install with a URL", { ...authored, url: "https://example.com/bells.git" }],
      ["an authored install with a bundle", { ...authored, bundleSha256: "b".repeat(64) }],
      ["a git install naming a parent", { ...base, parentInstallId: base.id }], ["a git install naming a draft", { ...base, draftId: ready.id }],
    ];
    const verdicts: string[] = [];
    for (const [why, o] of cases) verdicts.push(`${why}: ${(await as(db, "school_app", () => verdict(install(db, { ...o, id: uuid() })))).startsWith("raised")}`);
    expect(verdicts).toEqual(cases.map(([why]) => `${why}: true`));
    expect(await as(db, "school_app", () => verdict(install(db, { ...authored, id: uuid() })))).toBe("answered updated");
  }, SLOW);

  // RFC 9 Table 5.5: "at most 20,000 characters", which Postgres counts in code points.
  test("the record's text bound is 20,000 code points, as the model's is", async () => {
    const { db, base } = await drafted();
    const q = (text: string) => ({ id: uuid(), course: "bells", baseInstallId: base.id, text, skillSha256: "5".repeat(64), schoolVersion: "0.1.0" });
    const verdicts: string[] = [];
    for (const [why, text] of [["20,000 bells", "\u{1F514}".repeat(20_000)], ["20,001 bells", "\u{1F514}".repeat(20_001)],
      ["20,000 letters", "x".repeat(20_000)]] as const) {
      verdicts.push(`${why}: model ${AuthoringRequest.safeParse(q(text)).success}, record ${await as(db, "school_app", () => verdict(request(db, q(text))))}`);
    }
    expect(verdicts).toEqual(["20,000 bells: model true, record stored",
      '20,001 bells: model false, record raised: new row for relation "authoring_requests" violates check constraint "authoring_requests_text"',
      "20,000 letters: model true, record stored"]);
  }, SLOW);
});
