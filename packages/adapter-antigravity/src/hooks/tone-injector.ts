import {
  shouldFire,
  markFired,
  shouldInjectTone,
  formatStrictTonePrompt,
  trimStaleHookStates,
} from "@remora/core";
import { readMode } from "../bridge/session";
import { ConversationDataAccessLayer } from "../bridge/conversation";

// ##########################################################
// AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
// ⚠️ 警告：本脚本是控制大模型生成阶段输出语气与心流宽容度的物理防线。
//   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
//   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
//   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
//   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
// ##########################################################

// ==========================================================
// 设计原理一：会话模式感知与条件化语气控制
// ==========================================================
// 1. 静态 Hook 动态路由：由于 hooks.json 的 PreInvocation 是静态 echo，无法读取上下文。
//    本脚本作为替代处理器，通过 SQLite session_state 表（由 session-guardian 写入）读取会话 mode。
// 2. 差异化语气约束：
//    - 在 strict 模式下：向模型注入极其严格的客观专业（strict tone）提示词，限制废话和情绪表达；
//    - 在 relax 模式下：不进行 any 语气约束注入，保障大模型在起草设计与发散脑暴时的创造力。

export function main(context: Record<string, unknown>): { injectSteps: any[] } {
  try {
    return _main(context);
  } catch {
    return { injectSteps: [] };
  }
}

function _main(context: Record<string, unknown>): { injectSteps: any[] } {
  const transcriptPath = (context["transcriptPath"] ?? "") as string;
  let convId = "default";
  if (transcriptPath) {
    const match = transcriptPath.match(/\/brain\/([^/]+)\//);
    if (match) {
      convId = match[1];
    }
  }

  const cdal = new ConversationDataAccessLayer(convId);
  const currentTurnIdx = cdal.getCurrentTurnIdx();

  trimStaleHookStates(convId, currentTurnIdx);

  const mode = readMode(convId, "strict");

  const injectSteps: any[] = [];
  if (mode === "strict" || mode === "alert") {
    const userInputCount = cdal.getUserInputCount();
    if (shouldInjectTone(userInputCount)) {
      if (shouldFire(convId, "tone_injected", String(currentTurnIdx))) {
        markFired(convId, "tone_injected", String(currentTurnIdx));

          // 中文翻译：
          // ⛔ REMORA 沟通风格限制 [严格语气]：
          // ============================================================
          // 你必须以最高的效率和直接性进行沟通！
          //
          // 1. 无运行注释：不要叙述你的内部审议或解释你的思考过程。先交付结果和结论。
          // 2. 零奉承：绝不使用夸张、道歉或情感铺垫。
          // 3. 极简注释：在代码编辑中，除非显式要求，否则不要写任何注释或文档字符串。
          // 4. 事实错误报告：如果你犯了错误，事实且简明地承认它（例如，"修正了第25行的变量引用"）。不要重复道歉。
          // ============================================================
          injectSteps.push({ ephemeralMessage: formatStrictTonePrompt() });
        }
      }
    }

  return { injectSteps: injectSteps };
}

import { hookEntrypoint } from "../bridge/context";

if (typeof require !== "undefined" && require.main === module) {
  hookEntrypoint()(main)();
}
