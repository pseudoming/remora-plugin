import { describe, it, expect } from "vitest";
import { decodeVarint, parseProtobuf, extractStepPayload } from "../src/bridge/step-codec";

// ---------------------------------------------------------------------------
// Helpers for constructing protobuf binary test data
// ---------------------------------------------------------------------------

function encodeVarint(val: number): Buffer {
  const result: number[] = [];
  while (true) {
    let b = val & 0x7f;
    val >>= 7;
    if (val) {
      result.push(b | 0x80);
    } else {
      result.push(b);
      break;
    }
  }
  return Buffer.from(result);
}

function tagType(tag: number, wireType: number): Buffer {
  return encodeVarint((tag << 3) | wireType);
}

function varintField(tag: number, value: number): Buffer {
  return Buffer.concat([tagType(tag, 0), encodeVarint(value)]);
}

function lengthField(tag: number, payload: Buffer): Buffer {
  return Buffer.concat([tagType(tag, 2), encodeVarint(payload.length), payload]);
}

function bit64Field(tag: number, value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([tagType(tag, 1), buf]);
}

function bit32Field(tag: number, value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return Buffer.concat([tagType(tag, 5), buf]);
}

// ===================================================================
// decodeVarint
// ===================================================================

describe("TestDecodeVarint", () => {
  it("test_single_byte", () => {
    const [val, off] = decodeVarint(Buffer.from([0x2e]));
    expect(val).toBe(46);
    expect(off).toBe(1);
  });

  it("test_multi_byte", () => {
    const [val, off] = decodeVarint(Buffer.from([0x80, 0x01]));
    expect(val).toBe(128);
    expect(off).toBe(2);
  });

  it("test_large_value", () => {
    const [val, off] = decodeVarint(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x07]));
    expect(val).toBe(2147483647);
    expect(off).toBe(5);
  });

  it("test_eof_empty", () => {
    expect(() => decodeVarint(Buffer.from([]), 0)).toThrow("Unexpected end of data while reading varint");
  });

  it("test_eof_partial", () => {
    expect(() => decodeVarint(Buffer.from([0x80]), 0)).toThrow("Unexpected end of data while reading varint");
  });

  it("test_eof_with_offset", () => {
    expect(() => decodeVarint(Buffer.from([0x08]), 1)).toThrow("Unexpected end of data while reading varint");
  });

  it("test_offset_used", () => {
    const [val, off] = decodeVarint(Buffer.from([0x00, 0x2e]), 1);
    expect(val).toBe(46);
    expect(off).toBe(2);
  });
});

// ===================================================================
// parseProtobuf
// ===================================================================

describe("TestParseProtobuf", () => {
  it("test_empty", () => {
    expect(parseProtobuf(Buffer.from([]))).toEqual({});
  });

  it("test_varint", () => {
    const result = parseProtobuf(varintField(1, 46));
    expect(result).toEqual({ 1: [46] });
  });

  it("test_multiple_varints_same_tag", () => {
    const result = parseProtobuf(Buffer.concat([varintField(1, 10), varintField(1, 20)]));
    expect(result).toEqual({ 1: [10, 20] });
  });

  it("test_multiple_tags", () => {
    const result = parseProtobuf(Buffer.concat([varintField(1, 10), varintField(2, 20)]));
    expect(result).toEqual({ 1: [10], 2: [20] });
  });

  it("test_length_delimited", () => {
    const result = parseProtobuf(lengthField(2, Buffer.from("hello")));
    expect(result).toEqual({ 2: [Buffer.from("hello")] });
  });

  it("test_64bit", () => {
    const result = parseProtobuf(bit64Field(2, 12345));
    expect(result).toEqual({ 2: [12345] });
  });

  it("test_32bit", () => {
    const result = parseProtobuf(bit32Field(3, 67890));
    expect(result).toEqual({ 3: [67890] });
  });

  it("test_unsupported_wire_type", () => {
    const result = parseProtobuf(tagType(4, 3));
    expect(result).toEqual({ 4: [] });
  });

  it("test_unsupported_wire_type_after_valid", () => {
    const data = Buffer.concat([varintField(1, 99), tagType(4, 6)]);
    const result = parseProtobuf(data);
    expect(result).toEqual({ 1: [99], 4: [] });
  });

  it("test_64bit_truncated", () => {
    const data = Buffer.concat([tagType(2, 1), Buffer.from([0x01, 0x02, 0x03])]);
    const result = parseProtobuf(data);
    expect(result).toEqual({ 2: [] });
  });

  it("test_32bit_truncated", () => {
    const data = Buffer.concat([tagType(3, 5), Buffer.from([0x01])]);
    const result = parseProtobuf(data);
    expect(result).toEqual({ 3: [] });
  });

  it("test_length_delimited_truncated", () => {
    // tag=5, wire_type=2, length=10 (varint 0x0a), payload "abc" (only 3 bytes)
    const data = Buffer.concat([tagType(5, 2), Buffer.from([0x0a]), Buffer.from("abc")]);
    const result = parseProtobuf(data);
    expect(result).toEqual({ 5: [] });
  });

  it("test_eof_in_tag", () => {
    const result = parseProtobuf(Buffer.from([0x80]));
    expect(result).toEqual({});
  });

  it("test_length_delimited_empty", () => {
    const result = parseProtobuf(lengthField(6, Buffer.from([])));
    expect(result).toEqual({ 6: [Buffer.from([])] });
  });
});

// ===================================================================
// extractStepPayload
// ===================================================================

describe("TestExtractStepPayload", () => {
  // -- empty / edge cases --

  it("test_empty_blob_returns_empty_dict", () => {
    expect(extractStepPayload(Buffer.from([]))).toEqual({});
  });

  it("test_none_blob_returns_empty_dict", () => {
    expect(extractStepPayload(null as unknown as Buffer)).toEqual({});
  });

  it("test_parse_exception_returns_empty_dict", () => {
    const data = Buffer.from([0x08, 0x80]);
    expect(extractStepPayload(data)).toEqual({});
  });

  // -- step_type mapping (tag=1, wire_type=0) --

  it("test_step_type_planner_response", () => {
    const result = extractStepPayload(varintField(1, 15));
    expect(result["type"]).toBe("PLANNER_RESPONSE");
  });

  it("test_step_type_user_input", () => {
    const result = extractStepPayload(varintField(1, 14));
    expect(result["type"]).toBe("USER_INPUT");
  });

  it("test_step_type_unknown", () => {
    const result = extractStepPayload(varintField(1, 42));
    expect(result["type"]).toBe("UNKNOWN_42");
  });

  it("test_no_step_type", () => {
    const result = extractStepPayload(varintField(2, 99));
    expect("type" in result).toBe(false);
  });

  // -- role mapping (tag5 -> tag=3, wire_type=0) --

  function tag5WithRole(roleVal: number): Buffer {
    const tag5Blob = varintField(3, roleVal);
    return lengthField(5, tag5Blob);
  }

  it("test_role_user", () => {
    const result = extractStepPayload(tag5WithRole(4));
    expect(result["role"]).toBe("user");
  });

  it("test_role_model", () => {
    const result = extractStepPayload(tag5WithRole(2));
    expect(result["role"]).toBe("model");
  });

  it("test_role_system", () => {
    const result = extractStepPayload(tag5WithRole(5));
    expect(result["role"]).toBe("system");
  });

  it("test_role_unknown", () => {
    const result = extractStepPayload(tag5WithRole(99));
    expect(result["role"]).toBe("unknown_99");
  });

  it("test_no_role", () => {
    const result = extractStepPayload(lengthField(5, Buffer.from([])));
    expect("role" in result).toBe(false);
  });

  // -- timestamp extraction (tag5 -> tag=1 -> tag=1) --

  it("test_timestamp_success", () => {
    const ts = 1717000000;
    const inner = varintField(1, ts);
    const middle = lengthField(1, inner);
    const data = lengthField(5, middle);
    const result = extractStepPayload(data);
    expect(result["timestamp"]).toBe("2024-05-29 16:26:40");
  });

  it("test_timestamp_exception_caught", () => {
    const badInner = Buffer.from([0x08, 0x80]);
    const middle = lengthField(1, badInner);
    const data = lengthField(5, middle);
    const result = extractStepPayload(data);
    expect("timestamp" in result).toBe(false);
    expect(result).toEqual({});
  });

  it("test_timestamp_no_sub_tag1", () => {
    const sub = varintField(2, 0);
    const middle = lengthField(1, sub);
    const data = lengthField(5, middle);
    const result = extractStepPayload(data);
    expect("timestamp" in result).toBe(false);
  });

  // -- Tag 20: content, internal_monologue, tool_calls --

  function tag20Blob(opts: { content?: Buffer; monologue?: Buffer; toolCalls?: Buffer[] }): Buffer {
    const parts: Buffer[] = [];
    if (opts.content !== undefined) {
      parts.push(lengthField(1, opts.content));
    }
    if (opts.monologue !== undefined) {
      parts.push(lengthField(3, opts.monologue));
    }
    if (opts.toolCalls) {
      for (const tc of opts.toolCalls) {
        parts.push(lengthField(7, tc));
      }
    }
    return Buffer.concat(parts);
  }

  function tcBlob(opts: { tcId?: Buffer; name?: Buffer; args?: Buffer }): Buffer {
    const parts: Buffer[] = [];
    if (opts.tcId !== undefined) {
      parts.push(lengthField(1, opts.tcId));
    }
    if (opts.name !== undefined) {
      parts.push(lengthField(2, opts.name));
    }
    if (opts.args !== undefined) {
      parts.push(lengthField(3, opts.args));
    }
    return Buffer.concat(parts);
  }

  it("test_content_decode_success", () => {
    const data = lengthField(20, tag20Blob({ content: Buffer.from("Hello") }));
    const result = extractStepPayload(data);
    expect(result["content"]).toBe("Hello");
  });

  it("test_content_decode_replacement_chars_nodejs", () => {
    // Node.js Buffer.toString('utf-8') never throws; replaces invalid seqs with U+FFFD.
    const data = lengthField(20, tag20Blob({ content: Buffer.from([0xff, 0xfe]) }));
    const result = extractStepPayload(data);
    expect("content" in result).toBe(true);
  });

  it("test_monologue_decode_success", () => {
    const data = lengthField(20, tag20Blob({ monologue: Buffer.from("thinking...") }));
    const result = extractStepPayload(data);
    expect(result["internal_monologue"]).toBe("thinking...");
  });

  it("test_monologue_decode_replacement_chars_nodejs", () => {
    // Node.js Buffer.toString('utf-8') never throws; replaces invalid seqs with U+FFFD.
    const data = lengthField(20, tag20Blob({ monologue: Buffer.from([0xff, 0xfe]) }));
    const result = extractStepPayload(data);
    expect("internal_monologue" in result).toBe(true);
  });

  it("test_tool_calls_valid_json", () => {
    const tc = tcBlob({ tcId: Buffer.from("call_1"), name: Buffer.from("my_tool"), args: Buffer.from('{"key":"val"}') });
    const data = lengthField(20, tag20Blob({ toolCalls: [tc] }));
    const result = extractStepPayload(data);
    expect(result["tool_calls"]).toHaveLength(1);
    const t = result["tool_calls"][0];
    expect(t["id"]).toBe("call_1");
    expect(t["name"]).toBe("my_tool");
    expect(t["arguments"]).toEqual({ key: "val" });
  });

  it("test_tool_calls_invalid_json", () => {
    const tc = tcBlob({ tcId: Buffer.from("call_2"), name: Buffer.from("another_tool"), args: Buffer.from("not-json") });
    const data = lengthField(20, tag20Blob({ toolCalls: [tc] }));
    const result = extractStepPayload(data);
    expect(result["tool_calls"]).toHaveLength(1);
    const t = result["tool_calls"][0];
    expect(t["id"]).toBe("call_2");
    expect(t["name"]).toBe("another_tool");
    expect(t["arguments"]).toBe("not-json");
  });

  it("test_tool_calls_partial_fields", () => {
    const tc = tcBlob({ tcId: Buffer.from("call_3") });
    const data = lengthField(20, tag20Blob({ toolCalls: [tc] }));
    const result = extractStepPayload(data);
    expect(result["tool_calls"]).toHaveLength(1);
    expect(result["tool_calls"][0]["id"]).toBe("call_3");
    expect("name" in result["tool_calls"][0]).toBe(false);
    expect("arguments" in result["tool_calls"][0]).toBe(false);
  });

  it("test_multiple_tool_calls", () => {
    const tc1 = tcBlob({ tcId: Buffer.from("c1"), name: Buffer.from("t1"), args: Buffer.from("{}") });
    const tc2 = tcBlob({ tcId: Buffer.from("c2"), name: Buffer.from("t2"), args: Buffer.from('{"a":1}') });
    const data = lengthField(20, tag20Blob({ toolCalls: [tc1, tc2] }));
    const result = extractStepPayload(data);
    expect(result["tool_calls"]).toHaveLength(2);
    expect(result["tool_calls"][0]["id"]).toBe("c1");
    expect(result["tool_calls"][1]["id"]).toBe("c2");
    expect(result["tool_calls"][1]["arguments"]).toEqual({ a: 1 });
  });

  it("test_no_tool_calls", () => {
    const data = lengthField(20, tag20Blob({ content: Buffer.from("hi") }));
    const result = extractStepPayload(data);
    expect("tool_calls" in result).toBe(false);
    expect(result["content"]).toBe("hi");
  });

  it("test_tag20_missing", () => {
    const result = extractStepPayload(varintField(1, 15));
    expect(result["type"]).toBe("PLANNER_RESPONSE");
    expect("content" in result).toBe(false);
    expect("internal_monologue" in result).toBe(false);
    expect("tool_calls" in result).toBe(false);
  });

  // -- combined end-to-end --

  it("test_full_entry", () => {
    const ts = 1717000000;
    const inner = varintField(1, ts);
    const middle = lengthField(1, inner);
    const tag5 = Buffer.concat([varintField(3, 4), middle]);

    const tc = tcBlob({ tcId: Buffer.from("call_x"), name: Buffer.from("search"), args: Buffer.from('{"q":"test"}') });
    const tag20 = tag20Blob({
      content: Buffer.from("Hello world"),
      monologue: Buffer.from("Hmm..."),
      toolCalls: [tc],
    });

    const data = Buffer.concat([varintField(1, 15), lengthField(5, tag5), lengthField(20, tag20)]);
    const result = extractStepPayload(data);

    expect(result["type"]).toBe("PLANNER_RESPONSE");
    expect(result["role"]).toBe("user");
    expect(result["timestamp"]).toBe("2024-05-29 16:26:40");
    expect(result["content"]).toBe("Hello world");
    expect(result["internal_monologue"]).toBe("Hmm...");
    expect(result["tool_calls"]).toHaveLength(1);
    expect(result["tool_calls"][0]["id"]).toBe("call_x");
    expect(result["tool_calls"][0]["name"]).toBe("search");
    expect(result["tool_calls"][0]["arguments"]).toEqual({ q: "test" });
  });
});
