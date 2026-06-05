# Remora - Antigravity Agent Cognitive Architecture Plugin

Remora 是一个专为 Google Antigravity (AGY) SDK 驱动的自主智能体设计的高级认知架构与温记忆增强插件。通过全局拦截钩子与温存储设计，Remora 能够自动搜刮、增量更新并按需召回智能体的技术架构决策（Architecture Decisions）和物理代码文件关联，同时提供全面的多沙箱安全防护与子特工存活自愈能力。

---

## 一、 系统总体架构

Remora 采用**双轨交互与异步压缩**的混合认知架构：

1. **拦截防线 (Hooks Interceptors)**
   - **PreInvocation Hook** (`{PLUGIN_ROOT}/scripts/session-guardian.py`)：在特工唤醒前读取上下文，注入 `<system-reminder>` 提示词，并同步 Language Server 环境。
   - **PreToolUse Hook** (`{PLUGIN_ROOT}/scripts/safety-check.py`)：在物理工具执行前拦截，对只读/深度特工实施细粒度沙箱策略，限制文件读取大小，并将重编译、重测试任务委派至 `Remora_Deep_Diver` 子特工。
   - **Stop Hook** (`{PLUGIN_ROOT}/sidecars/memory-compactor/compactor.py --event-driven`)：在单轮会话退出时触发，增量比对制品 MD5 并将制品快照作为温事实导入 SQLite 存储。

2. **温存储核心 (Warm Storage Layer)**
   - 基于 SQLite 的本地高性能关系数据库，启用 `WAL` (Write-Ahead Logging) 模式以支持高并发读写。
   - 包含 `messages_fts` (基于 trigram 的 FTS5 全文索引虚拟表) 用于实现毫秒级历史回忆高精度模糊召回。
   - 管理 `messages` 事实数据、`project_topics` 话题库、`topic_decisions` 决策打标，以及 `watermarks` 会话映射记录。

3. **后台守护服务 (Memory Compactor Daemon)**
   - 周期性轮询活跃特工会话，使用 LLM 增量提取会话中的非结构化架构决策。
   - 计算决策的置信度、覆盖率，保证 UUID 和确认 ID 的继承链条无损。
   - 触发 GC（垃圾回收）清理过期会话水印以及 72 小时前无用户确认的自动话题。

---

## 二、 系统安装指南

### 1. `install.py` 的作用
`install.py` 是 Remora 的物理安装与环境挂载工具，它负责：
- 自动检测并初始化 SQLite 温存储数据库表结构与索引（调用 `{PLUGIN_ROOT}/scripts/schema_init.py`）。
- 读取 `{PLUGIN_ROOT}/hooks.template.json` 并根据当前插件根路径动态渲染物理路径。
- 将拦截钩子（PreInvocation、PreToolUse、Stop）动态挂载并配置到宿主特工环境的 `hooks.json` 中。
- 对旧版数据库结构执行无损的数据迁移（包含字段追加、表重构与索引重建）。

### 2. 如何将 hooks 挂载到环境
在插件根目录下运行以下命令完成安装与挂载：
```bash
python3 install.py
```
该命令会自动生成 `hooks.json`，并将拦截器物理挂载到 Antigravity 的引擎钩子链中。如果需要自定义过滤关键词，可编辑 `{PLUGIN_ROOT}/keywords.json`。

---

## 三、 开发与调试指南

### 1. 如何开发新 Hook
1. 在 `{PLUGIN_ROOT}/scripts/` 目录下编写您的钩子逻辑（例如 Python 脚本）。
2. 在 `{PLUGIN_ROOT}/hooks.template.json` 中配置对应的挂载阶段（如 `pre_invocation`、`pre_tool_call` 或 `post_session`）。配置示例：
   ```json
   {
     "stage": "pre_tool_call",
     "script_path": "{PLUGIN_ROOT}/scripts/my-new-hook.py",
     "timeout_ms": 5000
   }
   ```
3. 运行 `python3 install.py` 重新生成并挂载 `hooks.json`。

### 2. 如何运行测试
Remora 包含完整的单元测试套件，用以验证生命周期管理、数据库并发读写、垃圾回收以及安全沙箱规则的鲁棒性。
您可以在插件根目录下执行：
```bash
pytest scripts/tests/
```
**注意**：所有开发必须遵守 Quality Gate 规范，文档和非安装脚本代码中禁止硬编码非 antigravity 的 `~/.gemini` 或绝对路径。可使用 `{PLUGIN_ROOT}` 变量并在运行时由加载器/安装器进行动态解析替换。

---

## 四、 常见问题 FAQ

### Q1: 子特工（Subagents）执行卡死或超时如何解决？
* **原因分析**：子特工在独立分支沙箱中执行重构、编译或长命令时，可能会因为资源争抢、等待交互输入或进程死锁而卡住，从而导致父特工在同步等待时触发超时。
* **解决办法**：
  1. 系统挂载的 `{PLUGIN_ROOT}/scripts/check-subagents-liveness.py` 会在每次拦截时自动扫描活跃的子特工。
  2. 若子特工超时未更新 `.runtime/progress.json`（非物理命令 60 秒，命令执行 180 秒），系统将判定为 Dead 并读取累计重试次数记录。
  3. 大模型会收到 `kill_and_retry` 建议并强杀子特工重新发起。若重试满 2 次仍失败，则会报警抛出 `escalate_to_human` 引导人类用户介入排查。

### Q2: 遇到 SQLite 数据库锁定（`database is locked`）该怎么办？
* **原因分析**：后台 Compactor 守护进程在执行强独占事务（`BEGIN EXCLUSIVE`）清理垃圾数据或重构 FTS5 索引时，如果前台拦截钩子刚好在并发高频写入，可能会因为锁升级冲突引发锁定错误。
* **解决办法**：
  1. **开启 WAL 模式**：Remora 默认通过 Schema 初始化脚本开启了 WAL 预写日志模式（`PRAGMA journal_mode=WAL;`），这能够实现读写并发不冲突。若该模式失效，请运行 `python3 scripts/schema_init.py` 重新校验挂载。
  2. **锁超时重试**：数据库连接时默认配置了 `timeout=15`（15秒等待缓冲），确保前台在写入时有足够的重试窗口。
  3. **降低 GC 频次**：如果高并发写入量极高，可编辑后台 `compactor.py` 配置文件，适当调大垃圾清理周期的轮询间隔（例如由 5 分钟调整为 30 分钟），避开高峰。
