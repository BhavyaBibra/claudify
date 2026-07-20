import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeCommandsDir } from "../util/paths.js";

/**
 * Locate the bundled `/away` command markdown. Works both from source (tsx) and
 * from the built package (dist/), since `skill/` ships alongside `dist/`.
 */
function findAwaySource(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../skill/away/away.md"), // dist/cli -> repo root/skill
    path.resolve(here, "../../../skill/away/away.md"),
    path.resolve(here, "../../skill/away.md"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function runInitSkill(): void {
  const src = findAwaySource();
  if (!src) {
    throw new Error("Could not locate the bundled /away command (skill/away/away.md).");
  }
  const destDir = claudeCommandsDir();
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, "away.md");
  fs.copyFileSync(src, dest);
  console.log(`Installed /away command to ${dest}`);
  console.log("Open any project in Claude Code and run `/away` to hand a session to Claudify.");
}
