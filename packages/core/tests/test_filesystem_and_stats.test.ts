import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { getActiveFiles, getSnapshot } from "../src/filesystem";

function makeWorkspace(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-test-"));
  const workspace = path.join(tempDir, "workspace");
  fs.mkdirSync(workspace);
  return workspace;
}

describe("TestGetActiveFilesNonGit", () => {
  let workspace: string;
  let tempDir: string;

  beforeAll(() => {
    workspace = makeWorkspace();
    tempDir = path.dirname(workspace);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("test_get_active_files_non_git", () => {
    const srcDir = path.join(workspace, "src");
    fs.mkdirSync(srcDir);
    const file1 = path.join(srcDir, "main.py");
    fs.writeFileSync(file1, "print('hello')");

    const nodeModules = path.join(workspace, "node_modules");
    fs.mkdirSync(nodeModules);
    const ignoredFile = path.join(nodeModules, "index.js");
    fs.writeFileSync(ignoredFile, "const a = 1;");

    const libDir = path.join(workspace, "lib");
    fs.mkdirSync(libDir);
    const file2 = path.join(libDir, "utils.py");
    fs.writeFileSync(file2, "def run(): pass");

    const activeFiles = getActiveFiles(workspace);

    expect(activeFiles.has(path.resolve(ignoredFile))).toBe(false);
    expect(activeFiles.has(path.resolve(file1))).toBe(true);
    expect(activeFiles.has(path.resolve(file2))).toBe(true);
  });
});

describe("TestGetActiveFilesNonGitFileLimit", () => {
  let workspace: string;
  let tempDir: string;

  beforeAll(() => {
    workspace = makeWorkspace();
    tempDir = path.dirname(workspace);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("test_get_active_files_non_git_file_limit", () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(workspace, `file_${i}.txt`), "a");
    }

    for (let i = 0; i < 2005; i++) {
      fs.writeFileSync(path.join(workspace, `f_${i}.txt`), "");
    }

    const activeFiles = getActiveFiles(workspace);
    expect(activeFiles.size).toBeLessThanOrEqual(2001);
  });
});

describe("TestGetActiveFilesGit", () => {
  let workspace: string;
  let tempDir: string;

  beforeAll(() => {
    workspace = makeWorkspace();
    tempDir = path.dirname(workspace);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("test_get_active_files_git", () => {
    execSync("git init", { cwd: workspace, stdio: "ignore" });

    execSync("git config user.name test", { cwd: workspace });
    execSync("git config user.email test@example.com", { cwd: workspace });

    const file1 = path.join(workspace, "tracked.py");
    fs.writeFileSync(file1, "print('tracked')");
    execSync("git add tracked.py", { cwd: workspace });

    const file2 = path.join(workspace, "untracked.py");
    fs.writeFileSync(file2, "print('untracked')");

    const gitignore = path.join(workspace, ".gitignore");
    fs.writeFileSync(gitignore, "ignored.py\n");
    execSync("git add .gitignore", { cwd: workspace });

    const file3 = path.join(workspace, "ignored.py");
    fs.writeFileSync(file3, "print('ignored')");

    const activeFiles = getActiveFiles(workspace);

    expect(activeFiles.has(path.resolve(file1))).toBe(true);
    expect(activeFiles.has(path.resolve(file2))).toBe(true);
    expect(activeFiles.has(path.resolve(file3))).toBe(false);
  });
});

describe("TestGetActiveFilesGitException", () => {
  let workspace: string;
  let tempDir: string;

  beforeAll(() => {
    workspace = makeWorkspace();
    tempDir = path.dirname(workspace);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("test_get_active_files_git_exception", () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    const file1 = path.join(workspace, "fallback.py");
    fs.writeFileSync(file1, "print('fallback')");

    const activeFiles = getActiveFiles(workspace);
    expect(activeFiles.has(path.resolve(file1))).toBe(true);

    process.env.PATH = originalPath;
  });
});

describe("TestGetSnapshot", () => {
  let workspace: string;
  let tempDir: string;

  beforeAll(() => {
    workspace = makeWorkspace();
    tempDir = path.dirname(workspace);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("test_get_snapshot", () => {
    const file1 = path.join(workspace, "snap.txt");
    fs.writeFileSync(file1, "hello");

    const snapshot = getSnapshot(workspace);
    expect(path.resolve(file1) in snapshot).toBe(true);
    expect(snapshot[path.resolve(file1)].size).toBe(5);
    expect("mtime" in snapshot[path.resolve(file1)]).toBe(true);
  });
});

describe("TestGetSnapshotOsStatException", () => {
  let workspace: string;
  let tempDir: string;

  beforeAll(() => {
    workspace = makeWorkspace();
    tempDir = path.dirname(workspace);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("test_get_snapshot_os_stat_exception", () => {
    const subdir = path.join(workspace, "sub");
    fs.mkdirSync(subdir);
    const file1 = path.join(subdir, "snap_error.txt");
    fs.writeFileSync(file1, "hello");
    fs.chmodSync(subdir, 0o400);

    const snapshot = getSnapshot(workspace);
    expect(path.resolve(file1) in snapshot).toBe(false);

    fs.chmodSync(subdir, 0o755);
  });
});
