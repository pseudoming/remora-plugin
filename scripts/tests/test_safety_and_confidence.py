#!/usr/bin/env python3
import sys
import os
import unittest
import sqlite3
import base64

# 动态将插件下的 scripts 和 sidecars 注入环境变量路径
PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(PLUGIN_DIR, "sidecars", "memory-compactor"))
sys.path.insert(0, os.path.join(PLUGIN_DIR, "scripts"))

# 导入要测试的模块
from safety_rules import inspect_command, decode_base64_token
from extract_decisions import calculate_factual_confidence

class TestSafetyRules(unittest.TestCase):
    def test_allow_rules(self):
        # 验证常规指令正确放行
        cases = [
            "ls -la",
            "git status",
            "cat README.md",
            "python3 main.py",
            "echo 'hello world'"
        ]
        for cmd in cases:
            decision, cat = inspect_command(cmd)
            self.assertEqual(decision, "allow")
            self.assertEqual(cat, "")

    def test_deny_rules_test(self):
        # 验证敏感测试指令拦截
        cases = [
            "pytest",
            "jest",
            "npm test",
            "mvn test",
            "gradlew test",
            "npm run test",
            "yarn test",
            "python3 -m pytest",
            "python -c 'import pytest; pytest.main()'",
            "node -e 'require(\"jest\")'"
        ]
        for cmd in cases:
            decision, cat = inspect_command(cmd)
            self.assertEqual(decision, "deny")
            self.assertEqual(cat, "test")

    def test_deny_rules_build(self):
        # 验证敏感构建指令拦截
        cases = [
            "npm run build",
            "gradlew build",
            "mvn package",
            "mvn install"
        ]
        for cmd in cases:
            decision, cat = inspect_command(cmd)
            self.assertEqual(decision, "deny")
            self.assertEqual(cat, "build")

    def test_base64_decoding_and_audit(self):
        # 验证 base64 解码与拦截
        # 1. 验证 decode_base64_token 基础逻辑
        self.assertIsNone(decode_base64_token("short_token")) # 太短，低于16字节
        self.assertIsNone(decode_base64_token("not_base64_chars!@#$"))
        
        # 编码 "pytest --verbose" (长度为16字节，如果加上空格大于16)
        # "pytest --verbose" base64 -> cHl0ZXN0IC0tdmVyYm9zZQ==
        b64_str = "cHl0ZXN0IC0tdmVyYm9zZQ=="
        self.assertEqual(decode_base64_token(b64_str), "pytest --verbose")

        # 2. 验证包含该 base64 token 的命令能否正确穿透并被拦截为 deny
        # 模拟执行 "echo cHl0ZXN0IC0tdmVyYm9zZQ=="
        decision, cat = inspect_command(f"echo {b64_str}")
        self.assertEqual(decision, "deny")
        self.assertEqual(cat, "test")

    def test_syntax_error_fallback(self):
        # 验证无法分词的异常语法的正则回退
        decision, cat = inspect_command('echo "unclosed quote')
        self.assertEqual(decision, "deny")
        self.assertEqual(cat, "syntax_error")

        decision, cat = inspect_command('echo "unclosed quote pytest')
        self.assertEqual(decision, "deny")
        self.assertEqual(cat, "test")

class TestFactualConfidence(unittest.TestCase):
    def setUp(self):
        # 初始化内存数据库并创建所需的表结构
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("""
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
        """)
        self.conn.commit()

    def tearDown(self):
        self.conn.close()

    def test_empty_baseline(self):
        # 当 baseline 没有任何内容时，默认置信度应该为 1.0
        confidence = calculate_factual_confidence(self.conn, [], [], [])
        self.assertEqual(confidence, 1.0)

    def test_full_coverage(self):
        # 1. 插入 mock 行为数据 (user_confirmed=1)
        self.conn.execute("INSERT INTO topic_decisions (id, user_confirmed) VALUES (101, 1)")
        self.conn.execute("INSERT INTO topic_decisions (id, user_confirmed) VALUES (102, 1)")
        self.conn.commit()

        # 2. 准备 baseline 物理写文件列表和已确认决策列表
        baseline_files = ["safety-rules.py", "intent-detector.py"]
        baseline_actions = ["confirm:101", "confirm:102"]

        # 3. 准备大模型生成的话题内容 (包含所需文件名)
        output_topics = [
            {
                "topic_id": "t_001",
                "decisions": [
                    {
                        "decision": "refactor safety-rules.py and update intent-detector.py",
                        "rationale": "for modularity"
                    }
                ]
            }
        ]

        # 4. 期待 4 个元素全部覆盖，置信度为 1.0
        confidence = calculate_factual_confidence(
            self.conn, baseline_files, baseline_actions, output_topics
        )
        self.assertEqual(confidence, 1.0)

    def test_partial_coverage(self):
        # 1. 插入一真一假的行为数据 (101为confirmed, 102未confirmed)
        self.conn.execute("INSERT INTO topic_decisions (id, user_confirmed) VALUES (101, 1)")
        self.conn.execute("INSERT INTO topic_decisions (id, user_confirmed) VALUES (102, 0)")
        self.conn.commit()

        baseline_files = ["safety-rules.py", "intent-detector.py"]
        baseline_actions = ["confirm:101", "confirm:102"]

        # 大模型生成结果中只提到了 safety-rules.py
        output_topics = [
            {
                "topic_id": "t_001",
                "decisions": [
                    {
                        "decision": "refactor safety-rules.py only",
                        "rationale": "skip other files"
                    }
                ]
            }
        ]

        # 元素覆盖率计算：
        # - baseline_files: safety-rules.py (覆盖), intent-detector.py (未覆盖) -> 1/2
        # - baseline_actions: confirm:101 (覆盖, 因为 db 字段 user_confirmed=1), confirm:102 (未覆盖, 因为 user_confirmed=0) -> 1/2
        # - 总覆盖: 2 / 4 = 0.50
        confidence = calculate_factual_confidence(
            self.conn, baseline_files, baseline_actions, output_topics
        )
        self.assertEqual(confidence, 0.5)

if __name__ == "__main__":
    unittest.main()
