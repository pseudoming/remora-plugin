import * as fs from "node:fs";
import * as path from "node:path";
import {
  warn,
  error,
  cleanSystemReminders,
  detectMode,
  isTimerCanceled,
  markFired,
  formatStrictRecallReminder,
  formatAlertRecallPrompt,
  formatHeartbeatTimerInjection,
  formatCumulativeReadWarning,
  formatSubagentDispatchReminder,
  writeMode,
  getHookState,
} from "@remora/core";
import { cleanup, getStats } from "../bridge/stats";
import { getSubagentType } from "../bridge/subagent";
import { getDataDir, extractConvId, findPluginRoot } from "../bridge/paths";
import { ConversationDataAccessLayer } from "../bridge/conversation";
import { getMetadata } from "../bridge/agentapi";

export function main(context: Record<string, unknown>): { injectSteps: Array<Record<string, unknown>> } {
  try {
    return _main(context);
  } catch {
    return { injectSteps: [{ ephemeralMessage: "<system-reminder>⚠️ Remora Session Guardian 发生异常。状态同步防线已降级，但不影响正常对话。</system-reminder>" }] };
  }
}

function _main(context: Record<string, unknown>): { injectSteps: Array<Record<string, unknown>> } {
  // 0. Fail-Fast 探测环境是否已被 install.py 初始化
  const initializedFile = path.join(getDataDir(), ".runtime", "installed.flag");
  if (!fs.existsSync(initializedFile)) {
    return { injectSteps: [{ ephemeralMessage: "🚨 **[REMORA FATAL ERROR]** Plugin uninitialized! Please run `npm run build && node packages/adapter-antigravity/bin/install.js --force` in the plugin root." }] };
  }

  // 物理缓存 LS API 凭据以解决子代理在 Hook 沙盒中缺乏鉴权环境变量的问题
  const lsAddr = process.env["ANTIGRAVITY_LS_ADDRESS"];
  const csrfToken = process.env["ANTIGRAVITY_CSRF_TOKEN"];
  if (lsAddr && csrfToken) {
    try {
      fs.mkdirSync(path.join(getDataDir(), ".runtime"), { recursive: true });
      fs.writeFileSync(
        path.join(getDataDir(), ".runtime", "remora_agent_env.json"),
        JSON.stringify({ ANTIGRAVITY_LS_ADDRESS: lsAddr, ANTIGRAVITY_CSRF_TOKEN: csrfToken }),
        "utf-8"
      );
    } catch {
      // pass
    }
  }

  const transcriptPath = context["transcriptPath"] as string;

  // 提取当前会话 ID
  const convId = extractConvId(transcriptPath) || "default";
  if (convId !== "default") {
    try {
      const subType = getSubagentType(transcriptPath);
      const mainIdFile = path.join(getDataDir(), ".runtime", "remora_main_conv_id.txt");
      let shouldWrite = false;
      if (subType === null) {
        // 只有在主会话（或无 sub_type）时才考虑写入
        if (process.env["ANTIGRAVITY_LS_ADDRESS"] || !fs.existsSync(mainIdFile)) {
          shouldWrite = true;
        }
      }

      if (shouldWrite) {
        fs.writeFileSync(mainIdFile, convId);
      }
    } catch {
      // pass
    }
  }

  const cdal = new ConversationDataAccessLayer(convId);

  // 动态读取 SQLite 获取最后一条用户指令
  let lastMsg = "";
  let heartbeatSteps: Array<Record<string, unknown>> = [];
  let isNewTurn = false;

  try {
    // 使用 CDAL 的原生 SQLite 倒序查询接口，安全获取最后 300 步
    const steps = cdal.streamStepsReverse(300);
    heartbeatSteps = Array.isArray(steps) ? steps : Array.from(steps);

    // 提取 last_msg 和 is_new_turn
    // heartbeat_steps 已经是逆序的 (从新到旧)
    for (const step of heartbeatSteps.slice(0, 50)) {
      const stepType = step["type"] as string;
      if (stepType === "EPHEMERAL_MESSAGE" || stepType === "SYSTEM_MESSAGE" || stepType === "ERROR_MESSAGE") {
        continue;
      }
      if (stepType === "USER_INPUT") {
        isNewTurn = true;
        lastMsg = (step["content"] as string) || "";
      }
      break;
    }
  } catch {
    // pass
  }

  const keywordsConfigPath = path.join(findPluginRoot(), "conf", "keywords.json");
  let relaxKws: string[] = [];
  let alertKws: string[] = [];
  try {
    const config = JSON.parse(fs.readFileSync(keywordsConfigPath, "utf-8")) as Record<string, unknown>;
    relaxKws = (config["relax_keywords"] as string[]) || [];
    alertKws = (config["alert_keywords"] as string[]) || [];
  } catch {
    // pass
  }

  const injectSteps: Array<Record<string, unknown>> = [];

  // ==========================================
  // 设计原理六：子代理创建的即时捕获与心跳断链续期状态机逻辑 (已优化无心跳提示语)
  // ==========================================
  // 由于平台的 One-shot 计时器会在子代理发送 any 中间进度同步消息时自动静默取消，
  // 我们直接在 PreInvocation 阶段从 CDAL 原生层中分析最新 UUID，并计算
  // 子代理最近活动与最近一次 schedule 定时器的相对时序。若已被取消且模型未续期，
  // 在上下文最前沿通过 injectSteps 注入强强制心跳指示。
  // 优化点：当无心跳定时器运行时，注入的消息及中文翻译使用角色名称 role_name 替代 uuid，
  // 并强制引导大模型使用拟人化的"进度+时间"汇报进度（如 subagent (role_name)），杜绝暴露底层安全定时器技术术语。
  let subagentUuid: string | null = null;
  let seenSubagent = false;
  let hasScheduleAfter = false;
  let latestSubagentActivityIndex = -1;
  let latestScheduleIndex = -1;
  let subagentFinishDetected = false;

  if (heartbeatSteps.length > 0) {
    try {
      // Pass 1：提取最新的 subagent_uuid 以及 schedule 挂载状态
      // 注意：heartbeat_steps 本来就是逆序的，所以直接遍历即可
      for (let idx = 0; idx < heartbeatSteps.length; idx++) {
        const step = heartbeatSteps[idx];
        const stepType = step["type"] as string;
        const stepStr = JSON.stringify(step);

        // 记录最新的 schedule 挂载，及 schedule 挂载判定（无论时序，只要同一轮且提及了 monitor 探活即可）
        // 从主干的 schedule 参数里直接正则提取最新拉起的子代理 UUID，从根源杜绝文本投毒及类型缺失的问题
        if (stepType === "PLANNER_RESPONSE" && step["tool_calls"]) {
          const toolCalls = step["tool_calls"] as Array<Record<string, unknown>>;
          for (const tc of toolCalls) {
            if (tc["name"] === "schedule") {
              const argsStr = JSON.stringify(tc["args"] || tc["arguments"] || {});
              if (latestScheduleIndex === -1) {
                latestScheduleIndex = idx;
                if (argsStr.includes("subagent-monitor.js")) {
                  hasScheduleAfter = true;
                } else {
                  hasScheduleAfter = false;
                }
              }

              if (!subagentUuid && argsStr.includes("subagent-monitor.js")) {
                const uuidRegex = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
                const cidMatches = Array.from(argsStr.matchAll(uuidRegex));
                for (const match of cidMatches) {
                  const uid = match[1];
                  if (uid !== convId && uid !== "11111111-1111-1111-1111-111111111111") {
                    subagentUuid = uid;
                    seenSubagent = true;
                    break;
                  }
                }
              }
              break;
            }
          }
        }

        // 判断子代理是否已被主动清理完成 (时序边界：模型发起清理，或物理回执明确包含 Successfully killed)
        // 注意：必须严格限定为 GENERIC 回执或 manage_subagents 调用，杜绝大模型在 thinking 字段 of 文本讨论触发假阳性
        if (!seenSubagent) {
          let isKillCommand = false;
          if (stepType === "PLANNER_RESPONSE" && step["tool_calls"]) {
            const toolCalls = step["tool_calls"] as Array<Record<string, unknown>>;
            for (const tc of toolCalls) {
              if (tc["name"] === "manage_subagents") {
                const args = (tc["args"] || tc["arguments"] || {}) as Record<string, unknown>;
                const action = String(args["Action"] || "").replace(/^"(.*)"$/, "$1");
                if (action === "kill" || action === "kill_all") {
                  isKillCommand = true;
                  break;
                }
              }
            }
          }
          const isSystemConfirm = stepType === "GENERIC" && step["content"] && typeof step["content"] === "string" &&
            ((step["content"] as string).includes("Successfully killed") || (step["content"] as string).includes("Terminated subagent"));
          if (isKillCommand || isSystemConfirm) {
            subagentFinishDetected = true;
          }
        }
      }

      // Pass 2：在 subagent_uuid 提取成功后，以该特定 ID 进行精准活跃检测，排除其它 UUID 及主干物理工具调用输出 of 噪声干扰
      if (subagentUuid && !subagentFinishDetected) {
        for (let idx = 0; idx < heartbeatSteps.length; idx++) {
          const step = heartbeatSteps[idx];
          const stepType = step["type"] as string;
          const stepStr = JSON.stringify(step);

          // 彻底放宽拦截类型捕获各种格式的消息体，但严格排除系统自身的大型历史汇总记录
          if (stepType !== "CONVERSATION_HISTORY" && stepType !== "CHECKPOINT") {
            // 精确匹配本子代理的活跃，且排除主会话自己物理命令/文件读写/subagent状态查询所产生的带有 UUID 的输出干扰
            if (stepStr.includes(subagentUuid) &&
              !["run_command", "view_file", "grep_search", "manage_subagents", "schedule"].some(cmd => stepStr.includes(cmd))) {
              latestSubagentActivityIndex = idx;
              break;
            }
          }
        }
      }

      // 正常退出自动物理清除重试计数缓存
      if (subagentFinishDetected) {
        try {
          const retryFile = path.join(getDataDir(), ".runtime", `remora_subagent_retries_${convId}.json`);
          if (fs.existsSync(retryFile)) {
            fs.unlinkSync(retryFile);
          }
        } catch {
          // pass
        }
      }
    } catch {
      // pass
    }
  }

  // 逆序索引越小时间越近。若子代理活动比最新的定时器更近，代表 timer 已经被该中间消息自动静默取消了
  const timerCanceled = isTimerCanceled(latestSubagentActivityIndex, latestScheduleIndex);

  if (subagentUuid && !subagentFinishDetected && (!hasScheduleAfter || timerCanceled)) {
    const pluginRoot = findPluginRoot();
    const pythonBin = "node";

    // 提取子会话的角色名称 (优先通过 agentapi，其次通过历史记录)
    let roleName: string | null = null;
    try {
      const metadata = getMetadata(subagentUuid) as Record<string, unknown>;
      const subagentSpec = metadata["subagentSpec"] as Record<string, unknown> | undefined;
      if (subagentSpec) {
        roleName = (subagentSpec["typeName"] as string) || null;
      }
    } catch {
      // pass
    }

    if (!roleName && heartbeatSteps.length > 0) {
      try {
        for (const step of heartbeatSteps) {
          if (step["type"] === "PLANNER_RESPONSE" && step["tool_calls"]) {
            const toolCalls = step["tool_calls"] as Array<Record<string, unknown>>;
            for (const tc of toolCalls) {
              if (tc["name"] === "invoke_subagent") {
                const argsSub = (tc["args"] || tc["arguments"] || {}) as Record<string, unknown>;
                const subagents = argsSub["Subagents"] as Array<Record<string, unknown>> | undefined;
                if (subagents && subagents.length > 0) {
                  for (const s of subagents) {
                    if (s["TypeName"]) {
                      roleName = s["TypeName"] as string;
                      break;
                    }
                  }
                } else if (argsSub["TypeName"]) {
                  roleName = argsSub["TypeName"] as string;
                }
                if (roleName) {
                  break;
                }
              }
            }
          }
          if (roleName) {
            break;
          }
        }
      } catch {
        // pass
      }
    }

    if (!roleName) {
      roleName = subagentUuid;
    }

    // 中文翻译：⚠️ [系统警告] subagent ({role_name}) 当前在无心跳定时器状态下运行。请立即调用 schedule 设置 60s 心跳定时器。
    // 在回复中必须使用拟人化的"进度+时间"结构汇报，禁止透露"挂载定时器"。
    injectSteps.push({
      ephemeralMessage: formatHeartbeatTimerInjection(roleName, subagentUuid, pythonBin, pluginRoot, convId)
    });
  }

  // ##########################################################
  // AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
  // ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
  //   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
  //   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
  //   禁止在不更新设计注释与提示词翻译的情况下直接覆写 logic！
  // ##########################################################

  // ==========================================
  // 设计原理四：系统提示清洗，阻断意图自反馈死循环
  // ==========================================
  // 即使系统在上一回合注入了包含 remora 关键词的提醒，大模型的 transcript 依然会包含 these 系统提醒。
  // 如果不加清洗地进行正则检测，会导致每回合均误命中而持续注入，从而陷入无限自触发状态。
  // 我们采用 re.sub(r'<system-reminder>.*?</system-reminder>', '', last_msg, flags=re.DOTALL)
  // 正则剥离所有系统提示内容，只保留用户的原生真实意图。

  // 意图探测逻辑
  // 剥离前置注入的系统提醒，防止其携带的关键字引发无限自反馈死循环
  const cleanMsg = cleanSystemReminders(lastMsg);

  const [mode, alertWord] = detectMode(cleanMsg, relaxKws, alertKws);

  if (alertWord) {
    const recallCmd = `npx tsx packages/adapter-antigravity/src/cli/remora-recall.ts "${alertWord}"`;
    injectSteps.push({ ephemeralMessage: formatAlertRecallPrompt(alertWord, recallCmd) });
  } else if (mode === "strict") {
    let currentTurnIdx = cdal.getCurrentTurnIdx();
    let currentTurnIdxNum = 0;
    if (currentTurnIdx !== null && currentTurnIdx !== undefined) {
      const parsed = parseInt(String(currentTurnIdx), 10);
      if (!isNaN(parsed)) {
        currentTurnIdxNum = parsed;
      }
    }
    const lastRecallStr = getHookState(convId, -1, "last_recall_turn");
    let lastRecall = 0;
    if (lastRecallStr) {
      const parsed = parseInt(lastRecallStr, 10);
      if (!isNaN(parsed)) {
        lastRecall = parsed;
      }
    }
    if (currentTurnIdxNum - lastRecall >= 3) {
      injectSteps.push({ ephemeralMessage: formatStrictRecallReminder("remora-recall.ts") });
      markFired(convId, "last_recall_turn", String(currentTurnIdxNum));
    }
  }

  writeMode(convId, mode);

  // ==========================================
  // 设计原理五：View File 累加器与主干上下文防腐 (Anti-Context-Rot) 软阻断
  // ==========================================
  try {
    // 新回合强制初始化与清零 (无需检查是否存在，保障状态干净)
    if (isNewTurn) {
      cleanup(convId);
    }

    // 二级认知摩擦：检查是否软超标或触发子代理调用关键词
    const stats = getStats(convId);
    const srcKb = Math.floor(((stats["accumulated_source_bytes"] as number) || 0) / 1024);
    const dataKb = Math.floor(((stats["accumulated_data_bytes"] as number) || 0) / 1024);
    
    const hasSubagentKeyword = /\b(?:subagent|diver|extractor|委派|沙盒)\b/i.test(cleanMsg);
    const lastDispatchTurnStr = getHookState(convId, -1, "dispatch_protocol_injected_turn");
    let currentTurnIdx = cdal.getCurrentTurnIdx();
    let currentTurnIdxNum = 0;
    if (currentTurnIdx !== null && currentTurnIdx !== undefined) {
      const parsed = parseInt(String(currentTurnIdx), 10);
      if (!isNaN(parsed)) {
        currentTurnIdxNum = parsed;
      }
    }
    const alreadyInjectedThisTurn = lastDispatchTurnStr === String(currentTurnIdxNum);

    if (!alreadyInjectedThisTurn && (srcKb > 150 || dataKb > 50 || hasSubagentKeyword)) {
      if (srcKb > 150 || dataKb > 50) {
        injectSteps.push({
          ephemeralMessage: formatCumulativeReadWarning(srcKb, dataKb)
        });
      }
      injectSteps.push({
        ephemeralMessage: formatSubagentDispatchReminder()
      });
      markFired(convId, "dispatch_protocol_injected_turn", String(currentTurnIdxNum));
    }
  } catch {
    // pass
  }

  return { injectSteps: injectSteps };
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
  hookEntrypoint()(main)();
}

