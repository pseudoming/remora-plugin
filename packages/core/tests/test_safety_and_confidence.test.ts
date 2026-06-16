import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { inspectCommand, decodeBase64Token } from "../src/rules/inspector";
import {
	calculateFactualConfidence,
	validateIdInheritance,
} from "../src/coverage";

describe("TestSafetyRules", () => {
	it("test_allow_rules", () => {
		// 验证常规指令正确放行
		const cases = [
			"ls -la",
			"git status",
			"cat README.md",
			"python3 main.py",
			"echo 'hello world'",
		];
		for (const cmd of cases) {
			const [decision, cat] = inspectCommand(cmd);
			expect(decision).toBe("allow");
			expect(cat).toBe("");
		}
	});

	it("test_deny_rules_test", () => {
		// 验证敏感测试指令拦截
		const cases = [
			"pytest",
			"jest",
			"npm test",
			"mvn test",
			"gradlew test",
			"npm run test",
			"yarn test",
			"python3 -m pytest",
			"python -c 'import pytest; pytest.main()'",
			"node -e 'require(\"jest\")'",
		];
		for (const cmd of cases) {
			const [decision, cat] = inspectCommand(cmd);
			expect(decision).toBe("deny");
			expect(cat).toBe("test");
		}
	});

	it("test_deny_rules_build", () => {
		// 验证敏感构建指令拦截
		const cases = [
			"npm run build",
			"gradlew build",
			"mvn package",
			"mvn install",
		];
		for (const cmd of cases) {
			const [decision, cat] = inspectCommand(cmd);
			expect(decision).toBe("deny");
			expect(cat).toBe("build");
		}
	});

	it("test_base64_decoding_and_audit", () => {
		// 验证 base64 解码与拦截
		// 1. 验证 decode_base64_token 基础逻辑
		expect(decodeBase64Token("short_token")).toBeNull(); // 太短，低于16字节
		expect(decodeBase64Token("not_base64_chars!@#$")).toBeNull();

		// 编码 "pytest --verbose" (长度为16字节，如果加上空格大于16)
		// "pytest --verbose" base64 -> cHl0ZXN0IC0tdmVyYm9zZQ==
		const b64Str = "cHl0ZXN0IC0tdmVyYm9zZQ==";
		expect(decodeBase64Token(b64Str)).toBe("pytest --verbose");

		// 2. 验证包含该 base64 token 的命令能否正确穿透并被拦截为 deny
		// 模拟执行 "echo cHl0ZXN0IC0tdmVyYm9zZQ=="
		const [decision, cat] = inspectCommand(`echo ${b64Str}`);
		expect(decision).toBe("deny");
		expect(cat).toBe("test");
	});

	it("test_syntax_error_fallback", () => {
		// 验证无法分词的异常语法的正则回退
		const [decision1, cat1] = inspectCommand('echo "unclosed quote');
		expect(decision1).toBe("deny");
		expect(cat1).toBe("syntax_error");

		const [decision2, cat2] = inspectCommand('echo "unclosed quote pytest');
		expect(decision2).toBe("deny");
		expect(cat2).toBe("test");
	});
});

describe("TestFactualConfidence", () => {
	let conn: Database.Database;

	// 初始化内存数据库并创建所需的表结构
	function setUp(): void {
		conn = new Database(":memory:");
		conn.exec(`
            CREATE TABLE topic_decisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_uuid TEXT,
                topic_id TEXT,
                conversation_id TEXT,
                decision TEXT,
                rationale TEXT,
                evidence_msg_ids TEXT,
                user_confirmed INTEGER,
                created_at_line INTEGER
            )
        `);
	}

	function tearDown(): void {
		conn.close();
	}

	it("test_empty_baseline", () => {
		// 当 baseline 没有任何内容时，默认置信度应该为 1.0
		setUp();
		try {
			const confidence = calculateFactualConfidence([], [], []);
			expect(confidence).toBe(1.0);
		} finally {
			tearDown();
		}
	});

	it("test_full_coverage", () => {
		setUp();
		try {
			// 1. 插入 mock 行为数据 (user_confirmed=1)
			conn
				.prepare(
					"INSERT INTO topic_decisions (id, user_confirmed) VALUES (101, 1)",
				)
				.run();
			conn
				.prepare(
					"INSERT INTO topic_decisions (id, user_confirmed) VALUES (102, 1)",
				)
				.run();

			// 2. 准备 baseline 物理写文件列表和已确认决策列表
			const baselineFiles = ["safety-rules.py", "intent-detector.py"];
			const baselineActions = ["confirm:101", "confirm:102"];

			// 3. 准备大模型生成的话题内容 (包含所需文件名)
			const outputTopics = [
				{
					topic_id: "t_001",
					decisions: [
						{
							decision:
								"refactor safety-rules.py and update intent-detector.py",
							rationale: "for modularity",
						},
					],
				},
			];

			// 4. 期待 4 个元素全部覆盖，置信度为 1.0
			const confidence = calculateFactualConfidence(
				baselineFiles,
				baselineActions,
				outputTopics,
				conn
			);
			expect(confidence).toBe(1.0);
		} finally {
			tearDown();
		}
	});

	it("test_partial_coverage", () => {
		setUp();
		try {
			// 1. 插入一真一假的行为数据 (101为confirmed, 102未confirmed)
			conn
				.prepare(
					"INSERT INTO topic_decisions (id, user_confirmed) VALUES (101, 1)",
				)
				.run();
			conn
				.prepare(
					"INSERT INTO topic_decisions (id, user_confirmed) VALUES (102, 0)",
				)
				.run();

			const baselineFiles = ["safety-rules.py", "intent-detector.py"];
			const baselineActions = ["confirm:101", "confirm:102"];

			// 大模型生成结果中只提到了 safety-rules.py
			const outputTopics = [
				{
					topic_id: "t_001",
					decisions: [
						{
							decision: "refactor safety-rules.py only",
							rationale: "skip other files",
						},
					],
				},
			];

			// 元素覆盖率计算：
			// - baseline_files: safety-rules.py (覆盖), intent-detector.py (未覆盖) -> 1/2
			// - baseline_actions: confirm:101 (覆盖, 因为 db 字段 user_confirmed=1), confirm:102 (未覆盖, 因为 user_confirmed=0) -> 1/2
			// - 总覆盖: 2 / 4 = 0.50
			const confidence = calculateFactualConfidence(
				baselineFiles,
				baselineActions,
				outputTopics,
				conn
			);
			expect(confidence).toBe(0.5);
		} finally {
			tearDown();
		}
	});

	it("test_validate_id_inheritance_warning", () => {
		setUp();
		try {
			// 1. Insert user_confirmed=1 topic decisions
			conn
				.prepare(
					"INSERT INTO topic_decisions (id, project_uuid, user_confirmed) VALUES (201, 'p1', 1)",
				)
				.run();
			conn
				.prepare(
					"INSERT INTO topic_decisions (id, project_uuid, user_confirmed) VALUES (202, 'p1', 1)",
				)
				.run();

			// 2. Prepare new topics that miss ID 202
			const newTopics = [
				{
					topic_id: "t_001",
					decisions: [
						{
							decision: "some decision",
							inherited_from: [201],
						},
					],
				},
			];

			// 3. Call and check that it prints warning and returns True instead of throwing
			let threw = false;
			try {
				const result = validateIdInheritance("p1", newTopics);
				expect(result).toBe(true);
			} catch (_e) {
				threw = true;
			}
			expect(threw).toBe(false);
		} finally {
			tearDown();
		}
	});
});
