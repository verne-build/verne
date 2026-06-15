import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// js-yaml is installed into an isolated dir in CI (env JS_YAML) to avoid running
// `npm install` against the project graph; fall back to bare resolution locally.
const require = createRequire(import.meta.url);
const yaml = require(process.env.JS_YAML ?? "js-yaml");

// Merge electron-builder `latest-mac.yml` files from multiple arch builds into
// one whose `files:` lists every arch. electron-updater (MacUpdater) selects the
// entry matching the client arch (arm64 urls contain "arm64"; x64 ones don't).
export function mergeManifests(contents) {
  const docs = contents.map((c) => yaml.load(c)).filter(Boolean);
  if (docs.length === 0) throw new Error("no manifests to merge");
  const out = { ...docs[0], files: [] };
  const seen = new Set();
  for (const d of docs)
    for (const f of d.files ?? []) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      out.files.push(f);
    }
  if (out.files[0]) { out.path = out.files[0].url; out.sha512 = out.files[0].sha512; }
  const dates = docs.map((d) => d.releaseDate).filter(Boolean).sort();
  if (dates.length) out.releaseDate = dates[dates.length - 1];
  return yaml.dump(out, { lineWidth: -1 });
}

// CLI: node merge-mac-manifests.mjs <out.yml> <in1.yml> <in2.yml> ...
const [out, ...ins] = process.argv.slice(2);
if (out && ins.length) {
  writeFileSync(out, mergeManifests(ins.map((p) => readFileSync(p, "utf8"))));
  console.log(`merged ${ins.length} manifests -> ${out}`);
}
