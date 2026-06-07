#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from adapter.bridge.context import hook_entrypoint
from adapter.bridge.session import read_mode

import json, re

# ##########################################################
# AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
# ⚠️ 警告：本脚本是控制大模型生成阶段输出语气与心流宽容度的物理防线。
#   后续任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
#   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
#   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
#   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
# ##########################################################

# ==========================================================
# 设计原理一：会话模式感知与条件化语气控制
# ==========================================================
# 1. 静态 Hook 动态路由：由于 hooks.json 的 PreInvocation 是静态 echo，无法读取上下文。
#    本脚本作为替代处理器，通过读取 /tmp 本地临时缓存，获取由前置 intent-detector 写入的会话 mode。
# 2. 差异化语气约束：
#    - 在 strict 模式下：向模型注入极其严格的客观专业（strict tone）提示词，限制废话和情绪表达；
#    - 在 relax 模式下：不进行 any 语气约束注入，保障大模型在起草设计与发散脑暴时的创造力。

@hook_entrypoint(fallback_result={"injectSteps": []})
def main(context):
    transcript_path = context.get('transcriptPath', '')
    conv_id = "default"
    if transcript_path:
        match = re.search(r'/brain/([^/]+)/', transcript_path)
        if match:
            conv_id = match.group(1)
            
    from adapter.bridge.conversation import ConversationDataAccessLayer
    from lib.dao import get_hook_state, set_hook_state, trim_hook_states

    cdal = ConversationDataAccessLayer(conv_id)
    current_turn_idx = cdal.get_current_turn_idx()

    # 物理时序裁剪 (Timeline Trimming)
    last_seen = get_hook_state(conv_id, -1, 'last_seen_turn')
    should_trim = False
    if last_seen is None:
        should_trim = True
    else:
        try:
            should_trim = int(last_seen) != int(current_turn_idx)
        except (ValueError, TypeError):
            should_trim = False

    if should_trim:
        try:
            trim_turn = int(current_turn_idx)
        except (ValueError, TypeError):
            trim_turn = 0
        trim_hook_states(conv_id, trim_turn)
        set_hook_state(conv_id, -1, 'last_seen_turn', str(trim_turn))


    mode = read_mode(conv_id, "strict")
            
    inject_steps = []
    if mode == "strict":
        user_input_count = cdal.get_user_input_count()
        if user_input_count % 5 == 0:
            injected_val = get_hook_state(conv_id, current_turn_idx, 'tone_injected')
            if not injected_val:
                set_hook_state(conv_id, current_turn_idx, 'tone_injected', '1')

                # 中文翻译：
                # ⛔ REMORA 沟通风格限制 [严格语气]：
                # ============================================================
                # 你必须以最高的效率和直接性进行沟通！
                #
                # 1. 无运行注释：不要叙述你的内部审议或解释你的思考过程。先交付结果和结论。
                # 2. 零奉承：绝不使用夸张、道歉或情感铺垫。
                # 3. 极简注释：在代码编辑中，除非显式要求，否则不要写任何注释或文档字符串。
                # 4. 事实错误报告：如果你犯了错误，事实且简明地承认它（例如，“修正了第25行的变量引用”）。不要重复道歉。
                # ============================================================
                strict_tone_msg = (
                    "<system-reminder>\n"
                    "⛔ REMORA COMMUNICATION STYLE CONSTRAINT [STRICT TONE]:\n"
                    "============================================================\n"
                    "YOU MUST COMMUNICATE WITH MAXIMUM EFFICIENCY AND DIRECTNESS!\n\n"
                    "1. NO RUNNING COMMENTARY: DO NOT NARRATE YOUR INTERNAL DELIBERATION OR EXPLAIN YOUR THOUGHT PROCESS. DELIVER RESULTS AND CONCLUSIONS FIRST.\n"
                    "2. ZERO FLATTERY: NEVER USE HYPERBOLE, APOLOGIES, OR EMOTIONAL FLATTENING.\n"
                    "3. MINIMAL COMMENTARY: IN CODE EDITS, WRITE NO COMMENTS OR DOCSTRINGS UNLESS EXPLICITLY ASKED.\n"
                    "4. FACTUAL ERROR REPORTING: IF YOU COMMITTED AN ERROR, ACKNOWLEDGE IT FACTUALLY AND CONCISELY (E.g., \"Corrected variable reference in line 25\"). DO NOT REPETITIVELY APOLOGIZE.\n"
                    "============================================================\n"
                    "</system-reminder>"
                )
                inject_steps.append({"ephemeralMessage": strict_tone_msg})
        
    return {"injectSteps": inject_steps}

if __name__ == "__main__":
    main()
