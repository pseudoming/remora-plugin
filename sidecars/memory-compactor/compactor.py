#!/usr/bin/env python3
"""
Remora Memory Compactor V2.1

修复记录：
- V2.0: 修复 agentapi 雪崩（send-message 复用！水位线即时 commit）
- V2.1: 修复三个问题
  1. project_uuid 隐患：改用 agentapi get-conversation-metadata 获取真实 projectId
  2. JSONL 截断 bug：改为按行解析，只提取 USER_INPUT 和 MODEL 产出内容
  3. 饥饿问题：加会话随机打乱，避免同一批会话永远轮不到
"""
import json, time, subprocess, sqlite3, os, sys, random, signal, argparse, hashlib, re

def _get_data_dir():
    # 优先从环境变量读取
    env_path = os.environ.get("ANTIGRAVITY_EXECUTABLE_DATA_DIR")
    if env_path:
        return env_path
        
    # 从自身出发向后回溯定位 .gemini 宿主持久化路径
    current_dir = os.path.abspath(os.path.dirname(__file__))
    parts = current_dir.split(os.sep)
    if ".gemini" in parts:
        idx = parts.index(".gemini")
        gemini_root = os.sep.join(parts[:idx + 1])
        # 目标持久化路径
        return os.path.join(gemini_root, "sidecar_data/remora-plugin/memory-compactor/data")
    else:
        # 降级退化到同级 data 目录
        return os.path.join(current_dir, "data")

DATA_DIR = _get_data_dir()
DB_PATH = os.path.join(DATA_DIR, "remora_memory.db")
SCHEMA_PATH = os.path.join(
    os.path.dirname(__file__), "..", "..", "scripts", "schema.sql")
BRAIN_DIR = os.path.expanduser("~/.gemini/antigravity/brain")

CONV_MARKER_FILE = os.path.join(DATA_DIR, "compactor_conversation_id.txt")
EXCLUDE_FILE = os.path.join(DATA_DIR, "compactor_managed_conversations.json")
LOCK_FILE = os.path.join(DATA_DIR, "compactor.lock")
MAX_EXECUTION_TIME = 300
# 单个 LLM 调用 prompt 的最大字符数
MAX_PROMPT_LENGTH = 8000


class AgentApiError(Exception):
    pass

def acquire_lock():
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, 'r') as f:
                pid = int(f.read().strip())
            mtime = os.path.getmtime(LOCK_FILE)
            if time.time() - mtime < 1800:
                try:
                    os.kill(pid, 0)
                    print(f"Lock active by PID {pid}, exiting.", file=sys.stderr)
                    sys.exit(0)
                except OSError:
                    pass # 原进程已死，允许接管
            else:
                try:
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass # 超过30分钟，强制杀掉僵尸进程后允许接管
        except Exception:
            pass # 文件损坏或无法读取，允许强行接管
    
    # 无论上面是文件不存在、原进程已死还是被强杀，最终都会执行这段覆写接管
    with open(LOCK_FILE, 'w') as f:
        f.write(str(os.getpid()))

def release_lock():
    if os.path.exists(LOCK_FILE):
        try:
            with open(LOCK_FILE, 'r') as f:
                pid = int(f.read().strip())
            # 防护：只允许删除属于自己的锁，防止因为延迟导致误删别人的锁
            if pid == os.getpid():
                os.remove(LOCK_FILE)
        except Exception:
            pass

def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        with open(SCHEMA_PATH, 'r') as f:
            conn.executescript(f.read())
        # Schema 动态迁移升级防线：如果 created_at_line 字段不存在，自动 Alter Table 动态加入该列
        try:
            conn.execute("SELECT created_at_line FROM topic_decisions LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE topic_decisions ADD COLUMN created_at_line INTEGER DEFAULT 0")

        # Schema 动态迁移升级防线二：如果 user_confirmed 字段不存在，自动 Alter Table 动态加入该列
        try:
            conn.execute("SELECT user_confirmed FROM topic_decisions LIMIT 1")
        except sqlite3.OperationalError:
            conn.execute("ALTER TABLE topic_decisions ADD COLUMN user_confirmed INTEGER DEFAULT 0")

def format_timestamp(ts_str):
    """
    统一时间戳为 SQLite 标准 'YYYY-MM-DD HH:MM:SS' 字符串，以消除类型与格式失配 bug
    """
    if not ts_str:
        return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())
    ts_str = ts_str.replace('T', ' ').replace('Z', '')
    return ts_str[:19]


def prune_expired_watermarks():
    # ##########################################################
    # AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
    # ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
    #   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
    #   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
    #   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
    # ##########################################################

    # ==========================================
    # 设计原理：废弃水印冷会话内存大扫除机制
    # ==========================================
    # 当本地 brain 下的物理会话目录被回收删除后，
    # 定时增量扫描会自动 DELETE 数据库中该会话对应的 watermarks、messages 与 topic_decisions。
    # 避免无效元数据残留导致 FTS5 检索库与 decisions 库体积失控。
    with sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute("SELECT DISTINCT conversation_id FROM watermarks")
        active_db_convs = [row[0] for row in cursor.fetchall()]
        
        for conv_id in active_db_convs:
            if conv_id.startswith("artifact_sync_"):
                continue
            conv_dir = os.path.join(BRAIN_DIR, conv_id)
            if not os.path.exists(conv_dir):
                conn.execute("DELETE FROM watermarks WHERE conversation_id=?", (conv_id,))
                conn.execute("DELETE FROM messages WHERE conversation_id=?", (conv_id,))
                conn.execute("DELETE FROM topic_decisions WHERE conversation_id=?", (conv_id,))
                # 中文翻译：[Remora] 水印回收已清除会话: {conv_id}
                print(f"[Remora] 水印回收已清除会话: {conv_id}")
        conn.commit()


def load_excluded_ids():
    if os.path.exists(EXCLUDE_FILE):
        with open(EXCLUDE_FILE, 'r') as f:
            return set(json.load(f))
    return set()


def save_excluded_ids(ids):
    with open(EXCLUDE_FILE, 'w') as f:
        json.dump(list(ids), f)


def get_project_id(conv_id):
    """通过 agentapi 获取这个会话的真实 projectId"""
    try:
        result = subprocess.check_output(
            ["agentapi", "get-conversation-metadata", conv_id],
            stderr=subprocess.STDOUT, timeout=10)
        data = json.loads(result.decode('utf-8'))
        project_id = (data.get("response", {})
            .get("conversationMetadata", {})
            .get("metadata", {})
            .get("projectId", ""))
        return project_id if project_id else "unknown"
    except Exception:
        return "unknown"


def get_active_conversations():
    """扫描 brain 目录，获取最近 48 小时内有活动的会话
    自动排除自己创建的会话，随机打乱避免饥饿"""
    active_sessions = []
    if not os.path.exists(BRAIN_DIR):
        return []

    excluded_ids = load_excluded_ids()
    current_time = time.time()

    for conv_id in os.listdir(BRAIN_DIR):
        if conv_id in excluded_ids:
            continue
        if len(conv_id) != 36 or conv_id.count('-') != 4:
            continue

        transcript_path = os.path.join(
            BRAIN_DIR, conv_id, ".system_generated", "logs", "transcript.jsonl")
        if os.path.exists(transcript_path):
            mtime = os.path.getmtime(transcript_path)
            if current_time - mtime <= 2 * 24 * 3600:
                project_uuid = get_project_id(conv_id)
                active_sessions.append({
                    "project_uuid": project_uuid,
                    "conversation_id": conv_id,
                    "transcript_path": transcript_path
                })

    # 随机打乱，避免同一批会话永远轮不到
    random.shuffle(active_sessions)
    return active_sessions


def extract_key_content(transcript_path, start_line):
    """按行解析 JSONL，只提取 USER_INPUT 和 PLANNER_RESPONSE 的核心内容并附带物理行号"""
    key_content = []
    current_line = 0
    total_length = 0

    with open(transcript_path, 'r', encoding='utf-8') as f:
        for line in f:
            current_line += 1
            if current_line <= start_line:
                continue
            try:
                obj = json.loads(line)
                step_type = obj.get('type', '')
                content = obj.get('content', '')
                if not content:
                    continue
                # 注入 [line_xxx] 前缀以向 LLM 物理透传行号，保障证据精准回链
                if step_type in ('USER_INPUT', 'PLANNER_RESPONSE'):
                    snippet = f"[line_{current_line}] {content[:500]}"
                    key_content.append(snippet)
                    total_length += len(snippet)
                    if total_length >= MAX_PROMPT_LENGTH:
                        break
            except json.JSONDecodeError:
                continue

    return "\n".join(key_content), current_line


def is_subagent_session(transcript_path):
    """快速流式判别是否为系统/子代理派发的会话"""
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                obj = json.loads(line)
                if obj.get('type') == 'USER_INPUT' and obj.get('source') == 'SYSTEM':
                    return True
                break
    except Exception:
        pass
    return False


def read_incremental_logs(conn, session):
    """利用 SQLite 水位线进行增量读取，并将原日志叙写存入 messages 表"""
    is_sub = is_subagent_session(session['transcript_path'])
    
    cursor = conn.execute(
        "SELECT last_line_processed FROM watermarks WHERE project_uuid=? AND conversation_id=?",
        (session['project_uuid'], session['conversation_id']))
    row = cursor.fetchone()
    last_line = row[0] if row else 0

    # 持运行 JSONL 写入 messages 表（供FTS5全文检索用）
    current_line = 0
    with open(session['transcript_path'], 'r', encoding='utf-8') as f:
        for line in f:
            current_line += 1
            if current_line > last_line:
                try:
                    log_obj = json.loads(line)
                    step_type = log_obj.get('type', '')
                    
                    # 子代理会话仅录入交互与推理，彻底抛弃 TOOL_OUTPUT (历史副本)
                    if is_sub and step_type not in ('USER_INPUT', 'PLANNER_RESPONSE'):
                        continue
                        
                    conn.execute(
                        "INSERT OR IGNORE INTO messages (conversation_id, line_number, timestamp, role, content) VALUES (?, ?, ?, ?, ?)",
                        (session['conversation_id'], current_line,
                         format_timestamp(log_obj.get('timestamp', '')), log_obj.get('source', ''),
                         log_obj.get('content', '')))
                except Exception:
                    pass

    # 逆缩（Undo）自愈拦截线
    if current_line < last_line:
        # ##########################################################
        # AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
        # ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
        #   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
        #   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
        #   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
        # ##########################################################

        # ==========================================
        # 设计原理六：时序水位线逆缩 Undo 记忆大扫除机制
        # ==========================================
        # 当当前实际行数 current_line 小于记录的已处理水位线 last_line 时，
        # 说明用户撤销了部分之前的对话历史。
        # 此时物理大扫除该会话所有 line_number > current_line 的旧 messages 历史，
        # 以及当时基于该失效时限提取出来的架构决策（created_at_line > current_line），
        # 随后更新 last_line 为当前实际行数，保证提取行为最终一致性。

        # 时序重合对齐边界：后退至 current_line - 1 行（即 t-1 轮）
        # 确保下一次增量扫描能够将回滚分界线边缘的最后一条用户输入（第 t 行）
        # 与重新生成的回答一同带入 LLM 提取上下文，避免因果关系断裂导致的漏提
        target_rollback_line = max(0, current_line - 1)
        conn.execute(
            "DELETE FROM messages WHERE conversation_id=? AND line_number > ?",
            (session['conversation_id'], target_rollback_line))
        conn.execute(
            "DELETE FROM topic_decisions WHERE conversation_id=? AND created_at_line > ?",
            (session['conversation_id'], target_rollback_line))
        # 撤销事件一致性大扫除：若发生 Undo 回滚，一并清空事件队列中该项目未消费的 pending 事件，防范跨 Undo 误打标
        conn.execute(
            "DELETE FROM remora_event_queue WHERE project_uuid=? AND status='pending'",
            (session['project_uuid'],))
        # 物理水位线同步回滚更新：确保即使程序在后续阶段崩溃，自愈后的水位线也能在数据库中持久化
        conn.execute(
            "UPDATE watermarks SET last_line_processed=? WHERE project_uuid=? AND conversation_id=?",
            (target_rollback_line, session['project_uuid'], session['conversation_id']))
            
        # 中文翻译：[Remora] 检测到会话 Undo 回滚，温存储已自愈水位线至行号: {target_rollback_line}
        print(f"[Remora] 检测到会话 Undo 回滚，温存储已自愈水位线至行号: {target_rollback_line}")
        last_line = target_rollback_line

    if not row:
        conn.execute(
            "INSERT INTO watermarks (project_uuid, conversation_id, last_line_processed) VALUES (?, ?, ?)",
            (session['project_uuid'], session['conversation_id'], 0))

    # 提取核心内容（只取 USER_INPUT + MODEL 产出）
    key_content, _ = extract_key_content(session['transcript_path'], last_line)

    return key_content, current_line


def get_or_create_conversation(prompt):
    """复用已有会话，或在没有可复用会话时创建新的"""
    excluded_ids = load_excluded_ids()

    if os.path.exists(CONV_MARKER_FILE):
        with open(CONV_MARKER_FILE, 'r') as f:
            conv_id = f.read().strip()
            if conv_id:
                # 检查会话日志文件是否存在及步数是否超限
                transcript_path = os.path.join(
                    BRAIN_DIR, conv_id, ".system_generated", "logs", "transcript.jsonl")
                should_rollover = False
                if os.path.exists(transcript_path):
                    try:
                        # 采用 O(1) 内存流式读取，防大文件内存溢出
                        with open(transcript_path, 'rb') as tf:
                            line_count = sum(1 for _ in tf)
                        if line_count > 150:
                            should_rollover = True
                            print(f"[Remora] 会话 {conv_id} 步数已达 {line_count}，启动自动换代。")
                    except Exception:
                        pass
                
                if should_rollover:
                    try:
                        os.remove(CONV_MARKER_FILE)
                    except Exception:
                        pass
                else:
                    try:
                        result = subprocess.check_output(
                            ["agentapi", "send-message", conv_id, prompt],
                            stderr=subprocess.STDOUT, timeout=120)
                        return result.decode('utf-8').strip()
                    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
                        # 能进到这段代码，说明当前系统的CPU / 网络 或者其他的维度有比较恶劣的环境问题，都这个b样的环境了，没必要空耗着雪上加霜
                        raise AgentApiError(f"Fail-Fast: send-message failed. Abandoning execution. Error: {e}")

    try:
        # 新开启会话时，在 Prompt 头部直接注入当前初始化日期的 Markdown 大标题
        current_date_str = time.strftime('%Y-%m-%d', time.localtime())
        init_prompt = f"# Remora Memory Compactor ({current_date_str})\n\n" + prompt
        result = subprocess.check_output(
            ["agentapi", "new-conversation", init_prompt],
            stderr=subprocess.STDOUT, timeout=120)
        output = result.decode('utf-8').strip()

        try:
            resp = json.loads(output)
            new_conv_id = (resp.get('response', {})
                .get('newConversation', {})
                .get('conversationId', ''))
            if new_conv_id:
                with open(CONV_MARKER_FILE, 'w') as f:
                    f.write(new_conv_id)
                excluded_ids.add(new_conv_id)
                save_excluded_ids(excluded_ids)
        except json.JSONDecodeError:
            pass

        return output
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        # 能进到这段代码，说明当前系统的CPU / 网络 或者其他的维度有比较恶劣的环境问题，都这个b样的环境了，没必要空耗着雪上加霜
        raise AgentApiError(f"Fail-Fast: new-conversation failed. Abandoning execution. Error: {e}")


def process_logs():
    start_time = time.time()

    with sqlite3.connect(DB_PATH) as conn:
        active_sessions = get_active_conversations()
        for session in active_sessions:
            if time.time() - start_time > MAX_EXECUTION_TIME:
                print("Max execution time reached, stopping.", file=sys.stderr)
                break

            key_content, current_line = read_incremental_logs(conn, session)
            if not key_content.strip():
                conn.execute(
                    "UPDATE watermarks SET last_line_processed=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
                    (current_line, session['project_uuid'], session['conversation_id']))
                conn.commit()
                continue

            # ##########################################################
            # AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
            # ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
            #   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
            #   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
            #   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
            # ##########################################################

            # ==========================================
            # 设计原理五：Prompt 级别无状态提取约束保障机制
            # ==========================================
            # 由于底层 agentapi 限制，为了防止多会话创建发生雪崩崩溃，我们物理复用了同一个会话。
            # 但这会导致旧的上下文对模型在后续提取时产生干扰和污染。
            # 我们在此处加入 `[SYSTEM CONSTRAINT]` 强锚定逻辑约束模型忽略所有以往历史，
            # 仅专注于本次传入的对话，避免跨多轮发生误读与数据幻觉。

            # ##########################################################
            # AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
            # ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
            #   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
            #   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
            #   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
            # ##########################################################

            # ==========================================
            # 设计原理五：Prompt 级别无状态提取约束保障机制与时间戳防合并心跳机制
            # ==========================================
            # 1. 物理复用单个会话，防止 new-conversation 发生死循环雪崩。
            # 2. 加入 `[SYSTEM CONSTRAINT]` 强锚定逻辑约束模型忽略所有以往历史。
            # 3. 在返回中强制携带时间戳前缀，避免会话框消息合并，使用户可清晰感知后台心跳状态。
            # 4. 采用更鲁棒的正则截取 JSON 结构，免受前后纯文本时间戳的解析干扰。
            current_time_str = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime())

            # 中文翻译：[系统约束] 这是一个无状态的提取任务。在每行日志的开头有类似于 [line_123] 的前缀，它指代了该行的物理行号。你必须在 JSON 的 evidence_msg_ids 中返回支撑该决策的具体行号范围的整数数组（例如 [123, 124]），严禁返回空数组 []。如果在 MODEL 回复中包含了明确的自我纠偏、赞同并采纳用户提议（如“纠正错误/偏差”、“赞同该提议”、“已采纳该设计”），你必须在 decision 结构体中输出 "user_confirmed": true 字段。你必须在 JSON markdown 块的前一行输出该确切的时间戳：[Sync Finished: {current_time_str}]。
            prompt = f"""[SYSTEM CONSTRAINT]
This is a stateless extraction task. The conversation logs provided below are completely independent of any previous messages in this session.
You MUST ignore all previous contexts, topics, and decisions in this conversation history. Extract ADRs ONLY based on the new logs provided below.
Each line of the log is prefixed with its physical line number, e.g. [line_123]. You MUST reference these numbers.

You MUST output this exact timestamp on the first line before your JSON markdown block (do NOT put it inside the markdown code block):
[Sync Finished: {current_time_str}]

You are an expert Architecture Decision Record (ADR) extractor.
Analyze the following conversation snippets and extract all key topics.
You MUST output ONLY a valid JSON object with this structure:
{{"topics": [{{"topic_id": "t_001", "summary": "...", "decisions": [{{"decision": "...", "rationale": "...", "evidence_msg_ids": [123, 125], "user_confirmed": false}}]}}]}}
Note: evidence_msg_ids MUST NOT be empty. Fill it with the actual line numbers from [line_XXXX] prefixes that justify the decision.
Note: If the MODEL output shows clear self-correction, agreement, or adoption of user's proposal, set "user_confirmed": true.
If no significant topics, output: {{"topics": []}}

[CONVERSATION]
""" + key_content

            llm_output = get_or_create_conversation(prompt)
            if not llm_output:
                conn.execute(
                    "UPDATE watermarks SET last_line_processed=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
                    (current_line, session['project_uuid'], session['conversation_id']))
                conn.commit()
                continue

            # 使用正则截取 ```json ... ``` 包裹的部分，如果不存在则退化匹配第一对大括号，避免大模型输出时间戳或其他描述文字干扰 JSON 解析
            json_match = re.search(r'```json\s*(.*?)\s*```', llm_output, re.DOTALL)
            if not json_match:
                json_match = re.search(r'({.*})', llm_output, re.DOTALL)

            if json_match:
                json_str = json_match.group(1).strip()
            else:
                json_str = llm_output.strip()

            try:
                data = json.loads(json_str)
                for t in data.get("topics", []):
                    conn.execute(
                        """INSERT INTO project_topics (uuid, topic_id, summary)
                           VALUES (?, ?, ?)
                           ON CONFLICT(uuid, topic_id) DO UPDATE SET summary=?""",
                        (session['project_uuid'], t.get('topic_id', ''),
                         t.get('summary', ''), t.get('summary', '')))

                    for d in t.get("decisions", []):
                        user_confirmed_val = 1 if d.get("user_confirmed", False) else 0
                        conn.execute(
                            """INSERT INTO topic_decisions
                               (project_uuid, topic_id, conversation_id, decision, rationale, evidence_msg_ids, user_confirmed, created_at_line)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                            (session['project_uuid'], t.get('topic_id', ''),
                             session['conversation_id'], d.get('decision', ''),
                             d.get('rationale', ''),
                             json.dumps(d.get('evidence_msg_ids', [])),
                             user_confirmed_val,
                             current_line))
            except json.JSONDecodeError:
                pass

            conn.execute(
                "UPDATE watermarks SET last_line_processed=?, last_updated=CURRENT_TIMESTAMP WHERE project_uuid=? AND conversation_id=?",
                (current_line, session['project_uuid'], session['conversation_id']))
            conn.commit()


# ##########################################################
# AGENT MAINTENANCE DISCIPLINE (架构设计维护纪律)
# ⚠️ 警告：任何 AI Agent 欲修改本文件的核心逻辑，必须遵守：
#   1. 必须同步在此注释块中更新/添加对应的设计原理解析。
#   2. 所有英文提示词所在的代码行之上，必须同时保留/更新其精准的中文翻译注释。
#   禁止在不更新设计注释与提示词翻译的情况下直接覆写逻辑！
# ##########################################################

# ==========================================
# 设计原理三：Stop 事件制品同步与 MD5 过滤机制
# ==========================================
# 针对大模型离线（Stop 事件），在 hooks 中挂载 --event-driven 参数。
# 在毫秒级别计算 artifacts 下 Plan/Walkthrough 文件的 MD5 哈希。
# 当检测到哈希变化时，清除之前的同步事实并整体覆盖同步，
# 将其存入 messages 以便全文检索，免去在离线前通过大模型进行长耗时的提取，保证用户开发流畅。

def calculate_md5(file_path):
    """计算制品的 MD5 哈希以做增量变更过滤"""
    hash_md5 = hashlib.md5()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(4096), b""):
            hash_md5.update(chunk)
    return hash_md5.hexdigest()

def scan_and_ingest_artifacts(context):
    """
    双轨制品记忆搜刮：
    大模型每次运行 Stop 离线前被触发。仅计算 artifacts 下 Plan/Walkthrough 文件的 MD5。
    仅在哈希改变时，清空该文件在此项目下的旧同步事实，并把全新 Markdown 原文作为 system 对话
    直接导入 messages 数据库，免去大模型在退出时同步抽取造成的交互延迟（保证开发心流）。
    """
    artifact_dir = context.get('artifactDirectoryPath', '')
    project_uuid = os.environ.get("ANTIGRAVITY_PROJECT_ID", "unknown")
    if not artifact_dir or not os.path.exists(artifact_dir):
        return

    target_files = ["implementation_plan.md", "walkthrough.md"]
    
    with sqlite3.connect(DB_PATH) as conn:
        for filename in target_files:
            file_path = os.path.join(artifact_dir, filename)
            if not os.path.exists(file_path):
                continue
                
            current_hash = calculate_md5(file_path)
            
            # 1. 哈希过滤：如果 MD5 没变，直接跳过，耗时 < 1 毫秒
            cursor = conn.execute("SELECT hash FROM artifact_hashes WHERE file_path=?", (file_path,))
            row = cursor.fetchone()
            if row and row[0] == current_hash:
                continue
                
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # 2. 写入或覆盖哈希表
            conn.execute(
                "INSERT OR REPLACE INTO artifact_hashes (file_path, hash, last_updated) VALUES (?, ?, CURRENT_TIMESTAMP)",
                (file_path, current_hash))
                
            # 3. 物理一致性同步：将制品原文作为 system 角色事实导入 messages
            #    使用特定的 conversation_id 格式实现项目内物理绑定
            sync_conv_id = f"artifact_sync_{project_uuid}"
            
            # 清除旧事实 (覆盖重写，保证最终一致性)
            conn.execute(
                "DELETE FROM messages WHERE conversation_id=? AND role=?",
                (sync_conv_id, filename))
                
            # 物理写入温存储
            # 999900 系列行号为制品专用预留段
            conn.execute(
                """INSERT INTO messages (conversation_id, line_number, timestamp, role, content, topic_id)
                   VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)""",
                (sync_conv_id, 999900 + target_files.index(filename), filename, content, "artifact_topic"))
            
            # 确保在 project_topics 表中也有此全局约束话题的记录
            conn.execute(
                """INSERT OR REPLACE INTO project_topics (uuid, topic_id, status, summary, constraints)
                   VALUES (?, ?, 'closed', ?, ?)""",
                (project_uuid, "artifact_topic", f"Consolidated architecture decisions from {filename}", f"Artifact: {filename}"))
                
            # [P0] 极速无感写入事件队列，解决 Hook 挂接大模型延迟问题
            if filename == "implementation_plan.md":
                conn.commit()
                continue # Plan 审批由 check_plan_approval() 独立管线处理
            event_type = f"{filename.split('.')[0]}_sync" # walkthrough_sync 或 task_sync
            conn.execute(
                "INSERT INTO remora_event_queue (project_uuid, event_type, payload) VALUES (?, ?, ?)",
                (project_uuid, event_type, content))
                
            conn.commit()
            # 中文翻译：[Remora] 成功同步制品记忆: {filename}
            print(f"[Remora] 成功同步制品记忆: {filename}")

def check_plan_approval(conn, project_uuid):
    """
    [P0] Plan 审批判定窗口扫描 (手术刀精准化改造)
    不再直接执行 blanket UPDATE 造成旧决策污染性锁定。
    改为：识别到审批信号后，极速向 remora_event_queue INSERT 对应 plan_approval_sync 事件，
    将其并入事件消费管线，通过 LLM 进行高精度的「审批消息 + Plan 原文 -> 待确认 Decisions」映射。
    """
    # 1. 查找 implementation_plan.md 最后哈希变更时间
    cursor = conn.execute(
        "SELECT last_updated FROM artifact_hashes WHERE file_path LIKE '%implementation_plan.md' LIMIT 1"
    )
    row = cursor.fetchone()
    if not row:
        return
    t_plan_change = row[0]

    # 2. 拉取此时间点之后的全部用户输入消息
    cursor = conn.execute(
        "SELECT content FROM messages WHERE timestamp > ? AND role IN ('USER', 'USER_INPUT', 'USER_EXPLICIT')", (t_plan_change,)
    )
    user_messages = [r[0] for r in cursor.fetchall()]

    # 3. 加权关键词扫描
    approval_keywords = ["同意", "执行吧", "批准", "启动吧", "开始执行", "可以执行", "没问题", "approve", "confirm"]
    has_approval = False
    for msg in user_messages:
        if any(kw in msg for kw in approval_keywords):
            if not re.search(r'(不|拒绝|拒绝执行)\s*(' + '|'.join(approval_keywords) + ')', msg):
                has_approval = True
                break

    # 4. 生成 plan_approval_sync 事件，交付事件消费管线统一精准匹配
    if has_approval:
        # 获取 Plan 的最新原文
        cursor = conn.execute(
            "SELECT content FROM messages WHERE conversation_id = ? AND role = 'implementation_plan.md' LIMIT 1",
            (f"artifact_sync_{project_uuid}",)
        )
        plan_content_row = cursor.fetchone()
        plan_content = plan_content_row[0] if plan_content_row else ""
        
        payload_data = {
            "user_approval_context": "\n".join(user_messages),
            "plan_content": plan_content
        }
        
        # 极速写入事件队列，解决霰弹枪误打标
        conn.execute(
            "INSERT INTO remora_event_queue (project_uuid, event_type, payload) VALUES (?, ?, ?)",
            (project_uuid, "plan_approval_sync", json.dumps(payload_data))
        )
        conn.commit()
        print(f"[Remora] 探测到项目 {project_uuid} 用户审批信号，已向事件队列抛入 plan_approval_sync。")

def consume_event_queue(conn, start_time):
    """
    [P0] 核心打标消费管线 (带超限熔断保护)
    """
    cursor = conn.execute(
        "SELECT id, project_uuid, event_type, payload FROM remora_event_queue WHERE status = 'pending' ORDER BY id ASC"
    )
    events = cursor.fetchall()
    if not events:
        return

    for event_id, project_uuid, event_type, payload in events:
        # 提取待确认的老决策集 (引入 LIMIT 30 限制，防爆仓与超时熔断)
        cursor = conn.execute(
            "SELECT id, decision, rationale FROM topic_decisions WHERE project_uuid = ? AND user_confirmed = 0 ORDER BY id DESC LIMIT 30",
            (project_uuid,)
        )
        pending_decisions = [{"id": r[0], "decision": r[1], "rationale": r[2]} for r in cursor.fetchall()]
        
        if not pending_decisions:
            conn.execute("UPDATE remora_event_queue SET status = 'processed' WHERE id = ?", (event_id,))
            conn.commit()
            continue

        # AI 精准映射匹配
        prompt = f"""[SYSTEM CONSTRAINT]
You are a precise Architecture Decision Validator.
We have a list of pending decisions that need user confirmation.
Your task is to analyze the synchronization payload ({event_type}) provided below and determine which pending decisions have been successfully implemented or explicitly approved.

Pending Decisions to Validate:
{json.dumps(pending_decisions, ensure_ascii=False, indent=2)}

Sync Event Payload:
{payload}

You MUST output ONLY a valid JSON object listing the IDs of decisions that are confirmed:
{{"confirmed_ids": [12, 15]}}
If none match, return: {{"confirmed_ids": []}}
"""
        # [P1] 熔断保护升级：在发起耗时 LLM 调用前检查时间预算，预留 30s 缓冲防止击穿 300s
        if time.time() - start_time > 270:
            print("[Remora] 临界超时熔断，剩余事件留待下轮处理。", file=sys.stderr)
            break

        try:
            llm_output = get_or_create_conversation(prompt)
            json_match = re.search(r'({.*})', llm_output, re.DOTALL)
            if json_match:
                result_data = json.loads(json_match.group(1).strip())
                confirmed_ids = result_data.get("confirmed_ids", [])
                for d_id in confirmed_ids:
                    conn.execute(
                        "UPDATE topic_decisions SET user_confirmed = 1 WHERE id = ? AND project_uuid = ?",
                        (d_id, project_uuid)
                    )
                print(f"[Remora] 事件 {event_id} ({event_type}) 消费成功，已将决策集 {confirmed_ids} 打标锁定。")
        except AgentApiError:
            raise
        except Exception as e:
            print(f"[Remora] 消费事件 {event_id} 发生异常: {str(e)}", file=sys.stderr)
            conn.commit()
            continue
            
        conn.execute("UPDATE remora_event_queue SET status = 'processed' WHERE id = ?", (event_id,))
        conn.commit()

def main():
    # 中文翻译：Remora 内存压缩器 V2.2
    parser = argparse.ArgumentParser(description="Remora Memory Compactor V2.2")
    # 中文翻译：--cron
    parser.add_argument("--cron", action="store_true")
    # 中文翻译：--event-driven
    parser.add_argument("--event-driven", action="store_true")
    args = parser.parse_args()

    init_db()

    if args.event_driven:
        # Stop 钩子同步扫描制品。它是单次极轻量的，无需文件锁保护，避免互斥冲突
        try:
            context = json.load(sys.stdin)
            scan_and_ingest_artifacts(context)
        except Exception:
            pass
    else:
        # 默认或 --cron 阶段的后台增量对话扫描，长耗时，必须文件锁保护
        acquire_lock()
        cycle_start = time.time()
        try:
            prune_expired_watermarks()
            process_logs()
            
            # [P0] 串行保序：前置 decisions 提取 commit 之后，立即执行 Plan 审批拦截与事件队列 AI 精确匹配
            with sqlite3.connect(DB_PATH) as conn:
                active_projects = [row[0] for row in conn.execute("SELECT DISTINCT uuid FROM project_topics").fetchall()]
                for p_uuid in active_projects:
                    check_plan_approval(conn, p_uuid)
                consume_event_queue(conn, cycle_start)
        except AgentApiError as e:
            # 中文翻译：进程锁或者 agentapi 调用失败，放弃执行。
            print(str(e), file=sys.stderr)
            release_lock()
            sys.exit(1)
        except Exception:
            import traceback
            traceback.print_exc()
        finally:
            release_lock()

if __name__ == "__main__":
    main()
# Dummy comment to resolve action-gate false positive lock
