// Copy non-TS runtime assets into dist/ after tsc. Cross-platform.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = [["src/dashboard/page.html", "dist/dashboard/page.html"]];

for (const [from, to] of assets) {
  const src = path.join(root, from);
  const dest = path.join(root, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`copied ${from} -> ${to}`);
}

// tsc does not preserve the executable bit, which breaks the `claudify` bin.
const entry = path.join(root, "dist/index.js");
fs.chmodSync(entry, 0o755);
console.log("chmod +x dist/index.js");
