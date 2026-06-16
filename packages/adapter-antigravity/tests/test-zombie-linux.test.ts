import { describe, it, expect, vi, beforeEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";

const {
	mockReadFileSync,
	mockExistsSync,
	mockMkdirSync,
	mockWriteFileSync,
	realFs,
} = vi.hoisted(() => ({
	mockReadFileSync: vi.fn(),
	mockExistsSync: vi.fn(),
	mockMkdirSync: vi.fn(),
	mockWriteFileSync: vi.fn(),
	realFs: { value: null as any },
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	realFs.value = actual;
	return {
		...actual,
		readFileSync: mockReadFileSync,
		existsSync: mockExistsSync,
		mkdirSync: mockMkdirSync,
		writeFileSync: mockWriteFileSync,
	};
});

import { getSysUptime, cleanWhitelist } from "../src/sandbox/zombie-linux";

beforeEach(() => {
	vi.clearAllMocks();
	mockReadFileSync.mockImplementation((...args: any[]) => {
		return realFs.value.readFileSync(...args);
	});
	mockExistsSync.mockImplementation((...args: any[]) => {
		return realFs.value.existsSync(...args);
	});
	mockMkdirSync.mockImplementation((...args: any[]) => {
		return realFs.value.mkdirSync(...args);
	});
	mockWriteFileSync.mockImplementation((...args: any[]) => {
		return realFs.value.writeFileSync(...args);
	});
});

// ============================================================
// getSysUptime
// ============================================================

describe("TestGetSysUptime", () => {
	it("test_normal", () => {
		mockReadFileSync.mockImplementation(
			(filePath: string, encoding?: string) => {
				if (filePath === "/proc/uptime" && encoding === "utf-8") {
					return "123.45 67.89\n";
				}
				return realFs.value.readFileSync(filePath, encoding);
			},
		);
		const val = getSysUptime();
		expect(val).toBe(123.45);
	});

	it("test_exception_returns_zero", () => {
		mockReadFileSync.mockImplementation(
			(filePath: string, encoding?: string) => {
				if (filePath === "/proc/uptime") {
					throw new Error("fail");
				}
				return realFs.value.readFileSync(filePath, encoding);
			},
		);
		const val = getSysUptime();
		expect(val).toBe(0.0);
	});
});

// ============================================================
// cleanWhitelist
// ============================================================

describe("TestCleanWhitelist", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = realFs.value.mkdtempSync(path.join(os.tmpdir(), "remora_zombie_"));
	});

	it("test_file_not_exists", () => {
		const nonexistent = path.join(tmpDir, "nonexistent");
		mockExistsSync.mockImplementation((p: string) => {
			if (p === nonexistent) return false;
			return realFs.value.existsSync(p);
		});
		const result = cleanWhitelist(nonexistent);
		expect(result).toEqual(new Set());
	});

	it("test_stale_pids_cleaned", () => {
		const whitelistPath = path.join(tmpDir, "whitelist");
		realFs.value.writeFileSync(whitelistPath, "123\n456\n789\n");

		mockExistsSync.mockImplementation((p: string) => {
			if (p === whitelistPath) return true;
			if (p.includes("/proc/")) {
				if (p.includes("/proc/456")) return true;
				return false;
			}
			return realFs.value.existsSync(p);
		});

		mockWriteFileSync.mockImplementation(
			(p: string, data: string, encoding?: string) => {
				if (p === whitelistPath) {
					realFs.value.writeFileSync(p, data, encoding);
					return;
				}
				realFs.value.writeFileSync(p, data, encoding);
			},
		);

		const result = cleanWhitelist(whitelistPath);
		expect(result).toEqual(new Set(["456"]));
		const content = realFs.value.readFileSync(whitelistPath, "utf-8");
		expect(content).not.toContain("123");
		expect(content).not.toContain("789");
		expect(content).toContain("456");
	});

	it("test_valid_pids_kept", () => {
		const whitelistPath = path.join(tmpDir, "whitelist");
		realFs.value.writeFileSync(whitelistPath, "111\n222\n333\n");

		mockExistsSync.mockImplementation((p: string) => {
			if (p === whitelistPath) return true;
			if (p.includes("/proc/")) return true;
			return realFs.value.existsSync(p);
		});

		const result = cleanWhitelist(whitelistPath);
		expect(result).toEqual(new Set(["111", "222", "333"]));
		const content = realFs.value.readFileSync(whitelistPath, "utf-8");
		expect(content).toContain("111");
		expect(content).toContain("222");
		expect(content).toContain("333");
	});

	it("test_empty_lines_ignored", () => {
		const whitelistPath = path.join(tmpDir, "whitelist");
		realFs.value.writeFileSync(whitelistPath, "\n\n42\n\n\n");

		mockExistsSync.mockImplementation((p: string) => {
			if (p === whitelistPath) return true;
			if (p.includes("/proc/42")) return true;
			return false;
		});

		const result = cleanWhitelist(whitelistPath);
		expect(result).toEqual(new Set(["42"]));
		const content = realFs.value.readFileSync(whitelistPath, "utf-8");
		expect(content.trim()).toBe("42");
	});

	it("test_read_exception_graceful", () => {
		const whitelistPath = path.join(tmpDir, "whitelist");
		realFs.value.writeFileSync(whitelistPath, "111\n");

		mockExistsSync.mockImplementation((p: string) => {
			if (p === whitelistPath) return true;
			return realFs.value.existsSync(p);
		});

		mockReadFileSync.mockImplementation(() => {
			throw new Error("fail");
		});

		const result = cleanWhitelist(whitelistPath);
		expect(result).toEqual(new Set());
	});
});
