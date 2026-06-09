/**
 * Filesystem helpers — snapshot, hashing, git-aware file listing.
 *
 * 1:1 mirror of scripts/core/filesystem.py.
 */

import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const BLACKLIST_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__",
  "build", "dist", "target", "vendor", "pkg", ".gradle", ".git",
]);

export interface SnapshotEntry { mtime: number; size: number }
export type Snapshot = Record<string, SnapshotEntry>;

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

  if (!isGit) _walkFiles(cwd, activeFiles);
  return activeFiles;
}

function _walkFiles(dir: string, result: Set<string>, count: number = 0): number {
  let fileCount = count;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (BLACKLIST_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        fileCount = _walkFiles(fullPath, result, fileCount);
      } else if (entry.isFile()) {
        result.add(path.resolve(fullPath));
        fileCount++;
        if (fileCount > 2000) break;
      }
    }
  } catch { /* skip */ }
  return fileCount;
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

export function calculateMd5(filePath: string): string {
  const hash = crypto.createHash("md5");
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(4096);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

export function diffSnapshots(preSnapshot: Snapshot, postSnapshot: Snapshot): Set<string> {
  const modified = new Set<string>();
  for (const [fpath, postSt] of Object.entries(postSnapshot)) {
    if (!(fpath in preSnapshot)) {
      modified.add(path.basename(fpath));
    } else {
      const preSt = preSnapshot[fpath];
      if (preSt.mtime !== postSt.mtime || preSt.size !== postSt.size) {
        modified.add(path.basename(fpath));
      }
    }
  }
  return modified;
}
