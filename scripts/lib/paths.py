import os

def find_plugin_root():
    current_dir = os.path.abspath(os.path.dirname(__file__))
    while current_dir != '/' and current_dir != '':
        if os.path.exists(os.path.join(current_dir, "plugin.json")):
            return current_dir
        current_dir = os.path.dirname(current_dir)
    raise RuntimeError("FATAL: Cannot find plugin.json to anchor PLUGIN_ROOT. Are you running outside the plugin directory?")

def get_data_dir():
    # 第一优先级：宿主内聚目录
    # 第二优先级：~/.remora/data fallback
    # 彻底废弃 ANTIGRAVITY_EXECUTABLE_DATA_DIR 优先级，避免与 install.py 的物理迁移产生撕裂。
    plugin_root = find_plugin_root()
    if os.access(plugin_root, os.W_OK):
        return os.path.join(plugin_root, "data")
    return os.path.expanduser("~/.remora/data")

def get_db_path():
    return os.path.join(get_data_dir(), "remora_memory.db")
