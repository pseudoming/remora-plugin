import os

from core.liveness import (
    RELAX_PATTERN,
    clean_system_reminders,
    detect_mode,
    parse_sqlite_timestamp,
    find_all_uuids,
    judge_zombie,
)


def test_clean_system_reminders_no_tags():
    assert clean_system_reminders("hello world") == "hello world"


def test_clean_system_reminders_with_tags():
    assert clean_system_reminders("hello <system-reminder>foo</system-reminder> world") == "hello  world"


def test_clean_system_reminders_multiple_tags():
    assert clean_system_reminders(
        "<system-reminder>a</system-reminder> b <system-reminder>c</system-reminder>"
    ) == " b "


def test_clean_system_reminders_nested_tags():
    text = "start <system-reminder>outer<system-reminder>inner</system-reminder></system-reminder> end"
    result = clean_system_reminders(text)
    assert result == "start </system-reminder> end"


def test_clean_system_reminders_multiline():
    text = "before\n<system-reminder>\nmultiline\ncontent\n</system-reminder>\nafter"
    result = clean_system_reminders(text)
    assert result == "before\n\nafter"


def test_detect_mode_strict_default():
    assert detect_mode("run this command") == ("strict", None)
    assert detect_mode("") == ("strict", None)


def test_detect_mode_relax_keywords_trigger():
    assert detect_mode("这是一个草稿") == ("relax", None)
    assert detect_mode("some brainstorm ideas") == ("relax", None)
    assert detect_mode("讨论这个方案") == ("relax", None)
    assert detect_mode("let's brainstorm this") == ("relax", None)


def test_detect_mode_alert_keyword_override():
    alert = ["delete", "rm"]
    assert detect_mode("delete this 草稿", relax_keywords=[], alert_keywords=alert) == ("alert", "delete")
    assert detect_mode("this is a draft", alert_keywords=["delete"]) == ("relax", None)


def test_detect_mode_both_keyword_sets():
    alert = ["delete"]
    assert detect_mode("delete everything", alert_keywords=alert) == ("alert", "delete")


def test_detect_mode_default_params():
    assert detect_mode("draft idea") == ("relax", None)
    assert detect_mode("run test") == ("strict", None)


class TestDetectMode:
    def test_alert_keyword_returns_alert_with_word(self):
        assert detect_mode("你清醒一点", alert_keywords=["你清醒一点"]) == ("alert", "你清醒一点")

    def test_alert_overrides_relax(self):
        assert detect_mode("讨论方案，你清醒一点", relax_keywords=["讨论"], alert_keywords=["你清醒一点"]) == ("alert", "你清醒一点")

    def test_no_match_returns_strict_none(self):
        assert detect_mode("hello world") == ("strict", None)

    def test_relax_keyword_returns_relax_none(self):
        assert detect_mode("草案讨论", relax_keywords=["草案"]) == ("relax", None)

    def test_relax_no_keywords(self):
        assert detect_mode("这是一个草稿") == ("relax", None)

    def test_empty_relax_fallsback_to_regex(self):
        assert detect_mode("draft idea", relax_keywords=[]) == ("relax", None)

    def test_multiple_alert_returns_first_match(self):
        assert detect_mode("你好 再见", alert_keywords=["你好", "再见"]) == ("alert", "你好")

    def test_case_insensitive_alert(self):
        assert detect_mode("UPPERCASE DELETE", alert_keywords=["delete"]) == ("alert", "delete")

    def test_case_insensitive_relax(self):
        assert detect_mode("UPPERCASE DRAFT", relax_keywords=["draft"]) == ("relax", None)

    def test_alert_word_none_for_strict(self):
        mode, word = detect_mode("hello world")
        assert mode == "strict"
        assert word is None

    def test_alert_word_none_for_relax(self):
        mode, word = detect_mode("draft idea")
        assert mode == "relax"
        assert word is None


def test_parse_sqlite_timestamp_none():
    assert parse_sqlite_timestamp(None) == 0.0


def test_parse_sqlite_timestamp_int():
    assert parse_sqlite_timestamp(1700000000) == 1700000000.0


def test_parse_sqlite_timestamp_float():
    assert parse_sqlite_timestamp(1700000000.5) == 1700000000.5


def test_parse_sqlite_timestamp_valid_string():
    ts = parse_sqlite_timestamp("2024-05-29 16:26:40")
    assert ts > 0


def test_parse_sqlite_timestamp_iso_z():
    ts = parse_sqlite_timestamp("2024-05-29T16:26:40Z")
    assert ts > 0


def test_parse_sqlite_timestamp_iso_no_z():
    ts = parse_sqlite_timestamp("2024-05-29T16:26:40")
    assert ts > 0


def test_parse_sqlite_timestamp_garbage():
    assert parse_sqlite_timestamp("garbage") == 0.0


def test_find_all_uuids_string_with_uuid():
    parent = "00000000-0000-0000-0000-000000000000"
    result = find_all_uuids("abc123 e8c7f1a2-3b4d-5e6f-7890-abcdef123456 xyz", parent)
    assert "e8c7f1a2-3b4d-5e6f-7890-abcdef123456" in result


def test_find_all_uuids_excludes_parent():
    parent = "e8c7f1a2-3b4d-5e6f-7890-abcdef123456"
    result = find_all_uuids("id is %s" % parent, parent)
    assert parent not in result
    assert len(result) == 0


def test_find_all_uuids_dict_with_conversation_id():
    parent = "00000000-0000-0000-0000-000000000000"
    d = {"conversationId": "e8c7f1a2-3b4d-5e6f-7890-abcdef123456", "name": "test"}
    result = find_all_uuids(d, parent)
    assert "e8c7f1a2-3b4d-5e6f-7890-abcdef123456" in result


def test_find_all_uuids_dict_with_conversation_id_key():
    parent = "00000000-0000-0000-0000-000000000000"
    d = {"conversation_id": "e8c7f1a2-3b4d-5e6f-7890-abcdef123456", "name": "test"}
    result = find_all_uuids(d, parent)
    assert "e8c7f1a2-3b4d-5e6f-7890-abcdef123456" in result


def test_find_all_uuids_dict_excludes_parent_conversation_id():
    parent = "e8c7f1a2-3b4d-5e6f-7890-abcdef123456"
    d = {"conversationId": parent, "name": "test"}
    result = find_all_uuids(d, parent)
    assert parent not in result


def test_find_all_uuids_nested_dict():
    parent = "00000000-0000-0000-0000-000000000000"
    d = {"foo": {"conversationId": "e8c7f1a2-3b4d-5e6f-7890-abcdef123456"}}
    result = find_all_uuids(d, parent)
    assert "e8c7f1a2-3b4d-5e6f-7890-abcdef123456" in result


def test_find_all_uuids_list():
    parent = "00000000-0000-0000-0000-000000000000"
    data = ["e8c7f1a2-3b4d-5e6f-7890-abcdef123456", "another string"]
    result = find_all_uuids(data, parent)
    assert "e8c7f1a2-3b4d-5e6f-7890-abcdef123456" in result


def test_judge_zombie_normal_tool_under_60():
    is_zombie, limit = judge_zombie(30, "view_file", heavy_tools={"run_command", "grep_search"})
    assert not is_zombie
    assert limit == 60


def test_judge_zombie_heavy_tool_under_180():
    is_zombie, limit = judge_zombie(120, "run_command", heavy_tools={"run_command", "grep_search"})
    assert not is_zombie
    assert limit == 180


def test_judge_zombie_normal_tool_over_60():
    is_zombie, limit = judge_zombie(61, "view_file", heavy_tools={"run_command", "grep_search"})
    assert is_zombie
    assert limit == 60


def test_judge_zombie_heavy_tool_over_180():
    is_zombie, limit = judge_zombie(181, "grep_search", heavy_tools={"run_command", "grep_search"})
    assert is_zombie
    assert limit == 180


def test_judge_zombie_exact_boundary_normal():
    is_zombie, limit = judge_zombie(60, "view_file", heavy_tools={"run_command", "grep_search"})
    assert not is_zombie


def test_judge_zombie_exact_boundary_heavy():
    is_zombie, limit = judge_zombie(180, "run_command", heavy_tools={"run_command", "grep_search"})
    assert not is_zombie
