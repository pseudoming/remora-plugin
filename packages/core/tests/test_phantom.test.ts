import { describe, it, expect } from "vitest";
import { normalizeFilepath, ACTION_PATTERNS } from "../src/phantom";

/**
 * Mimics Python's re.findall() behavior:
 * - Single capture group → returns array of matched strings
 * - Multiple capture groups → returns array of string tuples (arrays)
 */
function findall(pattern: RegExp, text: string): (string | string[])[] {
  const gPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  return [...text.matchAll(gPattern)].map((m) => {
    const groups = Array.from(m).slice(1);
    return groups.length === 1 ? groups[0] : groups;
  });
}

function basename(p: string): string {
  return p.split("/").pop()!;
}

// ===================================================================
// normalizeFilepath
// ===================================================================

describe("normalizeFilepath", () => {
  it("test_target_file", () => {
    expect(normalizeFilepath({ TargetFile: "/home/user/project/src/main.py" })).toBe("main.py");
  });

  it("test_absolute_path", () => {
    expect(normalizeFilepath({ AbsolutePath: "/tmp/foo/bar.json" })).toBe("bar.json");
  });

  it("test_file_path", () => {
    expect(normalizeFilepath({ FilePath: "/a/b/c/test.txt" })).toBe("test.txt");
  });

  it("test_target", () => {
    expect(normalizeFilepath({ Target: "relative/path/script.sh" })).toBe("script.sh");
  });

  it("test_alias_priority_order", () => {
    const args = {
      TargetFile: "/a/target.py",
      AbsolutePath: "/a/abs.py",
      FilePath: "/a/filepath.py",
      Target: "/a/plain.py",
    };
    expect(normalizeFilepath(args)).toBe("target.py");
  });

  it("test_falls_through_to_next_alias_if_value_empty", () => {
    expect(normalizeFilepath({ TargetFile: "", AbsolutePath: "/b/fallback.md" })).toBe("fallback.md");
  });

  it("test_falls_through_if_value_none", () => {
    expect(normalizeFilepath({ TargetFile: null, FilePath: "/c/real.c" })).toBe("real.c");
  });

  it("test_string_input_returns_empty", () => {
    expect(normalizeFilepath("not_a_dict")).toBe("");
  });

  it("test_none_input_returns_empty", () => {
    expect(normalizeFilepath(null)).toBe("");
  });

  it("test_empty_dict_returns_empty", () => {
    expect(normalizeFilepath({})).toBe("");
  });

  it("test_dict_with_no_aliases_returns_empty", () => {
    expect(normalizeFilepath({ foo: "bar" })).toBe("");
  });

  it("test_strips_quotes_from_value", () => {
    expect(normalizeFilepath({ TargetFile: '"/quoted/path/file.py"' })).toBe("file.py");
    expect(normalizeFilepath({ TargetFile: "'single_quoted'" })).toBe("single_quoted");
  });

  it("test_flat_filename", () => {
    expect(normalizeFilepath({ TargetFile: "standalone.py" })).toBe("standalone.py");
  });
});

// ===================================================================
// ACTION_PATTERNS
// ===================================================================

describe("ACTION_PATTERNS", () => {
  /** Verify each of the 7 compiled regex patterns matches expected Chinese/English text. */

  it("test_pattern_1_markdown_link_modified", () => {
    /** Pattern 1: 已/成功 + verb + optional 文件 + Markdown link */
    const p = ACTION_PATTERNS[0];
    const matches = findall(p, "已修改了 [config.py](file:///home/project/config.py) 文件");
    expect(matches).toContain("config.py");
  });

  it("test_pattern_1_markdown_link_created", () => {
    const p = ACTION_PATTERNS[0];
    const matches = findall(p, "成功创建文件 [new_script.sh](file:///tmp/new_script.sh)");
    expect(matches).toContain("new_script.sh");
  });

  it("test_pattern_1_markdown_link_no_prefix", () => {
    const p = ACTION_PATTERNS[0];
    const matches = findall(p, "更新了 [app.js](file:///project/app.js)");
    expect(matches).toContain("app.js");
  });

  it("test_pattern_2_in_markdown_link_modified", () => {
    /** Pattern 2: 已在 Markdown link 中修改 */
    const p = ACTION_PATTERNS[1];
    const matches = findall(p, "已在 [readme.md](file:///readme.md) 中修改了");
    expect(matches).toContain("readme.md");
  });

  it("test_pattern_2_in_markdown_link_updated_success", () => {
    const p = ACTION_PATTERNS[1];
    const matches = findall(p, "成功在 [data.json](file:///data.json) 中更新了");
    expect(matches).toContain("data.json");
  });

  it("test_pattern_3_in_quoted_filename_modified", () => {
    /** Pattern 3: 已在 `filename` 中修改 */
    const p = ACTION_PATTERNS[2];
    const matches = findall(p, "已在 `main.py` 中修改了");
    expect(matches).toContain("main.py");
  });

  it("test_pattern_3_in_bare_filename", () => {
    const p = ACTION_PATTERNS[2];
    const matches = findall(p, "已在 script.js 中更新了");
    expect(matches).toContain("script.js");
  });

  it("test_pattern_4_verb_quoted_filename", () => {
    /** Pattern 4: verb + quoted filename (完成时态) */
    const p = ACTION_PATTERNS[3];
    const matches = findall(p, "已修改 `utils.py`");
    expect(Array.isArray(matches[0])).toBe(true);
    expect((matches[0] as string[])[0]).toBe("utils.py");
  });

  it("test_pattern_4_verb_single_quoted", () => {
    const p = ACTION_PATTERNS[3];
    const matches = findall(p, "更新了文件 'handler.ts'");
    expect(Array.isArray(matches[0])).toBe(true);
    expect((matches[0] as string[])[0]).toBe("handler.ts");
  });

  it("test_pattern_4_created_file", () => {
    const p = ACTION_PATTERNS[3];
    const matches = findall(p, "成功创建了 `new_module.py`");
    expect(Array.isArray(matches[0])).toBe(true);
    expect((matches[0] as string[])[0]).toBe("new_module.py");
  });

  it("test_pattern_5_verb_unquoted_known_extension", () => {
    /** Pattern 5: verb + unquoted filename with known extension */
    const p = ACTION_PATTERNS[4];
    const matches = findall(p, "已修改了文件 config.json");
    expect(matches).toContain("config.json");
  });

  it("test_pattern_5_verb_unquoted_py", () => {
    const p = ACTION_PATTERNS[4];
    const matches = findall(p, "修改了 main.py 的某个函数");
    expect(matches).toContain("main.py");
  });

  it("test_pattern_5_unquoted_unknown_extension_not_matched", () => {
    const p = ACTION_PATTERNS[4];
    const matches = findall(p, "修改了 data.xyz");
    expect(matches).toEqual([]);
  });

  it("test_pattern_6_english_verb_quoted", () => {
    /** Pattern 6: English verb + quoted filename */
    const p = ACTION_PATTERNS[5];
    const matches = findall(p, "updated `core.py`");
    expect(matches).toContain("core.py");
  });

  it("test_pattern_6_english_verb_double_quoted", () => {
    const p = ACTION_PATTERNS[5];
    const matches = findall(p, 'modified file "readme.md"');
    expect(matches).toContain("readme.md");
  });

  it("test_pattern_6_english_created", () => {
    const p = ACTION_PATTERNS[5];
    const matches = findall(p, "created `new_test.js`");
    expect(matches).toContain("new_test.js");
  });

  it("test_pattern_6_english_overwritten", () => {
    const p = ACTION_PATTERNS[5];
    const matches = findall(p, "overwritten `legacy.xml`");
    expect(matches).toContain("legacy.xml");
  });

  it("test_pattern_7_english_verb_unquoted", () => {
    /** Pattern 7: English verb + unquoted filename with known extension */
    const p = ACTION_PATTERNS[6];
    const matches = findall(p, "modified file config.py");
    expect(matches).toContain("config.py");
  });

  it("test_pattern_7_english_written", () => {
    const p = ACTION_PATTERNS[6];
    const matches = findall(p, "written data.json");
    expect(matches).toContain("data.json");
  });
});

// ===================================================================
// ACTION_PATTERNS cross-pattern integration
// ===================================================================

describe("ACTION_PATTERNS integration", () => {
  /** Simulate the full phantom detection matching loop. */

  it("test_multipattern_extraction", () => {
    const text =
      "我已经修改了 [main.py](file:///path/main.py) 并且" +
      "已在 utils.js 中调整了逻辑，" +
      "updated `helper.ts` too, and written file schema.sql.";
    const declared = new Set<string>();
    for (const pattern of ACTION_PATTERNS) {
      const matches = findall(pattern, text);
      for (let path of matches) {
        if (Array.isArray(path)) {
          path = path.filter((x) => x)[0];
        }
        declared.add(basename(path as string));
      }
    }
    expect(declared).toEqual(new Set(["main.py", "utils.js", "helper.ts", "schema.sql"]));
  });

  it("test_no_false_positives_on_prose", () => {
    const text = "I think this code looks good. Let's proceed to the next step.";
    const declared = new Set<string>();
    for (const pattern of ACTION_PATTERNS) {
      const matches = findall(pattern, text);
      for (let path of matches) {
        if (Array.isArray(path)) {
          path = path.filter((x) => x)[0];
        }
        declared.add(path as string);
      }
    }
    expect(declared).toEqual(new Set());
  });

  it("test_unquoted_without_known_extension_not_phantom", () => {
    const text = "修改了 helper.module 这是一个自定义类型";
    const declared = new Set<string>();
    for (const pattern of ACTION_PATTERNS) {
      const matches = findall(pattern, text);
      for (let path of matches) {
        if (Array.isArray(path)) {
          path = path.filter((x) => x)[0];
        }
        declared.add(path as string);
      }
    }
    expect(declared).toEqual(new Set());
  });
});
