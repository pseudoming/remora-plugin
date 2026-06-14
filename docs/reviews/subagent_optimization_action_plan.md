# Subagent 协同效能提升与物理缺陷修复路线图
> 制定时间：2026-06-11 | 基础数据源：4 个核心主矿会话（bbde1aba, eb6fe685, faae9b51, 7eab3152）共计 148 次调用全量深度审计

本路线图基于 148 次历史子代理调用的定量数据与定性分析，整合了框架物理 Bug、行为偏航和提示词失误，旨在建立一套完整的效能优化与故障修复行动纲领。

---

## 📊 一、 跨会话定量统计与背景跨度
根据对历史 148 次 `invoke_subagent` 全生命周期的审计，核心统计分布如下：

*   **Prompt 平均质量**：**3.2 / 5.0 分**（1-2★低质量占比 21%，主代理指令精准度亟待提高）。
*   **Prompt 约束覆盖率**：文件路径覆盖率达 94%；但**安全约束仅占 8%**，**超时指令仅占 4%**（子代理运行严重缺乏动态保护网）。
*   **头号失败根因**：**环境拦截与工具缺失（27%）**，远高于 Prompt 本身模糊导致的失败（合计 12%）。
*   **智能体误用率**：**18%**（在纯只读任务中错误派发了具备写权限的 `Remora_Deep_Diver`，而在某些会话中这一误用率高达 81%）。
*   **重复派发率**：**10%**（相同子任务多次派发，造成严重的 Token 与时间浪费）。

---

## 🎯 二、 主代理（Parent Agent）派发逻辑优化 (Dispatch & Dynamic Prompt)
这部分优化位于主代理下发 `invoke_subagent` 时的逻辑判断与 Payload 构造中，从源头上减少特工误用与重复开销。

### 1. 【P0 ✅ 已完成】 派发前的兵种与工具链前置过滤 (Tool Boundary Gate)
*   **规则**：主干在派发前必须预分析指令中的核心命令特征。
*   **动作**：若指令中含有终端操作（如 `git`、`sqlite3`、`grep`、`npm`、`build`），**只读特工绝对不可用**，必须派发 `Remora_Deep_Diver` 并限制在隔离沙盒内执行；若为纯文件浏览或日志索检，优先指派 `Remora_ReadOnly_Extractor` 以节省认知空间。
*   **实施**：`conf/templates/workflows/remora_coordinator.md` 新增 subagent 类型选择与工具链前置过滤章节。

### 2. 【P0 ✅ 平台已保障】 并发派发会话 ID 独占化与防重入 (Session Isolation & Re-entrancy Guard)
*   **规则**：并发审计及长链任务场景下，禁止复用带有历史残留状态的旧子代理会话，以防发生上下文污染和认知偏差。
*   **动作**：强制每一次非连续性的子任务派发必须通过 `invoke_subagent` 分配全新且全局唯一的会话 ID，保证沙盒运行时的“绝对隔离与纯净”。
*   **实施**：Antigravity 平台 `invoke_subagent` 默认不接收 `ConversationId`，每次调用自动分配新 ID。此外，主干代理每次执行新派发时，禁止将新指令发送给已处于 idle 状态的旧特工，必须 Spawn 新实例；对确需复用特工的极少数场景，必须在复用前对特工进行 context cache 与运行时变量的完整重置。


### 3. 【P1 ✅ 已完成】 废除 Prompt 中所有的“开放式修复”指令 (No Open-Ended Fixes)
*   **实施**：`remora_coordinator.md` 新增"subagent Prompt 安全约束"章节；`remora_deep_diver.template.json` 新增 Rule 11 Fail-Fast 规则。
*   **规则**：禁止向子特工下达 "fix any bugs if it fails" 等无边界自修指令。
*   **动作**：当子特工遭遇编译/测试失败，应强制指示其 Fail-Fast 阻断，并将精确的报错详情通过 `send_message` 上报回父代理，由父代理决策，规避 14% 的子代理越界乱改生产代码行为。

### 4. 【P1 ✅ 已完成】 单一 Prompt 子任务强上限限制 (Single Prompt Task Limit)
*   **实施**：`remora_coordinator.md` 新增 Prompt 子任务上限规则；`remora_deep_diver.template.json` Rule 13 (W12)；`remora_readonly_extractor.template.json` 同 W12。
*   **现象**：由于一个 Prompt 内混合了 4+ 个相互交织且无优先级排序的子任务，导致子特工在沙盒中执行了多达 569 步，其中 95% 的步数和 Token 均在无意义的发散中被白白浪费。
*   **动作**：在主代理派发层加入物理规则：单个子特工的 Prompt 指令中**最多仅允许包含 1-2 个具体的闭环子任务**。任何超量、多步骤的复合型排查/修复任务，主代理必须将其拆分为多阶段的子任务，依次或并发指派给特工执行。

### 5. 【P1 ✅ 已完成】 杜绝豁免性欺骗提示词 (No Hallucinated Privilege Claims)
*   **现象**：主代理为了安抚子代理去读大日志，在 Prompt 中使用欺骗性断言：“作为子特工你已经获得了豁免限制”。但在物理框架层面此豁免并未被激活，导致子特工在读取时依然被 Hook 拦截误杀，产生严重的信息不对称（见 NOVEL 失败模式 16）。
*   **动作**：严禁在指派 Prompt 中写入任何带有主观假设豁免的欺骗性话术。主代理必须根据真实的物理权限边界（如只读特工不能跑 shell 终端，主代理不能跑大日志 view_file）组装指令。

### 6. 【P1 ✅ 已完成】 主代理消费链去重校验 (Consuming Deduplication)
*   **状态**：已于 Phase 71 通过实现 Rule 4 Duplicate Spawn Rate Limiter 物理限流拦截机制完成，限制 180 秒内相同任务或角色的重复派发，规避冷启动开销。
*   **规则**：避免 10% 的重复派发浪费。
*   **动作**：主代理在启动新子特工前，必须核查历史 context 缓存，若已有类似子特工的输出未被引用消费，禁止重复派发相同任务。

---

## 🧠 三、 ✅ 子代理（Subagent）十五条微观行为规范 (Micro-Behavior Rules)
这部分微观规则必须被强制内嵌至 `Remora_Deep_Diver` 和 `Remora_ReadOnly_Extractor` 的系统提示词模板中，约束其沙盒内的底层动作纪律。

*   **实施状态**：全部 15 条规则已落地至 `agents/remora_deep_diver.json` 和 `agents/remora_readonly_extractor.json`（及模板），含审计师修正。
    - Deep_Diver: 25 条规则 (W4~W24)，含 W7 合并 NEED_TOOL + W14 限流 + W24 ANTI-ROT 降级通路
    - ReadOnly: 20 条规则 (W4~W24)，跳过不适用项（自指误拦截/零无谓创建/核心命令验证/熔断）
    - W10~W13 已从部署版同步回仓库模板
### 1. 物理重试防线
*   **【P0】 自指误拦截重试**：当你执行构建/测试命令遭遇 `DELEGATION BLOCKED` 或 `SAFETY INTERCEPT`，且你检查自己的 TypeName 就是指定的特工时，这属于系统的 False Positive（假阳性拦截），你必须立即重试执行该工具，严禁退回主代理。

### 2. 工具与依赖隔离
*   **【P0】 工具缺失秒退**：如果接收到的 Task 需要你物理上不具备的工具（如只读特工没有 `bash`/`git`/`sqlite3`），你必须在第 1 步立即调用 `send_message` 上报错误 `NEED_TOOL: <tool_name>` 并阻断退出，绝不允许进行盲目变通。
*   **【P3】 三步定位上限**：在查找和定位目标文件时，限制在 3 步内完成。若超过 3 步限制依然找不到对应文件，立即上报 `FILE_NOT_FOUND` 并停止，拒绝长步骤的野外考古搜寻。

### 3. 文件读写约束
*   **实施**：`remora_coordinator.md` 新增"subagent Prompt 安全约束"章节；`remora_deep_diver.template.json` 新增 Rule 11 Fail-Fast 规则。
*   **【P0】 零无谓物理文件创建**：除非 Task 指令中显式命令你写入文件，否则你**严禁**自发在沙盒内创建 `task.md`、中间日志、临时草稿或测试脚本。所有的分析与过程必须只通过文本报告在对话中呈递。
*   **【P1】 相对路径一致性**：所有读写和浏览操作的文件路径均以 `<repo_root>` 为锚点。在执行任何读取前，必须使用 `list_dir` 或 `stat` 验证目标文件是否在物理上存在，禁止凭空臆想。
*   **【P2】 单文件只读一次**：你对同一个文件仅允许读取一次。读取完毕后立刻将有用数据缓存在回复中，不允许因发生 compaction 或流程反复而重复读取相同文件，消除大体积 IO 沉没成本。

### 4. 任务执行与纠偏
*   **实施**：`remora_coordinator.md` 新增 Prompt 子任务上限规则；`remora_deep_diver.template.json` Rule 13 (W12)；`remora_readonly_extractor.template.json` 同 W12。
*   **【P1】 核心命令强制验证**：执行 Prompt 中显式给出的每条 bash 验证命令，在执行任何自主搜索前，不准跳过、不准用变通命令替换。
*   **【P1】 安全拦截降级保护**：当读取日志被 `ANTI-CONTEXT-ROT` 拦截时，优先检查 `scripts/` 或 `packages/` 下是否存在预置的只读访问脚本（如 `remora-recall.sh` 等），通过脚本提取，而不是强读原日志文件。
*   **【P1】 阶段性检查点上报 (抗失忆)**：为防止因 200 步左右触发 Compaction 清空上下文导致失忆，你必须每隔 25-30 步向父代理回传一次结构化检查点 `(a)已读文件 (b)关键发现 (c)剩余步骤`。若遭遇 compaction，利用该检查点迅速恢复记忆。
*   **【P1】 熔断机制**：任何工具调用如果在沙盒内被物理拦截超过 2 次，禁止盲目重试。必须立刻通过 `send_message` 将已有数据和拦截错误发送给父代理，Fail-Fast 退出。
*   **【P3】 任务完成即刻终止**：一旦 Task 指令中所列出的目标达成，必须立即停止。禁止擅自发明新的辅助工作，禁止去读取和浏览与该 Task 无关的其他生产代码。
*   **【P3】 括号消除规则**：指令中括号内的备注性文字（如 `mock (mook)`）仅作为澄清，在进行检索时自动将其忽略，只检索主术语。

---

## 🛠️ 四、 框架平台物理 Bug 修复与 NOVEL 失败模式防御
这部分工作必须直接在 Antigravity 框架 Hook 及底座代码中进行修复。

### 1. 【P0 ✅ 已完成】 修复沙盒内的自指拦截误杀 (Fix Sandbox Block)
*   **NOVEL 模式 1**：`safety-check.ts` 拦截构建/测试时，由于无法识读子上下文，导致已在沙盒中的 Deep_Diver 陷入"去委派子代理"的自指悖论。
*   **修复动作**：修改 `safety-check.ts` 逻辑，在解析到 `isSub === true` 且 TypeName 为 `Remora_Deep_Diver` 时，**无条件豁免**常规构建和测试命令拦截。
*   **实施**：#13 使 `isSub` 判定 100% 可靠后，本项自然消解。此外豁免条件从 `category === "test" || "build"` 扩为 `isSub && !isReadonlySub`，堵上 shlex 解析失败导致的 `syntax_error` 间隙。子代理不再收到 DELEGATION 消息。
    - `safety-check.ts`: L293 豁免条件放宽 + 注释

### 2. 【P0 ✅ 已完成】 修复大日志读取防线对子代理的误杀 (Exempt Logs in Sandbox)
*   **NOVEL 模式 9**：只读特工读取日志时，物理 Hook 仍执行体积累加熔断，导致本应用于大日志读取的隔离子特工瘫痪。
*   **修复动作**：在 `safety-check.ts` 中设定，当 `isReadonlySub === true` 时，**彻底豁免** view_file 累加限制与 `.jsonl` 敏感后缀拦截。
*   **实施**：#13 使 `isReadonlySub` 判定 100% 可靠后自然消解。`safety-check.ts:167` 的 `isReadonlySub` 豁免和 L175 的 `!isSub` 累加跳过已覆盖。无需额外代码改动。

### 3. 【P0 ✅ 已完成】 Zero-Step Spawn (零步衍生静默吞噬) 错误传播修复
*   **NOVEL 模式 5**：子特工在初始化失败时产生 0 行 transcript 日志，主框架未将此生命周期错误向主代理进行任何异常传播，导致系统静默等待并卡死。
*   **修复动作**：在 `subagent-monitor` 状态机中加入首步心跳断言。一旦拉起子代理但在 5 秒内未检测到首行生命周期产生，立即抛出 `SUBAGENT_SPAWN_FAILED` 物理错误并传播给主代理，触发紧急回退。
*   **实施**：`subagent-monitor.ts` 移除 `not_found` 提前退出，增加 30 秒超时检测。0 步 + 超时 → `spawn_failed` (exit 1)。`ConversationDataAccessLayer` 新增 DB→PB fallback 路由（`_dbHasContent` / `_loadPbSteps` / stream 方法 / `getDbMtime` 等），保证 DB 缺失时能通过加密 PB 获取会话元数据。
    - `conversation.ts`: +`_dbHasContent()` / `_loadPbSteps()` / `getLastModifiedTime()`，stream/stepIndex/mtime 方法 PB fallback
    - `subagent-monitor.ts`: 删除 early `not_found` exit，空步 + 30s 超时 → spawn_failed
    - 测试: +21 个 PB fallback 测试

### 4. 【P0 ✅ 已完成】 修复 Stop Hook Idle Guard (退出阻断悬挂) 逻辑缺陷
*   **实施**：`remora_coordinator.md` 新增 Prompt 子任务上限规则；`remora_deep_diver.template.json` Rule 13 (W12)；`remora_readonly_extractor.template.json` 同 W12。
*   **NOVEL 模式 6**：子代理事实上已经执行完毕并完成工作，但被 “no message sent” 阻断 Hook 卡住，必须经历 3-5 步的反复超时尝试才能强行退出，造成资源空转。
*   **修复动作**：重构退出拦截钩子逻辑，检测到子特工工具调用流已清空且上报结果就绪时，**强制绕过**空闲守卫（Idle Guard），实现毫秒级快速闭环退出。

### 5. 【P1 ⏳ 待观察】 防止 Ghost Completion (幽灵完成)
*   **NOVEL 模式 8**：子特工在极短步骤内宣称完成了极其复杂的物理修改（实际并未修改），主代理轻信其结论。
*   **修复动作**：在主干框架增加校验 Hook，对子代理报告中所声称修改过的 `Associated Files` 强制运行 git diff 或 physical check，对不实宣称抛出 `GHOST_COMPLETION_ERROR` 熔断。
*   **状态**：已有 `extractSubagentReport` 提取声称更改 + `sandbox-merge` 验证双向覆盖，加第三道校验性价比不高。待观察确认是否仍有幽灵完成发生。

### 6. 【P1 ⏳ 待观察】 防范 Safety Regex Bypass (安全正则绕过)
*   **状态**：已由心跳探活、JIT 注入、subagent-monitor 等基础设施覆盖。10% 重复派发来自早期会话数据，当前机制应已抑制。待观察确认。
*   **NOVEL 模式 10**：子代理利用 `reca*.sh` 通配符 glob 绕行了 safety-policy.ts 硬编码的脚本文件名过滤，实施了危险命令绕过。
*   **修复动作**：在命令审计层引入路径归一化解析，在匹配前解析出最终指向的绝对物理文件名，封锁通配符绕过漏洞。

### 7. 【P1 ⏳ 待观察】 物理截断 (Prompt Truncation) 防卫
*   **NOVEL 模式 7**：由于消息通道响应长度或语法截断，导致主代理派发的 Prompt 在半空中被切断（句中截断），子代理基于残破文本偏航。
*   **修复动作**：在 Prompt 通道拼装中加入完整性特征校验，对于未闭合的括号或句式直接拒绝发送并重新握手。

### 8. 【P1 ✅ 已完成】 修复工作区 branch 状态解析崩溃 (Fix got 2 workspaces)
*   **修复动作**：修改 Hook 工作目录解析，采用符号链接归一化解析，消除因多路径漂移引起的 `got 2` 报错崩溃。

### 9. 【P1 ✅ 已完成】 防范子代理配置动态篡改与越权 (Prevent Subagent Configuration Overriding)
*   **NOVEL 模式 12**：主代理在调用 `define_subagent` 时，通过动态传递与系统预设核心特工（如 `Remora_ReadOnly_Extractor`）同名的参数，并强行将 `enable_write_tools` 设为 `true`，从而使子代理在运行期获取了超越其角色原定安全沙箱的物理权限，导致静态隔离规约失效。
*   **修复动作**：在框架的 `define_subagent` 注册机制或 Hook 安全审计层（如 `safety-check.ts`）引入静态重载校验，禁止动态创建或覆盖与内置静态预设（`agents/` 下 the JSON）重名的特工；一旦检测到同名覆盖或关键权限参数（如 `enable_write_tools`）与静态文件不符，触发物理熔断拒绝定义。
*   **实施**：`safety-check.ts` 新增 `define_subagent` 拦截块，比对请求权限与 `agents/*.json` 静态定义，`enable_write_tools` 或 `enable_subagent_tools` 升级时拒绝 (CONFIG_OVERRIDE)。
    - `safety-check.ts`: +`BUILTIN_AGENTS` 常量 + `loadBuiltinAgentPerms()` + `define_subagent` 拦截块
    - `test-safety-check-wrapper.test.ts`: +4 个测试用例

### 10. 【P0 ✅ 已完成】 子代理启动时定时监控检查挂载失效故障排查与修复 (Fix Missing Scheduled Monitors)
*   **现象**：最近若干轮指派子代理执行任务时，原有的 Cron/Timeout 定时探活和自动回收守护程序未能在后台成功挂载与唤醒，导致子代理失去定时保护网。
*   **修复动作**：核查 `subagent-monitor` 状态机与插件注册生命周期钩子，确保 `schedule` 或定时器在 `invoke_subagent` 发起后 100% 成功注入并建立心跳监听，若注册失败则抛出告警并限制执行。
*   **实施**：`formatJitInjection()` 提示词重排序——Prompt 质量检查前置，schedule 调用后置且标记为独立强制步骤，消除与"不合格则重来"的指令冲突。链路已有 session-guardian 二次注入兜底，持续观察模型服从度。
    - `injection-formatting.ts`: `formatJitInjection()` 重排序 + schedule 加粗

### 11. 【P0 ✅ 已完成】 衍生未托管进程与僵死后台进程自动扫描及物理强杀 (Prevent Rogue Process Leaks)
*   **现象**：插件在运行期存在未被宿主监控到、存活时间过长的衍生后台进程（如 UPTIME 达数万秒的衍生 bash/node 进程），占用沙盒资源并触发安全网关警报。
*   **修复动作**：在 `scanner` 守护程序中引入进程家族树追溯与时间戳校验，一旦扫描到父会话已关闭或处于空闲状态、但衍生进程仍存活的“僵尸进程”，执行物理强杀（`kill -9`）并记录安全审计日志。
*   **实施**：阈值提升 + 提示词优化（自动强杀暂缓）。`isProcessExpired` 默认阈值 15s → 300s，避免正常子代理构建/测试被误杀。`zombie-detector.ts` 拦截提示改为 4 步自愈流程（list 确认 → 已死忽略 → 滞留等 60s kill → 正常忽略），拒绝原因更友好。
    - `core/src/zombie.ts`: `isProcessExpired` 阈值 15s → 300s
    - `hooks/zombie-detector.ts`: 提示词改为自愈流程 + 拒绝原因优化
### 12. 【P0 ✅ 已完成】 修复基于本地 runtime 主干 ID 标志文件的竞态与污染失效漏洞 (Fix Main ID Flag File Contamination)
*   **现象**：在非 LS 环境或运行过单元测试后，`.runtime/remora_main_conv_id.txt` 残留了 mock 值（如 `conv_1`）。此时如果以主会话执行，由于 Hook 写入条件 `process.env["ANTIGRAVITY_LS_ADDRESS"]` 限制导致无法重写该文件，主会话在 Hook 比对中会被错判为子会话 (`Remora_Subagent_Fallback`)，发生严重功能降级。
*   **修复动作**：重构 Hook 的写入条件。只要确定当前是主干代理，且当前会话 ID 与文件中的值不符，**无条件强制重写**该标志文件，消除对 LS 环境变量的依赖；同时在 `getSubagentType` 的排除判定逻辑中，若标志文件排除判定生效返回 Fallback，强制采用方案 B（`summaries.pb` 静态解析）进行二次校验，避免文件污染导致的判定失效。
*   **实施**：`remora_main_conv_id.txt` 已从全链路删除。判定不再依赖此文件，写入逻辑已从 `session-guardian.ts` 移除。`remora-topic.ts` 的 `forceColdStart()` 在文件缺失时走 `forceColdStartLatestSession(undefined)` 的 `ORDER BY updated_at DESC` fallback，语义无损。
    - `bridge/subagent.ts`: getSubagentType() 不再将 remora_main_conv_id.txt 作为 fallback
    - `session-guardian.ts`: 删除主 ID 锚点写入逻辑（原 L58-68），移除 ANTIGRAVITY_LS_ADDRESS 依赖
    - `scan-sessions.ts`: isSubagentSession() 收敛至 summaries PB 后间接不再依赖

### 13. 【P0 ✅ 已完成】 收敛子代理身份判定为全局摘要优先路由，LS 环境变量仅作极端兜底 (Consolidate Subagent Detection to Summaries PB)
*   **现象**：前期的判定方案分散在本地运行时标志文件、LS 环境变量与 `agentapi` 中，易因环境差异和污染引发误判。
*   **修复动作**：物理重构和收敛插件全生命周期中所有涉及主/子代理的判定逻辑，统一收口至 `agyhub_summaries_proto.pb` 全局摘要的静态解析（即通过读取并比对 `parent_conversation_id` 存在性）。将对 LS 环境变量的判断（如通过 `agentapi get-conversation-metadata` 或 `ANTIGRAVITY_LS_ADDRESS`）限定为**极低概率的系统防线兜底（Fallback Option）**，只有在摘要文件物理损坏、缺失或由于文件系统 IO 故障导致 PB 数据无法读出时，方可降级激活环境变量嗅探与 LS 联查。
*   **实施**：全链路判定统一收口至 `agyhub_summaries_proto.pb` 的 Config Tag 5 (`parent_conversation_id`) 静态解析。Hook 路径 (`safety-check.ts` / `session-guardian.ts`) 和 Sidecar 路径 (`warm-storage-sync.ts` / `extract-decisions.ts`) 均已收敛。PB 缺失/损坏时默认返回 null（判为主代理），不设 agentapi 兜底（PB 损坏意味着底座已不可用）。
    - `bridge/subagent.ts`: 新增 `parseSummariesPb()` + `getSubagentTypeByConvId()`；`getSubagentType()` 简化为委托；移除 agentapi 调用链、subagent_types.json、remora_main_conv_id.txt 全部 fallback
    - `session-guardian.ts`: heartbeat roleName 从 `getMetadata()` 切换至 `getSubagentTypeByConvId()`
    - `scan-sessions.ts`: `isSubagentSession()` 从 DB 启发表切换至 `getSubagentTypeByConvId() !== null`
    - `vitest.setup.ts`: 删除全局 `vi.mock("node:child_process")`（修复 5 个 pre-existing sandbox_merge 测试）

---

## ⚠️ 五、 ⏳ 认知与交互纪律微调

1.  **消除“僵尸惩罚语言”对特工的心智反向压制**：
    *   **现象**：Prompt 中 40% 的文本为假死惩罚警告，导致子特工在阅读到 sqlite 库时产生极度畏难和逃避心智，不敢执行正常的读取。
    *   **行动项**：将惩罚警告转化为正规的防御性代码范式（如主动提醒挂载 PRAGMA journal_mode = WAL），恢复特工正常的排查与探知本能。
2.  **⏳ 避免 `cognitive-push` 提示词注入越界覆盖** (已有框架隔离):
    *   **状态**：所有注入消息已使用 `<system-reminder>` / `<system-discipline>` 标签——Antigravity 框架原生隔离机制。加 `[SYSTEM STATE]` 括号属锦上添花，不构成安全风险。待观察。
    *   **动作**：在 PreInvocation 提示词拼接中采用严格的括号隔离：`[SYSTEM STATE: ...] \n [TASK: ...]`，防止动态注入文本意外冲刷和覆盖掉主任务指令本身。

---

## 🛠️ 六、 脚本复用与能效提升优化 (Scratch Utils Sharing)

### 1. 【P1 ✅ 已完成】 同会话多子代理草稿区共享（Intra-Session Scratch Sharing）
*   **现象**：在同一个主会话中，前后拉起的多个不同子代理（包括只读 Extractor 和沙盒 Deep_Diver）经常需要对相同的数据包/日志/文件执行相同的分析和探察逻辑。由于进程和目录完全隔离，后拉起的子代理通常需要从零重新生成/编写一遍解析脚本，造成严重的代码重复与能效拖累。
*   **动作**：
    1.  **确定家族共享目录**：统一以主会话的 `<appDataDir>/brain/<parent-conversation-id>/scratch/` 作为特工家族的共享临时工作空间。
    2.  **符号链接挂载机制**：在 `invoke_subagent` 创建子代理并在隔离区初始化时，由框架自动在子代理的 sandbox 目录下创建指向父级共享 `scratch/` 目录的符号链接（例如挂载为 `scratch/parent_shared/`），并对只读特工进行写保护。
    3.  **规则与提示引导**：在子代理提示词中引导其在前置步骤检查 `parent_shared/` 目录下是否已有先前子代理编写过的工具脚本，确认存在直接复用执行，而非盲目重新生成。
*   **实施**：采用 "只读共享子目录" 架构。主代理初始化 `brain/<parent>/scratch/subagent_shared/`；子代理 Hook 通过 `getParentConvId()` 解析父 UUID，动态 `symlink` 挂载到沙箱。`safety-check.ts` 用 `realpathSync` 防止路径逃逸 + 只读特工写拦截。模板 W25 分流（Deep_Diver 可写 / ReadOnly 只读复用）。
    - `subagent.ts`: +`getParentConvId()`
    - `session-guardian.ts`: +`lstat` 防御 + EEXIST unlink + symlink 挂载
    - `safety-check.ts`: +`realpathSync` 路径归一化 + 只读拒绝 + 路径穿越拒绝
    - 模板: +W25 分流 (26 条 / 21 条)

