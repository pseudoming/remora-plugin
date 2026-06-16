import { vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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
