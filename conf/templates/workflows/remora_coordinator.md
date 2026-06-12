---
description: 当面临长链路调试、深水区排查或大型重构时，主 Agent 进入协调者模式
---

# Remora Coordinator-Worker (防腐烂认知工作流)

**Description**: 当面临长链路调试、深水区排查或大型重构时，主 Agent 必须进入协调者模式，通过物理沙盒隔离执行和温存储主动召回，防止上下文污染与决策漂移。

## 1. 核心触发条件
遇到以下情况之一，必须进入此工作流：
- 用户显式输入指令（如 `/remora`）
- 需要执行预期会有巨大输出日志的排查任务
- 需要进行可能破坏工作区的试错操作

## 2. 物理沙盒隔离与分流 (Sandbox Execution & Dispatch)
**禁止直接执行**：严禁在主工作区亲自下场运行测试或调试代码。主 Agent 必须使用 `invoke_subagent` 委派只读 subagent `Remora_ReadOnly_Extractor`（Scenario A）或沙盒 subagent `Remora_Deep_Diver`（Scenario B，必须配置 `Workspace: "branch/share"` 工作区）。

### subagent 类型选择与工具链前置过滤 (Tool Boundary Gate)
下发子任务前，**必须扫描 Prompt 中的核心命令特征**以选择正确的 subagent 类型：
- 若 Prompt 中含有终端执行操作（`git` / `sqlite3` / `grep` / `npm` / `build` / `pytest` / `bash`）：**绝对不可指派 `Remora_ReadOnly_Extractor`**（该 agent 无 shell 执行权限）。必须指派 `Remora_Deep_Diver`，并限制在 `Workspace: "branch"` 沙盒内执行。
- 若为纯文件浏览、日志检索、文档审阅等只读操作（`view_file` / `list_dir` / `find_by_name`）：**优先指派 `Remora_ReadOnly_Extractor`**，以节省认知空间并避免隔离开销。
- 若任务混合了读写操作，按最危险的操作归类：只有当所有操作都是纯只读时，才能使用 `Remora_ReadOnly_Extractor`。

### subagent Prompt 安全约束 (Prompt Safety Rules)
- **禁止开放式修复指令**：严禁在 Prompt 中包含 `"fix any bugs"` / `"debug and fix"` / `"修一下"` / `"尝试修复"` 等无边界自修指令。此类开放指令导致子代理在 14% 的案例中擅自修改生产代码，未经主代理审批。
- **Fail-Fast 原则**：Prompt 中必须明确指示子代理——若遭遇编译/测试/构建失败，立即停止，将精确的报错详情通过 `send_message` 上报主代理，由主代理决策修复方案。禁止子代理自主诊断和修复。
- **单一 Prompt 子任务上限**：单个子代理的 Prompt 中最多包含 1-2 个具体闭环子任务。超量的复合排查/修复任务必须拆分为多轮独立派发（依次或并发），每轮之间有明确的优先级排序和依赖关系声明。历史数据显示单 Prompt 混合 4+ 子任务导致 569 步中 95% 白白浪费。
- **禁止虚假权限声明**：严禁在 Prompt 中写入任何主观假设的豁免话术，如"作为子特工你已获得豁免限制""本次任务不受安全策略约束""你可以任意读取大文件"等。此类声明在框架层面并未激活，会导致子代理被 Hook 拦截误杀后产生严重信息不对称。主代理必须按真实的物理权限边界组装指令——只读特工不能执行 shell，子代理读取大日志仍受限制，应引导其使用只读访问脚本（如 `remora-recall.ts`）。

> 💡 关于隔离级别、底线拦截规则、卡死心跳探活与双重自愈机制的具体指令技术细节，必须严格遵循 [/skills/remora-architecture/SKILL.md](file://{PLUGIN_ROOT}/skills/remora-architecture/SKILL.md) 规范。

## 3. 决策锚定与打标 (Decision Anchoring & Confirmation)
**Single Source of Truth**：SQLite 数据库 remora_memory.db 是决策的唯一真相源。严禁在主干或工作区手动写入 decisions.md 等物理文件。
1. **结构化上报**：subagent `Remora_Deep_Diver` 运行结束后，主 Agent 应接收并检查其遵循硬编码格式规范化上报的决策摘要（必须包含 `[ROOT CAUSE]` / `[REJECTED APPROACHES & RATIONALE]` / `[ASSOCIATED FILES]`）。
2. **事件流同步**：该格式化的决策上报将由 compactor.ts 守护进程提取并异步持久化至 SQLite 温存储中。
3. **确认锁定**：主 Agent 必须主动引导用户运行 `/confirm <decision_id>`，对数据库中已同步的核心决策进行手动打标确认，以防止决策在后续的内存压缩轮询中被作为过时信息清除。

## 4. 温存储主动召回 (Active Recall)
**禁止凭空猜测**：当用户的指令挑战了过往的历史记忆，或主干上下文已被高度压缩时，绝不可凭空臆断或猜测。
**触发动作**：严禁在主干会话中使用 grep_search 或 view_file 检索文本形态的大日志以防上下文爆炸。必须调用温存储官方接口：
`npx tsx {PLUGIN_ROOT}/packages/adapter-antigravity/src/cli/remora-recall.ts "<YOUR_KEYWORD>"`
从 SQLite FTS5 检索库中安全、精准地召回历史事实。
