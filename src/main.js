"use strict";

/* Rats, I Typed It All front end.
 *
 * The text pipeline lives here: cleanup, table conversion and indent
 * stripping all happen before anything is handed to Rust, so the backend
 * only ever receives a finished character sequence plus pacing options.
 */

const TAURI = window.__TAURI__ || null;
const invoke = TAURI ? TAURI.core.invoke : null;
const listen = TAURI ? TAURI.event.listen : null;

const $ = (id) => document.getElementById(id);

const el = {
  text: $("text"), count: $("count"), eta: $("eta"),
  paste: $("paste"), clear: $("clear"),
  tableMode: $("tableMode"), tableTarget: $("tableTarget"),
  tableFormat: $("tableFormat"), tableSummary: $("tableSummary"),
  cleanMarkdown: $("cleanMarkdown"),
  cleanDashes: $("cleanDashes"), cleanQuotes: $("cleanQuotes"),
  cleanEllipsis: $("cleanEllipsis"), cleanSpaces: $("cleanSpaces"),
  stripIndent: $("stripIndent"),
  cps: $("cps"), cpsOut: $("cpsOut"), burst: $("burst"), human: $("human"),
  newlineMode: $("newlineMode"), enterWarn: $("enterWarn"),
  tabMode: $("tabMode"), countdown: $("countdown"), focusGuard: $("focusGuard"),
  status: $("status"), progressWrap: $("progressWrap"), bar: $("bar"),
  progressText: $("progressText"), timer: $("timer"),
  start: $("start"), stop: $("stop"), a11yBanner: $("a11yBanner"),
  openA11y: $("openA11y"), recheckA11y: $("recheckA11y"), onTop: $("onTop"),
};

let running = false;
let tickHandle = null;
let lastElapsedMs = 0;

// ------------------------------------------------------------ text pipeline

const { processText: pipe, formatDuration } = window.TextPipe;

/** Gather current option state for the pure pipeline in textpipe.js. */
function options() {
  return {
    cleanMarkdown: el.cleanMarkdown.checked,
    cleanDashes: el.cleanDashes.checked,
    cleanQuotes: el.cleanQuotes.checked,
    cleanEllipsis: el.cleanEllipsis.checked,
    cleanSpaces: el.cleanSpaces.checked,
    stripIndent: el.stripIndent.checked,
    tableMode: el.tableMode.checked,
    tableTarget: el.tableTarget.value,
    tableFormat: el.tableFormat.value,
  };
}

function processText() {
  const r = pipe(el.text.value, options());
  if (r.table) {
    el.tableSummary.textContent = r.table.rows
      ? `${r.table.rows} rows x ${r.table.cols} columns, read as ${r.table.format.toUpperCase()}`
      : "No rows detected.";
  }
  return r.text;
}

// ------------------------------------------------------------ formatting

const fmtNum = (n) => n.toLocaleString();

function updateCount() {
  const out = processText();
  const n = out.length;
  el.count.textContent = `${fmtNum(n)} character${n === 1 ? "" : "s"}`;
  const cps = Number(el.cps.value);
  const chunk = el.burst.checked ? 80 : 1;
  const est = (n / cps) * (chunk > 1 ? 1 / chunk : 1);
  el.eta.textContent = n ? `about ${formatDuration(est * 1000)}` : "";
}

function setStatus(msg, kind) {
  el.status.textContent = msg;
  el.status.className = "status" + (kind ? " " + kind : "");
}

// ------------------------------------------------------------ run control

function showRunning(on) {
  running = on;
  el.start.classList.toggle("hidden", on);
  el.stop.classList.toggle("hidden", !on);
  el.progressWrap.classList.toggle("hidden", !on);
  if (!on && tickHandle) { clearInterval(tickHandle); tickHandle = null; }
}

function setProgress(typed, total, elapsedMs) {
  lastElapsedMs = elapsedMs;
  el.bar.style.width = total ? `${(100 * typed) / total}%` : "0%";
  el.progressText.textContent = `${fmtNum(typed)} / ${fmtNum(total)}`;
  el.timer.textContent = formatDuration(elapsedMs);
}

/** Show or hide the macOS Accessibility banner; returns true when granted. */
async function checkAccessibility() {
  if (!invoke) return true;
  let ok = true;
  try { ok = await invoke("accessibility_ok"); } catch { ok = true; }
  el.a11yBanner.classList.toggle("hidden", ok);
  return ok;
}

async function start() {
  const text = processText();
  if (!text) { setStatus("Nothing to type. Add some text first.", "err"); return; }
  if (!invoke) { setStatus("Typing is only available in the desktop app.", "err"); return; }
  if (!(await checkAccessibility())) {
    setStatus("Turn on Accessibility for this app first (see the note at the top).", "err");
    return;
  }

  const config = {
    text,
    cps: Number(el.cps.value),
    human: el.human.checked && !el.burst.checked,
    newlineMode: el.newlineMode.value,
    tabMode: el.tabMode.value,
    spacesPerTab: 4,
    countdownSecs: Number(el.countdown.value) || 5,
    stopOnFocusChange: el.focusGuard.checked,
    chunkSize: el.burst.checked ? 80 : 1,
  };

  try {
    await invoke("start_typing", { config });
    showRunning(true);
    setProgress(0, text.length, 0);
  } catch (e) {
    setStatus(String(e), "err");
  }
}

el.start.addEventListener("click", start);

el.stop.addEventListener("click", async () => {
  if (!invoke) return;
  setStatus("Stopping.", "err");
  try { await invoke("stop_typing"); } catch { /* nothing running */ }
});

// Float above other windows, or get out of the way, on demand.
el.onTop.addEventListener("change", async () => {
  if (!invoke) return;
  try { await invoke("set_on_top", { on: el.onTop.checked }); } catch { /* no-op */ }
});

// Take the user straight to the macOS Accessibility list (and pop the native
// system prompt, which also registers this app there).
if (el.openA11y) {
  el.openA11y.addEventListener("click", async () => {
    if (!invoke) return;
    try {
      const ok = await invoke("open_accessibility");
      el.a11yBanner.classList.toggle("hidden", ok);
      if (!ok) {
        setStatus("Turn on this app in the list that opened, then click “recheck”.", "ok");
      }
    } catch { /* opening settings is best effort */ }
  });
}

if (el.recheckA11y) {
  el.recheckA11y.addEventListener("click", async () => {
    const ok = await checkAccessibility();
    setStatus(ok ? "Accessibility is on. You’re ready." : "Still off. Quit and reopen the app after switching it on.", ok ? "ok" : "err");
  });
}

// ------------------------------------------------------------ backend events

if (listen) {
  listen("countdown", (e) => {
    const r = Math.max(0, e.payload.remaining);
    setStatus(`Click into your target now. Typing starts in ${r.toFixed(0)}s`, "ok");
  });

  listen("progress", (e) => {
    const p = e.payload;
    setStatus("Typing. Press Esc to stop.");
    setProgress(p.typed, p.total, p.elapsedMs);
    if (!tickHandle) {
      tickHandle = setInterval(() => {
        lastElapsedMs += 100;
        el.timer.textContent = formatDuration(lastElapsedMs);
      }, 100);
    }
  });

  listen("finished", (e) => {
    const f = e.payload;
    showRunning(false);
    if (f.error) {
      setStatus(`Could not type: ${f.error}`, "err");
    } else if (f.stopped) {
      setStatus(
        `${f.reason || "Stopped."} Typed ${fmtNum(f.typed)} of ${fmtNum(f.total)} characters in ${formatDuration(f.elapsedMs)}.`,
        "err"
      );
    } else {
      setStatus(
        `Done - typed ${fmtNum(f.typed)} characters in ${formatDuration(f.elapsedMs)}`,
        "ok"
      );
    }
  });
}

// ------------------------------------------------------------ UI wiring

el.paste.addEventListener("click", async () => {
  try {
    el.text.value += await navigator.clipboard.readText();
    updateCount();
  } catch {
    setStatus("Could not read the clipboard.", "err");
  }
});

el.clear.addEventListener("click", () => { el.text.value = ""; updateCount(); });

document.querySelectorAll(".collapsible").forEach((head) => {
  head.addEventListener("click", (ev) => {
    if (ev.target.tagName === "INPUT") return;
    const body = document.getElementById(head.dataset.target);
    if (body) body.classList.toggle("hidden");
  });
});

el.tableMode.addEventListener("change", () => {
  $("table-body").classList.toggle("hidden", !el.tableMode.checked);
  updateCount();
});

el.newlineMode.addEventListener("change", () => {
  el.enterWarn.classList.toggle("hidden", el.newlineMode.value !== "enter");
  updateCount();
});

el.burst.addEventListener("change", () => {
  el.human.disabled = el.burst.checked;
  updateCount();
});

el.cps.addEventListener("input", () => {
  el.cpsOut.textContent = `${el.cps.value} chars/sec`;
  updateCount();
});

["input", "change"].forEach((evt) => {
  el.text.addEventListener(evt, updateCount);
  [el.cleanMarkdown, el.cleanDashes, el.cleanQuotes, el.cleanEllipsis, el.cleanSpaces,
   el.stripIndent, el.tableTarget, el.tableFormat].forEach((n) =>
    n.addEventListener(evt, updateCount));
});

// ------------------------------------------------------------ presets

const { PRESETS, KEYS: PRESET_KEYS } = window.Presets;
const MY_PRESET = "rats.myPreset";

/** Current value of every preset-controlled setting. */
function readSettings() {
  const v = {};
  for (const k of PRESET_KEYS) {
    const n = $(k);
    v[k] = n.type === "checkbox" ? n.checked : n.type === "range" ? Number(n.value) : n.value;
  }
  return v;
}

/** Bring the parts of the page that depend on settings back in line. */
function syncDerived() {
  $("table-body").classList.toggle("hidden", !el.tableMode.checked);
  el.enterWarn.classList.toggle("hidden", el.newlineMode.value !== "enter");
  el.human.disabled = el.burst.checked;
  el.cpsOut.textContent = `${el.cps.value} chars/sec`;
}

function applySettings(values) {
  for (const k of PRESET_KEYS) {
    if (!(k in values)) continue;
    const n = $(k);
    if (n.type === "checkbox") n.checked = Boolean(values[k]);
    else n.value = String(values[k]);
  }
  syncDerived();
  updateCount();
  renderPresets();
}

// The saved preset lives in this computer's browser storage, which can be
// missing or blocked; the app works the same without it.
function loadMyPreset() {
  try {
    const raw = localStorage.getItem(MY_PRESET);
    return raw ? Object.assign({}, window.Presets.BASE, JSON.parse(raw)) : null;
  } catch { return null; }
}

function allPresets() {
  const mine = loadMyPreset();
  return mine
    ? [...PRESETS, { id: "mine", label: "My preset", hint: "Your saved settings.", values: mine }]
    : PRESETS;
}

/** Chips for every preset, with the one matching the current settings lit. */
function renderPresets() {
  const now = readSettings();
  const list = allPresets();
  const active = list.find((p) => PRESET_KEYS.every((k) => p.values[k] === now[k]));
  const box = $("presets");
  box.replaceChildren(...list.map((p) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (p === active ? " active" : "");
    b.textContent = p.label;
    b.setAttribute("aria-pressed", String(p === active));
    b.addEventListener("click", () => applySettings(p.values));
    return b;
  }));
  $("presetState").textContent = active ? active.label : "Custom";
  $("presetHint").textContent = active
    ? active.hint
    : "Your own mix of settings. Save it to come back to it in one click.";
}

// Any hand-made change re-checks which preset, if any, still matches.
["input", "change"].forEach((evt) =>
  document.addEventListener(evt, (e) => {
    if (PRESET_KEYS.includes(e.target.id)) renderPresets();
  }));

$("savePreset").addEventListener("click", () => {
  try {
    localStorage.setItem(MY_PRESET, JSON.stringify(readSettings()));
    setStatus("Saved. Click My preset any time to get these settings back.", "ok");
  } catch {
    setStatus("Could not save on this computer.", "err");
  }
  renderPresets();
});

// WebKit can restore form controls from a previous launch. That once left
// table mode silently ticked, which turns every comma in ordinary prose
// into a Tab. Always start from the defaults written in the HTML.
document.querySelectorAll("input, select, textarea").forEach((n) => {
  if (n.type === "checkbox") n.checked = n.defaultChecked;
  else if (n.tagName === "SELECT") {
    const i = [...n.options].findIndex((o) => o.defaultSelected);
    n.selectedIndex = i < 0 ? 0 : i;
  } else n.value = n.defaultValue;
});
syncDerived();
updateCount();
renderPresets();
checkAccessibility();
// Match the window's float state to the checkbox default on launch.
if (invoke) { invoke("set_on_top", { on: el.onTop.checked }).catch(() => {}); }
