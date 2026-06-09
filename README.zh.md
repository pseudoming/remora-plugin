<div align="center">

# Remora — Antigravity 认知架构插件

**[用计算换认知安全] — 由确定性规则守护概率性核心，让 AI Agent 不再失忆**

![Platform](https://img.shields.io/badge/platform-Antigravity-blue) ![Tests](https://img.shields.io/badge/tests-674%20passed-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green)

---

[English](README.md) | [简体中文](README.zh.md)

</div>

---

## 你的 AI Agent 正在逐渐失忆

使用 AI Coding Agent 的现实困境：

- **20 轮后开始犯错** — 上下文窗口被历史对话撑满，早先的架构决策被沖淡
- **跨天协作回到原点** — 每次新会话都要重新解释项目背景和技术约定
- **幻觉写入** — 模型声称修改了文件，实际上什么都没做
- **子代理卡死** — 后台任务无人问津，主 Agent 傻等超时
- **环境脏乱** — 未托管的僵尸进程堆积，日志塞满临时目录

---

## 为什么不直接让模型记住

单靠 System Prompt 加一句「请记住之前的对话」没用。更大的上下文窗口只是「桌子变大了」，不解决「注意力涣散」的问题——即使 2M token 窗口的模型，对话超过 50 轮后照样忽略早期的架构决策。

Remora 的做法：**主动搜刮 → 结构化存储 → 按需注射**——只把真正相关的历史决策塞回上下文，不増无意义的 tokens。

---

## 解法：700x ROI 的认知防线

通过 Antigravity 的 Hook 协议在 Agent 生命周期关键节点注入拦截器，配合 SQLite 温存储实现全自动记忆管理。设计经过 15 轮跨模型评审（Claude / ChatGPT / Gemini / DeepSeek / Doubao / Qwen）。

| 防线 | 做什么 | ROI |
|---|---|---|
| 🪝 **8 个生命周期钩子** | 写门禁、phantom 检测、决策重载、安全审计、僵尸清理 | 拦截一次错误写入 ≈ 节省 1h 返工 |
| 📓 **温存储** | SQLite + FTS5 trigram 中文全文索引，自动召回历史架构决策 | 召回 1 条被遗忘的决策 ≈ 避免 1 次方向性错误 |
| 💀 **子代理存活自愈** | 心跳探活 → kill_and_retry → escalate_to_human | 自动恢复，无需人工干预 |
| 🧹 **垃圾回收** | 72h 自动清理无用话题，30 天清理失效会话 | 数据库体积可控 |

```
多花 100 万 Token 做记忆管理（≈ ¥0.7）避免 1 小时返工（≈ ¥500）
                                                         ≈ 700x ROI
```

---

## 能做什么

- 📓 **决策记忆网络** — 全自动提取会话中的架构决策。FTS5 trigram 中文分词全文索引，三通道混合召回 + 警觉关键词强制召回 + 步距自动召回。用户确认后晋升 `manual` 级别，永久免于 GC
- 🛡️ **Phantom 文件检测** — 7 组中英正则匹配模型声称修改的文件名，物理快照 diff 交叉验证。发现幻读 → 注入警告 + `force_continue`
- ⚔️ **语义冲突检测 (Line C)** — PostInvocation 阶段检测模型输出与现有代码库/架构决策的语义冲突，防止方向性错误写入
- 💀 **子代理存活自愈** — 心跳探活（60s/180s 分级超时）。`completed` → alive，`blocked` → dead，`timeout` → kill_and_retry。重试满 2 次 → 人工介入
- 🚧 **全局写门禁** — 首次写入核心代码 → deny + 要求解释意图。二次重试 → allow + 文件触碰注入（注入历史决策）。三模式（严格/放松/警觉）自适应放行
- 🔒 **安全审计** — `run_command` / `view_file` / `grep_search` 前置拦截。Base64 递归审计、日志大文件读取熔断、测试/编译强制委派子代理沙箱
- 👻 **僵尸进程清理** — 扫描 `/proc` 查找未托管后台进程（>15s），匹配 Antigravity 环境变量 + 白名单过滤，发现即拦截工具执行

---

## 不做什么

- ❌ **不自动提交代码** · Git 操作由用户通过 sandbox-merge 显式触发
- ❌ **不替代模型推理** · Hook 层提供防御性校验，不修改模型输出内容
- ❌ **不上传数据** · 所有数据存于本地 SQLite，数据库路径由 `REMORA_DB_PATH` 控制

---

## 30 秒 Quick Start

```bash
git clone https://github.com/pseudoming/remora-antigravity-plugin.git \
  ~/.gemini/config/plugins/remora-plugin
cd ~/.gemini/config/plugins/remora-plugin
python3 install.py              # 安装
```

```bash
python3 install.py --dry-run    # 预览（不写入）
python3 install.py --force      # 重装（跳过 idempotent 检查）
python3 install.py --uninstall  # 卸载
```

```bash
export REMORA_DB_PATH=/path/to/remora_memory.db   # 数据库路径
export REMORA_LOG_LEVEL=DEBUG                      # DEBUG | INFO | WARN | ERROR
```

---

## CLI 工具

```bash
python3 scripts/adapter/cli/remora-recall.py "<关键词>"          # 召回历史架构决策
python3 scripts/adapter/cli/remora-topic.py new|switch|close|confirm  # 话题管理
python3 scripts/adapter/cli/read-session-log.py <conv_id> [rounds]    # 阅读会话日志
```

### 调试

```bash
python3 scripts/debug/tail.py    # 实时日志查看
python3 scripts/debug/inspect.py # 数据库状态检查
python3 scripts/debug/env.py     # 系统环境信息
```

---

## 架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Antigravity Engine — 触发 Hook                                           │
└───┬──────┬──────┬──────┬──────┬──────┬────────┬────────────────────────┘
    │      │      │      │      │      │        │
    ▼      ▼      ▼      ▼      ▼      ▼        ▼
  ┌──────────────────────┐ ┌──────────────┐ ┌────────────┐ ┌──────────────────────┐
  │   PreInvocation       │ │PostInvocation│ │ PreToolUse │ │       Stop            │
  │                       │ │              │ │            │ │                       │
  │ session-guardian      │ │ action-gate  │ │ safety-    │ │ compactor             │
  │   (三模式判定, 决策重载)│ │   (phantom   │ │  check     │ │   (制品MD5)           │
  │                       │ │    检测)      │ │   (命令审计)│ │                       │
  │ 快照 (snapshot-git)   │ │              │ │            │ │ clean-session-stats   │
  │   (diff采集)           │ │ 语义冲突    │ │ cognitive- │ │                       │
  │                       │ │   检测       │ │  push      │ │ check-subagents-      │
  │ cognitive-push         │ │   (Line C)   │ │   (写门禁,  │ │  liveness             │
  │   (决策注射)            │ │              │ │    文件触碰 │ │   (子代理探活)        │
  │                       │ │              │ │     注入)   │ │                       │
  │ zombie-detector        │ │              │ │ zombie-    │ └──────────┬────────────┘
  │   (进程扫描)            │ │              │ │  detector  │            │
  │                       │ │              │ │   (工具前   │            │
  │ tone-injector          │ │              │ │     拦截)   │            │
  │   (语气纪律)            │ │              │ └────────────┘            │
  └───────────┬────────────┘ └──────────────┘                            │
              │                                                          │
              ▼                                                          ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │                   SQLite 温存储 (remora_memory.db)                    │
  │  messages · project_topics · topic_decisions · watermarks            │
  │  session_state · runtime_hook_state · file_changes                   │
  │  messages_fts (FTS5 trigram) · artifact_hashes                       │
  └──────────────────────────────────────────────────────────────────────┘
              ▲                                         │
              │            ┌─────────────────────────┘
              │            ▼
  ┌───────────┴──────────────────────────────────────────────────────────┐
  │  Sidecar: memory-compactor (daemon)                                  │
  │  LLM 增量提取决策 → 置信度计算 → GC 清理 → UUID 继承链验证           │
  └──────────────────────────────────────────────────────────────────────┘
```

```
scripts/
├── core/          ← 可移植核心（零 AG 依赖）
│   ├── storage/   ← SQLite DAO — 10 模块
│   ├── rules/     ← 命令安全检查引擎
│   └── logger.py  ← 统一日志：4 级、trace ID、日切
├── adapter/       ← Antigravity 绑定层 — hooks/、bridge/、cli/、sandbox/、maintenance/
├── lib/           ← DAO re-export facade
├── schema/        ← DDL + 动态迁移
├── tests/         ← 674 个测试
└── debug/         ← tail.py、inspect.py、env.py
```

---

## 开发

```bash
# 运行测试
pytest scripts/tests/ -q                         # 674 tests

# 添加新 Hook
1. 编写脚本，使用 @hook_entrypoint 装饰器
2. 编辑 conf/templates/hooks.template.json
3. 运行 python3 install.py
```

**架构边界**

- `core/` 禁止 import `adapter/`（`test_architecture.py` 强制检查）
- 所有数据库读写通过 `lib/dao.py` 统一入口
- 源代码禁止硬编码绝对路径，使用 `find_plugin_root()`、环境变量或 `get_data_dir()`

---

## 贡献

PR 欢迎，特别是：

- 新语言关键词（`conf/keywords.json` — 目前只有中文，欢迎英/日/韩）
- 新 Hook 拦截规则（PreInvocation / PreToolUse / Stop）
- 新 CLI 管理工具
- 新 Sidecar 守护进程

提交前确保 `pytest scripts/tests/ -q` 全绿。

---

## 文档

| 文档 | 内容 |
|---|---|
| [项目总览](docs/PROJECT.md) | 架构、阶段、质量门禁 |
| [核心业务流程](docs/business_flows.md) | 10 个流程 + Mermaid 图 |
| [Antigravity 集成](.agents/skills/antigravity-integration/SKILL.md) | Hook / Sidecar / Plugin 协议 |
| [记忆机制](.agents/skills/antigravity-memory-mechanics/SKILL.md) | Checkpoint / Compaction / SQLite 温存储 |
| [Debug 工具](scripts/debug/README.md) | tail / inspect / env |
