import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

function walkFiles(
	dir: string,
	extensions: string[],
	generatedFiles: Set<string>,
	pluginRoot: string | null,
): string[] {
	const result: string[] = [];
	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const relPath = path.relative(pluginRoot ?? dir, fullPath);

		if (entry.isDirectory()) {
			if (
				entry.name === ".git" ||
				entry.name === "__pycache__" ||
				entry.name === "node_modules" ||
				entry.name === "scratch" ||
				entry.name === ".agents"
			) {
				continue;
			}
			result.push(
				...walkFiles(fullPath, extensions, generatedFiles, pluginRoot),
			);
		} else if (entry.isFile()) {
			if (
				generatedFiles.has(entry.name) ||
				entry.name === "ORIGINAL_REQUEST.md"
			) {
				continue;
			}
			if (
				relPath.startsWith("agents" + path.sep) &&
				entry.name.endsWith(".json") &&
				!entry.name.endsWith(".template.json")
			) {
				continue;
			}
			if (extensions.some((ext) => entry.name.endsWith(ext))) {
				result.push(fullPath);
			}
		}
	}

	return result;
}

describe("QualityGate", () => {
	let pluginRoot: string;

	beforeEach(() => {
		pluginRoot = path.resolve(__dirname, "..", "..", "..");
	});

	function getAllFiles(extensions: string[]): string[] {
		const generatedFiles = new Set([
			"hooks.json",
			"sidecar.json",
			"SKILL.md",
			"mcp_config.json",
		]);
		return walkFiles(pluginRoot, extensions, generatedFiles, pluginRoot);
	}

	it("no hardcoded tmp paths", () => {
		const badTmpPattern = new RegExp("/tmp/remora_", "g");

		for (const filePath of getAllFiles([".py", ".md", ".json"])) {
			if (filePath === path.resolve(__filename)) {
				continue;
			}
			if (path.basename(filePath) === "test_quality_gate.py") {
				continue;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			const matches = Array.from(content.matchAll(badTmpPattern));
			expect(matches).toEqual([]);
		}
	});

	it("no hardcoded absolute gemini paths", () => {
		const badHomePattern = new RegExp(
			"~/\\.gemini/(?!antigravity|config/)",
			"g",
		);
		const badAbsPattern = new RegExp(
			"/home/[^/]+/\\.gemini/(?!antigravity)",
			"g",
		);

		for (const filePath of getAllFiles([".py", ".md", ".json"])) {
			if (filePath === path.resolve(__filename)) {
				continue;
			}
			if (path.basename(filePath) === "test_quality_gate.py") {
				continue;
			}
			if (path.basename(filePath) === "install.py") {
				continue;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			const matches = Array.from(content.matchAll(badHomePattern));
			const absMatches = Array.from(content.matchAll(badAbsPattern));
			expect([...matches, ...absMatches]).toEqual([]);
		}
	});

	it("no dangerous file reads", () => {
		const badReadlines = new RegExp("\\.readlines\\(\\)", "g");

		for (const filePath of getAllFiles([".py"])) {
			if (filePath === path.resolve(__filename)) {
				continue;
			}
			if (path.basename(filePath) === "test_quality_gate.py") {
				continue;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			const matches = Array.from(content.matchAll(badReadlines));
			expect(matches).toEqual([]);
		}
	});

	it("no arbitrary python subprocess", () => {
		const badPython3 = new RegExp(
			"subprocess\\.(?:run|Popen|call)\\(\\s*\\[?\\s*['\"]python3['\"]",
			"g",
		);

		for (const filePath of getAllFiles([".py"])) {
			if (filePath === path.resolve(__filename)) {
				continue;
			}
			if (path.basename(filePath) === "test_quality_gate.py") {
				continue;
			}
			const content = fs.readFileSync(filePath, "utf-8");
			const matches = Array.from(content.matchAll(badPython3));
			expect(matches).toEqual([]);
		}
	});
});
