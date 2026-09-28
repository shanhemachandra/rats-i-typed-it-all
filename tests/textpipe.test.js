"use strict";

/* Tests for the pure text pipeline. Run with: node tests/textpipe.test.js */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "src", "textpipe.js"), "utf8"),
  sandbox
);
const TP = sandbox.TextPipe;

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n       expected ${b}\n       actual   ${a}`); }
}

console.log("cleanup");
eq(TP.applyCleanup("a—b", { cleanDashes: true }), "a-b", "em dash to hyphen");
eq(TP.applyCleanup("a–b", { cleanDashes: true }), "a-b", "en dash to hyphen");
eq(TP.applyCleanup("a—b", {}), "a—b", "em dash kept when option off");
eq(TP.applyCleanup("“hi”", { cleanQuotes: true }), '"hi"', "curly double quotes");
eq(TP.applyCleanup("it’s", { cleanQuotes: true }), "it's", "curly apostrophe");
eq(TP.applyCleanup("a…b", { cleanEllipsis: true }), "a...b", "ellipsis");
eq(TP.applyCleanup("a b", { cleanSpaces: true }), "a b", "non breaking space");

console.log("csv parsing");
eq(TP.parseCSV("a,b\nc,d"), [["a", "b"], ["c", "d"]], "simple csv");
eq(TP.parseCSV('a,"b,c"\nd,e'), [["a", "b,c"], ["d", "e"]], "quoted comma");
eq(TP.parseCSV('"say ""hi""",x'), [['say "hi"', "x"]], "escaped quotes");

console.log("tsv parsing");
eq(TP.parseTSV("a\tb\nc\td"), [["a", "b"], ["c", "d"]], "simple tsv");

console.log("table building");
eq(
  TP.buildTable("a,b\nc,d", { tableTarget: "spreadsheet" }).text,
  "a\tb\nc\td",
  "spreadsheet: tab between cells, newline between rows"
);
eq(
  TP.buildTable("a,b\nc,d", { tableTarget: "documentTable" }).text,
  "a\tb\tc\td",
  "document table: tab between every cell"
);
eq(
  TP.buildTable("a,b\nc,d", { tableTarget: "spreadsheet" }).format,
  "csv",
  "auto detects csv"
);
eq(
  TP.buildTable("a\tb\nc\td", { tableTarget: "spreadsheet" }).format,
  "tsv",
  "auto detects tsv when tabs present"
);
eq(
  TP.buildTable('a,"multi\nline"', { tableTarget: "spreadsheet" }).text,
  "a\tmulti line",
  "newline inside a cell is flattened so the grid survives"
);
eq(
  TP.buildTable("a,b\n\nc,d", { tableTarget: "spreadsheet" }).rows,
  2,
  "blank rows dropped"
);

console.log("processText");
eq(
  TP.processText("x—y", { cleanDashes: true }).text,
  "x-y",
  "cleanup applied outside table mode"
);
eq(
  TP.processText("  indented\n    more", { stripIndent: true }).text,
  "indented\nmore",
  "strip leading whitespace"
);
eq(
  TP.processText("a,b\nc,d", { tableMode: true, tableTarget: "spreadsheet" }).text,
  "a\tb\nc\td",
  "table mode routes through buildTable"
);
eq(
  TP.processText("a—b,c", { tableMode: true, cleanDashes: true, tableTarget: "spreadsheet" }).text,
  "a-b\tc",
  "cleanup runs before table parsing"
);
eq(TP.processText("a\r\nb", {}).text, "a\nb", "CRLF normalised");

console.log("duration formatting");
eq(TP.formatDuration(1000), "1 second", "singular second");
eq(TP.formatDuration(2500), "2.5 seconds", "fractional seconds");
eq(TP.formatDuration(45000), "45 seconds", "whole seconds");
eq(TP.formatDuration(60000), "1 minute", "exact minute");
eq(TP.formatDuration(124000), "2 minutes 4 seconds", "minutes and seconds");
eq(TP.formatDuration(3600000), "60 minutes", "long run");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
