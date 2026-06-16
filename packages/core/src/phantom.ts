export const ACTION_PATTERNS: RegExp[] = [
	new RegExp(
		"(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\\s*\\[([a-zA-Z0-9_\\-\\.\\/]+\\.[a-zA-Z0-9]+)\\]\\(file:\\/\\/[^\\)]+\\)",
		"i",
	),
	new RegExp(
		"(?:已|成功)在\\s*\\[([a-zA-Z0-9_\\-\\.\\/]+\\.[a-zA-Z0-9]+)\\]\\(file:\\/\\/[^\\)]+\\)\\s*中\\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?",
		"i",
	),
	new RegExp(
		"(?:已|成功)在\\s*[`'\"?]?([a-zA-Z0-9_\\-\\.\\/]+\\.[a-zA-Z0-9]+)[`'\"?]?\\s*中\\s*(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?",
		"i",
	),
	new RegExp(
		"(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\\s*[`'\"?](([a-zA-Z0-9_\\-\\.\\/]+\\.[a-zA-Z0-9]+))[`'\"?]?",
		"i",
	),
	new RegExp(
		"(?:(?:已|成功)(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了?|(?:修改|更新|覆写|写入|创建|修正|调整|重写|添加)了)(?:文件)?\\s*\\b([a-zA-Z0-9_\\-\\.\\/]+\\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\\b",
		"i",
	),
	new RegExp(
		"(?:updated|modified|written|created|overwritten|adjusted|rewritten)\\s*(?:file)?\\s*[`'\"?]([a-zA-Z0-9_\\-\\.\\/]+\\.[a-zA-Z0-9]+)[`'\"?]?",
		"i",
	),
	new RegExp(
		"(?:updated|modified|written|created|overwritten|adjusted|rewritten)\\s*(?:file)?\\s*\\b([a-zA-Z0-9_\\-\\.\\/]+\\.(?:py|md|json|sql|js|ts|sh|xml|txt|jsonl|log))\\b",
		"i",
	),
];

/**
 * 标准化提取同义路径键名，带类型防护。
 * 从 arguments 字典中提取文件路径并返回 basename。
 */
export function normalizeFilepath(argumentsDict: unknown): string {
	if (
		argumentsDict === null ||
		typeof argumentsDict !== "object" ||
		Array.isArray(argumentsDict)
	) {
		return "";
	}
	const dict = argumentsDict as Record<string, unknown>;
	const aliases = ["TargetFile", "AbsolutePath", "FilePath", "Target"];
	for (const alias of aliases) {
		const val = dict[alias];
		if (typeof val === "string" && val.length > 0) {
			const cleaned = val.replace(/^['"]+|['"]+$/g, "");
			const parts = cleaned.replace(/\\/g, "/").split("/");
			return parts[parts.length - 1];
		}
	}
	return "";
}

/**
 * 计算 phantom 修改：声明修改但实际未修改的文件集合。
 */
export function resolvePhantomModifications(
	declaredFiles: Set<string>,
	actualFiles: Set<string>,
): Set<string> {
	const result = new Set<string>();
	for (const f of declaredFiles) {
		if (!actualFiles.has(f)) {
			result.add(f);
		}
	}
	return result;
}
