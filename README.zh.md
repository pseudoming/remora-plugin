<div align="center">

# Remora — 让 AI Agent 不再失忆

**[用计算换认知安全] — 确定性规则守护概率性核心**

![Platform](https://img.shields.io/badge/platform-Antigravity-blue) ![Tests](https://img.shields.io/badge/tests-880%20passed-brightgreen) ![License](https://img.shields.io/badge/license-MIT-green)

[English](README.md) | 简体中文

</div>

---

## 你遇到过吗

项目第 4 天。两天前你花一小时解释为什么不引入 Redis——今天它又开始建议 Redis。你纠正过 3 次"这个函数签名不要改"。每次重开会话，它都忘。

子代理说"已完成"。`git diff` 什么都没有。两分钟后你才意识到它在撒谎。

模型不是变蠢了——它没有记忆。Remora 给它一个。

---

## Remora 做了什么

| 如果你的 agent… | Remora… |
|---|---|
| 每次新会话回到原点 | 跨会话记住架构决策——新会话打开时自动恢复 |
| 反复提议你否决过的方案 | 标记被否决的决策，让 agent 知道*为什么不做* |
| 声称改了文件但没改 | 物理比对文件系统——没改动就标记出来 |
| 狂读大日志撑爆上下文 | 统一读取预算——满额后强制委派子代理 |
| 派出的子代理卡死或静默挂起 | 每 60 秒心跳探活——死的自动 kill 并重试 |
| 推送代码或执行危险命令 | 拦截高危命令，必须你亲手点确认 |
| 忘记你定下的行为规则 | 把你的核心约束直接注入每个新上下文 |

所有决策存在本地 SQLite + FTS5 trigram。数据不出本机，零云端依赖。

---

## 30 秒开始

```bash
git clone https://github.com/pseudoming/remora-plugin.git
cd remora-plugin
./deploy.sh
```

继续干活。决策自动积累。不需要额外配置。

> 已安装？`remora-install --force` 原地更新。

---

## 架构

```
Antigravity Hook 触发
    │
    ├─ PreInvocation: session-guardian → cognitive-push → zombie-detector → ...
    ├─ PreToolUse:     safety-check (规则引擎 + 动态 CoR 链) → cognitive-push (写门禁)
    ├─ PostInvocation: action-gate (幻象检测)
    └─ Stop:           compactor → clean-session-stats → check-subagents-liveness
         │
         ▼
    SQLite 温存储 (remora_memory.db)
    messages · project_topics · topic_decisions · FTS5 trigram
         │
         ▼
    Sidecar: memory-compactor (后台 LLM 决策提取 + GC)
```

`safety-check.ts` 使用双层防线：10 条声明式 JSON 规则由纯 RuleEngine 求值（fail-closed），14 条纯函数规则以责任链模式执行（首个 DENY 胜出）。

---

## 能力一览

- **决策记忆** · 自动提取 → SQLite + FTS5 trigram → 冷启动注入 → `remora-recall` CLI 全文检索
- **声明式规则引擎** · 10 条 JSON 规则 + 14 条 CoR 动态规则，fail-closed
- **子代理治理** · workspace 矩阵 (branch/share/inherit)、prompt 密度限制、3 分钟去重、4-turn 只读熔断、高危命令门控
- **联合防腐** · view_file + grep_search 统一计费（80KB 警告 / 160KB 熔断）
- **幻象检测** · 声称的文件修改 vs 物理 git diff 交叉验证
- **子代理存活自愈** · /proc 扫描、心跳探活、自愈 SOP（kill → clean → verify）
- **Git MCP** · 零依赖 stdio JSON-RPC 2.0 git 服务器，隔离的版本控制
- **Hook 类型安全** · `PreToolUseResponse` / `PreInvocationResponse` 编译期杜绝 protojson 崩溃

---

## CLI 工具

```bash
remora-recall "<关键词>"                 # 通过 FTS5 全文索引召回决策
remora-topic new|switch|close           # 话题管理
remora-gate --rollback                   # 紧急回滚 safety-check
read-session-log <conv_id>              # 阅读会话日志
```

---

## 技术栈

| 层 | 选型 |
|----|------|
| 语言 | TypeScript (strict mode) |
| 数据库 | better-sqlite3 + WAL + FTS5 trigram |
| 构建 | tsc (core) + tsup/esbuild (adapter) |
| 格式化 | Biome (Rust 实现，替代 Prettier + ESLint) |
| 测试 | Vitest · 880 个测试 · 0 跳过 · CI 在 push/PR 时运行 (Node 20/22) |

---

## 部署

```bash
./deploy.sh                          # 构建两个包 + rsync 到运行目录
remora-install --force               # 重装 / 更新
remora-install --uninstall           # 卸载插件，保留数据库
remora-install --uninstall --purge   # 卸载全部
```

开发目录（`~/wsl_code/remora-plugin`）与运行目录（`~/.gemini/config/plugins/remora-plugin`）物理隔离。`data/` 目录在 rsync 时排除——已有数据库在升级时存留。Schema 变更使用 try-catch `ALTER TABLE ADD COLUMN` 迁移，自动创建 `.db.bak` 冷备份。

---

## 不做什么

- ❌ 不替你 commit
- ❌ 不修改你的代码
- ❌ 不上传数据——全在本地 SQLite

---

完整架构、Hook 生命周期、开发指南——见 [PROJECT.md](docs/PROJECT.md)。
