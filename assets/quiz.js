// Drives the quiz markup that render.ts emits: <div class="q" data-block data-why> with
// <button data-correct>. Opened as a file:// page it still works, it just records nothing.
//
// This file previously expected `.quiz[data-quiz]` with a JSON attribute, which the block
// renderer never produced — so every quiz was inert: no feedback, nothing recorded.
const meta = document.getElementById("school-meta");
const course = meta?.dataset.course ?? null;
const lesson = meta?.dataset.lesson ?? null;
const recording = course !== null && lesson !== null && location.protocol !== "file:";

const send = (path, body) => {
  if (!recording) return;
  fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ course, lesson, ...body }),
    keepalive: true,
  }).catch(() => {});
};

send("/api/view", {});
const shown = Date.now();

for (const q of document.querySelectorAll(".q[data-block]")) {
  const blockId = q.dataset.block;
  const why = q.dataset.why ?? "";
  const feedback = q.querySelector(".fb");
  const buttons = [...q.querySelectorAll("button")];
  let tries = 0;
  let settled = false;

  for (const button of buttons) {
    const correct = button.dataset.correct === "true";
    button.addEventListener("click", () => {
      if (settled) return;
      for (const other of buttons) other.className = "";
      button.className = correct ? "ok" : "bad";
      if (feedback !== null) feedback.textContent = `${correct ? "Correct." : "Not quite."} ${why}`.trim();

      // firstTry is this browser's view of it. The server decides authoritatively; see the
      // learning record contract in docs/rfc/0001-school.md.
      send("/api/answer", {
        blockId,
        choice: button.textContent ?? "",
        correct,
        firstTry: tries === 0,
        ms: Date.now() - shown,
      });
      tries += 1;
      if (correct) settled = true;
    });
  }
}
