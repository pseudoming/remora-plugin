---
name: remora-architecture
description: Executes tasks using Remora cognitive architecture. Use this skill when you encounter context-rot, memory loss, dirty environments, or need to orchestrate deep debugging and isolate massive logs.
---

# Remora Coordinator Mode Instructions

You are now in Remora Coordinator Mode. You must strictly follow these instructions to prevent context rot and maintain cognitive stability.

## 1. Global State Database (Single Source of Truth)
The definitive long-term memory and architectural state of this project is stored in an SQLite database located at:
由后台 compactor 自动维护。你不应该直接读取 DB 文件，必须通过 `remora-recall.py` 访问。
This database is automatically populated and maintained by the background `compactor.py` (running in singleton mode). You MUST treat this database as the ONLY Single Source of Truth (SSOT).
You MUST NOT manually write decisions to files like `decisions.md` for historical architecture anchoring.

## 2. Active Recall via Warm Storage
If you are unsure about past decisions, encounter an architectural keyword (e.g., 'compactor', 'database', 'agentapi'), or if a user challenges your memory, NEVER GUESS.
You MUST proactively use the `run_command` tool to execute the official retrieval script:
`{PYTHON} {PLUGIN_ROOT}/scripts/adapter/cli/remora-recall.py "<YOUR_KEYWORD>"`
**CRITICAL**: You MUST NOT use `grep_search` on any legacy text logs to blindly guess historical context. The `remora-recall.py` script is the EXCLUSIVE authorized method to access the `remora_memory.db` SSOT.

## 3. Subagent Delegation Rules (Differentiated)
- **ANTI-CONTEXT-ROT**: For long-chain debugging, massive log analysis, or risky operations, you are STRICTLY PROHIBITED from executing commands directly. You MUST first use `view_file` to read the `remora-architecture` skill instructions, and then use `invoke_subagent` for isolated execution:
  * **Read-Only Log Analysis / Evidence Retrieval / DB Query**: Use `invoke_subagent` with `TypeName: "Remora_ReadOnly_Extractor"` and `Prompt` explaining the facts to retrieve.
  * **Sandbox Debugging / Build Verification / Code Modifying**: Use `invoke_subagent` with `TypeName: "Remora_Deep_Diver"` and `Prompt` specifying the diagnostic or writing tasks.
- **SANDBOX BOUNDARY**: Under Deep_Diver, match your actions to the blast radius. Do not use destructive shortcuts (e.g. bypass hooks, delete locks). Under ReadOnly_Extractor, report outcomes without hedging and never modify any code.
- **MESSAGE BRIDGE PROTOCOL (消息中继桥接协议)**:
  * Whenever you receive a `send_message` progress payload from an active subagent, you MUST immediately extract the key updates.
  * You MUST output a direct, user-facing progress report in the current turn (e.g., "✅ **子特工进度上报**: 子特工 [ID] 物理完成了 [具体改动/测试] 动作"), ensuring the user is fully synchronized.
  * If you receive a `send_message` payload containing `{"remora_event": "user_query", "query": "<msg>"}`:
    1. You MUST immediately print the query to the user in Chinese and wait for the user's decision/answer.
    2. Once the user replies, you MUST immediately call `send_message` back to the subagent with the user's decision to unblock and resume its execution.