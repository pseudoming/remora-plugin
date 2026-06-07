import os
import sys
import struct
import json
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import core.proto_decoder as D


# ---------------------------------------------------------------------------
# Helpers for constructing protobuf binary test data
# ---------------------------------------------------------------------------

def _encode_varint(val):
    result = bytearray()
    while True:
        b = val & 0x7F
        val >>= 7
        if val:
            result.append(b | 0x80)
        else:
            result.append(b)
            break
    return bytes(result)


def _tag_type(tag, wire_type):
    return _encode_varint((tag << 3) | wire_type)


def _varint_field(tag, value):
    return _tag_type(tag, 0) + _encode_varint(value)


def _length_field(tag, payload):
    return _tag_type(tag, 2) + _encode_varint(len(payload)) + payload


def _bit64_field(tag, value):
    return _tag_type(tag, 1) + struct.pack('<Q', value)


def _bit32_field(tag, value):
    return _tag_type(tag, 5) + struct.pack('<I', value)


# ===================================================================
# decode_varint
# ===================================================================

class TestDecodeVarint:
    def test_single_byte(self):
        val, off = D.decode_varint(b'\x2E')
        assert val == 46
        assert off == 1

    def test_multi_byte(self):
        val, off = D.decode_varint(b'\x80\x01')
        assert val == 128
        assert off == 2

    def test_large_value(self):
        val, off = D.decode_varint(b'\xFF\xFF\xFF\xFF\x07')
        assert val == 2147483647
        assert off == 5

    def test_eof_empty(self):
        with pytest.raises(EOFError):
            D.decode_varint(b'', 0)

    def test_eof_partial(self):
        with pytest.raises(EOFError):
            D.decode_varint(b'\x80', 0)

    def test_eof_with_offset(self):
        with pytest.raises(EOFError):
            D.decode_varint(b'\x08', 1)

    def test_offset_used(self):
        val, off = D.decode_varint(b'\x00\x2E', 1)
        assert val == 46
        assert off == 2


# ===================================================================
# parse_protobuf
# ===================================================================

class TestParseProtobuf:
    def test_empty(self):
        assert D.parse_protobuf(b'') == {}

    def test_varint(self):
        result = D.parse_protobuf(_varint_field(1, 46))
        assert result == {1: [46]}

    def test_multiple_varints_same_tag(self):
        result = D.parse_protobuf(_varint_field(1, 10) + _varint_field(1, 20))
        assert result == {1: [10, 20]}

    def test_multiple_tags(self):
        result = D.parse_protobuf(_varint_field(1, 10) + _varint_field(2, 20))
        assert result == {1: [10], 2: [20]}

    def test_length_delimited(self):
        result = D.parse_protobuf(_length_field(2, b'hello'))
        assert result == {2: [b'hello']}

    def test_64bit(self):
        result = D.parse_protobuf(_bit64_field(2, 12345))
        assert result == {2: [12345]}

    def test_32bit(self):
        result = D.parse_protobuf(_bit32_field(3, 67890))
        assert result == {3: [67890]}

    def test_unsupported_wire_type(self):
        result = D.parse_protobuf(_tag_type(4, 3))
        assert result == {4: []}

    def test_unsupported_wire_type_after_valid(self):
        data = _varint_field(1, 99) + _tag_type(4, 6)
        result = D.parse_protobuf(data)
        assert result == {1: [99], 4: []}

    def test_64bit_truncated(self):
        data = _tag_type(2, 1) + b'\x01\x02\x03'
        result = D.parse_protobuf(data)
        assert result == {2: []}

    def test_32bit_truncated(self):
        data = _tag_type(3, 5) + b'\x01'
        result = D.parse_protobuf(data)
        assert result == {3: []}

    def test_length_delimited_truncated(self):
        data = _tag_type(5, 2) + b'\x0A' + b'abc'
        result = D.parse_protobuf(data)
        assert result == {5: []}

    def test_eof_in_tag(self):
        result = D.parse_protobuf(b'\x80')
        assert result == {}

    def test_length_delimited_empty(self):
        result = D.parse_protobuf(_length_field(6, b''))
        assert result == {6: [b'']}


# ===================================================================
# extract_step_payload
# ===================================================================

class TestExtractStepPayload:
    # -- empty / edge cases --

    def test_empty_blob_returns_empty_dict(self):
        assert D.extract_step_payload(b'') == {}

    def test_none_blob_returns_empty_dict(self):
        assert D.extract_step_payload(None) == {}

    def test_parse_exception_returns_empty_dict(self):
        data = b'\x08\x80'
        assert D.extract_step_payload(data) == {}

    # -- step_type mapping (tag=1, wire_type=0) --

    def test_step_type_planner_response(self):
        result = D.extract_step_payload(_varint_field(1, 15))
        assert result.get('type') == 'PLANNER_RESPONSE'

    def test_step_type_user_input(self):
        result = D.extract_step_payload(_varint_field(1, 14))
        assert result.get('type') == 'USER_INPUT'

    def test_step_type_unknown(self):
        result = D.extract_step_payload(_varint_field(1, 42))
        assert result.get('type') == 'UNKNOWN_42'

    def test_no_step_type(self):
        result = D.extract_step_payload(_varint_field(2, 99))
        assert 'type' not in result

    # -- role mapping (tag5 -> tag=3, wire_type=0) --

    @staticmethod
    def _tag5_with_role(role_val):
        tag5_blob = _varint_field(3, role_val)
        return _length_field(5, tag5_blob)

    def test_role_user(self):
        result = D.extract_step_payload(self._tag5_with_role(4))
        assert result.get('role') == 'user'

    def test_role_model(self):
        result = D.extract_step_payload(self._tag5_with_role(2))
        assert result.get('role') == 'model'

    def test_role_system(self):
        result = D.extract_step_payload(self._tag5_with_role(5))
        assert result.get('role') == 'system'

    def test_role_unknown(self):
        result = D.extract_step_payload(self._tag5_with_role(99))
        assert result.get('role') == 'unknown_99'

    def test_no_role(self):
        result = D.extract_step_payload(_length_field(5, b''))
        assert 'role' not in result

    # -- timestamp extraction (tag5 -> tag=1 -> tag=1) --

    def test_timestamp_success(self):
        ts = 1717000000
        inner = _varint_field(1, ts)
        middle = _length_field(1, inner)
        data = _length_field(5, middle)
        result = D.extract_step_payload(data)
        assert result.get('timestamp') == '2024-05-29 16:26:40'

    def test_timestamp_exception_caught(self):
        bad_inner = b'\x08\x80'
        middle = _length_field(1, bad_inner)
        data = _length_field(5, middle)
        result = D.extract_step_payload(data)
        assert 'timestamp' not in result
        assert result == {}

    def test_timestamp_no_sub_tag1(self):
        sub = _varint_field(2, 0)
        middle = _length_field(1, sub)
        data = _length_field(5, middle)
        result = D.extract_step_payload(data)
        assert 'timestamp' not in result

    # -- Tag 20: content, internal_monologue, tool_calls --

    @staticmethod
    def _tag20_blob(content=None, monologue=None, tool_calls=None):
        parts = []
        if content is not None:
            parts.append(_length_field(1, content))
        if monologue is not None:
            parts.append(_length_field(3, monologue))
        if tool_calls:
            for tc in tool_calls:
                parts.append(_length_field(7, tc))
        return b''.join(parts)

    @staticmethod
    def _tc_blob(tc_id=None, name=None, args=None):
        parts = []
        if tc_id is not None:
            parts.append(_length_field(1, tc_id))
        if name is not None:
            parts.append(_length_field(2, name))
        if args is not None:
            parts.append(_length_field(3, args))
        return b''.join(parts)

    def test_content_decode_success(self):
        data = _length_field(20, self._tag20_blob(content=b'Hello'))
        result = D.extract_step_payload(data)
        assert result.get('content') == 'Hello'

    def test_content_decode_failure_caught(self):
        data = _length_field(20, self._tag20_blob(content=b'\xff\xfe'))
        result = D.extract_step_payload(data)
        assert 'content' not in result

    def test_monologue_decode_success(self):
        data = _length_field(20, self._tag20_blob(monologue=b'thinking...'))
        result = D.extract_step_payload(data)
        assert result.get('internal_monologue') == 'thinking...'

    def test_monologue_decode_failure_caught(self):
        data = _length_field(20, self._tag20_blob(monologue=b'\xff\xfe'))
        result = D.extract_step_payload(data)
        assert 'internal_monologue' not in result

    def test_tool_calls_valid_json(self):
        tc = self._tc_blob(tc_id=b'call_1', name=b'my_tool', args=b'{"key":"val"}')
        data = _length_field(20, self._tag20_blob(tool_calls=[tc]))
        result = D.extract_step_payload(data)
        assert len(result['tool_calls']) == 1
        t = result['tool_calls'][0]
        assert t['id'] == 'call_1'
        assert t['name'] == 'my_tool'
        assert t['arguments'] == {"key": "val"}

    def test_tool_calls_invalid_json(self):
        tc = self._tc_blob(tc_id=b'call_2', name=b'another_tool', args=b'not-json')
        data = _length_field(20, self._tag20_blob(tool_calls=[tc]))
        result = D.extract_step_payload(data)
        assert len(result['tool_calls']) == 1
        t = result['tool_calls'][0]
        assert t['id'] == 'call_2'
        assert t['name'] == 'another_tool'
        assert t['arguments'] == 'not-json'

    def test_tool_calls_partial_fields(self):
        tc = self._tc_blob(tc_id=b'call_3')
        data = _length_field(20, self._tag20_blob(tool_calls=[tc]))
        result = D.extract_step_payload(data)
        assert len(result['tool_calls']) == 1
        assert result['tool_calls'][0]['id'] == 'call_3'
        assert 'name' not in result['tool_calls'][0]
        assert 'arguments' not in result['tool_calls'][0]

    def test_multiple_tool_calls(self):
        tc1 = self._tc_blob(tc_id=b'c1', name=b't1', args=b'{}')
        tc2 = self._tc_blob(tc_id=b'c2', name=b't2', args=b'{"a":1}')
        data = _length_field(20, self._tag20_blob(tool_calls=[tc1, tc2]))
        result = D.extract_step_payload(data)
        assert len(result['tool_calls']) == 2
        assert result['tool_calls'][0]['id'] == 'c1'
        assert result['tool_calls'][1]['id'] == 'c2'
        assert result['tool_calls'][1]['arguments'] == {"a": 1}

    def test_no_tool_calls(self):
        data = _length_field(20, self._tag20_blob(content=b'hi'))
        result = D.extract_step_payload(data)
        assert 'tool_calls' not in result
        assert result.get('content') == 'hi'

    def test_tag20_missing(self):
        result = D.extract_step_payload(_varint_field(1, 15))
        assert result.get('type') == 'PLANNER_RESPONSE'
        assert 'content' not in result
        assert 'internal_monologue' not in result
        assert 'tool_calls' not in result

    # -- combined end-to-end --

    def test_full_entry(self):
        ts = 1717000000
        inner = _varint_field(1, ts)
        middle = _length_field(1, inner)
        tag5 = _varint_field(3, 4) + middle

        tc = self._tc_blob(tc_id=b'call_x', name=b'search', args=b'{"q":"test"}')
        tag20 = self._tag20_blob(
            content=b'Hello world',
            monologue=b'Hmm...',
            tool_calls=[tc],
        )

        data = _varint_field(1, 15) + _length_field(5, tag5) + _length_field(20, tag20)
        result = D.extract_step_payload(data)

        assert result['type'] == 'PLANNER_RESPONSE'
        assert result['role'] == 'user'
        assert result['timestamp'] == '2024-05-29 16:26:40'
        assert result['content'] == 'Hello world'
        assert result['internal_monologue'] == 'Hmm...'
        assert len(result['tool_calls']) == 1
        assert result['tool_calls'][0]['id'] == 'call_x'
        assert result['tool_calls'][0]['name'] == 'search'
        assert result['tool_calls'][0]['arguments'] == {"q": "test"}
