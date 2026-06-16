# CLAUDE.md

> 基于 2026-06-17 完整源代码审查生成。未参考任何历史文档或记忆。

## 项目概述

**remora-plugin** — Antigravity AI Agent 运行时的认知安全与记忆持久化插件系统。通过生命周期钩子在 Agent 执行的 4 个关键阶段（PreInvocation / PreToolUse / PostInvocation / Stop）注入拦截、校验、自愈逻辑，后端依托 SQLite 温存储层实现跨会话记忆、架构决策提取、幻影写入检测、子代理存活监控等能力。

- **仓库地址**: `git+https://github.com/pseudoming/remora-antigravity-plugin.git`
- **许可证**: MIT
- **Node 版本**: 20 / 22（CI 矩阵）
- **运行时平台**: Antigravity（Gemini 内部 AI Agent 框架）

---

## 仓库结构

```
remora-plugin/
├── packages/
│   ├── core/                               @remora/core v0.1.0
│   │   ├── src/
│   │   │   ├── index.ts                    公开 API barrel export
│   │   │   ├── dao.ts                      DAO 门面（re-export 全部 storage 模块 + gate + connection）
│   │   │   ├── policy.ts                   SYSTEM_POLICY 统一常量（SANDBOX/ORCHESTRATION/SAFETY/GREP/DISPLAY）
│   │   │   ├── safety-policy.ts            安全策略函数（prompt 长度/沙箱/读取熔断/语法校验/rot 敏感文件识别）
│   │   │   ├── injection-formatting.ts     15+ 提示词模板函数（行为纪律/冲突警告/写门禁/幻影告警/JIT/调度提醒）
│   │   │   ├── phantom.ts                  幻影文件检测（7 组中英文正则 + 标准化 + 差集算法）
│   │   │   ├── liveness.ts                 存活判定（模式检测/UUID 提取/僵尸判定/心跳取消检测）
│   │   │   ├── zombie.ts                   僵尸进程判定（纯逻辑，不含 /proc 扫描）
│   │   │   ├── gate.ts                     去重门控（shouldFire/markFired/isDuplicate/clearStale/shouldInjectTone）
│   │   │   ├── injector.ts                 决策文本截断（750 字符预算）
│   │   │   ├── reader.ts                   会话轮次提取（filterUserAiRounds）
│   │   │   ├── state-trim.ts               Hook 运行时状态清理
│   │   │   ├── text-analysis.ts            审批信号扫描 + 语义冲突检测 Prompt 构建
│   │   │   ├── filesystem.ts               文件遍历/MD5/快照 diff（黑名单目录过滤，2000 文件上限）
│   │   │   ├── coverage.ts                 置信度计算 + UUID 继承链完整性验证
│   │   │   ├── logger.ts                   结构化文件日志（按日轮转，3 天过期，支持调用栈定位）
│   │   │   ├── storage/                    11 个 DAO 模块
│   │   │   │   ├── connection.ts           DB 连接管理（WAL + NORMAL 同步）
│   │   │   │   ├── sessions.ts             会话模式读写
│   │   │   │   ├── messages.ts             消息存储 + FTS5 全文索引
│   │   │   │   ├── topics.ts               话题 CRUD + 文件关联 + 生命周期
│   │   │   │   ├── decisions.ts            架构决策 CRUD + FTS5 相关性搜索 + 确认/注入计数
│   │   │   │   ├── recall.ts               FTS5 + LIKE 联合回溯
│   │   │   │   ├── artifacts.ts            制品哈希缓存 + 事件队列
│   │   │   │   ├── watermarks.ts           会话水位线
│   │   │   │   ├── file-changes.ts         文件变更追踪
│   │   │   │   ├── runtime-state.ts        跨进程 Hook 状态 KV 存储
│   │   │   │   └── maintenance.ts          话题 GC / 水位线修剪 / 幽灵消息清理
│   │   │   └── rules/
│   │   │       ├── types.ts                类型定义（Condition/Action/Rule/Fact/DecisionResult）
│   │   │       ├── facts.ts                IFactExtractor 接口
│   │   │       ├── engine.ts               RuleEngine（优先级排序 + 6 种操作符条件匹配）
│   │   │       └── inspector.ts            Shell 命令安全检查器（tokenizer + 绕过检测 + base64 递归审计）
│   │   ├── schema/schema.sql               DDL + FTS5 trigram 触发器（9 张表）
│   │   ├── conf/
│   │   │   ├── keywords.json               relax/alert 触发关键词
│   │   │   ├── features.json               特征开关（semantic_conflict_detection 默认 OFF）
│   │   │   └── approval.json               审批信号关键词 + 否定前缀
│   │   └── tests/                          21 个测试文件
│   │
│   └── adapter-antigravity/                @remora/antigravity-plugin v0.1.0
│       ├── src/
│       │   ├── types.ts                    核心类型契约（AntigravityHookContext/PreToolUseResponse 等）
│       │   ├── hooks/
│       │   │   ├── safety-check.ts          ★ 核心安全钩子：规则引擎 → 14 条 DynamicRule CoR 链
│       │   │   ├── cognitive-push.ts        PreInvocation（冷启动/行为纪律/语义冲突）+ PreToolUse（写门禁）
│       │   │   ├── session-guardian.ts      ★ 最大钩子（~688 行）：启动检查/凭证缓存/模式检测/心跳管理/累计读取统计
│       │   │   ├── action-gate.ts           幻影检测（声称 vs 工具调用 vs 物理快照 三方交叉验证）
│       │   │   ├── tone-injector.ts         严格语气注入（每 5 轮一次）
│       │   │   ├── zombie-detector.ts       /proc 扫描僵尸进程（仅告警，不杀）
│       │   │   ├── rule-runner.ts           规则引擎桥接（AntigravityFactExtractor + RuleRunner 单例）
│       │   │   ├── snapshot-git.ts          文件系统快照（供 action-gate 消费）
│       │   │   ├── command-auditors/        6 个子代理命令审计器
│       │   │   │   ├── high-risk-gate.ts    高风险命令授权门禁（git push/rm -rf/npm publish）
│       │   │   │   ├── merger-audit.ts      Merger 子代理白名单审计
│       │   │   │   ├── main-audit.ts        主代理命令审计（反 rot + blast radius check）
│       │   │   │   ├── deep-diver-audit.ts  DeepDiver 子代理审计（宽松）
│       │   │   │   ├── readonly-audit.ts    ReadOnly 子代理审计（严格只读）
│       │   │   │   └── git-commit-escape.ts Git commit message 注入逃逸检测
│       │   │   └── post-filters/            9 个动态规则过滤器
│       │   │       ├── trim-timeline.ts         时间线清理
│       │   │       ├── duplicate-spawn.ts       重复 spawn 检测（3 分钟窗口）
│       │   │       ├── prompt-syntax.ts         Prompt 语法截断校验
│       │   │       ├── subagent-jit.ts          JIT 调度注入
│       │   │       ├── define-subagent-override.ts  内置 Agent 覆盖防护
│       │   │       ├── shared-workspace-traversal.ts 共享工作区路径穿越检测
│       │   │       ├── send-message-turn-limit.ts    send_message 轮次限制
│       │   │       ├── unified-read-limit.ts         统一读取累积熔断
│       │   │       └── git-mcp-deny.ts              Git MCP 写操作权限门禁
│       │   ├── bridge/                    11 个平台桥接模块
│       │   │   ├── agentapi.ts            agentapi CLI 封装（元数据/消息/会话创建）
│       │   │   ├── context.ts             Hook 入口包装器（stdin JSON → hook → stdout JSON）
│       │   │   ├── conversation.ts        CDAL：SQLite + Protobuf（AES-256-GCM 解密）数据访问层
│       │   │   ├── subagent.ts            子代理元数据（Protobuf summaries 解析）
│       │   │   ├── progress.ts            ProgressSentinel（原子化进度状态写入）
│       │   │   ├── filesystem.ts          平台文件系统操作
│       │   │   ├── paths.ts               路径解析
│       │   │   ├── profiler.ts            Hook 耗时分析
│       │   │   ├── session.ts             会话工具
│       │   │   ├── stats.ts               统计工具
│       │   │   └── step-codec.ts          步骤编解码
│       │   ├── sidecar/                   8 个后台守护模块
│       │   │   ├── compactor.ts           主循环调度器（周期/事件驱动）
│       │   │   ├── warm-storage-sync.ts   增量消息同步（含回滚检测）
│       │   │   ├── extract-decisions.ts   ★ ADR 提取管线（LLM 调用 → JSON 解析 → 置信度校验 → 入库）
│       │   │   ├── sync-artifacts.ts      制品同步
│       │   │   ├── check-approval.ts      审批检查
│       │   │   ├── consume-events.ts      事件队列消费
│       │   │   ├── scan-sessions.ts        会话扫描
│       │   │   └── sidecar-lock.ts        分布式锁
│       │   ├── sandbox/                   4 个沙箱模块
│       │   │   ├── check-subagents-liveness.ts  子代理探活 + 自愈 SOP 注入
│       │   │   ├── subagent-monitor.ts          schedule 定时回调监控器
│       │   │   ├── zombie-linux.ts              Linux /proc 工具
│       │   │   └── sandbox-merge.ts             沙箱合并（git diff + ghost audit）
│       │   ├── cli/                       6 个 CLI 入口
│       │   │   ├── remora-gate.ts          门控 CLI
│       │   │   ├── remora-init.ts          初始化 CLI
│       │   │   ├── remora-recall.ts        回溯查询 CLI
│       │   │   ├── remora-topic.ts          话题管理 CLI
│       │   │   ├── read-session-log.ts      会话日志读取
│       │   │   └── git-squash.ts            Git squash 工具
│       │   ├── debug/                     3 个调试工具
│       │   │   ├── env.ts                  环境信息
│       │   │   ├── inspect.ts              检查工具
│       │   │   └── tail.ts                 日志 tail
│       │   ├── maintenance/               4 个 GC/清理模块
│       │   │   ├── clean-session-stats.ts
│       │   │   ├── cleanup-ghost-records.ts
│       │   │   ├── session-gc.ts
│       │   │   └── topic-gc.ts
│       │   ├── mcp/
│       │   │   └── git-mcp.ts             Remora Git MCP 服务（stdio JSON-RPC 2.0）
│       │   ├── schema/
│       │   │   ├── schema-init.ts          DB 初始化 + 增量迁移（try-catch ALTER TABLE + 冷备份）
│       │   │   └── schema.sql              与 core 同源的 DDL
│       │   └── install.ts                  物理隔离部署（rsync 同步 + 源文件清除）
│       ├── conf/remora-rules.json          10 条声明式安全规则（优先级 50-100）
│       ├── agents/                         3 个子代理定义（JSON）
│       │   ├── remora_deep_diver.json
│       │   ├── remora_merger.json
│       │   └── remora_readonly_extractor.json
│       └── tests/                          35 个测试文件 + vitest.setup.ts
│
├── conf/                                  项目级配置（与 packages 内 conf/ 部分重叠）
│   ├── remora-rules.json
│   ├── keywords.json
│   ├── features.json
│   ├── approval.json
│   ├── high-risk-commands.json
│   └── templates/                         部署模板（hooks/mcp/sidecar/skill/agents/workflows）
├── hooks.json                             Claude Code Hook 注册表（4 阶段 11 个 Hook）
├── mcp_config.json                        MCP 服务注册
├── plugin.json                            插件元数据
├── agents/                                子代理定义（JSON）
├── skills/                                Claude Code Skill 定义
│   └── remora-architecture/SKILL.md
├── sidecars/                              Sidecar 配置
│   └── memory-compactor/sidecar.json
├── data/                                  运行时数据（gitignored）
│   └── remora_memory.db                   ~8 MiB SQLite 数据库
├── deploy.sh                              一键构建 + 部署
├── biome.json                             Biome 格式化/lint（tab 缩进，双引号）
├── docs/                                  项目文档
└── .github/workflows/test.yml             CI（Node 20/22）
```

---

## 构建与测试

```bash
# === 构建 ===
cd packages/core && npm run build                 # tsc → dist/（ES2022/CJS）
cd packages/adapter-antigravity && npm run build   # tsup → dist/（bundle CJS，内联 @remora/core，external better-sqlite3）
./deploy.sh                                        # 一键：core build → adapter build → install.js --force

# === 测试 ===
cd packages/core && npm test                       # vitest run，21 个文件
cd packages/adapter-antigravity && npm test         # vitest run，35 个文件，setup 文件自动备份/恢复 conf/keywords.json

# === 代码质量 ===
npx biome format --write .                         # 格式化
npx biome lint .                                   # 静态检查
```

---

## 架构规则（强制）

### 1. Core 零平台依赖
`packages/core/src/**` 中的任何 `.ts` 文件不得 import `adapter-antigravity` 或任何平台特定 API（`/proc`、`agentapi`、`protobuf` 等）。由 `test_architecture.test.ts` 静态 AST 扫描强制执行。

### 2. 全部 DB 访问走 DAO 门面
`packages/core/src/dao.ts` 是数据库访问的**唯一入口**——它 re-export 全部 11 个 storage 模块 + gate + connection。严禁在 DAO 之外直接调用 `better-sqlite3`。

### 3. 新模块归属

| 依赖项 | 归属 |
|--------|------|
| `better-sqlite3`、纯算法、DS、规则引擎、提示词模板 | `packages/core/src/` |
| `agentapi` CLI、`conversation.db`、Protobuf、Hook 协议、`/proc` 扫描、Antigravity 专有 API | `packages/adapter-antigravity/src/` |

### 4. Hook 响应结构严格约束
Hook stdout 输出的 JSON 必须严格符合 `PreInvocationResponse` / `PreToolUseResponse` 类型定义（`adapter-antigravity/src/types.ts`）。任何未识别的 key 会导致 Antigravity `protojson` 反序列化器崩溃。调试输出走 `stderr`（`console.error`/`console.debug`）。

### 5. 禁止硬编码路径
使用 `REMORA_DB_PATH` 环境变量或 `bridge/paths.ts` 中的路径解析函数。不得假定固定路径。

### 6. Fail-Closed 安全原则
安全组件异常 → deny，不 allow。规则引擎异常 → deny。动态规则链异常 → throw → 上层 catch → deny。不允许静默吞异常后放行。

---

## Hook 生命周期

Hook 在 `hooks.json` 中注册，按阶段顺序执行：

| 阶段 | Hook（按执行序） | 触发时机 |
|------|-----------------|---------|
| **PreInvocation** | zombie-detector → snapshot-git → session-guardian → tone-injector → cognitive-push (--stage=pre-invoke) → check-subagents-liveness | 每次 Agent 调用开始前 |
| **PreToolUse** | zombie-detector（`.*` 全工具）→ safety-check（写/读/命令工具）→ cognitive-push (--stage=pre-tool) | 工具调用前，按 matcher 过滤 |
| **PostInvocation** | action-gate | Agent 调用完成后 |
| **Stop** | compactor（--event-driven）→ clean-session-stats → check-subagents-liveness | Agent 会话停止时 |

### PreToolUse matcher 详情

```
.*                                              → zombie-detector.js
run_command|view_file|grep_search|write_to_file
  |multi_replace_file_content|replace_file_content → safety-check.js
write_to_file|multi_replace_file_content
  |replace_file_content                          → cognitive-push.js --stage=pre-tool
```

---

## 核心 Hook 详解

### safety-check.ts — 双层安全防线

所有 PreToolUse 安全检查的统一入口。两阶段串联：

**第 1 层：规则引擎（声明式）**
- `globalRuleRunner.runActiveBlock(hookType, rawPayload)` 调用 `RuleEngine.evaluate()`
- 10 条 JSON 规则（`remora-rules.json`），按 `priority` 降序评估，首个匹配即返回
- 覆盖：沙箱逃逸（P100）、日志爆炸（P95）、Prompt 长度（P90）、密度违规（P85）、工作区 JIT（P80）、继承写保护（P75）、view_file 限制（P70）、PB 读取（P65）、DB 环境缺失（P60）、ReadOnly 轮次（P50）
- 引擎异常 → fail-closed → deny

**第 2 层：动态规则链（命令式）**
- 14 个 `DynamicRule` 函数，签名 `(ctx: DynamicRuleContext) => PreToolUseResponse | undefined`
- 依次执行（CoR），首个非 `undefined` 结果即为最终裁决，短路后续规则
- 执行顺序：
  1. `trimTimelineRule` — 清理过期 Hook 状态
  2. `checkDuplicateSpawnRule` — 3 分钟窗口内重复子代理 spawn 检测
  3. `checkPromptSyntaxRule` — 子代理 prompt XML 标签/括号/引号完整性校验
  4. `injectSubagentJITRule` — JIT 调度提醒注入（不 deny）
  5. `checkDefineSubagentOverrideRule` — 内置 Agent 权限覆盖防护
  6. `checkSharedWorkspaceTraversalRule` — 共享工作区路径穿越检测
  7. `checkSendMessageTurnLimitRule` — ReadOnly 子代理 4 轮限制
  8. `checkUnifiedReadLimitRule` — 主代理统一读取累积熔断
  9. `checkGitMcpRule` — Git MCP 写操作仅限 Merger
  10. `auditMergerCmdRule` — Merger 子代理命令白名单审计
  11. `auditReadonlyCmdRule` — ReadOnly 子代理命令只读审计
  12. `auditDeepDiverCmdRule` — DeepDiver 命令审计
  13. `auditMainCmdRule` — 主代理命令审计（反 rot + blast radius）
  14. `auditHighRiskCmdRule` — 高风险命令授权门禁

### session-guardian.ts — 会话守护（最大钩子）

PreInvocation 阶段运行，承担 6 项职责：
1. **启动检查**：验证 `.runtime/installed.flag` 存在，不存在则注入 FATAL ERROR
2. **凭证缓存**：将 `ANTIGRAVITY_LS_ADDRESS` / `ANTIGRAVITY_CSRF_TOKEN` 写入 JSON 文件供子代理读取
3. **共享工作区挂载**：为子代理 symlink `scratch/subagent_shared/`，为主代理导出活跃决策
4. **子代理心跳管理**：检测 schedule 定时器注册状态，缺失则注入 `schedule(DurationSeconds="60")` 指令
5. **模式检测**：匹配 `keywords.json` 中的 relax/alert 关键词，触发对应注入策略
6. **累计读取统计**：跟踪 source/data 字节数，超软水位线（150KB/50KB）时注入子代理委派提醒
7. **GC 触发**：每个新 turn 触发 `cleanup(convId)`

### cognitive-push.ts — 认知推送

双阶段运行：
- **PreInvocation**：冷启动决策注入、relax 模式行为纪律、语义冲突检测（Line C，特征开关控制，每 10 轮触发，LLM 驱动的 rejected/deferred 决策冲突分析）、工作追踪提示
- **PreToolUse（写门禁）**：首次写非规划文件 → deny + 要求解释意图；同回合二次重试 → allow + 注入关联历史决策；规划制品（`/artifacts/task.md` 等）直接放行

### action-gate.ts — 幻影检测

PostInvocation 阶段，三方交叉验证：
1. 正则（`ACTION_PATTERNS` 7 组中英文）从 PLANNER_RESPONSE 提取"声称修改"的文件
2. 从 transcript 提取实际工具调用的 TargetFile
3. 对比 pre/post 文件系统快照（由 snapshot-git.ts 产生）
4. 差集计算 → phantom 文件集合。首次注入警告 + force_continue；重复注入更强警告

---

## 数据库

SQLite，WAL 模式 + NORMAL 同步。FTS5 trigram 分词支持中文/日文全文检索。

### 核心表

| 表名 | 键 | 用途 |
|------|-----|------|
| `project_topics` | (uuid, topic_id) | 按项目隔离的话题，含状态、摘要、置信度、关联文件 JSON |
| `topic_decisions` | id (autoincrement) | ADR，含决策/原因/证据链/用户确认/注入计数/压缩摘要 |
| `messages` | id | 原始消息归档 |
| `messages_fts` | (FTS5) | trigram 全文索引，INSERT/DELETE 触发器自动同步 |
| `watermarks` | (project_uuid, conversation_id) | 会话维度消息处理水位线 |
| `artifact_hashes` | file_path | 制品 MD5 缓存（毫秒级增量同步） |
| `session_state` | session_id | IPC 会话模式（relax/strict）+ 冷启动标记 |
| `runtime_hook_state` | (session_id, turn_idx, key) | 跨进程 Hook KV 状态 |
| `file_changes` | id | 文件物理变更追踪 |
| `remora_event_queue` | id | 物理事件同步队列（多项目隔离） |

### 迁移策略
- `schema-init.ts` 通过 try-catch `ALTER TABLE ADD COLUMN` 探测缺失列
- 迁移前自动创建 `.db.bak` 冷备份
- `data/` 目录在 rsync 部署时排除，用户数据不会被覆盖

---

## 子代理体系

三个专用子代理类型，每个有详细的 JSON 行为定义（`agents/*.json`）：

| 子代理 | 用途 | 命令审计策略 |
|--------|------|-------------|
| `Remora_ReadOnly_Extractor` | 只读信息提取、代码审阅 | 严格只读（readonly-audit），4 轮限制 |
| `Remora_Deep_Diver` | 深度分析、复杂调试 | 宽松（deep-diver-audit），仅防 git commit 逃逸 |
| `Remora_Merger` | Git 合并、分支管理 | 白名单（merger-audit），仅允许 git checkout/merge/am/apply/add/commit/diff/status |

---

## 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `REMORA_DB_PATH` | `~/.remora/data/remora_memory.db` | SQLite 数据库路径 |
| `REMORA_LOG_LEVEL` | `INFO` | DEBUG/INFO/WARN/ERROR/OFF |
| `REMORA_LOG_DIR` | `$TMPDIR/remora/log` | 结构化日志目录 |
| `REMORA_TRACE_ID` | `s_<8-hex>` | 请求追踪 ID |
| `REMORA_HOOKS_PROFILE_LOG` | `~/.remora/data/hooks_profile.log` | Hook 耗时分析日志 |

---

## 关键设计模式

- **DAO 门面**（`dao.ts`）：11 个 storage 模块的单一 barrel 再出口，所有 DB 操作强制流经此入口
- **Barrel Export**（`index.ts`）：`@remora/core` 的完整公开 API 面
- **责任链（CoR）**：14 个 DynamicRule 依次执行，首个非 undefined 结果短路
- **JIT 注入**：一次性临时消息注入，通过 `runtime_hook_state` 标记防重复
- **去重门控**（`gate.ts`）：基于 `runtime_hook_state` 的字符串值比较去重
- **Fail-Closed**：安全组件异常一律 deny，绝不静默放行
- **文件快照 diff**：PreInvocation 快照 → PostInvocation 比对，交叉验证
- **特征开关**（`features.json`）：语义冲突检测（Line C）当前 OFF
- **增量迁移**：try-catch ALTER TABLE + 冷备份，向前兼容

---

## 提交规范

```
[Phase XX Report] <简要标题>

Changelog:
- <文件路径>:
  * <详细变更条目>

Co-Authored-By: Claude <noreply@anthropic.com>
```
