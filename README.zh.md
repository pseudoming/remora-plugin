<div align="center">

# Remora — Antigravity 认知架构插件

**[用计算换认知安全] — 由确定性规则守护概率性核心，让 AI Agent 不再失忆**

![Platform](https://img.shields.io/badge/platform-Antigravity-blue) ![Tests](https://img.shields.io/badge/tests-755%20passed-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green)

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
- 🔒 **安全审计与隔离** — `run_command` / `view_file` / `grep_search` 前置拦截。Base64 递归审计、日志大文件读取熔断、测试/编译强制委派子代理沙箱。集成 Stdio Git MCP 服务实现受限环境安全的版本控制。
- 👻 **僵尸清理与治理** — 扫描 `/proc` 查找未托管后台进程（>15s）。内置 `CLI Rollback`、编译自愈 (Compile Self-Healing) 以及跨会话目录共享防线，全面收编子代理行为边界。
- ⚙️ **声明式安全引擎** — `safety-check` 采用纯粹的责任链模式 (CoR)，支持 Glob Bypass 静态防线与统一魔术数字策略。通过 TypeScript 严格接口（如 `PreToolUseResponse`）从编译期彻底杜绝宿主环境 `protojson crash`。

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
npm install -g @remora/antigravity-plugin && remora-install
```

```bash
export REMORA_DB_PATH=/path/to/remora_memory.db   # 数据库路径
export REMORA_LOG_LEVEL=DEBUG                      # DEBUG | INFO | WARN | ERROR
```

---

## CLI 工具

```bash
npx tsx packages/adapter-antigravity/src/cli/remora-recall.ts "<关键词>"          # 召回历史架构决策
npx tsx packages/adapter-antigravity/src/cli/remora-topic.ts new|switch|close|confirm  # 话题管理
npx tsx packages/adapter-antigravity/src/cli/read-session-log.ts <conv_id> [rounds]    # 阅读会话日志
```

### 调试

```bash
npx tsx packages/adapter-antigravity/src/debug/tail.ts    # 实时日志查看
npx tsx packages/adapter-antigravity/src/debug/inspect.ts # 数据库状态检查
npx tsx packages/adapter-antigravity/src/debug/env.ts     # 系统环境信息
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
packages/
├── core/               ← 可移植核心（零 AG 依赖）
│   ├── src/storage/    ← SQLite DAO — 11 模块
│   ├── src/rules/      ← 命令安全检查引擎
│   ├── schema/         ← DDL + 动态迁移
│   ├── conf/           ← 配置文件
│   └── tests/          ← 331 个测试
├── adapter-antigravity/ ← Antigravity 绑定层
│   ├── src/hooks/      ← 生命周期钩子
│   ├── src/bridge/     ← Agent API 桥接
│   ├── src/cli/        ← CLI 工具
│   ├── src/debug/      ← 调试工具
│   ├── src/sandbox/    ← 沙箱
│   ├── src/sidecar/    ← Sidecar 守护进程
│   ├── src/maintenance/ ← 维护
│   └── tests/          ← 424 个测试
```

---

## 开发

```bash
# 运行测试
cd packages/core && npm test                    # 331 个核心测试
cd packages/adapter-antigravity && npm test     # 424 个适配器测试

# 添加新 Hook
1. 在 packages/adapter-antigravity/src/hooks/ 中编写 TypeScript Hook 模块
2. 编辑 conf/templates/hooks.template.json
3. 运行 remora-install
```

**架构边界**

- `core/` 禁止 import `adapter-antigravity/`（`test_architecture.ts` 强制检查）
- 所有数据库读写通过 `packages/core/src/dao.ts` 统一入口
- 源代码禁止硬编码绝对路径，使用 `findPluginRoot()`、环境变量或 `getDataDir()`

---

### 编译、物理隔离部署与数据库演进

本项目采用物理隔离的自包含部署方式。开发目录（如 `~/wsl_code/remora-plugin`）为源码仓库，全局运行插件目录（`~/.gemini/config/plugins/remora-plugin`）为物理独立运行环境。

#### 1. 一键构建与物理部署
在开发目录下直接运行一键部署脚本：
```bash
./deploy.sh
```
该脚本将自动完成：
- 递归清理开发目录下的 Python 编译缓存。
- 执行 TypeScript 构建编译（输出至各个 `dist/` 目录）。
- 物理断开旧的符号链接，通过 `rsync` 增量同步文件至全局部署目录。
- **物理大扫除**：在目标运行目录中强制清除开发期特有的源文件（`src/`）、测试用例（`tests/`）、配置文件（`tsconfig.json`），并**递归清理所有 `.d.ts` 类型声明文件**和 **`node_modules/.vite` 构建缓存**，实现最大程度的体积瘦身与环境纯净。

#### 2. 数据库安全演进 (Database Migration)
- **数据防覆盖**：在 `rsync` 过程中彻底排除了 `data/` 目录。本地已积累的 `remora_memory.db` 在重新部署时绝不会被覆盖。
- **自动冷备份**：每次运行安装升级时，程序会自动在同目录下为 `remora_memory.db` 创建一份 `.bak` 冷备份保护。
- **字段热升级**：当需要扩展表字段时：
  1. 在 `packages/core/schema/schema.sql` 的建表 DDL 中追加新字段（供新用户使用）。
  2. 在 `packages/adapter-antigravity/src/schema/schema-init.ts` 的 `initDb()` 中追加对应的 `try-catch` 探测与 `ALTER TABLE ADD COLUMN` 逻辑（供已有老数据库自动热升级）。


---

## 贡献

PR 欢迎，特别是：

- 新语言关键词（`conf/keywords.json` — 目前只有中文，欢迎英/日/韩）
- 新 Hook 拦截规则（PreInvocation / PreToolUse / Stop）
- 新 CLI 管理工具
- 新 Sidecar 守护进程

提交前确保两组 npm test 套件全绿。

---

## 文档

| 文档 | 内容 |
|---|---|
| [项目总览](docs/PROJECT.md) | 架构、阶段、质量门禁 |
| [核心业务流程](docs/business_flows.md) | 10 个流程 + Mermaid 图 |
| [子代理协同与探活](docs/subagent_collaboration.zh.md) | 协同设计、心跳超时延期、编译物理部署、SQLite 热升级 |
| [Antigravity 集成](.agents/skills/antigravity-integration/SKILL.md) | Hook / Sidecar / Plugin 协议 |
| [记忆机制](.agents/skills/antigravity-memory-mechanics/SKILL.md) | Checkpoint / Compaction / SQLite 温存储 |
| [Debug 工具](packages/adapter-antigravity/src/debug/README.md) | tail / inspect / env |
