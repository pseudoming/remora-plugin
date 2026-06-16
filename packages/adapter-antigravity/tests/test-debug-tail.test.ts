import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { TEST_LOG_DIR } = vi.hoisted(() => {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remora-tail-"));
	process.env.REMORA_LOG_DIR = dir;
	return { TEST_LOG_DIR: dir };
});

import * as tailMod from "../src/debug/tail";

afterAll(() => {
	fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true });
});

function makeLogEntry(
	tid = "T1",
	timestamp = "2026-01-01 12:00:00",
	level = "INFO",
	source = "test",
	message = "hello",
): string {
	return `[TID:${tid}] [${timestamp}] [${level}] [${source}] ${message}\n`;
}

function outLines(calls: string[][]): string[] {
	const text = calls.map((c) => c[0]).join("");
	return text
		.trim()
		.split("\n")
		.filter((l) => l.length > 0);
}

function setupLogDir(): void {
	fs.rmSync(TEST_LOG_DIR, { recursive: true, force: true });
	fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
}

describe("TestDefaultRun", () => {
	it("test_five_entries", () => {
		setupLogDir();
		const entries = Array.from({ length: 5 }, (_, i) =>
			makeLogEntry(
				undefined,
				`2026-01-01 12:00:0${i + 1}`,
				undefined,
				undefined,
				`msg${i + 1}`,
			),
		);
		fs.writeFileSync(path.join(TEST_LOG_DIR, "system.log"), entries.join(""));

		vi.spyOn(process, "argv", "get").mockReturnValue(["node", "tail.js"]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const lines = outLines(stdoutSpy.mock.calls as unknown as string[][]);
		expect(lines.length).toBe(5);

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestLevelFilter", () => {
	it("test_only_error", () => {
		setupLogDir();
		const entries = [
			makeLogEntry(undefined, undefined, "INFO", undefined, "info msg"),
			makeLogEntry(undefined, undefined, "ERROR", undefined, "error msg"),
			makeLogEntry(undefined, undefined, "WARN", undefined, "warn msg"),
			makeLogEntry(undefined, undefined, "ERROR", undefined, "another error"),
			makeLogEntry(undefined, undefined, "DEBUG", undefined, "debug msg"),
		];
		fs.writeFileSync(path.join(TEST_LOG_DIR, "system.log"), entries.join(""));

		vi.spyOn(process, "argv", "get").mockReturnValue([
			"node",
			"tail.js",
			"--level",
			"ERROR",
		]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
		expect(out).toContain("error msg");
		expect(out).toContain("another error");
		expect(out).not.toContain("info msg");
		expect(out).not.toContain("warn msg");
		expect(out).not.toContain("debug msg");

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestGrep", () => {
	it("test_filter_by_substring", () => {
		setupLogDir();
		const entries = [
			makeLogEntry(
				undefined,
				undefined,
				undefined,
				undefined,
				"this has abc in it",
			),
			makeLogEntry(undefined, undefined, undefined, undefined, "this does not"),
			makeLogEntry(
				undefined,
				undefined,
				undefined,
				undefined,
				"ABC should also match",
			),
			makeLogEntry(
				undefined,
				undefined,
				undefined,
				undefined,
				"no match here either",
			),
		];
		fs.writeFileSync(path.join(TEST_LOG_DIR, "system.log"), entries.join(""));

		vi.spyOn(process, "argv", "get").mockReturnValue([
			"node",
			"tail.js",
			"--grep",
			"abc",
		]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const out = stdoutSpy.mock.calls
			.map((c) => String(c[0]))
			.join("")
			.toLowerCase();
		expect(out).toContain("this has abc");
		expect(out).toContain("abc should also match");
		expect(out).not.toContain("this does not");
		expect(out).not.toContain("no match");

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestLinesLimit", () => {
	it("test_two_most_recent", () => {
		setupLogDir();
		const entries = Array.from({ length: 10 }, (_, i) =>
			makeLogEntry(
				undefined,
				`2026-01-01 12:00:${String(i).padStart(2, "0")}`,
				undefined,
				undefined,
				`msg${i}`,
			),
		);
		fs.writeFileSync(path.join(TEST_LOG_DIR, "system.log"), entries.join(""));

		vi.spyOn(process, "argv", "get").mockReturnValue([
			"node",
			"tail.js",
			"--lines",
			"2",
		]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const lines = outLines(stdoutSpy.mock.calls as unknown as string[][]);
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("msg9");
		expect(lines[1]).toContain("msg8");

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestAscOrder", () => {
	it("test_oldest_first", () => {
		setupLogDir();
		const entries = [
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:03",
				undefined,
				undefined,
				"third",
			),
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:01",
				undefined,
				undefined,
				"first",
			),
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:02",
				undefined,
				undefined,
				"second",
			),
		];
		fs.writeFileSync(path.join(TEST_LOG_DIR, "system.log"), entries.join(""));

		vi.spyOn(process, "argv", "get").mockReturnValue([
			"node",
			"tail.js",
			"--asc",
		]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const lines = outLines(stdoutSpy.mock.calls as unknown as string[][]);
		expect(lines.length).toBe(3);
		expect(lines[0]).toContain("first");
		expect(lines[1]).toContain("second");
		expect(lines[2]).toContain("third");

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestTodayFlag", () => {
	it("test_skips_archive", () => {
		setupLogDir();
		fs.writeFileSync(
			path.join(TEST_LOG_DIR, "system.log"),
			makeLogEntry(undefined, undefined, undefined, undefined, "today entry"),
		);
		fs.mkdirSync(TEST_LOG_DIR, { recursive: true });
		fs.writeFileSync(
			path.join(TEST_LOG_DIR, "system.2026-01-01.log"),
			makeLogEntry(undefined, undefined, undefined, undefined, "archive entry"),
		);

		vi.spyOn(process, "argv", "get").mockReturnValue([
			"node",
			"tail.js",
			"--today",
		]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
		expect(out).toContain("today entry");
		expect(out).not.toContain("archive entry");

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestMultipleFiles", () => {
	it("test_reads_all_by_default", () => {
		setupLogDir();
		fs.writeFileSync(
			path.join(TEST_LOG_DIR, "system.log"),
			makeLogEntry(undefined, undefined, undefined, undefined, "from system"),
		);
		fs.writeFileSync(
			path.join(TEST_LOG_DIR, "system.2026-01-01.log"),
			makeLogEntry(undefined, undefined, undefined, undefined, "from archive"),
		);

		vi.spyOn(process, "argv", "get").mockReturnValue(["node", "tail.js"]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
		expect(out).toContain("from system");
		expect(out).toContain("from archive");

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestEmptyDir", () => {
	it("test_no_crash_empty_output", () => {
		setupLogDir();

		vi.spyOn(process, "argv", "get").mockReturnValue(["node", "tail.js"]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderrSpy = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`exit ${code}`);
		});

		let exitCode = 0;
		try {
			tailMod.main();
		} catch (e: unknown) {
			const msg = String(e);
			const m = msg.match(/exit (\d+)/);
			if (m) exitCode = parseInt(m[1], 10);
		}

		expect(exitCode).toBe(1);
		const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
		expect(stderr).toContain("No log files found");
		const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
		expect(stdout).toBe("");

		stdoutSpy.mockRestore();
		stderrSpy.mockRestore();
		exitSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestCombinedFlags", () => {
	it("test_level_warn_grep_timeout_lines_3", () => {
		setupLogDir();
		const entries = [
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:01",
				"WARN",
				undefined,
				"timeout on server",
			),
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:02",
				"WARN",
				undefined,
				"normal warn",
			),
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:03",
				"ERROR",
				undefined,
				"timeout error",
			),
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:04",
				"WARN",
				undefined,
				"another timeout",
			),
			makeLogEntry(
				undefined,
				"2026-01-01 12:00:05",
				"WARN",
				undefined,
				"timeout yet again",
			),
		];
		fs.writeFileSync(path.join(TEST_LOG_DIR, "system.log"), entries.join(""));

		vi.spyOn(process, "argv", "get").mockReturnValue([
			"node",
			"tail.js",
			"--level",
			"WARN",
			"--grep",
			"timeout",
			"--lines",
			"3",
		]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const lines = outLines(stdoutSpy.mock.calls as unknown as string[][]);
		expect(lines.length).toBe(3);
		for (const line of lines) {
			expect(line).toContain("WARN");
			expect(line.toLowerCase()).toContain("timeout");
		}

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});

describe("TestColorCodes", () => {
	it("test_error_has_red_ansi", () => {
		setupLogDir();
		const entries = [
			makeLogEntry(undefined, undefined, "ERROR", undefined, "error msg"),
			makeLogEntry(undefined, undefined, "INFO", undefined, "info msg"),
		];
		fs.writeFileSync(path.join(TEST_LOG_DIR, "system.log"), entries.join(""));

		vi.spyOn(process, "argv", "get").mockReturnValue(["node", "tail.js"]);
		const stdoutSpy = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);

		tailMod.main();

		const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
		expect(out).toContain("\x1b[31m");
		expect(out.trim().length).toBeGreaterThan(0);

		stdoutSpy.mockRestore();
		vi.restoreAllMocks();
	});
});
