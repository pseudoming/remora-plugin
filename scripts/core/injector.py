MAX_CHARS = 750

def truncate_decisions(decisions):
    texts = []
    current_len = 0
    for d in decisions:
        text = d["text"]
        if current_len + len(text) > MAX_CHARS:
            texts.append(text[:(MAX_CHARS - current_len)] + "...")
            break
        texts.append(text)
        current_len += len(text)
    return "\n- ".join(texts)
