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
- `packages/core/src/` modules **MUST NEVER** import from `packages/adapter-antigravity/src/`. Violations are caught by `test_architecture.test.ts`.
- `packages/core/src/` contains pure business logic with zero Antigravity dependencies.
- `packages/adapter-antigravity/src/` may import from `packages/core/src/` — this direction is allowed and expected.

### 2. DAO Access Gate
- All database read/write operations go through `packages/core/src/dao.ts` or standard export paths.
- Direct Database connection initialization outside of `core` storage/dao modules is forbidden.

### 3. Import Boundary Enforcement
- `test_architecture.test.ts` runs on every CI build. Any import that crosses the wrong boundary will fail the test instantly.
- Before creating new files, verify which side of the boundary they belong on:
  - Antigravity-dependent (conversation.db, agentapi, hook protocol) → `packages/adapter-antigravity/src/`
  - Pure logic with no platform dependency → `packages/core/src/`

## ARCHITECTURE & REFACTORING DISCIPLINE

### 1. Hook Schema Strictness
When developing Antigravity Hooks (e.g., PreInvocation, PreToolUse), you **MUST NEVER** inject arbitrary/custom keys into the JSON payload. Unrecognized fields will instantly crash the `protojson` unmarshaler and bring down the AgentExecutor.

- ❌ **BAD:**
```typescript
injectSteps.push({
    decision: "fallback",
    error_reason: "Missing initialized variable" // Fatal: causes protojson crash
});
```

- ✅ **GOOD:**
```typescript
// Log custom debugging info strictly to stderr
console.error("[Hook Error] Missing initialized variable");
injectSteps.push({
    decision: "fallback",
    decision_reason: "Internal state error" // Standard schema key
});
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
For complex scripts, installation orchestrators (`install.ts`), or drafts, you MUST write them to the `scratch/` directory and perform static verification. Specifically for installers, you **MUST** mentally walk through or simulate a **clean install** scenario.

- ❌ **BAD:** Assuming `fs.readdirSync("agents")` works because the folder exists in your current development tree, which will crash with `ENOENT` on a brand new machine.
- ✅ **GOOD:** Using guard clauses like `if (fs.existsSync("agents"))` or `fs.mkdirSync("agents", { recursive: true })` to handle empty states.

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
git commit -m "[Phase 64 Addendum] Clean Physical isolated deployment with auto-cleanup & backup protection

Changelog:
- packages/adapter-antigravity/src/hooks/session-guardian.ts:
  * Added subagent detection check to prevent overwriting parent session ID.
- conf/templates/agents/remora_readonly_extractor.template.json:
  * Restricted extraction tools to plain text only."
```

### 6. Artifact Synchronization & Phase Archiving (制品同步与阶段归档)
Every time a phase or task is completed and before submitting your changes, you **MUST** review all project planning artifacts (`walkthrough.md`, `task.md`, `implementation_plan.md`). You **MUST** ensure all completed sub-tasks are marked as `[x]`, the walkthrough is updated to reflect the final implementation details (not intermediate drafts), and stale/completed plans are appropriately archived.

### 7. Environment Hygiene & Stale Script Cleanup (环境卫生与临时脚本清理)
You **MUST ALWAYS** actively delete any temporary files, diagnostic scripts, test compilation caches, or hack scripts created in the `scratch/` directory or project tree immediately after diagnosing and fixing the root cause. Do not leave trailing debug scrap behind to pollute the codebase.

### 8. Subagent File Transport & cp Ban (子特工数据传输与 cp 拷贝禁令)
When transferring logs, scripts, or parsed content from a subagent back to the parent context, AI agents **MUST NEVER** use raw `cp` commands to copy files directly into the main repository tree or active brain workspaces. 
- You **MUST** strictly route all file transfers through the shared scratch directory (`scratch/parent_shared/`).
- **Race Condition Protection (.done suffix)**: When writing files to the shared directory, you **MUST** create a companion empty `.done` flag file (e.g. `result.json.done` for `result.json`) to signal to the parent agent that the write has fully completed. The parent agent MUST NOT read the file until its corresponding `.done` flag is present.

## KNOWN TECHNICAL DEBT (Phase 51 Audit)

### Dead Code — Functions with ZERO production callers (only tests invoke them)

| Function | File | Line |
|----------|------|------|
| `getFilesByTopic()` | `packages/core/src/storage/file_changes.ts` | :14 |
| `deleteHookState()` | `packages/core/src/storage/runtime_state.ts` | :62 |

Remaining two: `getFilesByTopic` is forward-looking symmetric design with `getDecisionsByFile` (Phase 43, possible future topic-context injection). `deleteHookState` had a real caller in Phase 39-40 Git Commit Gate, orphaned when gate was removed. Both safe to remove or keep.

### Confirmed Bugs

*No outstanding confirmed bugs.*

### Architecture Violation — Sidecar has raw SQL in adapter layer (✅ RESOLVED Phase 52)

All `packages/adapter-antigravity/src/sidecar/` files now route through `packages/core/src/dao.ts`.

| File | SQL operations | Status |
|------|---------------|--------|
| `warm-storage-sync.ts` | INSERT/DELETE messages, watermarks, event_queue | ✅ All moved to core storage logic |
| `extract-decisions.ts` | INSERT/UPSERT project_topics, topic_decisions, watermarks | ✅ All moved to core storage logic |
| `consume-events.ts` | SELECT/UPDATE topic_decisions, event_queue | ✅ All moved to core storage logic |
| `check-approval.ts` | SELECT artifact_hashes, messages; INSERT event_queue | ✅ All moved to core storage logic |
| `sync-artifacts.ts` | INSERT/DELETE messages, INSERT event_queue, project_topics | ✅ All moved to core storage logic |
| `scan-sessions.ts` | SELECT watermarks | ✅ No raw SQL remaining |
| `compactor.ts` | SELECT DISTINCT project_topics | ✅ Moved to core storage logic |

### Platform-Agnostic Extraction (Phase 52)

| Function | Source | Destination |
|----------|--------|-------------|
| `scanApprovalSignals()` | `check-approval.ts` | `packages/core/src/rules/` |
| `suggestZombieAction()` | `subagent-monitor.ts` | `packages/core/src/zombie.ts` |
| Approval config (keywords, negation prefixes) | hardcoded in check-approval.ts | `packages/adapter-antigravity/conf/approval.json` |

### Phase 52 — File-touch injection (COMPLETED, committed)

cognitive-push PreToolUse calls `getDecisionsByFile()` on write gate allow path.
+2 test cases (#7 inject, #8 dedup).

### Architecture Cleanup (Phase 52)

- `updateWatermark` merged: decisions copy removed, messages version is canonical
- `getOpenTopic(conn, ...)` separated from existing `getActiveTopic(project_uuid)` to avoid signature collision
- `getAllProjectUuids(conn)` added to topics logic for compactor dispatch loop

## PENDING WORK — Roadmap Items

### Route B: Subagent Optimization (Phase 70-71)

| # | Task | Status | Dependencies |
|---|------|--------|-------------|
| B1 | **Workspace JIT checks**: Workspace JIT Actionable Phrase Matrix check in safety-check | [x] | None |
| B2 | **Prompt length limit rules 1-4**: Two-tier prompt density and facts injection checks | [x] | None |
| B3 | **Shared scratch folders**: Symlink scratch directory sharing for sibling subagents | [x] | None |
| B4 | **Config tampering block**: Prevent subagent configuration overriding and privilege escalation | [x] | None |
| B5 | **W14~W25 micro-behavior rules**: Add rules W14 to W25 to Deep_Diver and ReadOnly Extractor templates | [x] | None |

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
