import struct
import json

def decode_varint(data, offset=0):
    result = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise EOFError("Unexpected end of data while reading varint")
        b = data[offset]
        offset += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, offset

def parse_protobuf(data):
    """
    Parse a protobuf byte string (flat layer) into a dictionary mapping tags to lists of values.
    Length-delimited values are returned as raw bytes.
    """
    offset = 0
    results = {}
    
    while offset < len(data):
        try:
            tag_type, offset = decode_varint(data, offset)
        except EOFError:
            break
            
        tag = tag_type >> 3
        wire_type = tag_type & 0x07
        
        if tag not in results:
            results[tag] = []
            
        if wire_type == 0: # Varint
            val, offset = decode_varint(data, offset)
            results[tag].append(val)
        elif wire_type == 1: # 64-bit
            if offset + 8 > len(data): break
            val = struct.unpack('<Q', data[offset:offset+8])[0]
            offset += 8
            results[tag].append(val)
        elif wire_type == 2: # Length-delimited
            length, offset = decode_varint(data, offset)
            if offset + length > len(data): break
            val_bytes = data[offset:offset+length]
            offset += length
            results[tag].append(val_bytes)
        elif wire_type == 5: # 32-bit
            if offset + 4 > len(data): break
            val = struct.unpack('<I', data[offset:offset+4])[0]
            offset += 4
            results[tag].append(val)
        else:
            # Unsupported wire type, abort parsing to avoid infinite loop
            break
            
    return results

def extract_step_payload(blob):
    """
    Extracts content, internal_monologue, and tool_calls from a step_payload blob.
    Returns a dictionary simulating a JSONL entry.
    """
    if not blob:
        return {}
        
    try:
        root = parse_protobuf(blob)
    except Exception:
        return {}
        
    entry = {}
    
    step_type_list = root.get(1, [])
    if step_type_list:
        step_type = step_type_list[0]
        if step_type == 15:
            entry['type'] = 'PLANNER_RESPONSE'
        elif step_type == 14:
            entry['type'] = 'USER_INPUT'
        else:
            entry['type'] = f'UNKNOWN_{step_type}'

    tag5s = root.get(5, [])
    for tag5_blob in tag5s:
        try:
            tag5_msg = parse_protobuf(tag5_blob)
            
            # Extract role
            if 3 in tag5_msg:
                role_val = tag5_msg[3][0]
                if role_val == 4:
                    entry['role'] = 'user'
                elif role_val == 2:
                    entry['role'] = 'model'
                elif role_val == 5:
                    entry['role'] = 'system'
                else:
                    entry['role'] = f'unknown_{role_val}'
                    
            # Extract timestamp from Tag 1 -> Tag 1
            if 1 in tag5_msg:
                sub_msg = parse_protobuf(tag5_msg[1][0])
                if 1 in sub_msg:
                    ts_val = sub_msg[1][0]
                    from datetime import datetime, timezone
                    dt = datetime.fromtimestamp(ts_val, timezone.utc)
                    entry['timestamp'] = dt.strftime('%Y-%m-%d %H:%M:%S')
        except Exception:
            pass
            
    tag20s = root.get(20, [])
    for tag20_blob in tag20s:
        # Tag 20 is a nested message containing the core payload
        tag20_msg = parse_protobuf(tag20_blob)
        
        if 1 in tag20_msg:
            try:
                entry['content'] = tag20_msg[1][0].decode('utf-8')
            except Exception:
                pass
        if 3 in tag20_msg:
            try:
                entry['internal_monologue'] = tag20_msg[3][0].decode('utf-8')
            except Exception:
                pass
        
        if 7 in tag20_msg:
            entry['tool_calls'] = []
            for tool_call_blob in tag20_msg[7]:
                tc_msg = parse_protobuf(tool_call_blob)
                tc = {}
                if 1 in tc_msg: tc['id'] = tc_msg[1][0].decode('utf-8')
                if 2 in tc_msg: tc['name'] = tc_msg[2][0].decode('utf-8')
                if 3 in tc_msg:
                    raw_args = tc_msg[3][0].decode('utf-8')
                    try:
                        tc['arguments'] = json.loads(raw_args)
                    except Exception:
                        tc['arguments'] = raw_args
                entry['tool_calls'].append(tc)
                
    return entry
