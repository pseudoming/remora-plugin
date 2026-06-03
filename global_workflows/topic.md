---
description: 手动切换、新建或关闭活跃的话题上下文
---

# Remora Topic Control Workflow (话题手动控制工作流)

**Description**: 该工作流定义了如何处理用户的 `/topic` 指令，从而在 SQLite 中切换、新建或关闭活跃的话题上下文。

## 1. 触发指令
当用户输入以下格式的控制指令时触发：
- `/topic <name> [new|switch|close]`
或者
- `/topic <name>` (默认动作为 switch)

## 2. 执行动作
主 Agent 收到指令后，禁止直接忽略，必须在本地 WSL2 环境下通过命令行执行 `remora-topic.py` 控制脚本写入数据库。

### 命令行调用规范
使用 `run_command` 工具执行以下命令：
```bash
/usr/bin/python3 ~/.gemini/config/plugins/remora-plugin/scripts/remora-topic.py <action> -u "${ANTIGRAVITY_PROJECT_ID}" -n "<name>"
```
- `<action>` 对应用户输入的动作，可选值为：`new`、`switch`、`close`。若用户未提供动作，默认为 `switch`。
- `<name>` 对应话题的标识符。
- `${ANTIGRAVITY_PROJECT_ID}` 对应当前项目的 UUID。

## 3. 回复确认
执行完成后，向用户报告执行结果，例如：“✅ 已成功切换当前活跃话题为 <name>。”
