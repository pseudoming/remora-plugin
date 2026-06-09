import * as fs from "node:fs";
import * as path from "node:path";

import { getProfiler } from "../bridge/context";
import { getSnapshot, diffSnapshots } from "../bridge/filesystem";
import {
  normalizeFilepath,
  ACTION_PATTERNS,
  resolvePhantomModifications,
  formatPhantomFirstWarning,
  formatPhantomRepeatWarning,
  debug,
  trimStaleHookStates,
  getHookState,
  setHookState,
  insertFileChange,
  getProjectUuidByConv,
} from "@remora/core";
import { extractConvId } from "../bridge/paths";
import { readMode } from "../bridge/session";
import { ConversationDataAccessLayer } from "../bridge/conversation";

// ##########################################################
// AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
// ⚠️ 警告：本脚本是判定大模型动作幻觉（Phantom Modification）的物理防线。
//   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
//   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
//   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
//   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
// ##########################################################

// ==========================================================
// 设计原理一：Markdown 链接与陈述意图正则匹配
// ==========================================================
// 解析大模型 PLANNER_RESPONSE 中声称已修改/更新/创建的文件名。
// 采用 7 组多时态中英文动词正则模式，过滤并提取出大模型声称发生修改的文件名 Basename。

// ==========================================================
// 设计原理二：时序净化与强水位线截断
// ==========================================================
// 1. 强水位线截断：在通过 CDAL 提取原生步骤时，以 `initialNumSteps` 为强水位线。
//    凡是 step_index 小于等于该水位线的步骤，说明是本轮交互启动之前发生的历史步骤，必须停止回溯，防历史交互干扰。
// 2. 回合截断：逆序回溯时，一旦遇到用户的 `USER_INPUT` 输入，表示上一个交互回合结束，停止回溯。
// 3. 锁定最近 PLANNER_RESPONSE：只抓取本回合内最近一次的模型输出，杜绝跨回合时序污染。

// ==========================================================
// 设计原理三：同义路径别名归一化对齐
// ==========================================================
// 模型在调用原生写文件工具或自定义工具时，参数名称可能在 TargetFile / AbsolutePath / FilePath / Target 之间摆动。
// 引入 `normalize_filepath` 自动过滤并提取统一的 Basename，消除假阳性误报。

// ==========================================================
// 设计原理四：零误伤降级保护 (Zero-Fault Fallback)
// ==========================================================
// 用全局 `try-except Exception` 包裹 main()。若发生任何解析崩溃，默认无条件放行（返回空 injectSteps），确保正常交互绝对可用。

function profilerStep(event: string): void {
  try {
    const p = getProfiler();
    if (p) {
      p.step(event);
    }
  } catch {
    // pass
  }
}

export function getPhysicalModifications(cwd: string, transcriptPath: string): Set<string> {
  try {
    const convDir = path.dirname(path.dirname(path.dirname(transcriptPath)));
    const scratchDir = path.join(convDir, "scratch");
    const snapshotFile = path.join(scratchDir, "remora_pre_snapshot.json");

    let preSnapshot: Record<string, any> = {};
    if (fs.existsSync(snapshotFile)) {
      preSnapshot = JSON.parse(fs.readFileSync(snapshotFile, "utf-8"));
    }

    profilerStep("phys_snapshot_pre_loaded");
    const postSnapshot = getSnapshot(cwd);
    profilerStep("phys_snapshot_post_computed");

    const modifiedFiles = diffSnapshots(preSnapshot, postSnapshot);

    if (fs.existsSync(snapshotFile)) {
      try {
        fs.unlinkSync(snapshotFile);
      } catch {
        // pass
      }
    }

    return modifiedFiles;
  } catch {
    return new Set<string>();
  }
}

export function getLatestConversationStates(cdal: ConversationDataAccessLayer, initialNumSteps: number = 0): [string, Set<string>, boolean] {
  /**
   * 通过 CDAL 原生读取 SQLite，
   * 提取出最近一次大模型的 PLANNER_RESPONSE 陈述文本以及本次 Invocation 中的物理写入工具调用。
   */
  let plannerText: string | null = null;
  const actualModifiedFiles = new Set<string>();
  let hasAnyToolCalls = false;

  try {
    // 使用 CDAL 的原生 SQLite 倒序查询接口，安全获取最后 1000 步
    for (const step of cdal.streamStepsReverse(1000)) {
      const stepType = step["type"];
      const source = step["source"];
      const stepIndex = step["step_index"];

      // 水位线强截断，防止时序污染
      if (initialNumSteps > 0 && stepIndex != null && stepIndex <= initialNumSteps) {
        break;
      }

      // 遇到真实用户的输入，代表交互回合结束，停止回溯
      if (stepType === "USER_INPUT" || source === "USER" || source === "USER_EXPLICIT") {
        break;
      }

      const toolCalls = step["tool_calls"] ?? [];
      if (toolCalls.length > 0) {
        hasAnyToolCalls = true;
      }

      // 锁定最近的一次 PLANNER_RESPONSE
      if (stepType === "PLANNER_RESPONSE" && plannerText === null) {
        plannerText = step["content"] ?? "";
      }

      // 分析并提取写入工具调用的目标文件，应用别名归一化
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const name = call["name"] ?? "";
          let args = call["args"] ?? call["arguments"] ?? {};

          if (name === "write_to_file" || name === "replace_file_content" || name === "multi_replace_file_content") {
            if (typeof args === "string") {
              try {
                args = JSON.parse(args);
              } catch {
                // pass
              }
            }

            if (typeof args === "object" && args !== null && !Array.isArray(args)) {
              const baseName = normalizeFilepath(args);
              if (baseName) {
                actualModifiedFiles.add(baseName);
              }
            }
          }
        }
      }
    }
  } catch {
    // pass
  }

  return [plannerText ?? "", actualModifiedFiles, hasAnyToolCalls];
}

export function main(context: Record<string, any>): { injectSteps: any[]; terminationBehavior: string } {
  try {
    return _main(context);
  } catch {
    return { injectSteps: [], terminationBehavior: "" };
  }
}

export function _main(context: Record<string, any>): { injectSteps: any[]; terminationBehavior: string } {
  const transcriptPath = context["transcriptPath"] ?? "";
  const cwd = context["cwd"] ?? process.cwd();

  // Dump context to scratch for analysis
  try {
    const convDir = path.dirname(path.dirname(path.dirname(transcriptPath)));
    const scratchDir = path.join(convDir, "scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "context_dump.json"), JSON.stringify(context, null, 2), "utf-8");
  } catch {
    // pass
  }

  const convId = extractConvId(transcriptPath) || "default";

  // 规则 7: Bypass gating if write tool returns error
  const toolCallResult = context["toolCallResult"] ?? {};
  if (toolCallResult && "error" in toolCallResult && toolCallResult["error"] !== null) {
    return { injectSteps: [], terminationBehavior: "" };
  }

  const cdal = new ConversationDataAccessLayer(convId);
  const currentTurnIdx = cdal.getCurrentTurnIdx();

  trimStaleHookStates(convId, currentTurnIdx);


  const initialNumSteps = context["initialNumSteps"] ?? 0;

  profilerStep("start_conv_state_read");
  const [plannerText, actualToolFiles, hasAnyToolCalls] = getLatestConversationStates(cdal, initialNumSteps);
  profilerStep("finish_conv_state_read");

  const physicalFiles = getPhysicalModifications(cwd, transcriptPath);
  profilerStep("finish_physical_modifications");

  if (physicalFiles.size > 0) {
    const projectUuid = getProjectUuidByConv(convId);
    if (projectUuid) {
      for (const fname of physicalFiles) {
        insertFileChange(projectUuid, convId, fname, "snapshot");
      }
    }
  }

  // 事实基座 = (解析 transcript 得到的工具调用文件集) U (物理增量比对得出的文件集)
  const actualFiles = new Set([...actualToolFiles, ...physicalFiles]);

  // 若本回合无任何工具调用且无物理变更，或未发生任何文本生成，直接放行
  if (!plannerText || (!hasAnyToolCalls && physicalFiles.size === 0)) {
    return { injectSteps: [], terminationBehavior: "" };
  }

  const mode = readMode(convId, "strict");

  // Relax 模式自适应直接放行，不执行虚报比对，提供最大发散性心流
  if (mode === "relax") {
    return { injectSteps: [], terminationBehavior: "" };
  }

  const declaredFiles = new Set<string>();
  for (const pattern of ACTION_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    const matches = plannerText.matchAll(globalPattern);
    for (const match of matches) {
      let filePath: string;
      if (match.length > 1) {
        // Has capture groups — extract first non-empty group (like Python findall tuple handling)
        const groups = match.slice(1).filter((x) => x !== undefined && x !== "");
        filePath = groups.length > 0 ? groups[0] : match[0];
      } else {
        filePath = match[0];
      }
      if (filePath) {
        declaredFiles.add(path.basename(filePath));
      }
    }
  }

  // 计算宣称已改但实际未发工具调用的文件差集
  const phantomModifications = resolvePhantomModifications(declaredFiles, actualFiles);
  if (phantomModifications.size > 0) {
    debug(`phantom detected: ${[...phantomModifications]}`);
  } else {
    debug("phantom check: no false positives");
  }
  profilerStep("regex_matching_complete");

  if (phantomModifications.size > 0) {
    const gatingCnt = getHookState(convId, currentTurnIdx, "action_gating_cnt");
    if (gatingCnt === "1") {
      return {
        injectSteps: [{ ephemeralMessage: formatPhantomRepeatWarning([...phantomModifications]) }],
        terminationBehavior: "",
      };
    } else {
      setHookState(convId, currentTurnIdx, "action_gating_cnt", "1");
      return {
        injectSteps: [{ ephemeralMessage: formatPhantomFirstWarning([...phantomModifications], ["write_to_file", "replace_file_content"]) }],
        terminationBehavior: "force_continue",
      };
    }
  } else {
    return { injectSteps: [], terminationBehavior: "" };
  }
}
