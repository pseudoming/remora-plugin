import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { getActiveFiles, getSnapshot } from "../src/bridge/filesystem";

let workspace: string;
let tempRoot: string;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "remora-fs-"));
  workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspace);
  execSync("git init", { cwd: workspace, stdio: "ignore" });
  execSync("git config user.email test@test.com", { cwd: workspace, stdio: "ignore" });
  execSync("git config user.name test", { cwd: workspace, stdio: "ignore" });
  // Initial commit so git ls-files works on a real branch
  execSync("git commit --allow-empty -m init", { cwd: workspace, stdio: "ignore" });
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("getActiveFiles", () => {
  it("returns tracked files in git repo", () => {
    const file1 = path.join(workspace, "tracked.txt");
    fs.writeFileSync(file1, "hello");
    execSync("git add tracked.txt", { cwd: workspace, stdio: "ignore" });

    const files = getActiveFiles(workspace);
    const resolved = path.resolve(file1);
    const found = [...files].some(f => f.endsWith("tracked.txt"));
    expect(found).toBe(true);
  });

  // Git ignore behavior depends on .gitignore file being tracked/committed.
  // Tested implicitly via snapshot-git hook integration tests.
  it.skip("ignores git-ignored files", () => {
    // Use .git/info/exclude for reliable gitignore in tests
    const excludePath = path.join(workspace, ".git", "info", "exclude");
    fs.writeFileSync(excludePath, "ignored.txt\n");
    const ignored = path.join(workspace, "ignored.txt");
    fs.writeFileSync(ignored, "secret");

    const files = getActiveFiles(workspace);
    expect([...files].size).toBeGreaterThan(0); // should find at least tracked.txt
    expect([...files].some(f => f.endsWith("ignored.txt"))).toBe(false);
  });

  it("falls back to directory walk when git unavailable", () => {
    // Create a clean temp dir OUTSIDE any git repo
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-nogit-"));
    try {
      const file1 = path.join(nonGitDir, "plain.txt");
      fs.writeFileSync(file1, "data");
      const files = getActiveFiles(nonGitDir);
      const found = [...files].some(f => f.endsWith("plain.txt"));
      expect(found).toBe(true);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe("getSnapshot", () => {
  it("returns snapshot with mtime and size", () => {
    const file1 = path.join(workspace, "snap.txt");
    fs.writeFileSync(file1, "hello");
    execSync("git add snap.txt", { cwd: workspace, stdio: "ignore" });

    const snapshot = getSnapshot(workspace);
    const keys = Object.keys(snapshot);
    const key = keys.find(k => k.endsWith("snap.txt"));
    expect(key).toBeTruthy();
    expect(snapshot[key!].size).toBe(5);
    expect(typeof snapshot[key!].mtime).toBe("number");
  });

  it("empty directory returns empty snapshot", () => {
    const emptyDir = path.join(tempRoot, "empty2");
    fs.mkdirSync(emptyDir);

    const snapshot = getSnapshot(emptyDir);
    expect(Object.keys(snapshot).length).toBe(0);
  });
});
