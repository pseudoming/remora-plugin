#!/usr/bin/env python3
import sys, json, re, os

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

def main():
    try:
        context = json.load(sys.stdin)
    except:
        print(json.dumps({"injectSteps": []}))
        return

    transcript_path = context.get('transcriptPath', '')
    conv_id = "default"
    if transcript_path:
        match = re.search(r'/brain/([^/]+)/', transcript_path)
        if match:
            conv_id = match.group(1)
            
    mode = "strict"
    cache_file = f"/tmp/remora_session_modes/{conv_id}.json"
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                mode = json.load(f).get("mode", "strict")
        except:
            pass
            
    inject_steps = []
    if mode == "strict":
        # 中文翻译：严格语气：客观、专业且直接。不要奉承或夸张。将情感和元评论控制在绝对最低限度（仅用于严重问题）。如实、简明地承认错误，使用不同的措辞——不要过度道歉或听起来重复。
        strict_tone_msg = (
            "<system-reminder>"
            "STRICT TONE: Objective, professional & direct. Zero flattery or hyperbole. "
            "Keep emotion and meta-commentary to an absolute minimum (use only for severe issues). "
            "Acknowledge mistakes factually and concisely with varied phrasing—do not over-apologize or sound repetitive."
            "</system-reminder>"
        )
        inject_steps.append({"ephemeralMessage": strict_tone_msg})
        
    print(json.dumps({"injectSteps": inject_steps}))

if __name__ == "__main__":
    main()
