#!/usr/bin/env node
// Fail when README.md does not mention the version in manifest.json.

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const version = String(manifest.version || "");

if (!version) {
  console.error("manifest.json has no version");
  process.exit(1);
}

const mentioned = new RegExp(`(^|[^\\d.])${version.replace(/\./g, "\\.")}([^\\d.]|$)`).test(readme);
if (!mentioned) {
  console.error(`README.md does not mention manifest version ${version}`);
  process.exit(1);
}

console.log(`OK: README.md mentions manifest version ${version}`);
