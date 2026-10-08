"use strict";

/* Setting presets for the places people type into most.
 *
 * Pure data, kept out of main.js so the test can check every key and value
 * against the real controls in index.html. Keys are control ids: booleans
 * set checkboxes, strings set selects, numbers set the speed slider.
 *
 * Every preset sets every key in BASE, so clicking one always gives the same
 * result whatever was set before. Countdown, the focus guard and keep on top
 * are personal choices and are never touched by a preset.
 *
 * BASE must equal the defaults written in index.html: the app resets to those
 * on launch, and Document (which is BASE unchanged) then shows as selected. */

(function (root) {
  const BASE = {
    tableMode: false,
    tableTarget: "spreadsheet",
    tableFormat: "auto",
    cleanMarkdown: true,
    cleanDashes: true,
    cleanQuotes: false,
    cleanEllipsis: false,
    cleanSpaces: false,
    stripIndent: false,
    newlineMode: "enter",
    tabMode: "tab",
    human: true,
    burst: false,
    cps: 25,
  };

  const DEFS = [
    {
      id: "document", label: "Document",
      hint: "Word, Google Docs, Pages, email. Enter starts a new line and chat formatting symbols are removed.",
      set: {},
    },
    {
      id: "chat", label: "Chat",
      hint: "Slack, Teams, Discord, WhatsApp. New lines use Shift and Enter, so your text arrives as one message instead of one per line.",
      set: { newlineMode: "shiftEnter", tabMode: "spaces", cps: 30 },
    },
    {
      id: "spreadsheet", label: "Spreadsheet",
      hint: "Excel, Google Sheets. Paste a table: Tab moves across a row and Enter starts the next one. Click the first cell during the countdown.",
      set: { tableMode: true, human: false, cps: 30 },
    },
    {
      id: "code", label: "Code editor",
      hint: "VS Code and other editors. Leading spaces are stripped so the editor's own auto indent is not doubled. Symbols like ** and backticks are kept.",
      set: { cleanMarkdown: false, cleanDashes: false, stripIndent: true, human: false, cps: 60 },
    },
    {
      id: "remote", label: "Remote desktop",
      hint: "Citrix, Remote Desktop, VNC, virtual machines. Slow and steady, so no keys are dropped on the way to the remote computer.",
      set: { human: false, cps: 12 },
    },
    {
      id: "form", label: "Web form",
      hint: "Portals and single-line fields, where pressing Enter would submit the form. Line breaks become spaces.",
      set: { newlineMode: "space", tabMode: "spaces" },
    },
  ];

  const PRESETS = DEFS.map((d) => ({
    id: d.id, label: d.label, hint: d.hint, values: Object.assign({}, BASE, d.set),
  }));

  root.Presets = { BASE, PRESETS, KEYS: Object.keys(BASE) };
})(typeof window !== "undefined" ? window : globalThis);
