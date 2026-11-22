// Drives explain blocks (render.ts renderExplain). The server is the record: after a save or a
// grading it returns the block's markup, rendered from the database, and this swaps it in, so a
// reload and a live update always look the same. The only thing kept in the browser is an unsent
// draft, so typing is not lost to a closed tab; it is cleared once the server has the text.
{
  const meta = document.getElementById("school-meta");
  const encounterId = meta?.dataset.encounter ?? null;
  const shown = Date.now();

  const uuid = () => {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  const draftKey = (block) => `school.draft.${encounterId}.${block.dataset.block}`;
  const store = (fn) => { try { return fn(localStorage); } catch { return null; } };

  const post = async (path, body) => {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  };
  const replace = (block, html) => {
    const t = document.createElement("template");
    t.innerHTML = html;
    const next = t.content.firstElementChild;
    if (next) block.replaceWith(next);
    return next;
  };
  const say = (block, text) => {
    const el = block.querySelector(".saved");
    if (el) el.textContent = text;
  };

  async function grade(block, submissionId) {
    for (const b of block.querySelectorAll("button")) b.disabled = true;
    say(block, "Getting feedback. This can take up to a minute.");
    try {
      const r = await post("/api/grade", { submissionId });
      if (r.data.html) replace(block, r.data.html);
      else say(block, "Your explanation is saved. Feedback could not be fetched; reload and retry.");
    } catch {
      say(block, "Your explanation is saved. Feedback could not be fetched; reload and retry.");
      for (const b of block.querySelectorAll("button")) b.disabled = false;
    }
  }

  async function submit(block) {
    const box = block.querySelector("textarea");
    const text = (box?.value ?? "").trim();
    if (text === "") { say(block, "Write something first."); return; }
    // One id per attempt, kept across retries of the same text, so a resend is never a second explanation.
    if (block.dataset.pending === undefined || block.dataset.pendingText !== text) {
      block.dataset.pending = uuid();
      block.dataset.pendingText = text;
    }
    const button = block.querySelector('[data-act="submit"]');
    if (button) button.disabled = true;
    say(block, "Saving…");
    try {
      const r = await post("/api/explanation", { submissionId: block.dataset.pending, encounterId, blockId: block.dataset.block, text, ms: Date.now() - shown });
      if (!r.ok) {
        say(block, r.status === 409 ? "That was already saved differently. Reload the lesson." : "This could not be saved. Reload the lesson.");
        if (button) button.disabled = false;
        return;
      }
      store((s) => s.removeItem(draftKey(block)));
      const next = replace(block, r.data.html);
      if (next) await grade(next, r.data.submissionId);
    } catch {
      say(block, "Not saved yet. Check the connection and tap Submit again.");
      if (button) button.disabled = false;
    }
  }

  if (encounterId !== null && location.protocol !== "file:") {
    for (const block of document.querySelectorAll(".explain[data-block]")) {
      const box = block.querySelector("textarea");
      const draft = store((s) => s.getItem(draftKey(block)));
      if (box && draft) box.value = draft;
    }
    document.addEventListener("input", (e) => {
      const box = e.target.closest?.(".explain textarea");
      const block = box?.closest(".explain");
      if (block) store((s) => s.setItem(draftKey(block), box.value));
    });
    document.addEventListener("click", (e) => {
      const button = e.target.closest?.(".explain button[data-act]");
      const block = button?.closest(".explain");
      if (!block) return;
      const act = button.dataset.act;
      if (act === "submit") submit(block);
      else if (act === "grade") grade(block, button.dataset.submission);
      else if (act === "again") {
        const form = block.querySelector("template");
        if (!form) return;
        const fresh = block.cloneNode(false);
        fresh.removeAttribute("data-submission");
        fresh.append(block.querySelector(":scope > p").cloneNode(true), form.content.cloneNode(true));
        block.replaceWith(fresh);
        fresh.querySelector("textarea")?.focus();
      }
    });
  }
}
