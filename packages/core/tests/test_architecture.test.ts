/**
 * Architectural Boundary Enforcement
 *
 * Mirror of scripts/tests/test_architecture.py.
 * Ensures packages/core/src/ never imports from packages/adapter-antigravity/.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGES_ROOT = path.resolve(__dirname, "..", "..");
const CORE_SRC = path.join(PACKAGES_ROOT, "core", "src");
const ADAPTER_PREFIX = "adapter-antigravity";

function tsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { recursive: true })) {
		const full = path.join(dir, entry);
		if (full.endsWith(".ts") && fs.statSync(full).isFile()) {
			results.push(full);
		}
	}
	return results;
}

function checkImports(filepath: string, forbidden: string): string[] {
	const content = fs.readFileSync(filepath, "utf-8");
	const lines = content.split("\n");
	const violations: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().startsWith("//")) continue;
		// Check for relative imports that reach into adapter-antigravity
		if (line.includes("from") && line.includes(forbidden)) {
			violations.push(
				`${path.relative(CORE_SRC, filepath)}:${i + 1}  →  ${line.trim()}`,
			);
		}
		// Check for path references to adapter packages
		if (
			line.includes(`"../../../adapter-antigravity`) ||
			line.includes(`'../../../adapter-antigravity`)
		) {
			violations.push(
				`${path.relative(CORE_SRC, filepath)}:${i + 1}  →  ${line.trim()}`,
			);
		}
	}
	return violations;
}

describe("Architecture", () => {
	it("core/ must never import from adapter-antigravity/", () => {
		const offenders: string[] = [];
		for (const fp of tsFiles(CORE_SRC)) {
			const bad = checkImports(fp, ADAPTER_PREFIX);
			offenders.push(...bad);
		}
		if (offenders.length > 0) {
			expect.fail(
				"❌ ARCHITECTURE VIOLATION: core/ must not import adapter/!\n\n" +
					"The following core files import from adapter-antigravity:\n" +
					offenders.map((o) => `  • ${o}`).join("\n") +
					"\n\nFix: move adapter-dependent logic to packages/adapter-antigravity/.",
			);
		} else {
			expect(offenders).toEqual([]);
		}
	});

	it("core/ must never import from adapter/ relative path", () => {
		const offenders: string[] = [];
		for (const fp of tsFiles(CORE_SRC)) {
			const bad = checkImports(fp, "src/adapter");
			offenders.push(...bad);
		}
		if (offenders.length > 0) {
			expect.fail(
				"❌ ARCHITECTURE VIOLATION: core/ must not import adapter/!\n\n" +
					"The following core files import from adapter relative path:\n" +
					offenders.map((o) => `  • ${o}`).join("\n") +
					"\n\nFix: move adapter-dependent logic to packages/adapter-antigravity/.",
			);
		} else {
			expect(offenders).toEqual([]);
		}
	});

	it("cli files must contain require.main === module or import.meta.url", () => {
		const cliDir = path.join(
			PACKAGES_ROOT,
			"adapter-antigravity",
			"src",
			"cli",
		);
		if (!fs.existsSync(cliDir)) {
			expect.fail(`CLI directory not found at: ${cliDir}`);
		}
		const files = fs.readdirSync(cliDir).filter((file) => {
			return (
				(file.startsWith("remora-") || file.startsWith("read-")) &&
				file.endsWith(".ts")
			);
		});
		expect(files.length).toBeGreaterThan(0);

		const missingGuards: string[] = [];
		for (const file of files) {
			const fullPath = path.join(cliDir, file);
			const content = fs.readFileSync(fullPath, "utf-8");
			if (
				!content.includes("require.main === module") &&
				!content.includes("import.meta.url")
			) {
				missingGuards.push(file);
			}
		}

		if (missingGuards.length > 0) {
			expect.fail(
				"❌ CLI ENTRY GUARD VIOLATION: The following CLI files lack require.main === module or import.meta.url:\n" +
					missingGuards.map((f) => `  • ${f}`).join("\n"),
			);
		}
	});
});
