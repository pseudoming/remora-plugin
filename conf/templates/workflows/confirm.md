---
description: 手动打标确认决策，将其永久锁定（防内存压缩清理）
---

# Remora Decision Confirm Workflow (架构决策手动打标确认工作流)

**Description**: 该工作流定义了如何处理用户的 `/confirm` 指令，通过手动打标将特定的架构决策标记为 `user_confirmed` 锁定状态，防止在内存压缩时被过滤抛弃。

## 1. 触发指令
当用户输入以下格式的指令时触发：
- `/confirm <decision_id>`

## 2. 执行动作
主 Agent 收到指令后，必须在本地 WSL2 环境下运行控制脚本，将对应的决策状态更新为已确认。

### 命令行调用规范
使用 `run_command` 工具执行以下命令：
```bash
node {PLUGIN_ROOT}/packages/adapter-antigravity/dist/cli/remora-topic.js confirm -u "${ANTIGRAVITY_PROJECT_ID}" -d <decision_id>
```
- `<decision_id>` 对应用户指定的决策 ID（在决策摘要列表中可见的整数 ID）。

## 3. 回复确认
执行完成后，查询并反馈该决策的打标结果，例如：“✅ 决策 ID <decision_id> 已手动确认并永久锁定。”
