// The settings page: connect the bridge, see whether it answers, and edit its agents.
// Nothing here holds the token after it is sent; the server keeps it and never returns it,
// except once, right after "Generate a token", so the bridge can be started with it.
{
  const $ = (s, root = document) => root.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "text") n.textContent = v;
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v !== undefined) n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };
  const send = async (path, body) => {
    const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  };

  const STATUS = {
    none: "Not connected. Enter the bridge's address and token below.",
    unreachable: "The bridge isn't answering at that address. Is it running?",
    unauthorised: "The bridge refused the token. Use the token the bridge was started with.",
    unconfigured: "Connected. The bridge has no agents yet; add one below.",
    misconfigured: "Connected, but the bridge's configuration has a problem.",
    ok: "Connected.",
  };
  async function refreshStatus() {
    const box = $("#bridge-status");
    const { data } = await send("/api/settings/status");
    box.dataset.state = data.connection;
    box.replaceChildren(el("strong", { text: STATUS[data.connection] ?? "Unknown." }));
    if (data.connection === "ok") {
      const on = (data.agents ?? []).filter((a) => a.enabled);
      const ready = on.filter((a) => a.found).length;
      box.append(" ", el("span", { class: "hint", text: `${ready} of ${on.length} enabled agent${on.length === 1 ? "" : "s"} ready.` }));
    }
    if (data.config) box.append(el("br"), el("span", { class: "hint", text: `Agents are saved in ${data.config}` }));
    if (data.error) box.append(" ", el("span", { class: "hint", text: data.error }));
    if (data.connection === "ok" || data.connection === "unconfigured") loadAgents(data.agents ?? []);
    else $("#agents").replaceChildren(el("p", { class: "hint", text: "Connect the bridge to edit its agents." }));
  }

  // Connection form.
  const form = $("#bridge-form");
  const msg = (text, bad = false) => { const m = $(".form-msg", form); m.textContent = text; m.dataset.bad = bad ? "true" : "false"; };
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {};
    const url = form.elements.url, token = form.elements.token;
    if (!url.disabled) body.url = url.value.trim();
    if (!token.disabled && token.value !== "") body.token = token.value;
    const r = await send("/api/settings/bridge", body);
    if (!r.ok) return msg(r.data.error ?? "That could not be saved.", true);
    token.value = "";
    if (r.data.tokenSet) { $("#token-state").textContent = "A token is saved. Type a new one to replace it."; token.placeholder = "\u2022".repeat(8); }
    msg("Saved.");
    refreshStatus();
  });
  form.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="generate"]') === null) return;
    const url = form.elements.url;
    const r = await send("/api/settings/bridge", { generate: true, ...(url.disabled ? {} : { url: url.value.trim() || "http://127.0.0.1:4748" }) });
    if (!r.ok) return msg(r.data.error ?? "No token was generated.", true);
    if (!url.disabled && url.value.trim() === "") url.value = "http://127.0.0.1:4748";
    $("#token-state").textContent = "A token is saved. Type a new one to replace it.";
    form.elements.token.placeholder = "\u2022".repeat(8);
    const box = $("#start-command");
    $("code", box).textContent = `SCHOOL_BRIDGE_TOKEN=${r.data.generated} bun bridge/bridge.ts`;
    box.hidden = false;
    msg("Token generated and saved. Start the bridge with it, from the School folder.");
    refreshStatus();
  });
  $("#start-command").addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="copy"]') === null) return;
    try { await navigator.clipboard.writeText($("#start-command code").textContent); e.target.textContent = "Copied"; } catch { e.target.textContent = "Select and copy it"; }
  });

  // Agent editor.
  let found = new Map();
  function agentRow(a) {
    const row = el("li", { class: "agent" });
    const id = `a${Math.random().toString(36).slice(2, 8)}`;
    const state = found.has(a.name) ? (found.get(a.name) ? ["found", "Program found"] : ["missing", "Program not found"]) : ["new", "Not saved yet"];
    row.append(
      el("div", { class: "agent-head" },
        el("input", { class: "agent-name", "aria-label": "Agent name", value: a.name ?? "", placeholder: "name" }),
        el("span", { class: `badge b-${state[0]}`, text: state[1] }),
        el("label", { class: "switch" }, el("input", { type: "checkbox", class: "agent-enabled", checked: a.enabled !== false }), " On")),
      el("label", { class: "field", for: id }, el("span", { class: "field-label", text: "Command" })),
      el("textarea", { id, class: "agent-command mono", rows: "2", spellcheck: "false", placeholder: "claude -p {prompt}" }),
      el("div", { class: "agent-opts" },
        el("label", {}, "Output ", (() => {
          const s = el("select", { class: "agent-output" });
          for (const [v, t] of [["text", "plain text"], ["claude-json", "claude --output-format json"]]) s.append(el("option", { value: v, selected: (a.output ?? "text") === v, text: t }));
          return s;
        })()),
        el("label", {}, "Timeout ", el("input", { type: "number", class: "agent-timeout", min: "1", max: "900", value: a.timeout_seconds ?? "", placeholder: "default", "aria-label": "Timeout in seconds, blank for the default" }), " s")),
      el("div", { class: "actions" },
        el("button", { type: "button", class: "secondary", "data-act": "up", "aria-label": "Move up", text: "↑" }),
        el("button", { type: "button", class: "secondary", "data-act": "down", "aria-label": "Move down", text: "↓" }),
        el("button", { type: "button", class: "secondary", "data-act": "test", text: "Test" }),
        el("button", { type: "button", class: "secondary danger", "data-act": "remove", text: "Remove" })),
      el("p", { class: "agent-msg hint", role: "status", "aria-live": "polite" }));
    $(".agent-command", row).value = a.command ?? "";
    return row;
  }
  function collect() {
    const agents = [...document.querySelectorAll("#agent-list .agent")].map((r) => {
      const a = { name: $(".agent-name", r).value.trim(), command: $(".agent-command", r).value.trim(), output: $(".agent-output", r).value };
      if (!$(".agent-enabled", r).checked) a.enabled = false;
      const t = $(".agent-timeout", r).value;
      if (t !== "") a.timeout_seconds = Number(t);
      return a;
    });
    const t = $("#chain-timeout").value;
    return { ...(t === "" ? {} : { timeout_seconds: Number(t) }), agents };
  }
  async function loadAgents(health) {
    found = new Map(health.map((a) => [a.name, a.found]));
    const { ok, data } = await send("/api/settings/agents");
    const box = $("#agents");
    if (!ok) return box.replaceChildren(el("p", { class: "hint", text: data.error ?? "The agents could not be read." }));
    const raw = data.raw ?? { agents: [] };
    const list = el("ol", { id: "agent-list", class: "agents" }, ...raw.agents.map(agentRow));
    box.replaceChildren(list,
      el("div", { class: "actions" },
        el("button", { type: "button", class: "secondary", "data-act": "add", text: "Add an agent" }),
        el("label", { class: "inline" }, "Default timeout ", el("input", { id: "chain-timeout", type: "number", min: "1", max: "900", value: raw.timeout_seconds ?? 180 }), " s"),
        el("button", { type: "button", "data-act": "save", text: "Save agents" })),
      el("p", { id: "agents-msg", class: "form-msg", role: "status", "aria-live": "polite" }));
  }
  $("#agents").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const row = b.closest(".agent");
    const say = (text, bad = false) => { const m = $("#agents-msg"); m.textContent = text; m.dataset.bad = bad ? "true" : "false"; };
    switch (b.dataset.act) {
      case "add": $("#agent-list").append(agentRow({ name: "", command: "", output: "text" })); $("#agent-list .agent:last-child .agent-name").focus(); break;
      case "remove": row.remove(); say("Removed. Save agents to keep this."); break;
      case "up": if (row.previousElementSibling) row.previousElementSibling.before(row); break;
      case "down": if (row.nextElementSibling) row.nextElementSibling.after(row); break;
      case "save": {
        b.disabled = true;
        const r = await send("/api/settings/agents", collect());
        b.disabled = false;
        if (!r.ok) return say(r.data.error ?? "The agents could not be saved.", true);
        say("Saved. The bridge uses these from its next run.");
        refreshStatus();
        break;
      }
      case "test": {
        const m = $(".agent-msg", row);
        const name = $(".agent-name", row).value.trim();
        if (!found.has(name)) { m.textContent = "Save agents first, then test."; return; }
        b.disabled = true;
        m.textContent = "Testing… this runs the agent for real.";
        const r = await send("/api/settings/agents/test", { agent: name });
        b.disabled = false;
        const a = (r.data.attempts ?? [])[0];
        m.textContent = r.data.status === "succeeded" ? `Works (${Math.round((a?.ms ?? 0) / 100) / 10} s).`
          : `Did not work: ${a?.error ?? r.data.error ?? "unknown"}${a?.stderr ? ` — ${a.stderr.trim().split("\n").at(-1)}` : ""}`;
        break;
      }
    }
  });

  refreshStatus();
}
