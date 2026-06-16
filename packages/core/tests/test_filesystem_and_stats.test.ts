import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { walkFiles, diffSnapshots, calculateMd5 } from "../src/filesystem";

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

		const activeFiles = walkFiles(workspace);

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

		const activeFiles = walkFiles(workspace);
		expect(activeFiles.size).toBeLessThanOrEqual(2001);
	});
});

// Git-aware tests moved to adapter (packages/adapter-antigravity/)


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

	it("test_walkFiles_finds_snap_file", () => {
		const file1 = path.join(workspace, "snap.txt");
		fs.writeFileSync(file1, "hello");

		const files = walkFiles(workspace);
		expect(files.has(path.resolve(file1))).toBe(true);
	});
});

