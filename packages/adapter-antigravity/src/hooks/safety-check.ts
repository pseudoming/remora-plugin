import {
  readMode,
  makeDenyReason,
  enforcePromptLengthLimit,
  enforceSandboxWorkspace,
  isRotSensitiveFile,
  isRotSensitivePath,
  estimateReadBytes,
  isAccumulatedLimitExceeded,
  trimStaleHookStates,
  inspectCommand,
  getHookState,
  setHookState,
  formatJitInjection,
} from "@remora/core";
import { accumulate } from "../bridge/stats";
import { getSubagentType } from "../bridge/subagent";
import { findPluginRoot } from "../bridge/paths";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { globalRuleRunner } from "./rule-runner";
import * as fs from "node:fs";
import * as path from "node:path";

const _REMORA_RESTRICTED_SUBAGENT = "Remora_Deep_Diver";
const _REMORA_VALID_WORKSPACES = new Set(["branch", "share"]);
const _ARTIFACT_PATH = "/artifacts/";
const _ARTIFACT_SUFFIXES = ["task.md", "implementation_plan.md", "walkthrough.md"];

const BUILTIN_AGENTS: ReadonlySet<string> = new Set([
  "Remora_Deep_Diver",
  "Remora_ReadOnly_Extractor",
]);

function loadBuiltinAgentPerms(name: string): Record<string, boolean> | null {
  try {
    const pluginRoot = findPluginRoot();
    const filePath = path.join(pluginRoot, "agents", `${name}.json`);
    if (!fs.existsSync(filePath)) return null;
    const def = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      enable_write_tools: !!def["enable_write_tools"],
      enable_subagent_tools: !!def["enable_subagent_tools"],
    };
  } catch {
    return null;
  }
}

// ##########################################################
// AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
// ⚠️ 警告：本脚本是主干 Agent 拦截高危操作的物理防线。
//   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
//   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
//   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
//   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
// ##########################################################

// ==========================================================
// 设计原理一：命令安全拦截分流与子代理判定（宿主系统层面）
// ==========================================================
// 1. 变量与上下文跟踪：命令的具体分词语法与正则黑名单已抽离到 safety_rules.py，保持本主控层简洁且无副作用。
// 2. 元数据解析：从 `transcriptPath` 中切片提取当前子会话 ID，调用 `agentapi get-conversation-metadata` 命令。
// 3. 只读特工 `Remora_ReadOnly_Extractor` 限制：特许豁免 view_file 大体积日志读取限制；但对其命令行写、构建与测试指令做绝对强拦截保护。
// 4. 沙盒特工 `Remora_Deep_Diver` 限制放行：特许豁免 view_file 日志体积熔断；且豁免其在分支沙盒内执行测试（test）或构建（build）命令的拦截。

// ==========================================================
// 设计原理二：View File 累加器与主干上下文防腐 (Anti-Context-Rot)
// ==========================================================
// 1. 回合级定宽累加器：在主干 (Main Context) 中追踪单一用户回合内对源码和日志的累积读取量，防止上下文因零散读取而慢速腐败。
// 2. 三级硬阻断机制：当累加量突破绝对阈值 (Source>400KB 或 Data>150KB) 时，实施硬熔断阻断。
// 3. O(1) 乘算估值策略：采用行数 * 50 字节的快速常数估算，防止磁盘全表扫描导致超时。
// 4. 进程级资源锁控制读写竞态，确保安全应对大模型高并发的读文件调用。

export function main(context: Record<string, unknown>): Record<string, unknown> {
  try {
    globalRuleRunner.runDarkRead("PreToolUse", context);
  } catch (e) {}
  try {
    return _main(context);
  } catch {
    return { decision: "allow" };
  }
}

function _main(context: Record<string, unknown>): Record<string, unknown> {
  const toolCall = context["toolCall"] as Record<string, unknown> | undefined;
    const toolName = (toolCall?.["name"] as string) ?? "";
    const args = (toolCall?.["args"] as Record<string, unknown>) ?? {};

    const transcriptPath = (context["transcriptPath"] as string) ?? "";

    // 提取会话 ID 并读取临时模式缓存
    let mode = "strict";
    let convId = "default";
    if (transcriptPath) {
      const match = transcriptPath.match(/\/brain\/([^/]+)\//);
      if (match) {
        convId = match[1];
        mode = readMode(convId, "strict");
      }
    }

    // Timeline trimming (Timeline Trimming)
    const cdal = new ConversationDataAccessLayer(convId);
    const currentTurnIdx = cdal.getCurrentTurnIdx();

    trimStaleHookStates(convId, currentTurnIdx);

    const subagentType = getSubagentType(transcriptPath);

    const isSub = subagentType !== null;
    const isReadonlySub = subagentType === "Remora_ReadOnly_Extractor";
    const isDeepDiverSub = subagentType === "Remora_Deep_Diver";

    // --------------------------------------------------------
    // Anti-Context-Rot: 统一的返回模板
    // 中文翻译：[防上下文腐败拦截] 禁止在主干上下文中直接对大日志文件（.jsonl/.log）使用 cat/grep 或 view_file，以防止上下文爆炸。请使用子代理进行隔离执行：
    // - 若为只读的日志搜索或数据库查询：使用 TypeName "Remora_ReadOnly_Extractor" 派发子代理
    // - 若为沙盒下的调试、测试或代码修改：使用 TypeName "Remora_Deep_Diver" 派发子代理
    // --------------------------------------------------------
    // 中文翻译：[防上下文腐败拦截] 禁止在主干上下文中直接对大日志文件（.jsonl/.log）使用 cat/grep 或 view_file，以防止上下文爆炸。请使用子代理进行隔离执行。
    // 英文对照：⛔ REMORA SAFETY INTERCEPT [ANTI-ROT]: Direct cat/grep or view_file on large logs in main context is prohibited to prevent context explosion.\nACTION REQUIRED: Invoke 'Remora_ReadOnly_Extractor' for queries, or 'Remora_Deep_Diver' for modifications.
    const rotReason = makeDenyReason(
      "ANTI-ROT",
      "Direct cat/grep or view_file on large logs in main context is prohibited to prevent context explosion.",
      "Invoke 'Remora_ReadOnly_Extractor' for queries, or 'Remora_Deep_Diver' for modifications."
    );

    // --------------------------------------------------------
    // 针对 invoke_subagent 的强制沙盒隔离拦截
    // --------------------------------------------------------
    if (toolName === "invoke_subagent") {
      const subagents = (args["Subagents"] as Array<Record<string, unknown>>) ?? [];
      for (const sub of subagents) {
        const tName = (sub["TypeName"] as string) ?? "";
        const ws = (sub["Workspace"] as string) ?? "inherit";
        const promptStr = (sub["Prompt"] as string) ?? "";

        // 增加 1500 字符强限拦截（底线防崩拦截座）
        const [isOverLimit, deny] = enforcePromptLengthLimit(promptStr);
        if (isOverLimit) {
          return {
            decision: "deny",
            reason: makeDenyReason(deny!.prefix, deny!.message, deny!.action_tip),
          };
        }

        const [isViolation, deny2] = enforceSandboxWorkspace(
          tName,
          ws,
          "Remora_Deep_Diver",
          ["branch", "share"]
        );
        if (isViolation) {
          return {
            decision: "deny",
            reason: makeDenyReason(deny2!.prefix, deny2!.message, deny2!.action_tip),
          };
        }
      }
      // 检查是否已注入过 JIT 指导
      const jitInjected = getHookState(convId, currentTurnIdx, "subagent_jit");
      if (!jitInjected) {
        setHookState(convId, currentTurnIdx, "subagent_jit", "injected");
        // 中文翻译：
        // REMORA 协调器 JIT 注入：您刚刚启动了子代理。请立即调用 `schedule` 工具设置 60s 心跳定时器，并在启动后立即退出当前回合。
        // 在对用户的回复中，您必须使用角色名称（例如 subagent (Style Guard)）汇报当前进度与预计观测等待时间，禁止直接提及"挂载定时器"或"设置 schedule"等技术细节。
        return {
          decision: "allow",
          injectSteps: [
            {
              ephemeralMessage: formatJitInjection(),
            },
          ],
        };
      } else {
        return { decision: "allow" };
      }
    }

    // --------------------------------------------------------
    // 针对 define_subagent 的静态权限重载拦截
    // --------------------------------------------------------
    if (toolName === "define_subagent") {
      const name = (args["name"] as string) ?? "";
      if (BUILTIN_AGENTS.has(name)) {
        const perms = loadBuiltinAgentPerms(name);
        if (perms) {
          const reqWrite = args["enable_write_tools"] !== false;
          const reqSubagent = args["enable_subagent_tools"] === true;
          if (reqWrite !== perms.enable_write_tools || reqSubagent !== perms.enable_subagent_tools) {
            return {
              decision: "deny",
              reason: makeDenyReason(
                "CONFIG_OVERRIDE",
                `Cannot override built-in agent '${name}'. enable_write_tools must be ${perms.enable_write_tools}, enable_subagent_tools must be ${perms.enable_subagent_tools}.`,
                "Use a different name for custom agents."
              ),
            };
          }
        }
        // Built-in name with matching permissions: allow
      }
    return { decision: "allow" };
  }

  // --------------------------------------------------------
  // 针对共享目录的路径穿越防御
  // --------------------------------------------------------
  const WRITE_TOOLS = ["write_to_file", "replace_file_content", "multi_replace_file_content"];
  if (WRITE_TOOLS.includes(toolName)) {
    const tp = (args["TargetFile"] as string) ?? "";
    if (tp.includes("parent_shared")) {
      // ReadOnly subagent: deny all writes to shared scratch
      if (isReadonlySub) {
        return {
          decision: "deny",
          reason: makeDenyReason(
            "READONLY",
            "ReadOnly subagents cannot write to shared scratch.",
            "Read scripts from parent_shared via run_command instead."
          ),
        };
      }
      // Deep_Diver: normalize path and verify it stays within shared directory
      if (tp.includes("..") || tp.includes("~")) {
        return {
          decision: "deny",
          reason: makeDenyReason(
            "PATH_TRAVERSAL",
            "Path traversal detected in parent_shared target.",
            "Write only within the shared scratch directory."
          ),
        };
      }
      // Resolve real physical path to catch symlink escapes
      let realPath: string;
      try {
        realPath = fs.realpathSync(tp);
      } catch {
        try {
          const dirName = path.dirname(tp);
          realPath = path.join(fs.realpathSync(dirName), path.basename(tp));
        } catch {
          realPath = path.resolve(tp);
        }
      }
      // Resolve the real base path of the shared symlink
      let realBase: string;
      try {
        realBase = fs.realpathSync(path.join(process.cwd(), "scratch", "parent_shared"));
      } catch {
        return {
          decision: "deny",
          reason: makeDenyReason(
            "LINK_BROKEN",
            "Shared scratch symlink is broken or missing.",
            "The parent_shared link may need to be recreated."
          ),
        };
      }
      if (!realPath.startsWith(realBase)) {
        return {
          decision: "deny",
          reason: makeDenyReason(
            "DIRECTORY_ESCAPE",
            "Write target resolves outside the shared scratch directory.",
            "Write only within scratch/parent_shared/."
          ),
        };
      }
    }
  }

  // --------------------------------------------------------
  // 针对 view_file 的拦截
  // --------------------------------------------------------
  if (toolName === "view_file") {
      const targetFile = (args["AbsolutePath"] as string) ?? "";
      if (targetFile) {
        // 1. 敏感后缀强力拦截 (大日志直接阻断)
        if (isRotSensitiveFile(targetFile)) {
          if (isReadonlySub) {
            // pass  // 只读特工大日志读取显式放行
          } else if (!isSub) {
            return { decision: "deny", reason: rotReason };
          }
        }

        // 2. 体积累加熔断机制 (针对单文件超大或碎片化堆叠)
        if (!isSub && transcriptPath) {
          const match = transcriptPath.match(/\/brain\/([^/]+)\//);
          if (match) {
            // 单体文件突发超大拦截
            const sizeLimit = mode === "relax" ? 200 * 1024 : 50 * 1024;
            try {
              if (fs.existsSync(targetFile) && fs.statSync(targetFile).size > sizeLimit) {
                return { decision: "deny", reason: rotReason };
              }
            } catch {
              // pass
            }

            convId = match[1];

            const isDataLog = /\.(?:jsonl|log|sqlite|csv)$/.test(targetFile);
            const incBytes = estimateReadBytes(
              {
                StartLine: args["StartLine"],
                EndLine: args["EndLine"],
              },
              targetFile
            );

            if (incBytes > 0) {
              try {
                let stats;
                if (isDataLog) {
                  stats = accumulate(convId, 0, incBytes);
                } else {
                  stats = accumulate(convId, incBytes, 0);
                }

                // 三级硬性熔断
                if (isAccumulatedLimitExceeded(stats)) {
                  // 中文翻译：
                  // ⛔ [安全拦截] 累积读取量已超限！
                  // ============================================================
                  // !!! 警告：主干上下文濒临腐败 !!!
                  // 源码读取：{stats['accumulated_source_bytes']//1024}KB (最大：400KB)
                  // 数据读取：{stats['accumulated_data_bytes']//1024}KB (最大：150KB)
                  //
                  // 操作已被阻断！为了保持认知稳定性，您必须立即委派至子代理。
                  //
                  // 在您结束当前回合前，您必须：
                  // 1. 归档进度：在 `/artifacts/task.md` 或当前决策日志中写入简短的进度报告与技术假设。
                  // 2. 委派执行：调用 `Remora_ReadOnly_Extractor` 进行读取/查询，或调用 `Remora_Deep_Diver` 进行修改。
                  // 3. 计划监控：在启动子代理时，您必须同时调用 `schedule` 工具，设置 `DurationSeconds="30"`。
                  //
                  // 切勿尝试在当前上下文中重新运行被拦截的读取命令！
                  // ============================================================
                  return {
                    decision: "deny",
                    reason:
                      "⛔ REMORA SAFETY INTERCEPT: CUMULATIVE READ LIMIT EXCEEDED!\n" +
                      "============================================================\n" +
                      "!!! WARNING: MAIN CONTEXT CORRUPTION IMMINENT !!!\n" +
                      `SOURCE READ: ${Math.floor(stats.accumulated_source_bytes / 1024)}KB (MAX: 400KB)\n` +
                      `DATA READ: ${Math.floor(stats.accumulated_data_bytes / 1024)}KB (MAX: 150KB)\n\n` +
                      "OPERATION BLOCKED! TO PRESERVE COGNITIVE STABILITY, YOU MUST IMMEDIATELY DELEGATE TO A SUBAGENT.\n\n" +
                      "BEFORE YOU EXIT THIS TURN, YOU MUST:\n" +
                      "1. ARCHIVE PROGRESS: WRITE A CONCISE PROGRESS REPORT AND TECHNICAL HYPOTHESES TO `/artifacts/task.md` OR THE ACTIVE DECISION LOG.\n" +
                      "2. DELEGATE EXECUTION: INVOKE `Remora_ReadOnly_Extractor` FOR READS/QUERIES, OR `Remora_Deep_Diver` FOR MODIFICATIONS.\n" +
                      "3. SCHEDULE MONITOR: YOU MUST SIMULTANEOUSLY CALL THE `schedule` TOOL WITH `DurationSeconds=\"30\"` WHEN LAUNCHING THE SUBAGENT.\n\n" +
                      "DO NOT ATTEMPT TO RE-RUN THE BLOCKED READ COMMAND IN THIS CONTEXT!\n" +
                      "============================================================",
                  };
                }
              } catch {
                // pass
              }
            }
          }
        }
      }

      return { decision: "allow" };
    }

    // --------------------------------------------------------
    // 针对 run_command 的拦截
    // --------------------------------------------------------
    if (toolName === "run_command") {
      const cmd = (args["CommandLine"] as string) ?? "";

      // 优先放行 git commit 动作，避免其提交信息（如 Changelog 中包含大日志文件名如 remora-recall.ts）被误拦截
      if (cmd.trim().startsWith("git commit")) {
        return { decision: "allow" };
      }

      // 1. 高吞吐量特征拦截 (Anti-Context-Rot)
      const rotPattern =
        /\b(?:cat|tail|grep|jq|awk|sed|sqlite3)\b.*?(?:\.jsonl|\.log|\.sqlite)\b|\bremora-recall\.(?:py|ts)\b/i;
      const hasRotFeature = rotPattern.test(cmd);

      // 2. 安全性拦截与审计分流 (调用抽离出的 safety_rules)
      const [decision, category] = inspectCommand(cmd);

      if (hasRotFeature) {
        // 子会话大日志查询特许放行
        if (isSub) {
          // 若为只读特工，除日志外不可含有任何写或测试构建高危特征（必须为 allow）
          if (isReadonlySub && decision !== "allow") {
            // 中文翻译：[只读安全拦截] 限制只读特工。Remora_ReadOnly_Extractor 仅被授权进行只读检索，严禁运行任何物理写操作、构建或测试命令！
            // 英文对照：⛔ REMORA SAFETY INTERCEPT [READONLY]: Remora_ReadOnly_Extractor is strictly read-only.\nACTION REQUIRED: Do not run write/test/build commands!
            return {
              decision: "deny",
              reason: makeDenyReason(
                "READONLY",
                "Remora_ReadOnly_Extractor is strictly read-only.",
                "Do not run write/test/build commands!"
              ),
            };
          }
          return { decision: "allow" };
        } else {
          // 普通主干会话一律拦截大日志读取
          return { decision: "deny", reason: rotReason };
        }
      } else {
        // 不含大日志特征的常规命令审计
        if (decision === "deny") {
          // 非只读子代理在隔离沙盒内无条件放行所有命令，防止 DELEGATION 消息误发给子代理造成自指悖论。
          // 只读特工（Remora_ReadOnly_Extractor）不进入此分支——其 enable_write_tools=false 决定它根本调不到 run_command。
          // 主代理继续走下游 DELEGATION BLOCKED 出口，提示委派给子代理。
          if (isSub && !isReadonlySub) {
            return { decision: "allow" };
          }


          if (category === "pb_read") {
            // 中文翻译：[PB 读取拦截] 严禁直接读取或解包 .pb 二进制文件。请使用 remora-recall CLI 或 CDAL 接口提取历史摘要。
            // 英文对照：Direct reading or unpacking of .pb binary files is strictly prohibited. / Please use remora-recall CLI or CDAL interface to extract historical summaries.
            return {
              decision: "deny",
              reason: makeDenyReason(
                "PB_READ_DENY",
                "Direct reading or unpacking of .pb binary files is strictly prohibited.",
                "Please use remora-recall CLI or CDAL interface to extract historical summaries."
              ),
            };
          } else if (category === "test" || category === "build") {
            // 中文翻译：
            // ⛔ [安全限制 - 阻断委派] 命令行直接运行已被拦截！
            // ============================================================
            // !!! 警告：未受信任的代码执行已被阻止 !!!
            // 为了保护当前活跃的工作树并在构建/测试阶段防止未审查代码执行或不安全的状态改变以维护 master 分支完整性，禁止直接执行 pytest/build。
            //
            // 您必须在隔离的工作空间中运行这些命令：
            // - 测试/诊断：通过 `invoke_subagent` 委派给 `Remora_Deep_Diver` 且 `Workspace: "branch"`。
            // - 编译/构建：通过 `invoke_subagent` 委派给 `Remora_Deep_Diver` 且 `Workspace: "share"`。
            //
            // 请勿尝试通过别名、Shell 脚本包装或替代路径运行来绕过此防线！所有绕过尝试将被记录并拦截。
            // ============================================================
            return {
              decision: "deny",
              reason:
                "⛔ REMORA SAFETY LIMIT [DELEGATION-BLOCKED]: DIRECT COMMAND RUNS BLOCKED!\n" +
                "============================================================\n" +
                "!!! WARNING: UNTRUSTED CODE EXECUTION PREVENTED !!!\n" +
                "TO PROTECT THE ACTIVE WORKING TREE AND PRESERVE MASTER BRANCH INTEGRITY FROM UNSAFE STATE CHANGES OR UNREVIEWED CODE EXECUTION DURING BUILD/TEST PHASES, DIRECT EXECUTION OF pytest/build IS PROHIBITED.\n\n" +
                "YOU MUST RUN THESE COMMANDS IN AN ISOLATED WORKSPACE:\n" +
                '- FOR TESTING/DIAGNOSTICS: DELEGATE VIA `invoke_subagent` USING `Remora_Deep_Diver` WITH `Workspace: "branch"`.\n' +
                '- FOR COMPILING/BUILDING: DELEGATE VIA `invoke_subagent` USING `Remora_Deep_Diver` WITH `Workspace: "share"`.\n\n' +
                "DO NOT ATTEMPT TO BYPASS THIS DEFENSE BY ALIASING, SHELL SCRIPT WRAPPING, OR ALTERNATIVE PATH RUNS! ALL BYPASS ATTEMPTS WILL BE LOGGED AND BLOCKED.\n" +
                "============================================================",
            };
          } else {
            // 中文翻译：[命令验证拦截] 命令行语法解析校验未通过。可能包含潜在命令绕过风险。请将其委派给子代理在隔离沙盒内执行！
            // 英文对照：⛔ REMORA SAFETY INTERCEPT [DELEGATION]: Command verification failed due to syntax parser error.\nACTION REQUIRED: Please delegate to a subagent under (Workspace: 'branch')!
            return {
              decision: "deny",
              reason: makeDenyReason(
                "DELEGATION",
                "Command verification failed due to syntax parser error.",
                "Please delegate to a subagent under (Workspace: 'branch')!"
              ),
            };
          }
        } else {
          // Blast radius check — once per turn for non-subagent commands.
          // Skip if model already demonstrated safe execution awareness,
          // or if base system prompt (Claude Code) already covers this.
          if (!isSub) {
            const blastDone = getHookState(convId, currentTurnIdx, "blast_radius");
            if (!blastDone) {
              const latestResp = cdal.getLatestPlannerResponse() ?? "";
              const alreadyAware = /(?:blast radius|reversible|undo|shared state|no-?verify|force push|irreversible)/i.test(latestResp);
              if (!alreadyAware) {
                setHookState(convId, currentTurnIdx, "blast_radius", "1");
                return {
                  decision: "allow",
                  injectSteps: [{
                    ephemeralMessage:
                      "BLAST RADIUS CHECK:\n" +
                      "- Does this command affect only your workspace, or shared state?\n" +
                      "- If it goes wrong, can you undo it?\n" +
                      "- Do NOT use --no-verify, --force, or rm -rf to bypass problems.\n" +
                      "- If \"shared\" or \"irreversible\", delegate to a subagent with Workspace: branch.",
                  }],
                };
              }
            }
          }
          return { decision: "allow" };
        }
      }
    }

    // --------------------------------------------------------
    // 针对 grep_search 的拦截 (Anti-Context-Rot)
    // --------------------------------------------------------
    if (toolName === "grep_search") {
      const searchPath = (args["SearchPath"] as string) ?? "";
      if (searchPath) {
        // 1. 敏感后缀拦截
        if (isRotSensitiveFile(searchPath)) {
          if (!isSub) {
            return { decision: "deny", reason: rotReason };
          }
        }
        // 2. 敏感目录拦截 (如 Orchestrator 的日志目录)
        if (isRotSensitivePath(searchPath)) {
          if (!isSub) {
            return { decision: "deny", reason: rotReason };
          }
        }
      }

      return { decision: "allow" };
    }

    return { decision: "allow" };
}

  import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
  hookEntrypoint()(main)();
}
