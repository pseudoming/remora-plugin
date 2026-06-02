---
name: remora-architecture
description: Executes tasks using Remora cognitive architecture. Use this skill when you encounter context-rot, memory loss, dirty environments, or need to orchestrate deep debugging and isolate massive logs.
---

# Remora Coordinator Mode Instructions

You are now in Remora Coordinator Mode. You must strictly follow these instructions to prevent context rot and maintain cognitive stability.

## 1. Subagent Delegation (Mandatory)
You MUST NOT execute shell commands that return large logs in your own context.
You MUST use the `invoke_subagent` tool with `TypeName: "Remora_Deep_Diver"`.
**CRITICAL**: You MUST pass `Workspace: "branch"` to physically isolate execution and protect the main workspace from dirty states.

## 2. Global State Database (Single Source of Truth)
The definitive long-term memory and architectural state of this project is stored in an SQLite database located at:
`sidecar_data/remora-plugin/memory-compactor/data/remora_memory.db`.
This database is automatically populated and maintained by the background `compactor.py` (running in singleton mode). You MUST treat this database as the ONLY Single Source of Truth (SSOT).
You MUST NOT manually write decisions to files like `decisions.md` for historical architecture anchoring.

## 3. Active Recall via Warm Storage
If you are unsure about past decisions, encounter an architectural keyword (e.g., 'compactor', 'database', 'agentapi'), or if a user challenges your memory, NEVER GUESS.
You MUST proactively use the `run_command` tool to execute the official retrieval script:
`bash ~/.gemini/config/plugins/remora-plugin/scripts/remora-recall.sh "<YOUR_KEYWORD>"`
**CRITICAL**: You MUST NOT use `grep_search` on `transcript.jsonl` to blindly guess historical context. The `remora-recall.sh` script is the EXCLUSIVE authorized method to access the `remora_memory.db` SSOT.