import os
import sys
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import core.injector as I


class TestTruncateDecisions:
    def test_empty_list_returns_empty_string(self):
        assert I.truncate_decisions([]) == ""

    def test_single_decision_under_budget(self):
        decisions = [{"text": "short text"}]
        result = I.truncate_decisions(decisions)
        assert result == "short text"

    def test_single_decision_exact_budget(self):
        text = "x" * I.MAX_CHARS
        decisions = [{"text": text}]
        result = I.truncate_decisions(decisions)
        assert result == text

    def test_single_decision_over_budget(self):
        text = "x" * 1000
        decisions = [{"text": text}]
        result = I.truncate_decisions(decisions)
        expected = text[:I.MAX_CHARS] + "..."
        assert result == expected
        assert len(result) == I.MAX_CHARS + 3

    def test_multiple_decisions_all_under_budget(self):
        decisions = [{"text": "A"}, {"text": "B"}, {"text": "C"}]
        result = I.truncate_decisions(decisions)
        assert result == "A\n- B\n- C"

    def test_multiple_decisions_over_budget_mid_item(self):
        # MAX_CHARS=750, first item uses 700 chars, second has 100 chars
        # Second item should be truncated to 50 chars + "..."
        decisions = [
            {"text": "x" * 700},
            {"text": "y" * 100},
        ]
        result = I.truncate_decisions(decisions)
        # first: 700 chars of x
        # second: 50 chars of y + "..." (since 700 + 100 > 750, truncated to 50)
        expected = ("x" * 700) + "\n- " + ("y" * 50) + "..."
        assert result == expected
        # third item should NOT appear (break after truncation)
        assert "z" not in result

    def test_multiple_decisions_over_budget_third_not_included(self):
        decisions = [
            {"text": "x" * 700},
            {"text": "y" * 100},
            {"text": "z" * 50},
        ]
        result = I.truncate_decisions(decisions)
        assert "z" not in result

    def test_first_item_already_over_budget(self):
        decisions = [
            {"text": "a" * 800},
            {"text": "b"},
        ]
        result = I.truncate_decisions(decisions)
        expected = ("a" * I.MAX_CHARS) + "..."
        assert result == expected
        assert "b" not in result

    def test_multiple_items_hitting_exact_fit(self):
        # Each item fits, total exactly at budget
        decisions = [
            {"text": "x" * 400},
            {"text": "y" * 350},
        ]
        result = I.truncate_decisions(decisions)
        assert result == ("x" * 400) + "\n- " + ("y" * 350)
