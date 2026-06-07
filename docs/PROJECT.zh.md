[English](PROJECT.md) | [简体中文](PROJECT.zh.md)

# Project: Remora Plugin

Remora — Antigravity 认知架构插件。通过 Hook 拦截器 + SQLite 温存储实现 AI Agent 的全自动记忆管理。

## Architecture

### 分层

```
scripts/
├── core/          ← 可移植核心（零 Antigravity 依赖）
│   ├── storage/   ← SQLite DAO（sessions, topics, decisions, recall 等 10 模块）
│   ├── rules/     ← 命令安全检查引擎（inspector）
│   ├── liveness.py, phantom.py, injector.py, zombie.py, reader.py, coverage.py
│   ├── filesystem.py, logger.py
├── adapter/       ← Antigravity 绑定层
│   ├── hooks/     ← 8 个生命周期拦截器
│   ├── bridge/    ← CDAL, agentapi, paths, session, subagent, stats, profiler
│   ├── cli/       ← remora-recall, remora-topic, read-session-log
│   ├── sandbox/   ← sandbox-merge, subagent-monitor, check-subagents-liveness
│   ├── sidecar/   ← compactor 守护进程（compactor, extract_decisions, warm_storage_sync 等 8 模块）
│   └── maintenance/ ← GC, 幽灵数据清理
├── lib/           ← DAO re-export facade（30 行）
├── schema/        ← DDL + 动态迁移
├── tests/         ← 655 个测试
└── debug/         ← tail, inspect, env
```

### 数据流

```
Antigravity Hook 触发
    → adapter/hooks/ （拦截、模式判定、记忆重载、写门禁、安全检查）
    → adapter/sidecar/compactor/ （后台 LLM 增量提取决策）
    → core/storage/ ← lib/dao.py （统一 SQLite 读写）
```

## Phases

| Phase | 内容 | 状态 |
|---|---|---|
| 44 | 架构分离：core/adapter 拆分、统一 logger、debug 工具 | ✅ |
| 45 | 技术债：DAO 架构收敛、import 卫生、测试工程 | ✅ |
| 46 | install.py 重写（幂等、dry-run、uninstall）、README v2、DB 路径统一 | ✅ |
| 47 | README v2 故事化改写、conf/ 目录规范化、tracking hygiene | ✅ |
| 48 | Sidecar 重构：AgentAPI bridge、纯函数拆 core、搬家 adapter/sidecar/ | ✅ |

## Quality Gates

- `core/` 禁止 import `adapter/`（`test_architecture.py` 强制检查）
- 所有 DB 读写过 `lib/dao.py`
- 655 tests, `pytest scripts/tests/ -q`
- 禁止裸 `sqlite3.connect()` 在 adapter/ 中

## Quick Start

```bash
git clone https://github.com/pseudoming/remora-antigravity-plugin.git \
  ~/.gemini/config/plugins/remora-plugin
cd ~/.gemini/config/plugins/remora-plugin
python3 install.py
pytest scripts/tests/ -q  # 655 tests
```
