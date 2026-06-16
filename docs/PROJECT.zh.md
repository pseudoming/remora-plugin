[English](PROJECT.md) | [简体中文](PROJECT.zh.md)

# Remora Plugin — 项目总览

Remora — Antigravity 认知架构插件。通过 Hook 拦截器 + SQLite 温存储实现 AI Agent 的全自动记忆管理。880 个测试，0 跳过。

## 架构

```
packages/
├── core/                        @remora/core — 纯逻辑，零平台依赖
│   ├── src/storage/             SQLite DAO（11 模块）
│   ├── src/rules/               声明式安全规则引擎
│   ├── src/                     injection-formatting, safety-policy 等
│   ├── schema/schema.sql        DDL + FTS5 trigram
│   └── tests/                   381 个测试
│
└── adapter-antigravity/         @remora/antigravity-plugin — Antigravity 绑定
    ├── src/hooks/               8 个生命周期钩子
    │   ├── post-filters/        9 条动态 CoR 规则
    │   └── command-auditors/    5 条命令审计规则
    ├── src/sidecar/             8 个守护进程（compactor, warm-storage-sync 等）
    ├── src/sandbox/             4 个模块（liveness, monitor, merge, zombie-linux）
    ├── src/bridge/              11 个桥接模块（agentapi, conversation, paths 等）
    ├── src/cli/                 6 个工具（recall, topic, init, gate, read-log, squash）
    ├── src/mcp/                 1 个服务器（git-mcp stdio JSON-RPC 2.0）
    ├── src/maintenance/         4 个模块（session-gc, topic-gc 等）
    ├── src/schema/              schema-init + 迁移逻辑
    └── tests/                   499 个测试
```

## Hook 生命周期

Hook 在 `hooks.json` 中注册（由 `install.ts` 从 `conf/templates/hooks.template.json` 渲染）。

| 阶段 | Hook（按顺序） |
|------|---------------|
| **PreInvocation** | zombie-detector → snapshot-git → session-guardian → tone-injector → cognitive-push (pre-invoke) → check-subagents-liveness |
| **PreToolUse** | zombie-detector (全部工具), safety-check (run_command/view_file/grep_search/写操作), cognitive-push (写操作) |
| **PostInvocation** | action-gate (幻象检测) |
| **Stop** | compactor (事件驱动), clean-session-stats, check-subagents-liveness |

### safety-check.ts — 双层防线

1. **规则引擎层**：`conf/remora-rules.json` 中的 10 条 JSON 规则，由 core 的 `RuleEngine` 求值。引擎异常时 fail-closed。
2. **动态规则链**：`post-filters/` 和 `command-auditors/` 中的 14 条纯函数规则，短路执行（首个 DENY 胜出）。

## 核心能力

- **决策记忆**：自动提取 → SQLite + FTS5 trigram → 冷启动注入 → `remora-recall` CLI
- **声明式规则引擎**：10 条 JSON 规则 + 14 条 CoR 动态规则，fail-closed
- **子代理治理**：workspace 矩阵（branch/share/inherit）、prompt 密度限制、3 分钟去重、4-turn 只读熔断、高危命令门控
- **联合防腐**：view_file + grep_search 统一计费（80KB 警告 / 160KB 熔断）
- **幻象检测**：声称的文件修改 vs 物理 git diff 交叉验证
- **子代理存活自愈**：/proc 扫描、心跳探活、自愈 SOP（kill → clean → verify）
- **Git MCP**：零依赖 stdio JSON-RPC 2.0 git 服务器，隔离的版本控制
- **Hook 类型安全**：`PreToolUseResponse` / `PreInvocationResponse` 杜绝 protojson 崩溃
- **C5 Worktree 剪枝**：自动清理死掉的子代理分支和 worktree 目录

## CLI 工具

```bash
remora-recall "<关键词>"                         # 通过 FTS5 全文索引召回决策
remora-topic new|switch|close                    # 话题管理
remora-gate --rollback                            # 紧急回滚 safety-check
read-session-log <conv_id>                        # 阅读会话日志
git-squash                                        # 压缩增量提交
```

## 质量门禁

- `core/` 禁止 import `adapter-antigravity/`（`test_architecture.ts` 强制执行）
- 所有数据库读写通过 `@remora/core` DAO
- 880 个测试，0 跳过，CI 在 push/PR 时运行（Node 20/22）
- 严格 TypeScript（`strict: true`）+ Biome 格式化
- `data/` 在 rsync 部署时排除——用户数据库在升级时存留

## 部署

```bash
./deploy.sh                          # 构建两个包 + rsync 到运行目录
remora-install --force               # 重装
remora-install --uninstall           # 卸载插件，保留数据库
remora-install --uninstall --purge   # 卸载插件 + 数据库
```

开发目录（`~/wsl_code/remora-plugin`）与运行目录（`~/.gemini/config/plugins/remora-plugin`）物理隔离。`data/` 目录在 rsync 时排除——已有数据库在部署时存留。Schema 变更使用 try-catch `ALTER TABLE ADD COLUMN` 迁移，自动创建 `.db.bak` 冷备份。

## Phases

| Phase | 内容 | 状态 |
|---|---|---|
| 44-63 | Core/adapter 拆分、Python→TypeScript 迁移、npm 安装器、tsup 构建、部署管线、双语文档 | ✅ |
| 64-68 | 物理隔离部署、Sidecar 动态激活、CDAL 重构、声明式规则引擎（暗部署） | ✅ |
| 69-72 | 子代理治理：CLI 回滚、TS 构建断言、Scaffolder 软链、僵尸告警、路径归一化 | ✅ |
| 73-77 | 规则引擎切换 + Glob 绕过 + Route C1 schema 迁移 + 卸载 purge + 联合防腐防线 | ✅ |
| 78-80 | Stdio Git MCP + 高危命令门控 + CoR 防御管线重构 | ✅ |
| 81-84 | 魔法数字策略 + 测试加固（0 跳过）+ 严格 HookPayload 类型化 | ✅ |
| 85-88 | 严格 Fail-Safe（消灭静默 catch）+ C5 Worktree 剪枝 + C6 测试解耦 + C7 模块化 | ✅ |
| 89-90 | 类型安全 Hook 接口 + 高危命令交互式门控 + 行为约束强制注入 | ✅ |
