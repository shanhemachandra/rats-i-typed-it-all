"use strict";

/* Shans Typer front end.
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
  cleanDashes: $("cleanDashes"), cleanQuotes: $("cleanQuotes"),
  cleanEllipsis: $("cleanEllipsis"), cleanSpaces: $("cleanSpaces"),
  stripIndent: $("stripIndent"),
  cps: $("cps"), cpsOut: $("cpsOut"), burst: $("burst"), human: $("human"),
  newlineMode: $("newlineMode"), enterWarn: $("enterWarn"),
  tabMode: $("tabMode"), countdown: $("countdown"), focusGuard: $("focusGuard"),
  status: $("status"), progressWrap: $("progressWrap"), bar: $("bar"),
  progressText: $("progressText"), timer: $("timer"),
  start: $("start"), pause: $("pause"), cancel: $("cancel"),
};

let running = false;
let paused = false;
let tickHandle = null;
let lastElapsedMs = 0;

// ------------------------------------------------------------ text pipeline

const { processText: pipe, formatDuration } = window.TextPipe;

/** Gather current option state for the pure pipeline in textpipe.js. */
function options() {
  return {
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
  el.pause.classList.toggle("hidden", !on);
  el.cancel.classList.toggle("hidden", !on);
  el.progressWrap.classList.toggle("hidden", !on);
  if (!on) {
    paused = false;
    el.pause.textContent = "Pause";
    if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
  }
}

function setProgress(typed, total, elapsedMs) {
  lastElapsedMs = elapsedMs;
  el.bar.style.width = total ? `${(100 * typed) / total}%` : "0%";
  el.progressText.textContent = `${fmtNum(typed)} / ${fmtNum(total)}`;
  el.timer.textContent = formatDuration(elapsedMs);
}

async function start() {
  const text = processText();
  if (!text) { setStatus("Nothing to type. Add some text first.", "err"); return; }
  if (!invoke) { setStatus("Typing is only available in the desktop app.", "err"); return; }

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
    // Keep the clock moving between progress events.
    tickHandle = setInterval(() => {
      if (!paused) {
        lastElapsedMs += 100;
        el.timer.textContent = formatDuration(lastElapsedMs);
      }
    }, 100);
  } catch (e) {
    setStatus(String(e), "err");
  }
}

el.start.addEventListener("click", start);

el.pause.addEventListener("click", async () => {
  if (!invoke) return;
  paused = !paused;
  await invoke(paused ? "pause_typing" : "resume_typing");
  el.pause.textContent = paused ? "Resume" : "Pause";
  setStatus(paused ? "Paused." : "Typing.");
});

el.cancel.addEventListener("click", async () => {
  if (invoke) await invoke("cancel_typing");
});

// ------------------------------------------------------------ backend events

if (listen) {
  listen("countdown", (e) => {
    const r = Math.max(0, e.payload.remaining);
    setStatus(`Click into your target now. Typing starts in ${r.toFixed(0)}s`, "ok");
  });

  listen("progress", (e) => {
    const p = e.payload;
    if (!paused) setStatus("Typing. Press Escape or Cancel to stop.");
    setProgress(p.typed, p.total, p.elapsedMs);
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
  [el.cleanDashes, el.cleanQuotes, el.cleanEllipsis, el.cleanSpaces,
   el.stripIndent, el.tableTarget, el.tableFormat].forEach((n) =>
    n.addEventListener(evt, updateCount));
});

el.cpsOut.textContent = `${el.cps.value} chars/sec`;
el.enterWarn.classList.remove("hidden");
updateCount();
