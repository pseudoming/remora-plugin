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
**禁止直接执行**：严禁在主工作区亲自下场运行测试或调试代码。主 Agent 必须使用 `invoke_subagent` 委派只读特工 `Remora_ReadOnly_Extractor`（Scenario A）或隔离特工 `Remora_Deep_Diver`（Scenario B，必须配置 `Workspace: "branch/share"` 工作区）。
> 💡 关于隔离级别、底线拦截规则、卡死心跳探活与双重自愈机制的具体指令技术细节，必须严格遵循 [/skills/remora-architecture/SKILL.md](file://{PLUGIN_ROOT}/skills/remora-architecture/SKILL.md) 规范。

## 3. 决策锚定与打标 (Decision Anchoring & Confirmation)
**Single Source of Truth**：SQLite 数据库 remora_memory.db 是决策的唯一真相源。严禁在主干或工作区手动写入 decisions.md 等物理文件。
1. **结构化上报**：子代理 Remora_Deep_Diver 运行结束后，主 Agent 应接收并检查其遵循硬编码格式规范化上报的决策摘要（必须包含 `[ROOT CAUSE]` / `[REJECTED APPROACHES & RATIONALE]` / `[ASSOCIATED FILES]`）。
2. **事件流同步**：该格式化的决策上报将由 compactor.py 守护进程提取并异步持久化至 SQLite 温存储中。
3. **确认锁定**：主 Agent 必须主动引导用户运行 `/confirm <decision_id>`，对数据库中已同步的核心决策进行手动打标确认，以防止决策在后续的内存压缩轮询中被作为过时信息清除。

## 4. 温存储主动召回 (Active Recall)
**禁止凭空猜测**：当用户的指令挑战了过往的历史记忆，或主干上下文已被高度压缩时，绝不可凭空臆断或猜测。
**触发动作**：严禁在主干会话中使用 grep_search 或 view_file 检索文本形态的大日志以防上下文爆炸。必须调用温存储官方接口：
`npx tsx {PLUGIN_ROOT}/packages/adapter-antigravity/src/cli/remora-recall.ts "<YOUR_KEYWORD>"`
从 SQLite FTS5 检索库中安全、精准地召回历史事实。
