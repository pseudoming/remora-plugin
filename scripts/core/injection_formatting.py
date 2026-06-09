"""Pure prompt-template functions extracted from hooks.

Each function formats an ephemeral message or prompt string
used to inject structured reminders into the LLM context.
No adapter/ imports — stdlib only.
"""


def format_relax_discipline_prompt(artifact_path=None, write_tool_examples=None):
    # 中文翻译：[行为纪律] 您当前处于需求研讨与规划阶段。
    # 除非用户明确指定了具体文件名，否则禁止修改核心代码文件。
    # 规划制品可自由编辑（artifact_path 指定具体路径）。
    # 若在此期间发现任何未经用户明确要求的 Bug 或代码异味，严禁立即动手。先写入实施计划，获得用户批准！
    if write_tool_examples:
        tools_str = f"DO NOT INVOKE ANY TOOLS (e.g., {', '.join(write_tool_examples)}) THAT CHANGE CORE CODE FILES."
    else:
        tools_str = "DO NOT INVOKE ANY TOOLS THAT CHANGE CORE CODE FILES."
    if artifact_path:
        artifacts_str = f"YOU MAY FREELY EDIT PLANNING ARTIFACTS UNDER {artifact_path}."
    else:
        artifacts_str = "YOU MAY FREELY EDIT PLANNING ARTIFACTS."
    return (
        "<system-discipline>\n"
        "COORDINATOR BEHAVIORAL DISCIPLINE:\n"
        "1. YOU ARE CURRENTLY IN THE REQUIREMENT DISCUSSION AND PLANNING PHASE.\n"
        f"2. UNLESS THE USER EXPLICITLY NAMES A SPECIFIC FILE TO MODIFY, {tools_str} {artifacts_str}\n"
        "3. IF YOU SPOT A BUG OR CODE SMELL NOT EXPLICITLY REQUESTED BY THE USER, DOCUMENT IT IN THE IMPLEMENTATION PLAN INSTEAD OF FIXING IT. SEEK USER APPROVAL BEFORE ANY WRITES.\n"
        "</system-discipline>"
    )


def format_decisions_for_session_resume(decisions, topic_id):
    lines = []
    for d in decisions:
        label = f"[{d['created_at'][:16]}"
        if d['user_confirmed']:
            label += ", 已确认"
        label += f"] {d['decision']}"
        if d.get('rationale'):
            label += f" (原因: {d['rationale'][:120]})"
        lines.append(label)
    decision_text = "\n".join(lines)
    decisions_from_memory = f"活跃话题: {topic_id}\n{decision_text}"
    prompt = (
        f"<system-reminder>\n"
        f"⚠️ SESSION RESUMED — 历史决策供参考:\n"
        f"============================================================\n"
        f"以下是本次话题下最近的历史决策（按时间排列）。\n"
        f"如果其中任何一条与当前上下文冲突，请与用户讨论后再继续。\n"
        f"{decisions_from_memory}\n"
        f"============================================================\n"
        f"</system-reminder>"
    )
    return prompt


def format_conflict_injection_message(d, c, is_repeat):
    label = "REPEAT CONFLICT" if is_repeat else "SEMANTIC CONFLICT DETECTED"
    type_label = d["decision_type"].upper()
    date = d["created_at"][:10] if d.get("created_at") else ""
    reason = c.get("reason", "")

    conflict_details = (
        f"  [{type_label}, {date}] {d['decision']}\n"
        f"  LLM analysis: {reason}"
    )

    msg = (
        f"<system-reminder>\n"
        f"⚠️ {label}. YOUR PROPOSED COURSE OF ACTION CONTRADICTS PRIOR DECISIONS.\n\n"
        f"BEFORE EXECUTING ANY TOOLS, YOU MUST:\n"
        f"1. EXPLICITLY POINT OUT THE CONFLICT TO THE USER\n"
        f"2. ASK THE USER WHETHER TO OVERRIDE THE PREVIOUS DECISION\n"
        f"3. WAIT FOR EXPLICIT USER CONFIRMATION BEFORE PROCEEDING\n\n"
        f"CONFLICT DETAILS:\n{conflict_details}\n\n"
        f"DO NOT PROCEED WITHOUT USER CONFIRMATION.\n"
        f"</system-reminder>"
    )
    return msg


def format_file_decisions_injection(file_name, decisions):
    lines = []
    for i, d in enumerate(decisions[:3], 1):
        lines.append(f"  {i}. {d['decision'][:150]}")
    msg = (
        f"<system-reminder>\n"
        f"⚠️ {file_name} 关联 {len(decisions)} 条历史决策:\n"
        f"{chr(10).join(lines)}\n"
        f"写入前请确认不与上述决策冲突。\n"
        f"</system-reminder>"
    )
    return msg


def format_write_gate_deny_prompt(target_file):
    # 中文翻译：
    # ⛔ REMORA 安全限制 [全局写入门控]：未授权的写入被阻止！
    # ============================================================
    # !!! 讨论保护与反冲动门控已触发 !!!
    # 你正在尝试在未授权的讨论阶段或首次调用中修改核心代码文件 (目标: {target_file})。
    #
    # 如需继续，你必须：
    # 1. 解释意图：向用户说明你正在修改的核心代码文件及改动逻辑。
    # 2. 自适应重试：若此修改确有必要且用户已批准，你必须在当前回合立即再次调用此写工具以解锁释放。
    # ============================================================
    return (
        f"<system-reminder>\n"
        f"⛔ REMORA SAFETY LIMIT [GLOBAL-WRITE-GATE]: UNSANCTIONED WRITE BLOCKED!\n"
        f"============================================================\n"
        f"!!! DISCUSSION PROTECTION & ANTI-IMPULSIVE GATE TRIGGERED !!!\n"
        f"YOU ARE ATTEMPTING TO MODIFY A CORE CODE FILE (Target: {target_file}) IN AN UNSANCTIONED DISCUSSION PHASE OR ON THE FIRST CALL.\n\n"
        f"TO PROCEED, YOU MUST:\n"
        f"1. EXPLAIN INTENT: EXPLAIN TO THE USER THE LOGIC AND PURPOSE OF MODIFYING THIS CORE FILE.\n"
        f"2. ADAPTIVE RETRY: IF THIS EDIT IS INDEED SANCTIONED AND CONFIRMED, RE-EXECUTE THE WRITE TOOL IMMEDIATELY IN THE CURRENT TURN TO UNLOCK AND RELEASE.\n"
        f"============================================================\n"
        f"</system-reminder>"
    )


def format_phantom_first_warning(phantom_files, write_tool_examples=None):
    # 中文翻译：
    # ⛔ [安全限制 - 动作拦截] 信任但验证 - 你的总结描述了你意图做的事情，但不一定是实际所做的事情。
    # 我们检测到你声称编辑或写入了文件 ({', '.join(phantom_modifications)})，但未检测到任何物理修改或 git 状态差异。
    # 要继续执行，你必须遵循以下步骤：
    # 1. 验证工具执行：确保你实际调用了文件编辑工具（write_tool_examples 参数指定具体工具名），而不仅仅是输出声称完成的文本。
    # 2. 检查差异：检查实际文件或运行 `git status` 以验证工具调用是否成功。
    # 3. 物理重试：使用正确的参数重新调用正确的工具，以确保物理文件得到更新。
    if write_tool_examples:
        tool_line = f"1. VERIFY TOOL EXECUTION: Ensure you actually invoked file editing tools (e.g., {', '.join(write_tool_examples)}) instead of just outputting text claiming completion.\n"
    else:
        tool_line = "1. VERIFY TOOL EXECUTION: Ensure you actually invoked file editing tools instead of just outputting text claiming completion.\n"
    warning_msg = (
        "⛔ REMORA SAFETY LIMIT [ACTION-GATING]: Trust but verify - your summary describes what you intended to do, not necessarily what you did.\n"
        f"We detected that you claimed to edit or write to files ({', '.join(phantom_files)}), but no physical modifications or git status differences were detected.\n"
        "To proceed, you MUST follow these steps:\n"
        + tool_line +
        "2. CHECK DIFF: Inspect the actual file or run `git status` to verify if the tool call succeeded.\n"
        "3. RETRY PHYSICALLY: Re-invoke the correct tool with the correct arguments to ensure the physical file is updated."
    )
    return warning_msg


def format_phantom_repeat_warning(phantom_files):
    # 中文翻译：
    # 底层检测模块发现了异常（物理文件未被修改），但模型自身可能能力不够，无法意识到是否真实修改。你必须在你的回答开头以中文输出：“底层检测模块发现了异常（物理文件未被修改），但模型自身可能能力不够，无法意识到是否真实修改。”
    warning_prompt = (
        "Underlying detection module discovered abnormal states (physical files were not modified), "
        "but the model itself may lack capability to realize whether it actually modified them. "
        "You MUST prepend your response in Chinese with: "
        "\"底层检测模块发现了异常（物理文件未被修改），但模型自身可能能力不够，无法意识到是否真实修改。\""
    )
    return warning_prompt


def format_strict_recall_reminder(recall_tool=None):
    if recall_tool:
        recall_ref = recall_tool
    else:
        recall_ref = "the recall tool"
    msg = (
        "<system-reminder>\n"
        f"📓 Before finalizing a new decision, cross-check with {recall_ref}. If a past decision conflicts with your current plan, discuss with the user before proceeding.\n"
        "</system-reminder>"
    )
    return msg


def format_strict_tone_prompt():
    # 中文翻译：
    # 1. 无运行注释：不要叙述你的内部审议或解释你的思考过程。先交付结果和结论。
    # 2. 零奉承：绝不使用夸张、道歉或情感铺垫。
    # 3. 极简注释：在代码编辑中，除非显式要求，否则不要写任何注释或文档字符串。
    # 4. 事实错误报告：如果你犯了错误，事实且简明地承认它（例如，“修正了第25行的变量引用”）。不要重复道歉。
    return (
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


def make_deny_reason(prefix, message, action_tip=""):
    # 中文翻译：[安全拦截] 统一格式化 Remora 安全拦截 of 返回原因
    # 英文对照：⛔ REMORA SAFETY INTERCEPT [{prefix}]: {message}\nACTION REQUIRED: {action_tip}
    reason = f"⛔ REMORA SAFETY INTERCEPT [{prefix}]: {message}"
    if action_tip:
        reason += f"\nACTION REQUIRED: {action_tip}"
    return reason
