"use strict";

const POLL_MS = 1000;
const NAMES = ["ana.k", "marco.vela", "priya_s", "tomasz.w", "lea.moreau", "jun.hara", "ines.oduya", "felix_b"];
const STEP_NAMES = ["Reply to comment", "Ask for email", "Send link"];
const USERNAME = /^[a-z0-9._]{1,30}$/;

const $ = (id) => document.getElementById(id);
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: keep it in memory only */ }
  },
};

const ui = {
  sandbox: store.get("playground.sandbox") || newSandboxId(),
  username: store.get("playground.user") || pick(NAMES),
  post: "post-1",
  state: null,
  clockOffset: 0,
  formVersion: null,
  formDirty: false,
  deliveries: [],
  seen: new Set(),
  rendered: {},
  timer: null,
};
store.set("playground.sandbox", ui.sandbox);

function newSandboxId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function pick(list, not) {
  const options = list.filter((x) => x !== not);
  return options[Math.floor(Math.random() * options.length)];
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Marks an element as new the first time its id is rendered, so only arrivals animate. */
function fresh(id) {
  if (ui.seen.has(id)) return "";
  ui.seen.add(id);
  return " is-new";
}

async function api(path, options = {}) {
  const res = await fetch(`/demo/${ui.sandbox}${path}`, {
    method: options.method || "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = res.status === 429 ? "Too many requests from your address, wait a minute." : data.message || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data;
}

/* Polling */

async function poll() {
  clearTimeout(ui.timer);
  try {
    const state = await api("/state");
    ui.state = state;
    ui.clockOffset = new Date(state.serverTime).getTime() - Date.now();
    render();
  } catch (error) {
    $("armed").textContent = `Could not load state: ${error.message}`;
  }
  if (document.visibilityState === "visible") ui.timer = setTimeout(poll, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") poll();
  else clearTimeout(ui.timer);
});

/* Rendering */

function person() {
  return ui.state?.people.find((p) => p.username === ui.username) || { username: ui.username, timeline: [], runs: [] };
}

/** Rewrites a region only when its data changed, so focus, scroll and animations survive polling. */
function paint(id, key, html) {
  if (ui.rendered[id] === key) return false;
  ui.rendered[id] = key;
  $(id).innerHTML = html;
  return true;
}

function render() {
  const state = ui.state;
  if (!state) return;
  renderHeaderBits();
  renderComments();
  renderMessages();
  renderRuns();
  renderCalls();
  renderArmed();
  renderPeople();
  fillForm();
  tick();
}

function renderHeaderBits() {
  $("username").value !== ui.username && document.activeElement !== $("username") && ($("username").value = ui.username);
  $("thread-with").textContent = `talking to @${ui.username}`;
  $("hood-user").textContent = `@${ui.username}`;
  const keyword = ui.state.automation.form.keywords[0] || "pricing";
  $("post-caption-text").innerHTML = `Spring course is open. Comment <b>${esc(keyword)}</b> and we'll DM you the details.`;
  $("editor-version").textContent = `v${ui.state.automation.version}`;
}

function outboundMeta(item) {
  if (item.status === "failed") return `<span class="tag tag-err">failed after ${item.attempts}</span>`;
  if (item.status === "pending") {
    const tries = item.attempts > 0 ? `retrying, ${item.attempts} failed` : "sending";
    return `<span class="tag tag-live"><span class="dot"></span>${tries}</span>`;
  }
  return item.attempts > 1 ? `<span class="tag">sent on try ${item.attempts}</span>` : "";
}

function renderComments() {
  const people = ui.state.people;
  const comments = people
    .flatMap((p) => p.timeline.filter((t) => t.kind === "comment" && t.postId === ui.post).map((t) => ({ ...t, user: p.username, person: p })))
    .sort((a, b) => a.at.localeCompare(b.at));
  const html = comments
    .map((c) => {
      const replies = c.person.timeline.filter((t) => t.kind === "comment_reply" && t.commentId === c.commentId);
      return `<li class="comment${fresh(c.id)}">
        <div><p class="comment-line"><b>${esc(c.user)}</b>${esc(c.text)}</p><span class="comment-meta mono">${clock(c.at)}</span></div>
        ${replies
          .map(
            (r) => `<div class="comment-reply${fresh(r.id)}">
              <p class="comment-line"><b>ottoline.studio</b>${esc(r.text)}</p>
              <span class="comment-meta">${outboundMeta(r) || `<span class="mono">${clock(r.at)}</span>`}</span>
            </div>`,
          )
          .join("")}
      </li>`;
    })
    .join("");
  if (paint("comments", ui.post + html.replace(/ is-new/g, ""), html)) $("comments").scrollTop = $("comments").scrollHeight;
}

function renderMessages() {
  const items = person().timeline.filter((t) => t.kind === "dm_in" || t.kind === "dm_out");
  const html = items
    .map((m) => {
      if (m.kind === "dm_in") {
        const sticker = m.attachments.length > 0;
        const note = !m.runId ? "not routed: no open conversation" : m.consumed ? "read as an answer" : "routed to the run";
        return `<li class="msg msg-in${fresh(m.id)}">
          <div class="msg-bubble${sticker && !m.text ? " has-sticker" : ""}">${sticker ? `<span class="sticker" role="img" aria-label="Sticker">sticker</span>` : ""}${esc(m.text)}</div>
          <span class="msg-meta"><span class="mono">${clock(m.at)}</span><span>${note}</span></span>
        </li>`;
      }
      const state = m.status === "failed" ? " msg-failed" : m.status === "pending" ? " msg-pending" : "";
      const mode = m.mode === "private_reply" ? "private reply to the comment" : "DM by user id";
      return `<li class="msg msg-out${state}${fresh(m.id)}">
        <div class="msg-bubble">${linkify(m.text)}</div>
        <span class="msg-meta"><span class="mono">${clock(m.at)}</span><span>${mode}</span>${outboundMeta(m)}</span>
      </li>`;
    })
    .join("");
  if (paint("messages", ui.username + html.replace(/ is-new/g, ""), html)) $("messages").scrollTop = $("messages").scrollHeight;
}

function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

const STATUS = {
  running: ["tag-live", "running"],
  waiting: ["tag-live", "waiting for a reply"],
  queued: ["tag-queued", "queued"],
  completed: ["tag-ok", "completed"],
  failed: ["tag-err", "failed"],
  timed_out: ["tag-err", "timed out"],
};

function renderRuns() {
  const rank = (r) => (r.status === "running" || r.status === "waiting" ? 0 : r.status === "queued" ? 1 : 2);
  const runs = [...person().runs].sort(
    (a, b) => rank(a) - rank(b) || (rank(a) === 1 ? a.queuePosition - b.queuePosition : b.createdAt.localeCompare(a.createdAt)),
  );
  const html = runs
    .map((r) => {
      const [tone, label] = STATUS[r.status] || ["", r.status];
      const live = r.status === "running" || r.status === "waiting";
      const queued = r.status === "queued" ? ` #${r.queuePosition}` : "";
      const outcome = r.outcome ? ` · ${r.outcome}` : "";
      const steps = Array.from({ length: r.stepCount }, (_, i) => {
        let cls = "";
        if (i < r.currentStep) cls = "done";
        else if (i === r.currentStep && live) cls = "current";
        else if (i === r.currentStep && (r.status === "failed" || r.status === "timed_out")) cls = "broken";
        else if (i === r.currentStep && r.status === "completed") cls = "stopped";
        return `<li class="step ${cls}">${STEP_NAMES[i] || `Step ${i + 1}`}</li>`;
      }).join("");
      const waiting =
        r.status === "waiting" && r.waitDeadline
          ? `<div class="countdown" data-deadline="${r.waitDeadline}" data-from="${r.updatedAt}">
               <span class="countdown-text mono"></span>
               <div class="bar" aria-hidden="true"><span></span></div>
             </div>`
          : "";
      const note =
        r.status === "queued" && r.queuePosition === 1
          ? `<p class="run-note">Starts when this person's live run ends, so a DM reply always has exactly one owner.</p>`
          : r.vars?.email
            ? `<p class="run-note">Collected <span class="mono">${esc(r.vars.email)}</span></p>`
            : "";
      return `<li class="run${fresh(r.id)}">
        <div class="run-head">
          <span class="tag ${tone}">${live ? '<span class="dot"></span>' : ""}${label}${queued}${esc(outcome)}</span>
          <span class="run-id mono">${esc(r.postId || "post")} · v${r.version}</span>
          <a class="grow" href="/runs/${r.id}" target="_blank" rel="noopener">JSON</a>
        </div>
        <ol class="steps" aria-label="Steps">${steps}</ol>
        ${waiting}
        ${r.lastError ? `<p class="run-error">${esc(r.lastError)}</p>` : ""}
        ${note}
      </li>`;
    })
    .join("");
  paint("runs", ui.username + html.replace(/ is-new/g, ""), html);
}

function renderCalls() {
  const calls = person()
    .timeline.filter((t) => t.kind === "comment_reply" || t.kind === "dm_out")
    .slice()
    .reverse();
  const html = calls
    .map((c) => {
      const what = c.kind === "comment_reply" ? "Comment reply" : `DM, step ${c.stepIndex + 1}`;
      const mode = c.kind === "comment_reply" ? "public" : c.mode === "private_reply" ? "private reply" : "user id";
      const tone = c.status === "sent" ? "tag-ok" : c.status === "failed" ? "tag-err" : "tag-live";
      const log = (c.attemptLog || [])
        .map((a) => `try ${a.attempt}: ${a.kind}${a.retryInMs != null ? `, retry in ${a.retryInMs} ms` : ", gave up"}`)
        .join("<br>");
      return `<tr>
        <td>${what}<span class="call-text" title="${esc(c.text)}">${esc(c.text)}</span>${log ? `<span class="attempt-log">${log}</span>` : ""}</td>
        <td>${mode}</td>
        <td><span class="tag ${tone}">${c.status}</span></td>
        <td class="mono">${c.attempts}</td>
      </tr>`;
    })
    .join("");
  paint("calls", ui.username + html, html);
}

function renderArmed() {
  const { faultsArmed, faultsSupported } = ui.state;
  const el = $("armed");
  for (const id of ["x-transient", "x-permanent"]) $(id).disabled = !faultsSupported;
  if (!faultsSupported) {
    el.textContent = "Fault injection needs the API and the worker in one process.";
    el.classList.remove("is-armed");
    return;
  }
  el.classList.toggle("is-armed", faultsArmed.length > 0);
  el.textContent = faultsArmed.length
    ? `Armed: the next ${faultsArmed.length === 1 ? "send fails" : `${faultsArmed.length} sends fail`} (${faultsArmed.join(", ")}). Post a comment to see it.`
    : "No failures armed. Sends go through.";
}

function renderPeople() {
  const others = ui.state.people.map((p) => p.username).filter((u) => u !== ui.username);
  $("people-block").hidden = others.length === 0;
  paint(
    "people",
    others.join(),
    others.map((u) => `<button type="button" class="chip" data-user="${esc(u)}">@${esc(u)}</button>`).join(""),
  );
}

function fillForm() {
  const { version, form } = ui.state.automation;
  if (ui.formDirty || ui.formVersion === version) return;
  ui.formVersion = version;
  $("f-keywords").value = form.keywords.join(", ");
  $("f-reply").value = form.replyText;
  $("f-prompt").value = form.prompt;
  $("f-final").value = form.finalText;
  $("f-timeout").value = form.timeoutSeconds;
}

/** Countdowns move every second without re-rendering the run cards. */
function tick() {
  const now = Date.now() + ui.clockOffset;
  for (const el of document.querySelectorAll("[data-deadline]")) {
    const deadline = new Date(el.dataset.deadline).getTime();
    const from = new Date(el.dataset.from).getTime();
    const left = Math.max(0, deadline - now);
    const s = Math.ceil(left / 1000);
    el.querySelector(".countdown-text").textContent =
      left > 0 ? `times out in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "deadline reached, closing";
    const share = deadline > from ? left / (deadline - from) : 0;
    el.querySelector(".bar > span").style.transform = `scaleX(${share.toFixed(3)})`;
  }
}
setInterval(tick, 1000);

/* Actions */

function logDelivery(label, deliveries) {
  const stored = deliveries.filter((d) => d.statusCode === 200 && d.duplicate === false).length;
  const dup = deliveries.filter((d) => d.duplicate).length;
  const failed = deliveries.filter((d) => d.statusCode !== 200).length;
  const parts = [`${stored} stored`];
  if (dup) parts.push(`${dup} acked as duplicate`);
  if (failed) parts.push(`${failed} rejected`);
  const id = `d-${Date.now()}-${Math.random()}`;
  ui.deliveries.unshift({ id, text: `${new Date().toLocaleTimeString()}  ${label}  ${deliveries.length > 1 ? `x${deliveries.length} ` : ""}200 -> ${parts.join(", ")}` });
  ui.deliveries = ui.deliveries.slice(0, 8);
  $("deliveries").innerHTML = ui.deliveries.map((d) => `<li class="${fresh(d.id).trim()}">${esc(d.text)}</li>`).join("");
}

async function busy(button, fn, errorEl) {
  if (errorEl) errorEl.textContent = "";
  if (button) button.disabled = true;
  try {
    await fn();
    await poll();
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message;
  } finally {
    if (button) button.disabled = false;
  }
}

function setUser(name) {
  ui.username = name;
  store.set("playground.user", name);
  $("username").value = name;
  $("username").removeAttribute("aria-invalid");
  render();
}

async function comment(text, postId, copies = 1) {
  const res = await api("/comment", { method: "POST", body: { username: ui.username, text, postId, copies } });
  logDelivery(`comment "${text}" on ${postId}`, res.deliveries);
}

async function message(text, attachments = []) {
  const res = await api("/message", { method: "POST", body: { username: ui.username, text, attachments } });
  logDelivery(attachments.length ? "DM sticker" : `DM "${text}"`, res.deliveries);
}

$("username").addEventListener("change", (e) => {
  const value = e.target.value.trim().toLowerCase().replace(/^@/, "");
  if (!USERNAME.test(value)) {
    e.target.setAttribute("aria-invalid", "true");
    $("comment-error").textContent = "Use letters, digits, dots and underscores, up to 30 characters.";
    return;
  }
  $("comment-error").textContent = "";
  setUser(value);
});

$("switch-user").addEventListener("click", () => setUser(pick(NAMES, ui.username)));

$("comment-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("comment-text").value.trim();
  if (!text) return;
  busy(e.submitter, () => comment(text, ui.post), $("comment-error"));
});

for (const tab of document.querySelectorAll("[data-post]")) {
  tab.addEventListener("click", () => {
    ui.post = tab.dataset.post;
    for (const t of document.querySelectorAll("[data-post]")) t.setAttribute("aria-selected", String(t === tab));
    document.querySelector("[data-post-art]").dataset.postArt = ui.post;
    render();
  });
}

$("dm-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("dm-text").value.trim();
  if (!text) return;
  busy(e.submitter, async () => {
    await message(text);
    $("dm-text").value = "";
  }, $("dm-error"));
});

$("send-sticker").addEventListener("click", (e) => busy(e.currentTarget, () => message("", [{ type: "sticker" }]), $("dm-error")));

for (const chip of document.querySelectorAll("[data-reply]")) {
  chip.addEventListener("click", () => busy(chip, () => message(chip.dataset.reply), $("dm-error")));
}

$("people").addEventListener("click", (e) => {
  const user = e.target.closest("[data-user]")?.dataset.user;
  if (user) setUser(user);
});

const chaos = (id, fn) => $(id).addEventListener("click", (e) => busy(e.currentTarget, fn, $("chaos-error")));
chaos("x-dup", () => comment($("comment-text").value.trim() || "pricing", ui.post, 3));
chaos("x-transient", () => api("/faults", { method: "POST", body: { transient: 2 } }));
chaos("x-permanent", () => api("/faults", { method: "POST", body: { permanent: true } }));
chaos("x-two-posts", () => Promise.all([comment("pricing", "post-1"), comment("pricing", "post-2")]));

const formFields = ["f-keywords", "f-reply", "f-prompt", "f-final", "f-timeout"];
for (const id of formFields) $(id).addEventListener("input", () => (ui.formDirty = true));

$("automation-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const status = $("automation-status");
  const body = {
    keywords: $("f-keywords").value.split(",").map((k) => k.trim()).filter(Boolean),
    replyText: $("f-reply").value.trim(),
    prompt: $("f-prompt").value.trim(),
    finalText: $("f-final").value.trim(),
    timeoutSeconds: Number($("f-timeout").value),
  };
  busy(e.submitter, async () => {
    status.textContent = "Saving";
    try {
      const saved = await api("/automation", { method: "PUT", body });
      ui.formDirty = false;
      ui.formVersion = null;
      status.textContent = `Saved as v${saved.version}. New comments use it.`;
    } catch (error) {
      status.textContent = error.message;
    }
  });
});

$("new-sandbox").addEventListener("click", () => {
  ui.sandbox = newSandboxId();
  store.set("playground.sandbox", ui.sandbox);
  ui.deliveries = [];
  ui.rendered = {};
  ui.formVersion = null;
  ui.formDirty = false;
  $("deliveries").innerHTML = "";
  poll();
});

setUser(ui.username);
poll();
