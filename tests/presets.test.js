"use strict";

/* Checks every preset against the real controls in index.html, so a renamed
 * control or a mistyped option value fails here instead of silently doing
 * nothing in the app. Run with: node tests/presets.test.js */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "presets.js"), "utf8"), sandbox);
const { BASE, PRESETS, KEYS } = sandbox.Presets;
const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");

let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`); }
}

/** What index.html declares for one control id. */
function control(id) {
  const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  if (input) {
    const tag = input[0];
    const type = (tag.match(/type="([^"]+)"/) || [])[1];
    const attr = (name) => (tag.match(new RegExp(`${name}="([^"]+)"`)) || [])[1];
    return {
      kind: type,
      checked: /\schecked[\s/>]/.test(tag),
      value: attr("value"), min: attr("min"), max: attr("max"),
    };
  }
  const select = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`));
  if (select) {
    const options = [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    return { kind: "select", options, first: options[0] };
  }
  return null;
}

function valid(id, value) {
  const c = control(id);
  if (!c) return `no control with id "${id}"`;
  if (c.kind === "checkbox") return typeof value === "boolean" ? null : "checkbox needs true or false";
  if (c.kind === "range") {
    if (typeof value !== "number") return "slider needs a number";
    return value >= Number(c.min) && value <= Number(c.max) ? null : `outside ${c.min} to ${c.max}`;
  }
  if (c.kind === "select") return c.options.includes(value) ? null : `not one of ${c.options.join(", ")}`;
  return `unhandled control type ${c.kind}`;
}

console.log("every preset value fits its control");
for (const p of PRESETS) {
  const problems = KEYS.map((k) => [k, valid(k, p.values[k])]).filter(([, e]) => e);
  check(problems.length === 0, p.label, problems.map(([k, e]) => `${k}: ${e}`).join("; "));
}

console.log("presets are complete and distinct");
for (const p of PRESETS) {
  check(KEYS.every((k) => k in p.values), `${p.label} sets every key`);
}
const seen = new Map();
for (const p of PRESETS) {
  const sig = JSON.stringify(KEYS.map((k) => p.values[k]));
  check(!seen.has(sig), `${p.label} differs from every other preset`, seen.has(sig) ? `same as ${seen.get(sig)}` : "");
  seen.set(sig, p.label);
}

console.log("BASE matches the defaults in index.html");
for (const k of KEYS) {
  const c = control(k);
  const htmlDefault = c.kind === "checkbox" ? c.checked
    : c.kind === "range" ? Number(c.value)
    : c.kind === "select" ? c.first : undefined;
  check(htmlDefault === BASE[k], `${k} default`, `index.html has ${JSON.stringify(htmlDefault)}, BASE has ${JSON.stringify(BASE[k])}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
