/**
 * Git-aware filesystem helpers — adapter layer.
 *
 * Mirrors scripts/core/filesystem.py getActiveFiles / getSnapshot.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { walkFiles, diffSnapshots, type Snapshot, type SnapshotEntry } from "@remora/core";

export { diffSnapshots, type Snapshot, type SnapshotEntry };

export function getActiveFiles(cwd: string): Set<string> {
  let isGit = false;
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "ignore" });
    isGit = true;
  } catch { isGit = false; }

  const activeFiles = new Set<string>();

  if (isGit) {
    try {
      const output = execSync(
        "git ls-files --cached --others --exclude-standard",
        { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
      );
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) activeFiles.add(path.resolve(cwd, trimmed));
      }
    } catch { isGit = false; }
  }

  if (!isGit) {
    for (const f of walkFiles(cwd)) activeFiles.add(f);
  }
  return activeFiles;
}

export function getSnapshot(cwd: string): Snapshot {
  const files = getActiveFiles(cwd);
  const snapshot: Snapshot = {};
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      snapshot[f] = { mtime: st.mtimeMs / 1000, size: st.size };
    } catch { /* skip */ }
  }
  return snapshot;
}
