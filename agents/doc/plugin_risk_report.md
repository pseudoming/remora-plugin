# Remora Plugin 风险报告
> 评估对象：`~/.gemini/config/plugins/remora-plugin`
> 评估基准：`~/wsl_code/remora/` Remora 认知架构设计文档 (v6)
> 交叉校验：两份独立 agent 分析 + 15 份架构 Review 决策历史
> 评估日期：2026-06-03

---

## 一、设计偏离风险（与 Remora 概念的差距）

### 1.1 话题管理：全自动 vs 用户控制

| 项目 | 描述 |
|------|------|
| **Remora 要求** | 手动打标为主（`/topic new/switch/close`），边界由用户显式管理。「不追求全自动话题切分。手动打标是经过深思熟虑的设计选择，不是临时妥协。」（`concept.md:105`） |
| **插件现状** | `compactor.py:380-493` 通过 LLM prompt 全自动提取话题和决策，用户零参与。`project_topics` 表的 `topic_id` 由 LLM 生成（`t_001`, `t_002`），无用户确认机制。 |
| **Review 历史佐证** | v1-gemini 将「话题解耦能力瓶颈」列为第一大巨坑：「指望大模型通过事后扫描一段几千 Token 的杂乱对话，一次性准确切分出独立的 Topic……极其容易产生幻觉」。v2-gemini 将「半自动打标」评为最惊艳设计之一：「放弃纯靠大模型全自动切分话题，让开发者像用 `git branch` 一样主动管理 Agent 的注意力，比让大模型耗费巨量 Token 去『猜』意图要精准且廉价一万倍。」v5-doubao 对「手动 Topic 为主，自动为辅」评分 10/10。 |
| **风险** | ① LLM 对话题边界的判断不可靠，尤其在复杂项目中容易误合并或误拆分；② 用户对系统「记住了什么」完全无感知，信任度下降；③ 一旦 LLM 提取出错误的话题摘要，后续所有基于该摘要的决策都将被污染，且无纠正入口。 |
| **严重程度** | **高** |
| **解决方案初稿** | Phase 1: 在 `compactor.py` 输出的 `topic_decisions` 中增加 `pending_review` 状态列；Phase 2: 实现 `/topic new/switch/close` 命令，让用户显式管理话题生命周期，LLM 仅作为「建议者」而非「决定者」。 |

### 1.2 硬锚点机制：完全缺失

| 项目 | 描述 |
|------|------|
| **Remora 要求** | `user_confirmed: true` 的决策进入「不可绕过的压缩保留校验清单」。压缩时强制保留，不可静默丢弃。（`concept.md:76`） |
| **插件现状** | `topic_decisions` 表无 `user_confirmed` 字段。`compactor.py:466-485` 每次扫描后直接 INSERT/UPDATE 决策，旧决策可能被覆盖或遗漏，无任何用户确认关卡。 |
| **Review 历史佐证** | v5-deepseek 明确提出「增强 Checksum：引入否定性校验」：「在压缩 Prompt 中……要求提取"明确决定**不**做什么"的列表。这个『否定性』决策至关重要，且极易在摘要中被遗漏。」v5-qwen 警告「丢失了 Rationale」：「几个月后，当遇到类似场景时，Agent 可能会再次提出方案 A，因为它**忘记了当初为什么否决 A**。」v5-doubao 建议「允许用户标记某些消息为不可压缩」。 |
| **风险** | ① 用户明确拍板的关键决策可能在下一次后台压缩中被 LLM 误判为「已过时」而丢弃；② 没有防漂移的最后一道物理防线；③ 这是 Remora 最核心的差异化价值（对比 CLAUDE.md/Cursor Rules 的静态文本），缺失后插件退化为一个「自动摘要器」。 |
| **严重程度** | **致命** |
| **解决方案初稿** | ① `schema.sql` 的 `topic_decisions` 表增加 `user_confirmed BOOLEAN DEFAULT 0` 列；② `remora-recall.sh` 增加 `/confirm <topic_id>` 和 `/unconfirm <topic_id>` 能力；③ `compactor.py` 提取逻辑中，对 `user_confirmed=1` 的决策做强制保留校验。 |

### 1.3 压缩可信度校验：声明存在，逻辑缺失

| 项目 | 描述 |
|------|------|
| **Remora 要求** | 压缩前提取决策清单 → 压缩后计算 pass rate → 输出 `compression_confidence`（客观比值，不依赖 LLM 自我评估）。若 < 0.7，在下次回复中插入警告。（`architecture.md:165-166`） |
| **插件现状** | `schema.sql:10` 定义了 `compression_confidence REAL DEFAULT 1.0` 列。但 `compactor.py` 从未计算或写入该值——始终为默认 1.0。无压缩前后对比逻辑。 |
| **Review 历史佐证** | v2-gemini 将 Checksum 评为「最惊艳的设计之一」：「相当于给大模型的记忆系统引入了 TDD」。v5-deepseek 警告 Checksum 的盲区：「Checksum 只能校验『有无』，无法校验『对错』。`compression_confidence: 0.92` 可能是一个危险的、带来虚假安全感的数字。」v5-qwen 将 Checksum 机制评为「神来之笔」：「用极低的计算成本换取了记忆摘要的结构化保真度。」 |
| **风险** | ① 压缩质量完全不可观测；② 用户和系统都无法感知记忆是否在退化；③ 违反了「防御性设计」原则——承认压缩可能有损，但必须有可验证指标。 |
| **严重程度** | **中** |
| **解决方案初稿** | ① `compactor.py` 在 LLM 提取前先对本次增量对话做关键决策清单快照（可用轻量正则 + 关键词）；② 提取后做交叉比对，写入 `compression_confidence`；③ 低于 0.7 时在 `intent-detector.py` 中注入 low-confidence 警告。 |

### 1.4 子代理执行隔离：Prompt 层级，非物理隔离

| 项目 | 描述 |
|------|------|
| **Remora 要求** | Git Worktree 隔离（三层回退：worktree → stash+checkout → 文件快照备份）。用完即焚，变更差异由用户确认后应用。（`architecture.md:183-188`） |
| **插件现状** | ① 物理分拆为只读 Extractor 与读写沙盒 Deep_Diver 两个特工类型；② `safety-check.py:229-233` 通过 `get_subagent_type` + `agentapi` 判定机制实现了对只读特工的强拦截审计及对沙盒调试特工的条件放行；③ Deep_Diver 的 system prompt（`remora_deep_diver.json`）要求 "Workspace: 'branch'" 但无脚本自动创建 Git Worktree；④ 实际隔离依赖宿主平台底层文件系统能力，插件自身不创建物理沙箱。 |
| **Review 历史佐证** | v3-gemini 将 Git Worktree 列为「Day 1 致命暗礁解决方案」：「这会在用户当前项目目录的**外部**生成一个物理隔离的文件树。子代理在里面随便怎么折腾，都**绝对不会污染用户当前 IDE 里正在看的文件**。」v4-gemini 揭示了「脏工作区悖论」：「Git Worktree 是基于当前仓库的 HEAD 创建的，它**绝对看不见** IDE 里未提交的『脏改动』！」v5-qwen 警告 Worktree 的「环境依赖」问题：「Worktree 隔离了**代码**，但没有隔离**运行环境**。」 |
| **风险** | ① 若宿主平台不支持 worktree 隔离，Deep_Diver 的写操作直接作用于主工作区；② 测试命令（pytest 等）的副作用无法隔离；③ 未提交的脏代码可能在沙箱中不可见，导致子代理基于错误代码状态执行；④ 与 Remora 设计的「执行噪音不污染主认知上下文」目标存在 gap。 |
| **严重程度** | **中** |
| **解决方案初稿** | 在 `scripts/` 下增加 `sandbox-setup.sh`，在 Deep_Diver 被调用前自动创建 Git Worktree（含脏状态探测 + stash 提示）。`safety-check.py` 放行测试命令时，附加 workspace 路径参数。 |

### 1.5 平台锁定

| 项目 | 描述 |
|------|------|
| **Remora 要求** | 独立 CLI/TUI 客户端，可附加到任何 Coding Agent（Claude Code, Cursor, etc.）。「这是记忆层，不是 Coding Agent 本身。它附加在现有 Agent 之上。」（`README.md:104`） |
| **插件现状** | 完全依赖 Antigravity/Gemini 的 hook 机制（`PreInvocation`, `PostInvocation`, `PreToolUse`, `Stop`）、`agentapi` CLI（`compactor.py:145,344-357`）、特定目录结构（`~/.gemini/antigravity/brain`、`transcript.jsonl` 格式）、`sidecar.json` 调度系统。 |
| **Review 历史佐证** | v5-doubao 强调：「它没有追求任何花哨的技术……如果按照分阶段计划实施，MVP 是完全可行的，而且会比现有的所有 Coding Agent 在长周期协作上表现好一个数量级。」但若核心逻辑无法脱离平台，这个承诺就无法兑现给非 Antigravity 用户。 |
| **风险** | ① 无法迁移到其他 Agent 平台；② 随 Antigravity 版本变化可能 break；③ 与 Remora 作为「通用认知架构」的定位不符。 |
| **严重程度** | **中** |
| **解决方案初稿** | Phase 2: 抽象出平台无关的 core（SQLite 操作、FTS5 检索、compactor 核心逻辑），Antigravity 适配层作为 platform adapter。注：此条优先级低于 #1.1-#1.4，因为当前阶段验证核心逻辑重于平台可移植性。 |

---

## 二、高容错场景劣化风险

> 此章节的原报告概念（区分 relax/strict 模式）在 Remora 概念文档中没有直接对应，但 v5-qwen 和 v4-gemini 的 Review 中有关联讨论。插件当前对所有交互采用统一的安全策略，在创意性/探索性场景中可能过度攻击。

### 2.1 强制性语气注入

| 项目 | 描述 |
|------|------|
| **触发位置** | `hooks.json:15-18` — `PreInvocation` 每轮无条件注入 strict tone 指令：「`STRICT TONE: Objective, professional & direct. Zero flattery or hyperbole. Keep emotion and meta-commentary to an absolute minimum`」 |
| **高容错场景影响** | 头脑风暴、架构草案设计、文档起草——这些场景需要发散性表达、积极性回应和修辞层次。 |
| **劣化机制** | `Zero flattery or hyperbole`、「`Keep emotion ... to an absolute minimum`」压制了模型在探索性对话中的自然表达。长期使用可能导致输出风格趋同、缺乏创造力。 |
| **Review 历史佐证** | v4-gemini 的「盲区三」揭示了正则硬拦截的「误杀风暴」问题：开发者正常的对话被误匹配后「中断 Debug 心流去翻历史记录，回答牛头不对马嘴」。虽然此条涉及的是 intent-detector 意图检测，但语气注入同样是一种「无条件攻击」——对所有对话形态施加统一约束。 |
| **严重程度** | **高** |
| **解决方案初稿** | ① `intent-detector.py` 增加场景识别层：检测到 brainstorm/draft/design 类关键词时，跳过该条 system-reminder 注入；② 将 `hooks.json` 中该 hook 改为条件触发（通过 `intent-detector.py` 输出的 `strictMode: true/false` 标志控制），需确认 hooks.json 是否支持条件执行。 |

### 2.2 关键词误触发导致防御性打断

| 项目 | 描述 |
|------|------|
| **触发位置** | `intent-detector.py:88-95` — 匹配到 `plugin.json` keywords 中任意一个即注入 `MEMORY DEFENSE TRIGGERED: STOP GUESSING. Execute bash remora-recall.sh` 指令 |
| **高容错场景影响** | 高频协作短语被误匹配 |
| **高频误触发词** | `重新思考`（草稿修改时自然使用）、`好好想想`（设计讨论时）、`仔细检查`（文档审阅时）、`回忆一下`（方案对比时）、`跟你说过`/`我早说过`（日常协作中） |
| **劣化机制** | 每轮注入 `STOP GUESSING` + 命令模型执行 bash 脚本查数据库，持续打断心流。在高容错场景下这些完全合理的对话触发词会导致反复弹出防御性指令。 |
| **Review 历史佐证** | v6 架构中意图检测由「硬拦截」改为「提示模式」（`architecture.md:85`）：「若命中，不直接硬拦截注入上下文，而是在 System Prompt 中插入提示……让 LLM 自己决定是否调用」。但插件实际注入的措辞 `STOP GUESSING` 语气远比「提示」更强制，更接近 v4 之前的「硬拦截」风格。v5-qwen 也建议：「不要直接硬拦截并注入……让 LLM 自己决定是否调用，既保留防御性又增加灵活性。」 |
| **严重程度** | **中** |
| **解决方案初稿** | ① 将 `plugin.json` keywords 分为两组：`hard_keywords`（如 `又忘了`、`找bug`，始终触发）和 `soft_keywords`（如 `重新思考`、`好好想想`，可降低触发频率或使用更温和的提示）；② `intent-detector.py` 中调整提示措辞，从 `STOP GUESSING` 改为更温和的建议语气（如「如果有不确定的历史事实，建议调用 `remora-recall.sh`」），对齐 v6 architecture 的「提示模式」设计。 |

### 2.3 safety-check.py 过度阻断

| 项目 | 描述 |
|------|------|
| **触发位置** | `safety-check.py` — `PreToolUse` 拦截 `view_file`、`run_command`、`grep_search` |
| **高容错场景影响** | 设计/起草时需要查阅文档、日志、配置文件以获取上下文 |
| **代码层面精度分析** | `run_command` 的 `rot_pattern`（`:278`）为 `r'\b(cat|tail|grep|jq|awk|sed|sqlite3)\b.*?(?:\.jsonl|\.log|\.sqlite)\b'`——仅匹配涉及 `.jsonl`/`.log`/`.sqlite` 后缀的操作，**不会误杀** `cat config.json`。`view_file` 拦截范围更精确：仅针对 `.jsonl`/`.log`/`.sqlite` 后缀文件（`:254`）且文件 > 50KB（`:261`）。`grep_search`（`:335-347`）额外拦截 `.system_generated` 和 `/logs` 目录。阻断逻辑的范围比原报告描写的更窄，但阻断返回的 200+ 字符 warning 仍有 token 浪费。 |
| **劣化机制** | 每次阻断返回 200+ 字符的 `ANTI-CONTEXT-ROT` 警告（`:241-246`），累积在上下文中浪费 token 且分散注意力。 |
| **Review 历史佐证** | v4-gemini 「盲区三」强调误杀风暴破坏心流。插件当前 `safety-check.py` 的阻断范围实际较精准（仅限大日志/日志目录），核心问题不在于误杀范围而在于阻断返回消息过长和阻断后的委托体验（正确引导到 ReadOnly_Extractor 或 Deep_Diver 的提示已内嵌在阻断消息中，`:244-245`）。 |
| **严重程度** | **低** |
| **建议** | 缩短 `ANTI-CONTEXT-ROT` 警告为一行（< 80 字符），减少 token 浪费。 |

### 2.4 action-gate.py 虚报检测误判

| 项目 | 描述 |
|------|------|
| **触发位置** | `action-gate.py:231-261` — 正则匹配中文/英文动词 + 文件名，与 `PostInvocation` 实际工具调用文件做差集 |
| **高容错场景影响** | 文档起草和架构讨论中频繁出现假设性文件引用 |
| **典型误判** | 模型说「我们可以在 `config.py` 中定义这些设置」，这是讨论性/建议性文本，但正则 `(?:修改|更新|覆写|写入|创建)` 可能匹配 → 被判定为 phantom modification → 注入阻断警告 + `force_continue` |
| **劣化机制** | ① 阻断正常讨论流，强制模型重新规划；② 在起草阶段根本不需要实际写入文件，`force_continue` 完全不合适；③ 增加的上下文垃圾干扰后续对话质量。 |
| **Review 历史佐证** | 无直接对应的 review 讨论。此模块是插件的自创功能，不在 Remora 原始设计的 Phase 1-3 范围内。其设计意图（防止 LLM 声称修改了文件但未执行）具有独立价值，但在起草/讨论场景中不适用。 |
| **严重程度** | **低-中** |
| **解决方案初稿** | ① 增加「未来时态/建议语态」滤除：匹配 `可以`、`将`、`应该`、`建议`、`考虑`、`我们不妨` 等前缀时不视为虚报；② 增加「讨论性动词」过滤：匹配 `定义`、`考虑`、`规划`、`设想` 等软动词时降低判定权重。 |

---

## 三、插件已正确实现的决策

> 以下是在 cross-reference 架构设计文档和 15 份 Review 后确认插件已正确实现的关键决策点。这些点表明插件在**技术基础设施**层面高度忠于 Remora 设计。

| # | 设计决策 | Review 来源 | 插件实现 | 状态 |
|---|---------|-------------|---------|------|
| 1 | **FTS5 trigram 分词器** | v3-gemini | `schema.sql:42` — `tokenize='trigram'` | ✅ 完全对齐 |
| 2 | **SQLite WAL 模式** | architecture.md:217 | `schema.sql:1` — `PRAGMA journal_mode=WAL` | ✅ 完全对齐 |
| 3 | **水位线增量处理** | v2-gemini "暗礁1" | `compactor.py:237-311` — watermark + undo 自愈 | ✅ 完全对齐 |
| 4 | **检索结果时序升序** | v4-gemini "盲区五" | `remora-recall.sh:81` — `ORDER BY m.id ASC` | ✅ 完全对齐 |
| 5 | **双通道召回（FTS5 + 直接决策匹配）** | v5-qwen "语义盲区" | `remora-recall.sh:70-110` — 通道 A FTS5 + 通道 B 直接匹配 | ✅ 实现优于单通道 |
| 6 | **流式读取防 OOM** | v3-gemini "OOM 幽灵" | `intent-detector.py:38` — `tail -n 50`；`action-gate.py:150` — `tail -n 1000` | ✅ 完全对齐（但 `read-session-log.py:18` 仍有 `f.readlines()`，需修复） |
| 7 | **意图检测「提示模式」** | v6 architecture | `intent-detector.py:93-94` — 注入 ephemeralMessage 而非硬拦截 | ✅ 机制对齐（措辞过于强硬，见 2.2） |
| 8 | **子代理分层（只读 + 读写）** | architecture.md Phase 2 | `remora_readonly_extractor.json` + `remora_deep_diver.json` — write tools 差异化 | ✅ 实现正确 |
| 9 | **事后锚定文件关联** | v4-gemini "盲区四" | `remora_deep_diver.json` 要求输出 `[ASSOCIATED FILES]`；`action-gate.py` 比对 claimed vs actual | ⚠️ 概念存在，但 `associated_files` 表字段在 compactor 中未落地 |
| 10 | **防御性降级（异常 = 放行）** | concept.md 防御性设计 | 所有脚本全局 try-except 返回 allow / 空 injectSteps | ✅ 完全对齐 |
| 11 | **MD5 增量制品同步** | 无直接对应 | `compactor.py:511-579` — artifact hash 比对 | ✅ 独立创新，不与设计冲突 |

---

## 四、潜在高优需求整理

> 按优先级排序，综合实现复杂度和风险影响面：

| # | 需求 | 影响面 | 复杂度 | 对应风险 |
|---|------|--------|--------|----------|
| 1 | **hard/soft keyword 分级** — `plugin.json` 拆分关键词为两组，`intent-detector.py` 中 soft 类使用温和提示措辞 | 意图检测误触发 | **低** (改 json + 10 行 python) | 2.2 |
| 2 | **action-gate 未来时态滤除** — 增加 `可以\|将\|应该\|建议\|考虑\|我们不妨\|不如` 等前缀匹配，不视为虚报 | 起草讨论被误阻断 | **低** (~10 行) | 2.4 |
| 3 | **意图检测措辞软化** — `intent-detector.py:93` 从 `STOP GUESSING` 改为 v6 风格的「建议调用 `remora-recall.sh` 验证」 | 防御性打断 | **低** (改一行) | 2.2 |
| 4 | **语气注入条件化** — `hooks.json:15-18` 的 strict tone 注入改为条件触发 | 发散性输出质量 | **低**（若 hooks 支持条件触发）/ **中**（否则需重构） | 2.1 |
| 5 | **safety-check 警告精简** — 将 `ANTI-CONTEXT-ROT` 阻断消息压缩为一行 | Token 浪费 | **低** (~5 行) | 2.3 |
| 6 | **`read-session-log.py` 修复** — 将 `f.readlines()` 替换为 `tail -n` 或流式读取 | 内存安全 | **低** (复用已有模式) | — |
| 7 | **`user_confirmed` 硬锚点** — `topic_decisions` 增加字段 + confirm/unconfirm 入口 | 关键决策漂移 | **中** (schema 迁移 + 新脚本 + compactor 修改) | 1.2 |
| 8 | **`compression_confidence` 实现** — compactor 增加压缩前后对比逻辑 | 压缩质量不可观测 | **中** | 1.3 |
| 9 | **手动话题管理** — `/topic new/switch/close` 命令 | 话题边界不可控 | **高** (需 CLI 集成 + schema 修改) | 1.1 |
| 10 | **Git Worktree 沙箱** — Deep_Diver 调用前自动创建隔离工作区 | 无真正执行隔离 | **高**（需处理脏状态、环境依赖、回退策略） | 1.4 |
| 11 | **平台抽象层** — 剥离 Antigravity 依赖，core 独立 | 平台锁定 | **高**（需重新设计模块边界） | 1.5 |
| 12 | **话题依赖链** — `dependencies` 字段 + 断裂预警 | 多话题协作 | **中** (schema + compactor) | — |
| 13 | **冷存储经验库** — Phase 3 跨项目经验积累 | 长期价值 | **高** | — |

---

## 五、综合评估

```
插件 vs Remora 概念匹配度：

  技术基础设施  ████████████████████░  90%  (SQLite/FTS5/水位线/cron/trigram/WAL)
  防御性设计    ████████████░░░░░░░░░░  55%  (Anti-Context-Rot + 降级放行 ✅；Checksum/硬锚点 ❌)
  记忆召回      ████████████████████░  90%  (双通道 FTS5 + LIKE + 时序升序 + 项目隔离)
  决策记录      ████████████████░░░░░░  70%  (decision + rationale 有 ✅；user_confirmed ❌；confidence ❌)
  执行隔离      ███░░░░░░░░░░░░░░░░░░░  15%  (Prompt 层分拆 ✅；物理 Worktree ❌)
  用户控制      ██░░░░░░░░░░░░░░░░░░░░  10%  (recall.sh 可被触发 ✅；无 topic/compact/confirm 命令 ❌)
  场景自适应    ░░░░░░░░░░░░░░░░░░░░░░   0%  (所有场景统一策略，无 relax/strict 区分)
```

---

## 六、最终结论

插件是 Remora 概念的一个**高效但有结构性缺陷的实现**。它将 Remora 设计中最困难的技术基础设施（增量水位线、FTS5 trigram、双通道召回、防御性降级）实现在了生产级水平，但又将 Remora 最核心的设计哲学（用户控制话题边界、硬锚点不可绕过、压缩质量可验证）几乎全部跳过。

**最准确的定性**：这不是 Remora 的不完整实现，而是将 Remora 的「温存储」和「子代理分发」层独立拿出来做了一个**自动化后台守护进程**，然后把「热记忆管理」和「用户认知控制面板」全部留给了未来。它的技术 DNA 是 Remora 的，但它的用户体验是传统 black-box automation 的。

**关键行动建议**：

1. **短期（本周可完成）**：需求 #1-#6（keyword 分级、措辞软化、未来时态滤除、safety-check 精简、read-session-log 修复），解决大部分「高容错场景劣化」问题。
2. **中期（2-3 周）**：需求 #7-#8（user_confirmed 硬锚点、compression_confidence），补上 Remora 最核心的两个差异化机制。这两项是区分「Remora」和「自动摘要器」的分水岭。
3. **长期（1-2 月）**：需求 #9-#10（手动话题管理、Git Worktree 沙箱），将插件从「后台守护进程」升级为「用户可控的认知架构」。
4. **远期**：需求 #11-#13（平台抽象、依赖链、冷存储），实现 Remora 完整愿景。


*交叉校验说明：本报告综合了第一个人工 agent 的初步评估、第二个 agent 的 review 历史 cross-reference，以及 15 份架构 Review 文档（v1-v5, 涵盖 Gemini/Claude/ChatGPT/DeepSeek/Doubao/Qwen）的决策历史。对原评估报告的 2.3 节关于 `cat config.json` 的误杀描述进行了代码级事实校准（`rot_pattern` 仅匹配 `.jsonl`/`.log`/`.sqlite` 后缀，`.json` 不会触发）。*
