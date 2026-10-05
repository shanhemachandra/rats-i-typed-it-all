"use strict";

/* Pure text transforms, kept free of the DOM so they can be tested directly
 * with node. The UI gathers options and calls processText; the Rust side
 * only ever sees the finished character sequence. */

(function (root) {
  /**
   * Reduce text copied from a chat window to clean text: drop code fences,
   * every backtick, heading hashes, quote markers, divider lines, link
   * syntax, and all bold/italic/strike markers, paired or stray. Single *
   * and _ go only when they wrap words, so "2 * 3" and snake_case survive.
   * "* item" bullets become "- item".
   */
  function stripMarkdown(s) {
    return s
      .replace(/^[ \t]*(```|~~~).*$\n?/gm, "")
      .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "")
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^([ \t]*>[ \t]?)+/gm, "")
      .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ")
      .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1$2")
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1$2")
      .replace(/\*\*|~~|`/g, "");
  }

  function applyCleanup(s, o) {
    o = o || {};
    if (o.cleanMarkdown) s = stripMarkdown(s);
    if (o.cleanDashes) s = s.replace(/[—–‒−]/g, "-");
    if (o.cleanQuotes) {
      s = s.replace(/[‘’‚‛]/g, "'")
           .replace(/[“”„‟]/g, '"');
    }
    if (o.cleanEllipsis) s = s.replace(/…/g, "...");
    if (o.cleanSpaces) s = s.replace(/[   ]/g, " ");
    return s;
  }

  /** CSV parse handling quoted fields, embedded commas and "" escapes. */
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
        } else cur += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); cur = ""; rows.push(row); row = []; }
      else if (c !== "\r") cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }

  function parseTSV(text) {
    return text.split("\n").map((line) => line.split("\t"));
  }

  function detectFormat(text, choice) {
    if (choice && choice !== "auto") return choice;
    return text.includes("\t") ? "tsv" : "csv";
  }

  /**
   * Turn a grid into a keystroke sequence the target app assembles itself.
   *
   * spreadsheet:    cells joined by Tab, rows by Enter. Excel and Sheets
   *                 return to the first column on Enter.
   * documentTable:  every cell joined by Tab, because Tab past the last
   *                 cell of a Word or Docs table opens the next row.
   */
  function buildTable(text, o) {
    o = o || {};
    const format = detectFormat(text, o.tableFormat);
    let rows = format === "tsv" ? parseTSV(text) : parseCSV(text);

    // A newline inside a cell would break the grid alignment.
    rows = rows
      .map((r) => r.map((c) => c.replace(/[\r\n]+/g, " ").trim()))
      .filter((r) => r.some((c) => c !== ""));

    const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const lines = rows.map((r) => r.join("\t"));
    const out = o.tableTarget === "documentTable"
      ? lines.join("\t")
      : lines.join("\n");

    return { text: out, rows: rows.length, cols, format };
  }

  function processText(raw, o) {
    o = o || {};
    let s = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    s = applyCleanup(s, o);
    if (o.tableMode) {
      const t = buildTable(s, o);
      return { text: t.text, table: t };
    }
    if (o.stripIndent) {
      s = s.split("\n").map((l) => l.replace(/^[ \t]+/, "")).join("\n");
    }
    return { text: s, table: null };
  }

  function formatDuration(ms) {
    const secs = ms / 1000;
    if (secs < 60) {
      const v = secs < 10 ? Number(secs.toFixed(1)) : Math.round(secs);
      return `${v} second${v === 1 ? "" : "s"}`;
    }
    const mins = Math.floor(secs / 60);
    const rem = Math.round(secs % 60);
    const mPart = `${mins} minute${mins === 1 ? "" : "s"}`;
    return rem ? `${mPart} ${rem} second${rem === 1 ? "" : "s"}` : mPart;
  }

  root.TextPipe = {
    applyCleanup, stripMarkdown, parseCSV, parseTSV, buildTable, processText, formatDuration,
  };
})(typeof window !== "undefined" ? window : globalThis);
