#!/usr/bin/env python3
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from lib.context import hook_entrypoint
from lib.paths import get_db_path
from lib.session import write_mode
from lib.stats import cleanup, get_stats

import json, re, subprocess

DB_PATH = get_db_path()

def _get_project_uuid_and_confidence(conv_id):
    project_uuid = None
    confidence = 1.0
    try:
        if os.path.exists(DB_PATH):
            import sqlite3
            with sqlite3.connect(DB_PATH) as conn:
                # 从水位线表获取项目映射
                r = conn.execute("SELECT project_uuid FROM watermarks WHERE conversation_id = ? LIMIT 1", (conv_id,)).fetchone()
                if r:
                    project_uuid = r[0]
                    # 查询最近更新话题的置信度 (ORDER BY updated_at DESC)
                    r_c = conn.execute("SELECT compression_confidence FROM project_topics WHERE uuid = ? ORDER BY updated_at DESC LIMIT 1", (project_uuid,)).fetchone()
                    if r_c and r_c[0] is not None:
                        confidence = r_c[0]
    except:
        pass
    return project_uuid, confidence

try:
    import remora_init
except ImportError:
    sys.path.insert(0, os.path.dirname(__file__))
    import remora_init

@hook_entrypoint(fallback_result={"injectSteps": [{"ephemeralMessage": "<system-reminder>⚠️ Remora Intent Detector 发生异常。拦截防线已降级，但不影响正常对话。</system-reminder>"}]})
def main(context):
    # 0. 环境自愈
    initialized = remora_init.init_environment()
    
    # 物理缓存 LS API 凭据以解决子代理在 Hook 沙盒中缺乏鉴权环境变量的问题
    ls_addr = os.environ.get("ANTIGRAVITY_LS_ADDRESS")
    csrf_token = os.environ.get("ANTIGRAVITY_CSRF_TOKEN")
    if ls_addr and csrf_token:
        try:
            with open("/tmp/remora_agent_env.json", "w", encoding="utf-8") as ef:
                json.dump({"ANTIGRAVITY_LS_ADDRESS": ls_addr, "ANTIGRAVITY_CSRF_TOKEN": csrf_token}, ef)
        except:
            pass
            
    # 动态读取 transcript.jsonl 获取最后一条用户指令
    last_msg = ""
    transcript_path = context.get('transcriptPath')
    heartbeat_lines = []
    if transcript_path and os.path.exists(transcript_path):
        try:
            output = subprocess.check_output(["tail", "-n", "300", transcript_path], stderr=subprocess.STDOUT)
            heartbeat_lines = [line.strip() for line in output.decode('utf-8').strip().split('\n') if line.strip()]
        except Exception:
            pass
        # [重构] 新实现：直接调用系统原生的 tail 截取末尾数据。
        # 优势：耗时稳定控制在个位数毫秒级，不随 file 体量增大而发生 I/O 与内存劣化，且不依赖对底层 payload 结构的猜测。
        try:
            output = subprocess.check_output(['tail', '-n', '50', transcript_path], stderr=subprocess.STDOUT)
            lines = output.decode('utf-8').strip().split('\n')
            
            # 检测是否为新回合启动 (最后一条有效实体必须是 USER_INPUT)
            is_new_turn = False
            for line in reversed(lines):
                if not line.strip(): continue
                try:
                    step = json.loads(line)
                    # 剥除系统静默消息，定位真实交互 Step
                    step_type = step.get('type')
                    if step_type in ['EPHEMERAL_MESSAGE', 'SYSTEM_MESSAGE', 'ERROR_MESSAGE']:
                        continue
                    
                    if step_type == 'USER_INPUT':
                        is_new_turn = True
                        last_msg = step.get('content', '')
                    break
                except Exception:
                    continue
        except Exception:
            pass
    
    # 动态读取 keywords.json 获取触发词
    keywords_config_path = os.path.join(os.path.dirname(__file__), 'keywords.json')
    hard_kws = []
    soft_kws = []
    try:
        with open(keywords_config_path, 'r') as f:
            config = json.load(f)
            hard_kws = config.get("hard_keywords", [])
            soft_kws = config.get("soft_keywords", [])
    except:
        pass
        
    # 提取当前会话 ID
    conv_id = "default"
    if transcript_path:
        match = re.search(r'/brain/([^/]+)/', transcript_path)
        if match:
            conv_id = match.group(1)
            # 写入主干会话 ID 以便 safety-check.py 兜底识别子代理，防止因 agentapi 超时引发死锁
            try:
                with open("/tmp/remora_main_conv_id.txt", "w") as mf:
                    mf.write(conv_id)
            except:
                pass
        
    inject_steps = []
    
    # ==========================================
    # 设计原理六：子代理创建的即时捕获与心跳断链续期状态机逻辑
    # ==========================================
    # 由于平台的 One-shot 计时器会在子代理发送 any 中间进度同步消息时自动静默取消，
    # 我们直接在 PreInvocation 阶段从 transcript.jsonl 中分析最新 UUID，并计算
    # 子代理最近活动与最近一次 schedule 定时器的相对时序。若已被取消且模型未续期，
    # 在上下文最前沿通过 injectSteps 注入强强制心跳指示。
    subagent_uuid = None
    seen_subagent = False
    has_schedule_after = False
    latest_subagent_activity_index = -1
    latest_schedule_index = -1
    subagent_finish_detected = False
    
    if transcript_path and os.path.exists(transcript_path):
        try:
            # Pass 1：提取最新的 subagent_uuid 以及 schedule 挂载状态
            for idx, line in enumerate(reversed(heartbeat_lines)):
                if not line.strip(): continue
                step = json.loads(line)
                step_type = step.get('type')
                step_str = json.dumps(step)
                
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
                for idx, line in enumerate(reversed(heartbeat_lines)):
                    if not line.strip(): continue
                    step = json.loads(line)
                    step_type = step.get('type')
                    step_str = json.dumps(step)
                    
                    # 彻底放宽拦截类型捕获各种格式的消息体，但严格排除系统自身的大型历史汇总记录（防止几百回合前的 UUID 印在当前最新行引发假活跃）
                    if step_type not in ["CONVERSATION_HISTORY", "CHECKPOINT"]:
                        # 精确匹配本子代理的活跃，且排除主会话自己物理命令/文件读写/子特工状态查询所产生的带有 UUID 的输出干扰
                        if subagent_uuid in step_str and not any(cmd in step_str for cmd in ["run_command", "view_file", "grep_search", "manage_subagents"]):
                            latest_subagent_activity_index = idx
                            break
                            
            # 正常退出自动物理清除重试计数缓存 (澄清：由于大模型调用 subagent-monitor 时强制传入 of {conv_id} 就是主会话 ID，因此 monitor 内部写入的 parent_conv_id 与此处拦截脚本读取 of conv_id 在物理上是完全同一键值，清理路径严格对齐，无歧义)
            if subagent_finish_detected:
                try:
                    retry_file = f"/tmp/remora_subagent_retries/{conv_id}.json"
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
        inject_steps.append({
            "ephemeralMessage": (
                "<system-reminder>\n"
                f"Subagent {subagent_uuid} is currently running WITHOUT a heartbeat timer. Call schedule NOW. "
                f"schedule(DurationSeconds=\"60\", Prompt=\"60s timeout for subagent {subagent_uuid}. Run: python3 ~/.gemini/config/plugins/remora-plugin/scripts/subagent-monitor.py {subagent_uuid} {conv_id}\")\n"
                "</system-reminder>"
            )
        })

    # 幽灵报喜（只在刚完成初始化的那一回合生效）
    if initialized:
        inject_steps.append({
            "ephemeralMessage": "<system-reminder>Remora 核心环境已自动初始化完成（Sidecar 将于 10 分钟内首次扫描）。防御系统在线，无需向用户报告此消息，请保持自然对话流。</system-reminder>"
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
        
    # 本地缓存落盘写入分发
    try:
        write_mode(conv_id, mode)
    except:
        pass

    # 分级匹配触发
    triggered = False
    if hard_kws and re.search(r'(' + '|'.join(hard_kws) + r')', clean_msg, re.IGNORECASE):
        triggered = True
    elif mode == "strict" and soft_kws and re.search(r'(' + '|'.join(soft_kws) + r')', clean_msg, re.IGNORECASE):
        triggered = True

    if triggered:
        project_uuid, confidence = _get_project_uuid_and_confidence(conv_id)
        confidence_warning = ""
        if confidence < 0.7:
            # 中文翻译：[置信度警告] 最近一次记忆压缩置信度较低，部分决策可能已被丢弃，请小心使用 recall 检索核对！
            confidence_warning = f"\n⚠️ [RECALL CONFIDENCE WARNING] 最近一次记忆压缩置信度较低 ({confidence:.2f})，部分决策可能已被丢弃，请使用 recall 检索温存储核对！"

        script_path = os.path.join(os.path.dirname(__file__), "remora-recall.py")
        # 中文翻译：🚨 记忆防御触发：不要猜测。执行 `python3 {script_path} "YOUR_KEYWORD"` 从温存储中检索事实。
        inject_steps.append({
            "ephemeralMessage": f"<system-reminder>{confidence_warning}\n🚨 MEMORY DEFENSE TRIGGERED: STOP GUESSING. Execute `python3 {script_path} \"YOUR_KEYWORD\"` to retrieve facts from warm storage.\n</system-reminder>"
        })

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
