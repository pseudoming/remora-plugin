import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

let tempDir: string;

beforeEach(() => {
	vi.resetModules();
	tempDir = path.join(
		os.tmpdir(),
		`remora-logger-test-${randomUUID().slice(0, 8)}`,
	);
	fs.mkdirSync(tempDir, { recursive: true });
	vi.stubEnv("REMORA_LOG_DIR", tempDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// ignore
	}
});

describe("TestInit", () => {
	it("first init creates directory and state", async () => {
		fs.rmdirSync(tempDir);
		expect(fs.existsSync(tempDir)).toBe(false);
		const logger = await import("../src/logger");
		logger.init();
		expect(fs.existsSync(tempDir)).toBe(true);
		const expected = path.join(tempDir, "system.log");
		// verify idempotent: second init should not throw
		expect(() => logger.init()).not.toThrow();
		// verify log file is set by writing a message
		logger.info("first message");
		expect(fs.existsSync(expected)).toBe(true);
	});

	it("second init is idempotent", async () => {
		const logger = await import("../src/logger");
		logger.init();
		logger.init();
		expect(() => logger.init()).not.toThrow();
	});
});

describe("TestLogWriting", () => {
	it("info writes correct format", async () => {
		const logger = await import("../src/logger");
		logger.init();
		logger.info("hello world");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8").trim();
		expect(content).toContain("[TID:");
		expect(content).toContain("[INFO");
		expect(content).toMatch(/\[[\w.\-/]+:\d+\]/);
		expect(content.endsWith("hello world")).toBe(true);
	});

	it("warn writes to log and stderr", async () => {
		const logger = await import("../src/logger");
		logger.init();
		const stderrWrite = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			logger.warn("danger zone");
			const logPath = path.join(tempDir, "system.log");
			const logContent = fs.readFileSync(logPath, "utf-8").trim();
			expect(logContent).toContain("[TID:");
			expect(logContent).toContain("[WARN");
			expect(logContent).toContain("danger zone");
			const stderrOutput = stderrWrite.mock.calls
				.map((c) => String(c[0]))
				.join("");
			expect(stderrOutput).toContain("[WARN]");
			expect(stderrOutput).toContain("danger zone");
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it("error writes to log and stderr", async () => {
		const logger = await import("../src/logger");
		logger.init();
		const stderrWrite = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			logger.error("fatal failure");
			const logPath = path.join(tempDir, "system.log");
			const logContent = fs.readFileSync(logPath, "utf-8").trim();
			expect(logContent).toContain("[TID:");
			expect(logContent).toContain("[ERROR]");
			expect(logContent).toContain("fatal failure");
			const stderrOutput = stderrWrite.mock.calls
				.map((c) => String(c[0]))
				.join("");
			expect(stderrOutput).toContain("[ERROR]");
			expect(stderrOutput).toContain("fatal failure");
		} finally {
			stderrWrite.mockRestore();
		}
	});

	it("profile writes prof level", async () => {
		const logger = await import("../src/logger");
		logger.init();
		logger.profile("benchmark data");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8").trim();
		expect(content).toContain("[TID:");
		expect(content).toContain("[PROF");
		expect(content).toContain("benchmark data");
	});

	it("file content is written and readable", async () => {
		const logger = await import("../src/logger");
		logger.init();
		logger.info("line one");
		logger.error("line two");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		const lines = content.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("line one");
		expect(lines[1]).toContain("line two");
	});
});

describe("TestTraceID", () => {
	it("trace id default", async () => {
		const logger = await import("../src/logger");
		logger.init();
		logger.info("trace default");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		const match = content.match(/\[TID:(s_[0-9a-f]{8})\]/);
		expect(match).not.toBeNull();
		expect(match![1].startsWith("s_")).toBe(true);
		expect(match![1].length).toBe(10);
	});

	it("set trace id", async () => {
		const logger = await import("../src/logger");
		logger.setTraceId("my_custom_tid");
		expect(process.env.REMORA_TRACE_ID).toBe("my_custom_tid");
		logger.init();
		logger.info("custom tid log");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("[TID:my_custom_tid]");
	});

	it("trace id inheritance", async () => {
		const logger = await import("../src/logger");
		vi.stubEnv("REMORA_TRACE_ID", "parent_tid_123");
		logger.init();
		expect(process.env.REMORA_TRACE_ID).toBe("parent_tid_123");
		logger.info("inheritance test");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("[TID:parent_tid_123]");
	});

	it("trace id in log line", async () => {
		const logger = await import("../src/logger");
		logger.init();
		logger.info("trace test");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("[TID:");
	});
});

describe("TestLogLevels", () => {
	it("log level off", async () => {
		vi.stubEnv("REMORA_LOG_LEVEL", "OFF");
		const logger = await import("../src/logger");
		logger.init();
		logger.info("off info");
		logger.warn("off warn");
		logger.error("off error");
		logger.debug("off debug");
		const logPath = path.join(tempDir, "system.log");
		expect(fs.existsSync(logPath)).toBe(false);
	});

	it("log level error", async () => {
		vi.stubEnv("REMORA_LOG_LEVEL", "ERROR");
		const logger = await import("../src/logger");
		logger.init();
		logger.info("info msg");
		logger.warn("warn msg");
		logger.error("error msg");
		logger.debug("debug msg");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("error msg");
		expect(content).not.toContain("info msg");
		expect(content).not.toContain("warn msg");
		expect(content).not.toContain("debug msg");
	});

	it("log level debug", async () => {
		vi.stubEnv("REMORA_LOG_LEVEL", "DEBUG");
		const logger = await import("../src/logger");
		logger.init();
		logger.debug("debug msg");
		logger.info("info msg");
		logger.warn("warn msg");
		logger.error("error msg");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("debug msg");
		expect(content).toContain("info msg");
		expect(content).toContain("warn msg");
		expect(content).toContain("error msg");
	});
});

describe("TestDebug", () => {
	it("debug in file", async () => {
		vi.stubEnv("REMORA_LOG_LEVEL", "DEBUG");
		const logger = await import("../src/logger");
		logger.init();
		logger.debug("debug message");
		const logPath = path.join(tempDir, "system.log");
		const content = fs.readFileSync(logPath, "utf-8");
		expect(content).toContain("debug message");
		expect(content).toContain("[DEBUG]");
	});

	it("debug suppressed at info", async () => {
		vi.stubEnv("REMORA_LOG_LEVEL", "INFO");
		const logger = await import("../src/logger");
		logger.init();
		logger.debug("silent debug");
		const logPath = path.join(tempDir, "system.log");
		expect(fs.existsSync(logPath)).toBe(false);
	});
});

describe("TestWarnStderr", () => {
	it("warn stderr always", async () => {
		vi.stubEnv("REMORA_LOG_LEVEL", "OFF");
		const logger = await import("../src/logger");
		logger.init();
		const stderrWrite = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			logger.warn("stderr check");
			const captured = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
			expect(captured).toContain("[WARN]");
			expect(captured).toContain("stderr check");
		} finally {
			stderrWrite.mockRestore();
		}
	});
});

describe("TestRotation", () => {
	it("rotation renames yesterdays log", async () => {
		const yesterday = new Date(Date.now() - 86400_000);
		const yesterdayStr = yesterday.toISOString().slice(0, 10);
		const current = path.join(tempDir, "system.log");
		fs.writeFileSync(current, "old log line\n");
		fs.utimesSync(current, yesterday, yesterday);

		const logger = await import("../src/logger");
		logger.init();

		// system.log should no longer contain old content
		if (fs.existsSync(current)) {
			expect(fs.statSync(current).mtime.getTime()).not.toBe(
				yesterday.getTime(),
			);
		}
		const archived = path.join(tempDir, `system.${yesterdayStr}.log`);
		expect(fs.existsSync(archived)).toBe(true);
		expect(fs.readFileSync(archived, "utf-8")).toContain("old log line");
	});

	it("no rotation when log is from today", async () => {
		const current = path.join(tempDir, "system.log");
		fs.writeFileSync(current, "today's log\n");

		const logger = await import("../src/logger");
		logger.init();

		expect(fs.existsSync(current)).toBe(true);
		expect(fs.readFileSync(current, "utf-8")).toContain("today's log");
	});
});

describe("TestCleanup", () => {
	it("cleanup removes files older than 3 days", async () => {
		const now = Date.now();
		const oldFiles: string[] = [];

		for (const daysAgo of [4, 5, 6]) {
			const dateStr = new Date(now - daysAgo * 86400_000)
				.toISOString()
				.slice(0, 10);
			const filePath = path.join(tempDir, `system.${dateStr}.log`);
			fs.writeFileSync(filePath, `old log ${daysAgo}d\n`);
			const oldDate = new Date(now - daysAgo * 86400_000);
			fs.utimesSync(filePath, oldDate, oldDate);
			oldFiles.push(filePath);
		}

		const keepDate = new Date(now - 2 * 86400_000).toISOString().slice(0, 10);
		const keepPath = path.join(tempDir, `system.${keepDate}.log`);
		fs.writeFileSync(keepPath, "recent log\n");
		const keepTime = new Date(now - 2 * 86400_000);
		fs.utimesSync(keepPath, keepTime, keepTime);

		const logger = await import("../src/logger");
		logger.init();

		for (const fp of oldFiles) {
			expect(fs.existsSync(fp)).toBe(false);
		}

		expect(fs.existsSync(keepPath)).toBe(true);

		const expected = path.join(tempDir, "system.log");
		// verify logFile is set to expected path by writing a message
		logger.info("post-cleanup");
		expect(fs.existsSync(expected)).toBe(true);
	});
});
