# Remora Project AI Agent Rules

## ⚠️ PROJECT IDENTITY: THIS IS remora-plugin, NOT remora
- This repository is the **Remora Antigravity Plugin** (`~/.gemini/config/plugins/remora-plugin`).
- There is a **separate** repository called `remora` (at `/home/agent/wsl_code/remora`) which is the concept/prototype project.
- **DO NOT** commit changes from this repo to the other one. They are different projects.
- **DO NOT** reference `/home/agent/wsl_code/remora` in this codebase. All file paths and git operations belong to THIS project's directory.

## LARGE FILE SAFETY
When reading or parsing potentially large log files (`*.jsonl`, etc.) in this project, you **MUST NEVER** use `f.readlines()` or load the entire file into memory at once. You **MUST** prioritize native shell utilities (`tail`, `grep`, `awk`) or use buffered/streaming reads to ensure O(1) memory footprint and minimal I/O latency.

## ARCHITECTURE INVARIANTS (FAILURE = BUILD FAILURE)

### 1. Core/Adapter Boundary
- `scripts/core/` modules **MUST NEVER** import from `scripts/adapter/`. Violations are caught by `test_architecture.py`.
- `scripts/core/` contains pure business logic with zero Antigravity dependencies.
- `scripts/adapter/` may import from `scripts/core/` — this direction is allowed and expected.

### 2. DAO Access Gate
- All database read/write operations go through `scripts/lib/dao.py` (the re-export facade).
- Direct `sqlite3.connect(get_db_path())` calls outside of `core/storage/` modules are forbidden.

### 3. Import Boundary Enforcement
- `test_architecture.py` runs on every CI build. Any import that crosses the wrong boundary will fail the test instantly.
- Before creating new files, verify which side of the boundary they belong on:
  - Antigravity-dependent (conversation.db, agentapi, hook protocol) → `adapter/`
  - Pure logic with no platform dependency → `core/`

## ARCHITECTURE & REFACTORING DISCIPLINE

### 1. Hook Schema Strictness
When developing Antigravity Hooks (e.g., PreInvocation, PreToolUse), you **MUST NEVER** inject arbitrary/custom keys into the JSON payload. Unrecognized fields will instantly crash the `protojson` unmarshaler and bring down the AgentExecutor.

- ❌ **BAD:**
```python
inject_steps.append({
    "decision": "fallback",
    "error_reason": "Missing initialized variable" # Fatal: causes protojson crash
})
```

- ✅ **GOOD:**
```python
import sys
# Log custom debugging info strictly to stderr
print("[Hook Error] Missing initialized variable", file=sys.stderr)
inject_steps.append({
    "decision": "fallback",
    "decision_reason": "Internal state error" # Standard schema key
})
```

### 2. Zombie State Eradication (幽灵变量消除)
When deleting an initialization or setup function call during refactoring, you **MUST** exhaustively search and remove all downstream conditionals, flags, or state checks that depend on it.

- ❌ **BAD:** Deleting `init_environment()` but leaving `if initialized:` further down the file, which causes a `NameError`.
- ✅ **GOOD:** Performing a full text search for all usages of `initialized` and structurally removing the dead branches before committing.

### 3. Bulk Refactoring Coverage Assertion
When performing global string/path replacements (e.g., migrating `/tmp` to SQLite), you **MUST ALWAYS** follow up with a global `grep_search` across the repository to assert 100% coverage.

- ❌ **BAD:** Running a quick fuzzy python script to replace `/tmp` and assuming it fixed everything.
- ✅ **GOOD:** Running `grep -r "/tmp/" src/` immediately after your script finishes to find and manually patch the edge cases your regex missed.

### 4. Sandbox Verification & Clean Install Preview
For complex scripts, installation orchestrators (`install.py`), or drafts, you MUST write them to the `scratch/` directory and perform static verification. Specifically for installers, you **MUST** mentally walk through or simulate a **clean install** scenario.

- ❌ **BAD:** Assuming `os.listdir("agents")` works because the folder exists in your current development tree, which will crash with `FileNotFoundError` on a brand new machine.
- ✅ **GOOD:** Using guard clauses like `if os.path.exists("agents"):` or `os.makedirs("agents", exist_ok=True)` to handle empty states.

### 5. Commit Message Strictness & Phase Reports
When submitting changes to the repository, AI agents **MUST ALWAYS** format their commit messages according to the structured Phase Report standard. You **MUST NEVER** use lazy, sparse, or one-liner commit messages.

### Standard Format:
```
[Phase X Report] <Brief Title of Phase Completion>

Changelog:
- <file_path_1>:
  * <Detailed itemized change 1>
  * <Detailed itemized change 2>
- <file_path_2>:
  * <Detailed itemized change>
```

- ❌ **BAD:**
```bash
git commit -m "fix sqlite bug and clean code"
```

- ✅ **GOOD:**
```bash
git commit -m "[Phase 37 Report] Consolidated SQLite MCP, Subagent Realignment & Session Guardian Bug Fix

Changelog:
- scripts/session-guardian.py:
  * Added subagent detection check to prevent overwriting parent session ID.
- agents/remora_readonly_extractor.template.json:
  * Restricted extraction tools to plain text only."
```

### 6. Artifact Synchronization & Phase Archiving (制品同步与阶段归档)
Every time a phase or task is completed and before submitting your changes, you **MUST** review all project planning artifacts (`walkthrough.md`, `task.md`, `implementation_plan.md`). You **MUST** ensure all completed sub-tasks are marked as `[x]`, the walkthrough is updated to reflect the final implementation details (not intermediate drafts), and stale/completed plans are appropriately archived.

### 7. Environment Hygiene & Stale Script Cleanup (环境卫生与临时脚本清理)
You **MUST ALWAYS** actively delete any temporary files, diagnostic scripts, test compilation caches, or hack scripts created in the `scratch/` directory or project tree immediately after diagnosing and fixing the root cause. Do not leave trailing debug scrap behind to pollute the codebase.

## KNOWN TECHNICAL DEBT (Phase 51 Audit)

### Dead Code — Functions with ZERO production callers (only tests invoke them)

| Function | File | Line |
|----------|------|------|
| `get_files_by_topic()` | `core/storage/file_changes.py` | :14 |
| `delete_hook_state()` | `core/storage/runtime_state.py` | :62 |

Remaining two: `get_files_by_topic` is forward-looking symmetric design with `get_decisions_by_file` (Phase 43, possible future topic-context injection). `delete_hook_state` had a real caller in Phase 39-40 Git Commit Gate, orphaned when gate was removed. Both safe to remove or keep.

### Confirmed Bugs

*No outstanding confirmed bugs.*

### Architecture Violation — Sidecar has raw SQL in adapter layer (✅ RESOLVED Phase 52)

All `adapter/sidecar/compactor/` files now route through `core/storage/` → `lib/dao.py`. New DAO functions accept external `conn` parameter for transaction consistency.

| File | SQL operations | Status |
|------|---------------|--------|
| `warm_storage_sync.py` | INSERT/DELETE messages, watermarks, event_queue | ✅ All moved to `core/storage/messages.py` |
| `extract_decisions.py` | INSERT/UPSERT project_topics, topic_decisions, watermarks | ✅ All moved to `core/storage/topics.py`/`decisions.py`/`messages.py` |
| `consume_events.py` | SELECT/UPDATE topic_decisions, event_queue | ✅ All moved to `core/storage/decisions.py`/`artifacts.py` |
| `check_approval.py` | SELECT artifact_hashes, messages; INSERT event_queue | ✅ All moved to `core/storage/artifacts.py` |
| `sync_artifacts.py` | INSERT/DELETE messages, INSERT event_queue, project_topics | ✅ All moved to `core/storage/artifacts.py` |
| `scan_sessions.py` | SELECT watermarks | ✅ No raw SQL remaining |
| `compactor.py` | SELECT DISTINCT project_topics | ✅ Moved to `core/storage/topics.py` |

New core modules: `core/storage/messages.py`, `core/storage/artifacts.py`, `core/text_analysis.py`

### Platform-Agnostic Extraction (Phase 52)

| Function | Source | Destination |
|----------|--------|-------------|
| `scan_approval_signals()` | `check_approval.py` | `core/text_analysis.py` |
| `suggest_zombie_action()` | `subagent-monitor.py` | `core/liveness.py` |
| Approval config (keywords, negation prefixes) | hardcoded in check_approval.py | `conf/approval.json` |

### Phase 52 — File-touch injection (COMPLETED, committed)

cognitive-push PreToolUse calls `get_decisions_by_file()` on write gate allow path.
+2 test cases (#7 inject, #8 dedup).

### Architecture Cleanup (Phase 52)

- `update_watermark` merged: decisions.py copy removed, messages.py version is canonical
- `get_open_topic(conn, ...)` separated from existing `get_active_topic(project_uuid)` to avoid signature collision
- `get_all_project_uuids(conn)` added to `topics.py` for compactor dispatch loop

## PENDING WORK — Roadmap Items

### Route C: Operational Optimization

| # | Task | Status | Dependencies |
|---|------|--------|-------------|
| C2 | **Auto-compression**: High-frequency decisions (injected_count > N, user_confirmed=1) → LLM one-line summary → `compressed_summary` column. Injection points prefer compressed summary over full text. | BLOCKED | Needs C1 data (1-2 weeks of injected_count accumulation to determine threshold) |
| C3 | **Context budget balancing**: Per-session token tracking for memory injection. Prioritize high-value decisions when context window is tight. | BLOCKED | Needs C2 for compressed summaries |

### Route A: Multi-Platform Support

| # | Task | Status | Dependencies |
|---|------|--------|-------------|
| A3 | **Binpack core**: Package `core/` as distributable binary/package for cross-platform reuse | PENDING | None — core is already clean |
| A4 | **OpenCode adapter**: New adapter layer for opencode platform hooks | PENDING | A3 binpack |

## Phase 59 JS/TS Migration — Lessons Learned

### Subagent File Overwrite Hazard
When running parallel subagents that edit the same test files, later subagents can overwrite earlier fixes. This happened repeatedly with `bun:test` → `vitest` import replacements and `mock` → `vi` API migrations. **Mitigation**: if files regress after a parallel subagent wave, run `git checkout -- <files>` to restore the committed versions, then re-apply needed edits sequentially.

### TypeScript Test Framework
- **Framework**: vitest (NOT bun test). Tests use `import { describe, it, expect, vi } from "vitest"`.
- **Runner**: `npm test` (vitest) in `packages/core/`. `bun test` has been fully removed.
- **Coverage**: `npm test -- --coverage` (requires `@vitest/coverage-v8`). Python: 94%, TS: 75.4%.
- **Test count**: 304 pass, 23 skip (adapter-level), 0 fail. 17 test files.
- **Package location**: `packages/core/` — this is the TS root, NOT `scripts/`.

### SQLite: better-sqlite3
- Works in Node.js (vitest). Does NOT work in Bun (issue #4290).
- Do NOT import `bun:sqlite` — the codebase uses `better-sqlite3`.
- Test files that use real databases import `Database from "better-sqlite3"`.
- Files that mock connection.ts use `vi.mock("../src/storage/connection", ...)` with `vi.hoisted()`.
- `vi.hoisted()` is vitest-specific — it runs factory before module imports. Use for mock functions that need to exist before the module-under-test is loaded.

### Python ↔ TS 1:1 Translation Contract
- Phase 59 is strict 1:1. NO optimizations, NO refactoring, NO signature changes.
- Python `snake_case` → TS `camelCase`. File names: `snake_case.py` → `kebab-case.ts`.
- Private Python functions (prefixed `_`) → TS non-exported functions or inlined.
- Optimizations recorded to `scratch/phase98_optimizations.md`.

### ESM Module Mocking Limits
- `vi.spyOn()` does NOT work on ESM namespace imports (e.g., `node:child_process`, `node:fs`).
- For these, use environment manipulation (e.g., `process.env.PATH = ""` to hide git) or filesystem tricks (e.g., `chmod 000` to simulate stat failure).

### Phase Roadmap (Updated)
| Phase | Content | Status |
|-------|---------|--------|
| 58 | Core extraction (Python hooks → core) | ✅ committed |
| 59 | Core → TypeScript (25 modules + 17 tests) | ✅ committed |
| 60 | Adapter rewrite (hooks/bridge/sidecar → TS) | PENDING |
| 98 | Optimizations & SQLite strategy | PENDING |
| 99 | OpenCode adapter | PENDING |
