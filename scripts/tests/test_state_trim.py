from unittest.mock import patch

from core.state_trim import trim_stale_hook_states


@patch("core.state_trim.set_hook_state")
@patch("core.state_trim.trim_hook_states")
@patch("core.state_trim.get_hook_state")
def test_first_call_last_seen_none(mock_get, mock_trim, mock_set):
    mock_get.return_value = None
    trim_stale_hook_states("conv-001", 5)
    mock_trim.assert_called_once_with("conv-001", 5)
    mock_set.assert_called_once_with("conv-001", -1, "last_seen_turn", "5")


@patch("core.state_trim.set_hook_state")
@patch("core.state_trim.trim_hook_states")
@patch("core.state_trim.get_hook_state")
def test_same_turn_noop(mock_get, mock_trim, mock_set):
    mock_get.return_value = "3"
    trim_stale_hook_states("conv-001", 3)
    mock_trim.assert_not_called()
    mock_set.assert_not_called()


@patch("core.state_trim.set_hook_state")
@patch("core.state_trim.trim_hook_states")
@patch("core.state_trim.get_hook_state")
def test_different_turn_trims_and_sets(mock_get, mock_trim, mock_set):
    mock_get.return_value = "2"
    trim_stale_hook_states("conv-001", 7)
    mock_trim.assert_called_once_with("conv-001", 7)
    mock_set.assert_called_once_with("conv-001", -1, "last_seen_turn", "7")


@patch("core.state_trim.set_hook_state")
@patch("core.state_trim.trim_hook_states")
@patch("core.state_trim.get_hook_state")
def test_unparseable_last_seen_noop(mock_get, mock_trim, mock_set):
    mock_get.return_value = "abc"
    trim_stale_hook_states("conv-001", 5)
    mock_trim.assert_not_called()
    mock_set.assert_not_called()
