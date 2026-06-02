#!/usr/bin/env python3
import sys, json, re, os
try:
    import remora_init
except ImportError:
    sys.path.insert(0, os.path.dirname(__file__))
    import remora_init

def main():
    # 0. 环境自愈
    initialized = remora_init.init_environment()
    
    context = json.load(sys.stdin)
    
    # 动态读取 transcript.jsonl 获取最后一条用户指令
    last_msg = ""
    transcript_path = context.get('transcriptPath')
    if transcript_path and os.path.exists(transcript_path):
        # [废弃] 原始实现：使用 f.readlines() 加载整个文件。
        # [废弃原因]：随着长周期对话的进行，transcript.jsonl 达到数十 MB 时，readlines() 会将文件全量加载到内存中，
        #           每次对话前都会导致极高的内存突增与 1-3 秒的 CPU IO 阻塞，造成严重的交互延迟灾难。由于该脚本在
        #           PreInvocation 钩子中执行，此延迟是不可接受的。
        # with open(transcript_path, 'r', encoding='utf-8') as f:
        #     lines = f.readlines()
        #     for line in reversed(lines):
        #         try:
        #             step = json.loads(line)
        #             if step.get('type') == 'USER_INPUT':
        #                 last_msg = step.get('content', '')
        #                 break
        #         except:
        #             pass
        
        # [重构] 新实现：直接调用系统原生的 tail 截取末尾数据。
        # 优势：耗时稳定控制在个位数毫秒级，不随文件体量增大而发生 I/O 与内存劣化，且不依赖对底层 payload 结构的猜测。
        try:
            import subprocess
            output = subprocess.check_output(['tail', '-n', '50', transcript_path], stderr=subprocess.STDOUT)
            lines = output.decode('utf-8').strip().split('\n')
            for line in reversed(lines):
                if not line.strip(): continue
                try:
                    step = json.loads(line)
                    if step.get('type') == 'USER_INPUT':
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
        
    inject_steps = []
    
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
    #   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
    # ##########################################################

    # ==========================================
    # 设计原理四：系统提示清洗，阻断意图自反馈死循环
    # ==========================================
    # 即使系统在上一回合注入了包含 remora 关键词的提醒，大模型的 transcript 依然会包含这些系统提醒。
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
        os.makedirs("/tmp/remora_session_modes", exist_ok=True)
        cache_file = f"/tmp/remora_session_modes/{conv_id}.json"
        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump({"mode": mode}, f)
    except:
        pass

    # 分级匹配触发
    triggered = False
    if hard_kws and re.search(r'(' + '|'.join(hard_kws) + r')', clean_msg, re.IGNORECASE):
        triggered = True
    elif mode == "strict" and soft_kws and re.search(r'(' + '|'.join(soft_kws) + r')', clean_msg, re.IGNORECASE):
        triggered = True

    if triggered:
        script_path = os.path.join(os.path.dirname(__file__), "remora-recall.sh")
        # 中文翻译：🚨 记忆防御触发：不要猜测。执行 `bash {script_path} "YOUR_KEYWORD"` 从温存储中检索事实。
        inject_steps.append({
            "ephemeralMessage": f"<system-reminder>\n🚨 MEMORY DEFENSE TRIGGERED: STOP GUESSING. Execute `bash {script_path} \"YOUR_KEYWORD\"` to retrieve facts from warm storage.\n</system-reminder>"
        })
        
    print(json.dumps({"injectSteps": inject_steps}))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # 终极防线：无论出什么异常，绝对不阻塞 Antigravity 的对话通道
        print(json.dumps({
            "injectSteps": [{
                "ephemeralMessage": f"<system-reminder>⚠️ Remora Intent Detector 发生异常: {str(e)}。拦截防线已降级，但不影响正常对话。</system-reminder>"
            }]
        }))
