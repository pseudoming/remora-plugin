import os
import sys
import re
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from core.phantom import normalize_filepath, ACTION_PATTERNS


# ===================================================================
# normalize_filepath
# ===================================================================

class TestNormalizeFilepath:
    def test_target_file(self):
        assert normalize_filepath({"TargetFile": "/home/user/project/src/main.py"}) == "main.py"

    def test_absolute_path(self):
        assert normalize_filepath({"AbsolutePath": "/tmp/foo/bar.json"}) == "bar.json"

    def test_file_path(self):
        assert normalize_filepath({"FilePath": "/a/b/c/test.txt"}) == "test.txt"

    def test_target(self):
        assert normalize_filepath({"Target": "relative/path/script.sh"}) == "script.sh"

    def test_alias_priority_order(self):
        args = {
            "TargetFile": "/a/target.py",
            "AbsolutePath": "/a/abs.py",
            "FilePath": "/a/filepath.py",
            "Target": "/a/plain.py",
        }
        assert normalize_filepath(args) == "target.py"

    def test_falls_through_to_next_alias_if_value_empty(self):
        assert normalize_filepath({"TargetFile": "", "AbsolutePath": "/b/fallback.md"}) == "fallback.md"

    def test_falls_through_if_value_none(self):
        assert normalize_filepath({"TargetFile": None, "FilePath": "/c/real.c"}) == "real.c"

    def test_string_input_returns_empty(self):
        assert normalize_filepath("not_a_dict") == ""

    def test_none_input_returns_empty(self):
        assert normalize_filepath(None) == ""

    def test_empty_dict_returns_empty(self):
        assert normalize_filepath({}) == ""

    def test_dict_with_no_aliases_returns_empty(self):
        assert normalize_filepath({"foo": "bar"}) == ""

    def test_strips_quotes_from_value(self):
        assert normalize_filepath({"TargetFile": '"/quoted/path/file.py"'}) == "file.py"
        assert normalize_filepath({"TargetFile": "'single_quoted'"}) == "single_quoted"

    def test_flat_filename(self):
        assert normalize_filepath({"TargetFile": "standalone.py"}) == "standalone.py"


# ===================================================================
# ACTION_PATTERNS
# ===================================================================

class TestActionPatterns:
    """Verify each of the 7 compiled regex patterns matches expected Chinese/English text."""

    def test_pattern_1_markdown_link_modified(self):
        """Pattern 1: 已/成功 + verb + optional 文件 + Markdown link"""
        p = ACTION_PATTERNS[0]
        matches = p.findall("已修改了 [config.py](file:///home/project/config.py) 文件")
        assert "config.py" in matches

    def test_pattern_1_markdown_link_created(self):
        p = ACTION_PATTERNS[0]
        matches = p.findall("成功创建文件 [new_script.sh](file:///tmp/new_script.sh)")
        assert "new_script.sh" in matches

    def test_pattern_1_markdown_link_no_prefix(self):
        p = ACTION_PATTERNS[0]
        matches = p.findall("更新了 [app.js](file:///project/app.js)")
        assert "app.js" in matches

    def test_pattern_2_in_markdown_link_modified(self):
        """Pattern 2: 已在 Markdown link 中修改"""
        p = ACTION_PATTERNS[1]
        matches = p.findall("已在 [readme.md](file:///readme.md) 中修改了")
        assert "readme.md" in matches

    def test_pattern_2_in_markdown_link_updated_success(self):
        p = ACTION_PATTERNS[1]
        matches = p.findall("成功在 [data.json](file:///data.json) 中更新了")
        assert "data.json" in matches

    def test_pattern_3_in_quoted_filename_modified(self):
        """Pattern 3: 已在 `filename` 中修改"""
        p = ACTION_PATTERNS[2]
        matches = p.findall("已在 `main.py` 中修改了")
        assert "main.py" in matches

    def test_pattern_3_in_bare_filename(self):
        p = ACTION_PATTERNS[2]
        matches = p.findall("已在 script.js 中更新了")
        assert "script.js" in matches

    def test_pattern_4_verb_quoted_filename(self):
        """Pattern 4: verb + quoted filename (完成时态)"""
        p = ACTION_PATTERNS[3]
        matches = p.findall("已修改 `utils.py`")
        assert isinstance(matches[0], tuple)
        assert matches[0][0] == "utils.py"

    def test_pattern_4_verb_single_quoted(self):
        p = ACTION_PATTERNS[3]
        matches = p.findall("更新了文件 'handler.ts'")
        assert isinstance(matches[0], tuple)
        assert matches[0][0] == "handler.ts"

    def test_pattern_4_created_file(self):
        p = ACTION_PATTERNS[3]
        matches = p.findall("成功创建了 `new_module.py`")
        assert isinstance(matches[0], tuple)
        assert matches[0][0] == "new_module.py"

    def test_pattern_5_verb_unquoted_known_extension(self):
        """Pattern 5: verb + unquoted filename with known extension"""
        p = ACTION_PATTERNS[4]
        matches = p.findall("已修改了文件 config.json")
        assert "config.json" in matches

    def test_pattern_5_verb_unquoted_py(self):
        p = ACTION_PATTERNS[4]
        matches = p.findall("修改了 main.py 的某个函数")
        assert "main.py" in matches

    def test_pattern_5_unquoted_unknown_extension_not_matched(self):
        p = ACTION_PATTERNS[4]
        matches = p.findall("修改了 data.xyz")
        assert matches == []

    def test_pattern_6_english_verb_quoted(self):
        """Pattern 6: English verb + quoted filename"""
        p = ACTION_PATTERNS[5]
        matches = p.findall("updated `core.py`")
        assert "core.py" in matches

    def test_pattern_6_english_verb_double_quoted(self):
        p = ACTION_PATTERNS[5]
        matches = p.findall('modified file "readme.md"')
        assert "readme.md" in matches

    def test_pattern_6_english_created(self):
        p = ACTION_PATTERNS[5]
        matches = p.findall("created `new_test.js`")
        assert "new_test.js" in matches

    def test_pattern_6_english_overwritten(self):
        p = ACTION_PATTERNS[5]
        matches = p.findall("overwritten `legacy.xml`")
        assert "legacy.xml" in matches

    def test_pattern_7_english_verb_unquoted(self):
        """Pattern 7: English verb + unquoted filename with known extension"""
        p = ACTION_PATTERNS[6]
        matches = p.findall("modified file config.py")
        assert "config.py" in matches

    def test_pattern_7_english_written(self):
        p = ACTION_PATTERNS[6]
        matches = p.findall("written data.json")
        assert "data.json" in matches


# ===================================================================
# ACTION_PATTERNS cross-pattern integration
# ===================================================================

class TestActionPatternsIntegration:
    """Simulate the full phantom detection matching loop."""

    def test_multipattern_extraction(self):
        text = (
            "我已经修改了 [main.py](file:///path/main.py) 并且"
            "已在 utils.js 中调整了逻辑，"
            "updated `helper.ts` too, and written file schema.sql."
        )
        declared = set()
        for pattern in ACTION_PATTERNS:
            matches = pattern.findall(text)
            for path in matches:
                if isinstance(path, tuple):
                    path = [x for x in path if x][0]
                declared.add(os.path.basename(path))
        assert declared == {"main.py", "utils.js", "helper.ts", "schema.sql"}

    def test_no_false_positives_on_prose(self):
        text = "I think this code looks good. Let's proceed to the next step."
        declared = set()
        for pattern in ACTION_PATTERNS:
            matches = pattern.findall(text)
            for path in matches:
                if isinstance(path, tuple):
                    path = [x for x in path if x][0]
                declared.add(path)
        assert declared == set()

    def test_unquoted_without_known_extension_not_phantom(self):
        text = "修改了 helper.module 这是一个自定义类型"
        declared = set()
        for pattern in ACTION_PATTERNS:
            matches = pattern.findall(text)
            for path in matches:
                if isinstance(path, tuple):
                    path = [x for x in path if x][0]
                declared.add(path)
        assert declared == set()
