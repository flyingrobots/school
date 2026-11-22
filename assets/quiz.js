// Drives the quiz markup that render.ts emits: <div class="q" data-block data-why> with
// <button data-choice data-correct>. Opened as a file:// page it still works; it records nothing.
//
// Progress lives in School's SQLite database, never here (RFC 1; ADR 9). The server resumes the
// encounter on reload and renders what is already answered. The browser only carries an answer
// until the server confirms it is committed: until then it sits in an outbox, is retried with
// the SAME submission id (so a resend is never a second answer), and the page says it is not
// saved yet. localStorage is used for that outbox alone, because an answer given offline must
// survive the tab closing before it can be delivered.
const meta = document.getElementById("school-meta");
const course = meta?.dataset.course ?? null;
const lesson = meta?.dataset.lesson ?? null;
const encounterId = meta?.dataset.encounter ?? null;
const recording = encounterId !== null && location.protocol !== "file:";

// randomUUID needs a secure context (https or localhost); getRandomValues works everywhere.
const uuid = () => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const OUTBOX = "school.outbox.v1";
const readOutbox = () => {
  try {
    const v = JSON.parse(localStorage.getItem(OUTBOX) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const writeOutbox = (items) => {
  try {
    localStorage.setItem(OUTBOX, JSON.stringify(items));
  } catch {
    // Storage unavailable (private mode, quota). The answer is still retried while the tab lives.
  }
};
let pending = readOutbox();

const statusFor = new Map(); // submissionId -> status element on this page
const say = (id, text) => {
  const el = statusFor.get(id);
  if (el) el.textContent = text;
};

async function deliver(item) {
  try {
    const res = await fetch("/api/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
      keepalive: true,
    });
    // 200: committed (or already was). 400/409: the server will never accept this one, so
    // retrying cannot help; say so rather than retry forever or claim it was saved.
    if (res.ok) return "saved";
    if (res.status === 400 || res.status === 409) return "refused";
    return "retry";
  } catch {
    return "retry";
  }
}

let flushing = false;
let backoff = 1000;
async function flush() {
  if (flushing || pending.length === 0) return;
  flushing = true;
  try {
    for (const item of [...pending]) {
      const outcome = await deliver(item);
      if (outcome === "retry") {
        say(item.submissionId, "Not saved yet. Retrying…");
        setTimeout(flush, backoff);
        backoff = Math.min(backoff * 2, 60_000);
        return;
      }
      pending = pending.filter((p) => p.submissionId !== item.submissionId);
      writeOutbox(pending);
      say(item.submissionId, outcome === "saved" ? "Saved." : "This answer could not be recorded. Reload the lesson.");
    }
    backoff = 1000;
  } finally {
    flushing = false;
  }
}

if (recording) {
  fetch("/api/view", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ course, lesson }),
    keepalive: true,
  }).catch(() => {});
  window.addEventListener("online", flush);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
  flush(); // anything left over from an earlier visit, on any lesson
}
const shown = Date.now();

for (const q of document.querySelectorAll(".q[data-block]")) {
  const blockId = q.dataset.block;
  const why = q.dataset.why ?? "";
  const feedback = q.querySelector(".fb");
  const saved = q.querySelector(".saved");
  const buttons = [...q.querySelectorAll("button")];
  let settled = q.dataset.settled === "true"; // already answered correctly in this encounter

  for (const button of buttons) {
    const correct = button.dataset.correct === "true";
    button.addEventListener("click", () => {
      if (settled) return;
      for (const other of buttons) other.className = "";
      button.className = correct ? "ok" : "bad";
      if (feedback !== null) feedback.textContent = `${correct ? "Correct." : "Not quite."} ${why}`.trim();
      if (correct) settled = true;
      if (!recording) return;

      // Whether it was right, and whether it was a first try, is the server's to decide.
      const item = { submissionId: uuid(), encounterId, blockId, choiceId: button.dataset.choice, ms: Date.now() - shown };
      if (saved !== null) {
        statusFor.set(item.submissionId, saved);
        saved.textContent = "Saving…";
      }
      pending.push(item);
      writeOutbox(pending); // before the network, so a closed tab cannot lose it
      flush();
    });
  }
}
