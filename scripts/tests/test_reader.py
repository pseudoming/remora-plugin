import pytest
from core.reader import filter_user_ai_rounds, MAX_CONTENT_CHARS


def _generator(items):
    """Convert list to lazy iterable for testing."""
    for item in items:
        yield item


class TestFilterUserAiRounds:
    def test_empty_iterable(self):
        result = filter_user_ai_rounds(iter([]))
        assert result == []

    def test_no_matching_types(self):
        steps = [
            {"type": "TOOL_USE", "content": "ls"},
            {"type": "TOOL_RESULT", "content": "file"},
            {"type": "SYSTEM_MESSAGE", "content": "hello"},
        ]
        result = filter_user_ai_rounds(_generator(steps))
        assert result == []

    def test_empty_content_skipped(self):
        steps = [
            {"type": "USER_INPUT", "content": ""},
            {"type": "USER_INPUT", "content": "hello"},
            {"type": "PLANNER_RESPONSE", "content": ""},
            {"type": "PLANNER_RESPONSE", "content": "world"},
        ]
        result = filter_user_ai_rounds(_generator(steps))
        assert result == [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "world"},
        ]

    def test_role_mapping(self):
        steps = [
            {"type": "USER_INPUT", "content": "u"},
            {"type": "PLANNER_RESPONSE", "content": "a"},
            {"type": "USER_INPUT", "content": "u2"},
            {"type": "PLANNER_RESPONSE", "content": "a2"},
        ]
        result = filter_user_ai_rounds(_generator(steps))
        assert result == [
            {"role": "user", "content": "u"},
            {"role": "assistant", "content": "a"},
            {"role": "user", "content": "u2"},
            {"role": "assistant", "content": "a2"},
        ]

    def test_content_truncation(self):
        long_content = "x" * 1500
        steps = [
            {"type": "USER_INPUT", "content": long_content},
        ]
        result = filter_user_ai_rounds(_generator(steps))
        assert len(result) == 1
        assert result[0]["role"] == "user"
        assert result[0]["content"] == "x" * MAX_CONTENT_CHARS

    def test_rounds_limit(self):
        steps = [
            {"type": "USER_INPUT", "content": "u1"},
            {"type": "PLANNER_RESPONSE", "content": "a1"},
            {"type": "USER_INPUT", "content": "u2"},
            {"type": "PLANNER_RESPONSE", "content": "a2"},
            {"type": "USER_INPUT", "content": "u3"},
            {"type": "PLANNER_RESPONSE", "content": "a3"},
        ]
        result = filter_user_ai_rounds(_generator(steps), rounds=2)
        assert len(result) == 4
        assert result == [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "a1"},
            {"role": "user", "content": "u2"},
            {"role": "assistant", "content": "a2"},
        ]

    def test_exception_during_iteration(self):
        def broken_gen():
            yield {"type": "USER_INPUT", "content": "first"}
            yield {"type": "PLANNER_RESPONSE", "content": "second"}
            raise RuntimeError("boom")

        result = filter_user_ai_rounds(broken_gen())
        assert result == [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "second"},
        ]

    def test_role_field_does_not_override_type(self):
        steps = [
            {"type": "USER_INPUT", "content": "hi", "role": "assistant"},
            {"type": "PLANNER_RESPONSE", "content": "hey", "role": "user"},
        ]
        result = filter_user_ai_rounds(_generator(steps))
        assert result == [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hey"},
        ]

    def test_no_content_key_defaults_to_empty(self):
        steps = [
            {"type": "USER_INPUT"},
            {"type": "USER_INPUT", "content": "real"},
        ]
        result = filter_user_ai_rounds(_generator(steps))
        assert result == [
            {"role": "user", "content": "real"},
        ]
