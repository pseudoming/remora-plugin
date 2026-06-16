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

- ⚠️ **COMMIT MESSAGE PRE-COMMIT HOOK BYPASS LIMITATION**:
因为 pre-commit 钩子严禁提交信息中包含换行符（`\n`），故执行多行 Phase Report Commit 时，必须先写入临时文件，并通过 `git commit -F <file>` 命令物理绕过该语法拦截，提交后主动删除临时文件。

### 6. Artifact Synchronization & Phase Archiving (制品同步与阶段归档)
Every time a phase or task is completed and before submitting your changes, you **MUST** review all project planning artifacts (`walkthrough.md`, `task.md`, `implementation_plan.md`). You **MUST** ensure all completed sub-tasks are marked as `[x]`, the walkthrough is updated to reflect the final implementation details (not intermediate drafts), and stale/completed plans are appropriately archived.

### 7. Environment Hygiene & Stale Script Cleanup (环境卫生与临时脚本清理)
You **MUST ALWAYS** actively delete any temporary files, diagnostic scripts, test compilation caches, or hack scripts created in the `scratch/` directory or project tree immediately after diagnosing and fixing the root cause. Do not leave trailing debug scrap behind to pollute the codebase.

### 8. Subagent File Transport & cp Ban (子特工数据传输与 cp 拷贝禁令)
When transferring logs, scripts, or parsed content from a subagent back to the parent context, AI agents **MUST NEVER** use raw `cp` commands to copy files directly into the main repository tree or active brain workspaces. 
- You **MUST** strictly route all file transfers through the shared scratch directory (`scratch/parent_shared/`).
- **Race Condition Protection (.done suffix)**: When writing files to the shared directory, you **MUST** create a companion empty `.done` flag file (e.g. `result.json.done` for `result.json`) to signal to the parent agent that the write has fully completed. The parent agent MUST NOT read the file until its corresponding `.done` flag is present.

### 9. 动态模拟数据安全规约 (Seed Data Gate)
所有用于开发调试、测试验证或本地模拟灌入的数据库种子脚本（如 `seed_decisions_data.js`），在代码头部**必须**增加物理环境变量校验：
```javascript
if (process.env.REMORA_SEED_DEV_MODE !== "1") {
  console.error("❌ ERROR: This script modifies database data. Set REMORA_SEED_DEV_MODE=1 to confirm execution.");
  process.exit(1);
}
```
严禁无门控地自发运行写盘/修改运行期数据库数据，防范生产环境数据库遭遇非预期污染。

### 10. Hook 异常捕获与可观测性规约 (Hook Fail-Safe & Diagnostics)
在 Hook 运行期内（如 `cognitive-push.ts`）执行的任何数据库 DDL 升级或更新写盘操作，均必须使用 `try-catch` 进行 Fail-Safe 保护，确保即便发生 `SQLITE_BUSY` 连接写锁冲突也绝不阻塞 Hook 本身执行。同时，捕获的异常应通过 `setHookState` 记录到当前 Turn 对应的 `injection_bump_failures` 等诊断参数中，提供离线数据质量审计手段。

## PENDING WORK — Roadmap Items

### 1. Route C: Operational Optimization (运行效能优化路线)
- **C2: 自动压缩决策记录 (Auto-compression)**：**`PENDING (解除阻塞)`**（由于本地开发期种子模拟方案和 C1 物理 DDL 基础均已建成，开发期可在本地直接绕过等待期闭环研发测试 C2）。
  - *子代理协同优化*：对高频 decisions 触发 LLM 自动单行摘要写回并优先读取，以压低上下文占用。
- **C3: 上下文配额平衡 (Context budget balancing)**：**`BLOCKED`**（在业务逻辑上绝对依赖 C2 压缩摘要的物理生成产物）。
  - *子代理协同优化*：执行 Per-session token 追踪，在上下文紧绷时优先注入高价值 decisions。
- **C4: 守护进程常驻模式 (Daemonized Hooks & IPC Stub Client)**：**`PENDING (待观察)`**（若后续观测到并发子特工调起时 SQLite 冲突或进程间读写竞态，则拉起 Unix Domain Socket 进行长驻内存求值）。
- **C5: 自动化分支与沙箱修剪机制 (Automated Branch & Worktree Pruning)**：**`PENDING`**（由于子代理长期处于高频调起状态，其创建的隔离工作树(worktrees)和独立分支如果不加以定期清理，将导致极大的资源泄漏与仓库腐化。需在 Remora 核心链路中实现定期剪枝机制，替代人工阶段性大扫除）。

### 2. Route A: Multi-Platform Support (多平台适配路线)
- **A3: Binpack core (核心包二进制独立打包)**：**`PENDING`**（无前置依赖，core 模块解耦已就绪）。
- **A4: OpenCode adapter (OpenCode 适配层开发)**：**`PENDING`**（依赖 A3 的完成）。

### 3. Subagent Optimization: Pending Observation (⏳ 子代理优化待观察防线)
- **防止 Ghost Completion (幽灵完成)**：防范子特工在极短步骤内虚假声称已在沙盒内修改文件。目前通过 `extractSubagentReport`（提取声称更改）+ `sandbox-merge`（验证双向覆盖）双向防线拦截，作为影子旁路持续观测。
- **物理截断 (Prompt Truncation) 防卫**：在 Prompt 拼装中加入完整性特征校验，防止消息通道截断导致子代理指令偏航。
- **避免 `cognitive-push` 提示词注入越界覆盖**：在 PreInvocation 提示词拼接中采用严格的括号隔离，防止动态注入文本意外覆盖主任务指令（目前已采用 `<system-reminder>`/`<system-discipline>` 原生标签隔离，持续观察）。

## ACTIVE DATA BACKUPS (活跃数据备份)
- **2026-06-15 备份 (卸载功能测试前置保护)**：
  - 备份根路径：`~/.remora_data_backup_safeguard_20260615/`
  - 全局数据库备份：`~/.remora_data_backup_safeguard_20260615/dot_remora_data/remora_memory.db`
  - 工作区数据库备份：`~/.remora_data_backup_safeguard_20260615/workspace_data/remora_memory.db`
  - 状态：✅ 已全量物理备份同步，随时可用于秒级恢复。
