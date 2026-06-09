PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS project_topics (
    uuid TEXT NOT NULL,         -- 关联的 Project UUID，用于物理隔离不同项目的记忆
    topic_id TEXT NOT NULL,     -- 话题的唯一标识符（如 t_001）
    status TEXT DEFAULT 'open', -- 话题状态：open（活跃）或 closed（已归档）
    summary TEXT,               -- 话题的结构化摘要内容
    compression_confidence REAL DEFAULT 1.0, -- [P2] 压缩置信度校验值 (校验存留决策比例)
    source TEXT DEFAULT 'auto', -- 话题来源：'auto' (自动提取) 或 'manual' (用户手动创建/打标晋升)
    last_accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 上次被 switch 切换或 recall 检索命中的时间戳
    associated_files TEXT DEFAULT '[]', -- JSON 字符串数组，物理修改关联的文件列表
    referenced_files TEXT DEFAULT '[]', -- JSON 字符串数组，只读参考关联的文件列表
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 创建时间
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 最后更新时间
    PRIMARY KEY (uuid, topic_id)
);

CREATE TABLE IF NOT EXISTS topic_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键，无特殊业务含义
    project_uuid TEXT NOT NULL,           -- 关联的 Project UUID
    topic_id TEXT NOT NULL,               -- 关联的话题 ID，指向 project_topics
    conversation_id TEXT NOT NULL,        -- 对话会话 ID，追踪决策发生在哪次具体交互中
    decision TEXT NOT NULL,               -- 做出的核心架构或实现决策
    rationale TEXT NOT NULL,              -- 做出该决策的深层原因（为什么做，或者为什么不做）
    evidence_msg_ids TEXT,                -- JSON 数组格式的自增消息 ID 记录（用于温存储防篡改溯源）
    user_confirmed INTEGER DEFAULT 0,     -- 用户是否已物理确认（1 为确认，100% 压缩强保留）
    decision_type TEXT DEFAULT 'approved',-- 决策类型（核准等）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 创建时间
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 最后更新时间
    FOREIGN KEY(project_uuid, topic_id) REFERENCES project_topics(uuid, topic_id)
);

-- [P0] 物理事件同步队列表，包含多项目隔离的 project_uuid
CREATE TABLE IF NOT EXISTS remora_event_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_uuid TEXT NOT NULL,           -- 多项目租户物理隔离标识
    event_type TEXT NOT NULL,             -- 事件类型：walkthrough_sync, task_sync, plan_approval_sync 等
    payload TEXT,                         -- JSON 格式或文本载荷，如制品变更原文
    status TEXT DEFAULT 'pending',        -- 状态：pending（待处理）, processed（已消费）
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);


-- [P0] 核心防守型温存储表与全文索引
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    line_number INTEGER NOT NULL,
    timestamp TIMESTAMP,
    role TEXT,
    content TEXT,
    topic_id TEXT,
    UNIQUE(conversation_id, line_number)
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content, content=messages, content_rowid=id, tokenize='trigram'
);

-- [P0] FTS5 同步触发器
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TABLE IF NOT EXISTS watermarks (
    project_uuid TEXT NOT NULL,           -- 关联的项目UUID
    conversation_id TEXT NOT NULL,        -- 对应的对话会话ID
    last_msg_id INTEGER DEFAULT 0,        -- 最后处理的消息ID
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP, -- 最后更新时间
    PRIMARY KEY (project_uuid, conversation_id)
);

-- [P2] 专门记录标准制品 MD5 哈希的缓存表，用于实现 Stop 钩子事件驱动下的毫秒级增量搜刮
CREATE TABLE IF NOT EXISTS artifact_hashes (
    file_path TEXT PRIMARY KEY,           -- 制品文件的绝对路径
    hash TEXT NOT NULL,                   -- 文件的 MD5 哈希校验值
    last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- 最后更新同步时间
);

-- [P25] IPC 状态同步表
CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT PRIMARY KEY,
    mode TEXT DEFAULT 'relax',
    is_cold_start INTEGER DEFAULT 1,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- [P39] runtime_hook_state 跨进程 Hook 状态表
CREATE TABLE IF NOT EXISTS runtime_hook_state (
    session_id TEXT NOT NULL,
    turn_idx INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (session_id, turn_idx, key)
);

CREATE TABLE IF NOT EXISTS file_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_uuid TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(conversation_id, file_name)
);

