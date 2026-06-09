/**
 * Filesystem helpers — hashing, diffing, file walking.
 *
 * Platform-agnostic core. Git-aware snapshot lives in adapter/bridge/filesystem.ts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const BLACKLIST_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__",
  "build", "dist", "target", "vendor", "pkg", ".gradle", ".git",
]);

export interface SnapshotEntry { mtime: number; size: number }
export type Snapshot = Record<string, SnapshotEntry>;

export function walkFiles(cwd: string): Set<string> {
  const result = new Set<string>();
  let fileCount = 0;

  function _walk(dir: string): void {
    if (fileCount > 2000) return;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (BLACKLIST_DIRS.has(entry.name)) continue;
        if (fileCount > 2000) return;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          _walk(fullPath);
        } else if (entry.isFile()) {
          result.add(path.resolve(fullPath));
          fileCount++;
        }
      }
    } catch { /* skip */ }
  }

  _walk(cwd);
  return result;
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
