import * as path from "node:path";
process.env.REMORA_DATA_DIR = path.resolve(__dirname, "temp_test_data");
process.env.REMORA_DB_PATH = path.join(process.env.REMORA_DATA_DIR, "remora_memory_test.db");

import { vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

// Ensure the sandboxed runtime directories and installed.flag exist
const tempRuntimeDir = path.join(process.env.REMORA_DATA_DIR, ".runtime");
if (!fs.existsSync(tempRuntimeDir)) {
	fs.mkdirSync(tempRuntimeDir, { recursive: true });
}
fs.writeFileSync(path.join(tempRuntimeDir, "installed.flag"), "test-initialized");



const KEYWORDS_PATH = path.resolve(
	__dirname ?? process.cwd(),
	"..",
	"..",
	"..",
	"conf",
	"keywords.json",
);

let keywordsBackup: string | null = null;

beforeEach(() => {
	if (fs.existsSync(KEYWORDS_PATH)) {
		keywordsBackup = fs.readFileSync(KEYWORDS_PATH, "utf-8");
	} else {
		keywordsBackup = null;
	}
});

afterEach(() => {
	if (keywordsBackup !== null) {
		fs.writeFileSync(KEYWORDS_PATH, keywordsBackup, "utf-8");
	} else if (fs.existsSync(KEYWORDS_PATH)) {
		fs.unlinkSync(KEYWORDS_PATH);
	}
});
