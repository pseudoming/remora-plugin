# Remora - Antigravity Agent Cognitive Architecture Plugin

Remora 是一个专为 Antigravity SDK 驱动的自主智能体设计的高级认知架构与温记忆增强插件。通过全局拦截钩子与温存储设计，Remora 能够自动搜刮、增量更新并按需召回智能体的技术架构决策（Architecture Decisions）和物理代码文件关联，同时提供全面的多沙箱安全防护与子特工存活自愈能力。

---

## 一、系统总体架构

Remora 采用**双轨交互与异步压缩**的混合认知架构：

### 1. 拦截防线 (Hooks Interceptors)

通过 Antigravity 的 Hook 协议在 Agent 生命周期关键节点注入认知规则：

| Hook 阶段 | 脚本 | 功能 |
|---|---|---|
| PreInvocation | `adapter/hooks/session-guardian.py`<br>`adapter/hooks/action-gate.py`<br>`adapter/hooks/cognitive-push.py` | 会话唤醒、模式判定、决策记忆重载、phantom 文件修改检测 |
| PreToolUse | `adapter/hooks/safety-check.py`<br>`adapter/hooks/tone-injector.py`<br>`adapter/hooks/zombie-detector.py` | 命令安全审计、读写熔断、子特工沙箱隔离、僵尸进程扫描 |
| Stop | `sidecars/memory-compactor/compactor.py --event-driven` | 制品 MD5 增量比对、温存储异步写入 |
| PreToolUse<br>（存活探活） | `adapter/sandbox/check-subagents-liveness.py`<br>`adapter/sandbox/subagent-monitor.py` | 子特工心跳检测、自愈重试、故障上报 |

### 2. 温存储核心 (Warm Storage Layer)

- 基于 SQLite 的本地高性能关系数据库，启用 `WAL` (Write-Ahead Logging) 模式以支持高并发读写。
- `messages_fts` 全文索引虚拟表（FTS5，trigram 分词器）实现毫秒级模糊召回。
- 核心表：`messages`（事实数据）、`project_topics`（话题库）、`topic_decisions`（决策打标）、`watermarks`（会话映射）、`session_state`（跨进程状态同步）、`file_changes`（物理文件变更追踪）。

### 3. 后台守护服务 (Memory Compactor Daemon)

- 周期性轮询活跃会话，LLM 增量提取非结构化架构决策。
- 计算决策置信度与覆盖率，保证 UUID 和确认 ID 的继承链条无损。
- 触发 GC 清理过期水印及 72 小时前未确认的自动话题。

### 4. 代码架构 (Code Organization)

```
scripts/
├── core/              ← 可移植插件核心（零 Antigravity 依赖）
│   ├── storage/       ← SQLite DAO 层（sessions、topics、decisions、recall 等 10 模块）
│   ├── rules/         ← 安全检查规则引擎
│   ├── logger.py      ← 统一日志（4 级门控、trace ID、日切）
│   ├── phantom.py     ← phantom 文件修改检测
│   ├── injector.py    ← 决策注入预算控制
│   ├── liveness.py    ← 存活判定、模式检测、时间戳解析
│   ├── zombie.py      ← /proc 进程扫描、白名单管理
│   ├── reader.py      ← 会话日志过滤与格式化
│   └── filesystem.py  ← 文件快照 diff
├── adapter/           ← Antigravity 绑定层（不可移植）
│   ├── hooks/         ← Hook 入口（6 个拦截器）
│   ├── bridge/        ← CDAL、会话管理、路径解析、进度追踪
│   ├── cli/           ← CLI 工具（remora-topic、remora-recall、read-session-log）
│   ├── sandbox/       ← 子特工存活探活、沙箱合并
│   └── maintenance/   ← GC、幽灵数据清理
├── lib/               ← DAO re-export facade（30 行，统一访问入口）
├── schema/            ← DDL 建表与动态迁移
├── tests/             ← 555 个单元测试（20 个测试文件）
└── debug/             ← 调试工具（tail.py、inspect.py、env.py）
```

---

## 二、安装指南

### 快速安装

```bash
python3 install.py
```

install.py 执行以下步骤：
1. Quality gate 静态架构检查
2. 模板渲染：`conf/templates/hooks.template.json` → `hooks.json`、agent templates、sidecar 配置
3. Workflow 部署：`global_workflows/` → `~/.gemini/config/global_workflows/`
4. 数据库初始化：调用 `scripts/schema/schema_init.py` 建表并执行动态迁移

### 命令行选项

| 选项 | 说明 |
|---|---|
| `--force` | 强制重装（忽略 `installed.flag`） |
| `--dry-run` | 干跑模式，预览操作但不写入任何文件 |
| `--uninstall` | 卸载插件（清理模板产物和 flag，保留数据库和 workflow） |

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `REMORA_DB_PATH` | `~/.remora/data/remora_memory.db` | SQLite 数据库路径 |
| `REMORA_LOG_LEVEL` | `INFO` | 日志级别：`DEBUG`、`INFO`、`WARN`、`ERROR`、`OFF` |
| `REMORA_HOOKS_PROFILE_LOG` | `~/.remora/data/hooks_profile.log` | Hook 性能分析日志路径 |
| `REMORA_TRACE_ID` | 自动生成 | 分布式追踪 ID（子进程自动继承） |

---

## 三、开发指南

### 运行测试

```bash
python3 -m pytest scripts/tests/ -q
```

555 个测试，覆盖 DAO、Hooks、侧车守护进程、CLI 工具、logger、文件系统等全部模块。

### 开发新 Hook

1. 在 `scripts/adapter/hooks/` 编写新脚本，使用 `@hook_entrypoint` 装饰器
2. 在 `conf/templates/hooks.template.json` 中配置挂载阶段（如 `PreToolUse`）
3. 运行 `python3 install.py` 重新渲染 `hooks.json`
4. 注意：Hook JSON payload 中**禁止注入自定义键**，仅使用标准 schema 字段（`decision`、`reason`、`injectSteps`、`ephemeralMessage` 等）

### 架构边界规则

- `core/` 模块**禁止** import `adapter/`（由 CI `test_quality_gate.py` 强制检查）
- `adapter/` 可以 import `core/`（允许方向）
- 所有数据库读写必须通过 `lib/dao.py` 统一入口
- 禁止在源码中硬编码 `~/.gemini` 等绝对路径（使用 `paths.py` 中的函数或环境变量）

---

## 四、常见问题

### Q1: 子特工执行卡死或超时？

系统挂载的 `check-subagents-liveness.py` 会在每次拦截时自动扫描活跃的子特工：
- 超时阈值：普通命令 60s，`run_command`/`grep_search` 180s
- 判定卡死后自动注入 `kill_and_retry` 建议
- 重试满 2 次仍失败 → 上报 `escalate_to_human` 引导人工介入

### Q2: SQLite 数据库锁定？

- Remora 默认启用 WAL 模式（`PRAGMA journal_mode=WAL`），支持读写并发
- 数据库连接默认 `timeout=15`（15 秒等待缓冲）
- 如高并发写入仍导致锁竞争，调大 Compactor 轮询间隔

---

## 五、调试工具

```bash
# 实时查看系统日志
python3 scripts/debug/tail.py

# 检查数据库状态
python3 scripts/debug/inspect.py

# 查看系统环境信息
python3 scripts/debug/env.py
```

详见 [scripts/debug/README.md](scripts/debug/README.md)。

---

## 六、更多文档

- [核心业务流程详解](docs/business_flows.md) — 10 个核心流程的 Mermaid 流程图文档
- [Antigravity 集成文档](.agents/skills/antigravity-integration/SKILL.md) — Antigravity Hook/Sidecar/Plugin 协议
- [Antigravity 记忆机制](.agents/skills/antigravity-memory-mechanics/SKILL.md) — Checkpoint/Compaction 与 SQLite 温存储
