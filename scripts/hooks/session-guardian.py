#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lib.context import hook_entrypoint
from lib.stats import cleanup, get_stats

import json, re, subprocess
from lib.subagent import get_subagent_type

@hook_entrypoint(fallback_result={"injectSteps": [{"ephemeralMessage": "<system-reminder>⚠️ Remora Session Guardian 发生异常。状态同步防线已降级，但不影响正常对话。</system-reminder>"}]})
def main(context):
    # 0. Fail-Fast 探测环境是否已被 install.py 初始化
    scripts_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if scripts_dir not in sys.path:
        sys.path.insert(0, scripts_dir)
    from lib.paths import get_data_dir
    initialized_file = os.path.join(get_data_dir(), ".runtime", "installed.flag")
    if not os.path.exists(initialized_file):
        return {"injectSteps": [{"ephemeralMessage": "🚨 **[REMORA FATAL ERROR]** Plugin uninitialized! Please run `python3 install.py` in the plugin root."}]}
    
    # 物理缓存 LS API 凭据以解决子代理在 Hook 沙盒中缺乏鉴权环境变量的问题
    ls_addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    csrf_token = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
    if ls_addr and csrf_token:
        try:
            with open(os.path.join(get_data_dir(), ".runtime", "remora_agent_env.json"), "w", encoding="utf-8") as ef:
                json.dump({"ANTIGRAVITY_LS_ADDRESS": ls_addr, "ANTIGRAVITY_CSRF_TOKEN": csrf_token}, ef)
        except:
            pass
            
    transcript_path = context.get('transcriptPath')
    
    # 提取当前会话 ID
    conv_id = "default"
    if transcript_path:
        match = re.search(r'/brain/([^/]+)/', transcript_path)
        if match:
            conv_id = match.group(1)
            try:
                sub_type = get_subagent_type(transcript_path)
                main_id_file = os.path.join(get_data_dir(), ".runtime", "remora_main_conv_id.txt")
                should_write = False
                if sub_type is None:
                    # 只有在主会话（或无 sub_type）时才考虑写入
                    if os.environ.get("ANTIGRAVITY_LS_ADDRESS") or not os.path.exists(main_id_file):
                        should_write = True
                
                if should_write:
                    with open(main_id_file, "w") as mf:
                        mf.write(conv_id)
            except:
                pass
                
    from lib.conversation import ConversationDataAccessLayer
    cdal = ConversationDataAccessLayer(conv_id)
    
    # 动态读取 SQLite 获取最后一条用户指令
    last_msg = ""
    heartbeat_steps = []
    is_new_turn = False
    
    try:
        # 使用 CDAL 的原生 SQLite 倒序查询接口，安全获取最后 300 步
        heartbeat_steps = list(cdal.stream_steps_reverse(limit=300))
        
        # 提取 last_msg 和 is_new_turn
        # heartbeat_steps 已经是逆序的 (从新到旧)
        for step in heartbeat_steps[:50]:
            step_type = step.get('type')
            if step_type in ['EPHEMERAL_MESSAGE', 'SYSTEM_MESSAGE', 'ERROR_MESSAGE']:
                continue
            if step_type == 'USER_INPUT':
                is_new_turn = True
                last_msg = step.get('content', '')
            break
    except Exception:
        pass
    
    # 动态读取 keywords.json 获取触发词
    keywords_config_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'rules', 'keywords.json')
    hard_kws = []
    soft_kws = []
    try:
        with open(keywords_config_path, 'r') as f:
            config = json.load(f)
            hard_kws = config.get("hard_keywords", [])
            soft_kws = config.get("soft_keywords", [])
    except:
        pass
        

        
    inject_steps = []
    
    # ==========================================
    # 设计原理六：子代理创建的即时捕获与心跳断链续期状态机逻辑 (已优化无心跳提示语)
    # ==========================================
    # 由于平台的 One-shot 计时器会在子代理发送 any 中间进度同步消息时自动静默取消，
    # 我们直接在 PreInvocation 阶段从 CDAL 原生层中分析最新 UUID，并计算
    # 子代理最近活动与最近一次 schedule 定时器的相对时序。若已被取消且模型未续期，
    # 在上下文最前沿通过 injectSteps 注入强强制心跳指示。
    # 优化点：当无心跳定时器运行时，注入的消息及中文翻译使用角色名称 role_name 替代 uuid，
    # 并强制引导大模型使用拟人化的“进度+时间”汇报进度（如 subagent (role_name)），杜绝暴露底层安全定时器技术术语。
    subagent_uuid = None
    seen_subagent = False
    has_schedule_after = False
    latest_subagent_activity_index = -1
    latest_schedule_index = -1
    subagent_finish_detected = False
    
    if heartbeat_steps:
        try:
            # Pass 1：提取最新的 subagent_uuid 以及 schedule 挂载状态
            # 注意：heartbeat_steps 本来就是逆序的，所以直接遍历即可
            for idx, step in enumerate(heartbeat_steps):
                step_type = step.get('type')
                step_str = json.dumps(step, ensure_ascii=False)
                
                # 记录最新的 schedule 挂载，及 schedule 挂载判定（无论时序，只要同一轮且提及了 monitor 探活即可）
                # 从主干的 schedule 参数里直接正则提取最新拉起的子代理 UUID，从根源杜绝文本投毒及类型缺失的问题
                if step_type == 'PLANNER_RESPONSE' and step.get('tool_calls'):
                    for tc in step.get('tool_calls', []):
                        if tc.get('name') == 'schedule':
                            args_str = json.dumps(tc.get('args', tc.get('arguments', {})))
                            if latest_schedule_index == -1:
                                latest_schedule_index = idx
                                if "subagent-monitor.py" in args_str:
                                    has_schedule_after = True
                                else:
                                    has_schedule_after = False
                            
                            if not subagent_uuid and "subagent-monitor.py" in args_str:
                                cid_matches = re.findall(r'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', args_str, re.I)
                                for uid in cid_matches:
                                    if uid != conv_id and uid != "11111111-1111-1111-1111-111111111111":
                                        subagent_uuid = uid
                                        seen_subagent = True
                                        break
                            break
                
                # 判断子代理是否已被主动清理完成 (时序边界：模型发起清理，或物理回执明确包含 Successfully killed)
                # 注意：必须严格限定为 GENERIC 回执或 manage_subagents 调用，杜绝大模型在 thinking 字段 of 文本讨论触发假阳性
                if not seen_subagent:
                    is_kill_command = False
                    if step_type == 'PLANNER_RESPONSE' and step.get('tool_calls'):
                        for tc in step.get('tool_calls', []):
                            if tc.get('name') == 'manage_subagents':
                                args = tc.get('args', tc.get('arguments', {}))
                                if str(args.get('Action', '')).strip('"') in ['kill', 'kill_all']:
                                    is_kill_command = True
                                    break
                    is_system_confirm = step_type == 'GENERIC' and step.get('content') and isinstance(step['content'], str) and ('Successfully killed' in step['content'] or 'Terminated subagent' in step['content'])
                    if is_kill_command or is_system_confirm:
                        subagent_finish_detected = True
                        
            # Pass 2：在 subagent_uuid 提取成功后，以该特定 ID 进行精准活跃检测，排除其它 UUID 及主干物理工具调用输出 of 噪声干扰
            if subagent_uuid and not subagent_finish_detected:
                for idx, step in enumerate(heartbeat_steps):
                    step_type = step.get('type')
                    step_str = json.dumps(step, ensure_ascii=False)
                    
                    # 彻底放宽拦截类型捕获各种格式的消息体，但严格排除系统自身的大型历史汇总记录
                    if step_type not in ["CONVERSATION_HISTORY", "CHECKPOINT"]:
                        # 精确匹配本子代理的活跃，且排除主会话自己物理命令/文件读写/subagent状态查询所产生的带有 UUID 的输出干扰
                        if subagent_uuid in step_str and not any(cmd in step_str for cmd in ["run_command", "view_file", "grep_search", "manage_subagents", "schedule"]):
                            latest_subagent_activity_index = idx
                            break
                            
            # 正常退出自动物理清除重试计数缓存
            if subagent_finish_detected:
                try:
                    retry_file = os.path.join(get_data_dir(), ".runtime", f"remora_subagent_retries_{conv_id}.json")
                    if os.path.exists(retry_file):
                        os.remove(retry_file)
                except:
                    pass
        except Exception:
            pass

    # 逆序索引越小时间越近。若子代理活动比最新的定时器更近，代表 timer 已经被该中间消息自动静默取消了
    is_timer_canceled = (latest_subagent_activity_index != -1 and 
                         (latest_schedule_index == -1 or latest_subagent_activity_index < latest_schedule_index))
                         
    if subagent_uuid and not subagent_finish_detected and (not has_schedule_after or is_timer_canceled):
        from lib.paths import find_plugin_root
        plugin_root = find_plugin_root()
        python_bin = sys.executable or "/usr/bin/python3"
        
        # 提取子会话的角色名称 (优先通过 agentapi，其次通过历史记录)
        role_name = None
        try:
            from lib.paths import get_data_dir
            env = dict(os.environ)
            if os.path.exists(os.path.join(get_data_dir(), ".runtime", "remora_agent_env.json")):
                try:
                    with open(os.path.join(get_data_dir(), ".runtime", "remora_agent_env.json"), "r", encoding="utf-8") as ef:
                        cached_env = json.load(ef)
                        env.update(cached_env)
                except:
                    pass
            cmd = ["/home/agent/.gemini/antigravity/bin/agentapi", "get-conversation-metadata", subagent_uuid]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=5, env=env)
            if res.returncode == 0:
                data = json.loads(res.stdout)
                metadata = data.get("response", {}).get("conversationMetadata", {}).get("metadata", {})
                role_name = metadata.get("subagentSpec", {}).get("typeName")
        except Exception:
            pass

        if not role_name and heartbeat_steps:
            try:
                for step in heartbeat_steps:
                    if step.get('type') == 'PLANNER_RESPONSE' and step.get('tool_calls'):
                        for tc in step.get('tool_calls', []):
                            if tc.get('name') == 'invoke_subagent':
                                args_sub = tc.get('args', tc.get('arguments', {}))
                                subagents = args_sub.get('Subagents', [])
                                if subagents:
                                    for s in subagents:
                                        if s.get('TypeName'):
                                            role_name = s.get('TypeName')
                                            break
                                elif args_sub.get('TypeName'):
                                    role_name = args_sub.get('TypeName')
                                if role_name:
                                    break
                    if role_name:
                        break
            except Exception:
                pass
                
        if not role_name:
            role_name = subagent_uuid
            
        # 中文翻译：⚠️ [系统警告] subagent ({role_name}) 当前在无心跳定时器状态下运行。请立即调用 schedule 设置 60s 心跳定时器。
        # 在回复中必须使用拟人化的“进度+时间”结构汇报，禁止透露“挂载定时器”。
        inject_steps.append({
            "ephemeralMessage": (
                "<system-reminder>\n"
                f"Subagent ({role_name}) is currently running WITHOUT a heartbeat timer. Call schedule NOW.\n"
                f"schedule(DurationSeconds=\"60\", Prompt=\"60s timeout for subagent {subagent_uuid}. Run: {python_bin} {plugin_root}/scripts/subagent-monitor.py {subagent_uuid} {conv_id}\")\n"
                f"When replying, report the progress of `subagent ({role_name})` in a natural tone and state that you will wait for 60 seconds before checking again. DO NOT mention mounting safety timers or schedule configs.\n"
                "</system-reminder>"
            )
        })



    # ##########################################################
    # AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
    # ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
    #   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
    #   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
    #   禁止在不更新设计注释与提示词翻译的情况下直接覆写 logic！
    # ##########################################################

    # ==========================================
    # 设计原理四：系统提示清洗，阻断意图自反馈死循环
    # ==========================================
    # 即使系统在上一回合注入了包含 remora 关键词的提醒，大模型的 transcript 依然会包含 these 系统提醒。
    # 如果不加清洗地进行正则检测，会导致每回合均误命中而持续注入，从而陷入无限自触发状态。
    # 我们采用 re.sub(r'<system-reminder>.*?</system-reminder>', '', last_msg, flags=re.DOTALL)
    # 正则剥离所有系统提示内容，只保留用户的原生真实意图。

    # 意图探测逻辑
    # 剥离前置注入的系统提醒，防止其携带的关键字（例如提醒中包含的路径/remora/）引发无限自反馈死循环
    clean_msg = re.sub(r'<system-reminder>.*?</system-reminder>', '', last_msg, flags=re.DOTALL)

    # 模式检测自适应：若包含探讨发散性关键词（草稿、想法、设计、讨论、讨论下、建议），设定为 relax，否则 strict
    mode = "strict"
    relax_pattern = r'(草稿|想法|设计|讨论|讨论下|建议|draft|brainstorm|design|suggest|discuss)'
    if re.search(relax_pattern, clean_msg, re.IGNORECASE):
        mode = "relax"
    # 强拦截词强制覆写为 strict 确保高危防御不逃逸
    if hard_kws and re.search(r'(' + '|'.join(hard_kws) + r')', clean_msg, re.IGNORECASE):
        mode = "strict"
        
    # 跨进程状态机同步 (写入 SQLite session_state 同步表，支持多拦截器 IPC)
    # 首次插入 is_cold_start = 1，更新时保持原有 is_cold_start，将其消费职责留给 Phase 26
    from lib import dao
    dao.write_mode(conv_id, mode)

    # ==========================================
    # 设计原理五：View File 累加器与主干上下文防腐 (Anti-Context-Rot) 软阻断
    # ==========================================
    try:
        # 新回合强制初始化与清零 (无需检查是否存在，保障状态干净)
        if is_new_turn:
            cleanup(conv_id)
        
        # 二级认知摩擦：检查是否软超标
        stats = get_stats(conv_id)
        src_kb = stats.get("accumulated_source_bytes", 0) // 1024
        data_kb = stats.get("accumulated_data_bytes", 0) // 1024
        if src_kb > 150 or data_kb > 50:
            # 中文翻译：⚠️ [系统警告] 本回合累计读取已达软水位线。主干上下文窗口开始膨胀。若需执行大范围代码审阅，请委派 Remora_ReadOnly_Extractor 子代理提取结构化结论，以免冲淡自身核心注意力。重要提示：调用子代理时，必须同时使用 schedule 工具创建 30s 定时监控（When invoking subagent, MUST also call schedule tool with DurationSeconds=30.）。
            inject_steps.append({
                "ephemeralMessage": f"<system-reminder>⚠️ SYSTEM WARNING: CUMULATIVE READ REACHED SOFT LIMIT (SOURCE: {src_kb}KB, DATA: {data_kb}KB). MAIN CONTEXT WINDOW IS INFLATING. IF EXTENSIVE CODE REVIEW IS REQUIRED, DELEGATE TO 'Remora_ReadOnly_Extractor' SUBAGENT TO EXTRACT STRUCTURED SUMMARIES AND PREVENT ATTENTION DILUTION. When invoking subagent, MUST also call schedule tool with DurationSeconds=30.</system-reminder>"
            })
    except Exception as e:
        pass
        
    return {"injectSteps": inject_steps}

if __name__ == "__main__":
    main()
