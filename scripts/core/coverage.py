import json


def calculate_factual_confidence(conn, baseline_files, baseline_actions, output_topics):
    if not baseline_files and not baseline_actions:
        return 1.0
    covered_files = 0
    covered_actions = 0
    decisions_text = ""
    for t in output_topics:
        for d in t.get("decisions", []):
            decisions_text += " " + d.get("decision", "").lower() + " " + d.get("rationale", "").lower()

    for f in baseline_files:
        if f.lower() in decisions_text:
            covered_files += 1

    for action in baseline_actions:
        if action.startswith("confirm:"):
            dec_id = action.split(":")[1]
            try:
                cursor = conn.execute("SELECT user_confirmed FROM topic_decisions WHERE id=?", (dec_id,))
                row = cursor.fetchone()
                if row and row[0] == 1:
                    covered_actions += 1
            except Exception:
                pass

    total_items = len(baseline_files) + len(baseline_actions)
    covered_items = covered_files + covered_actions
    return min(1.0, covered_items / total_items) if total_items > 0 else 1.0


def validate_id_inheritance(conn, project_uuid, new_topics):
    cursor = conn.execute(
        "SELECT id FROM topic_decisions WHERE project_uuid = ? AND user_confirmed = 1",
        (project_uuid,)
    )
    confirmed_ids = {row[0] for row in cursor.fetchall()}
    if not confirmed_ids:
        return True
    inherited_ids = set()
    for t in new_topics:
        for d in t.get("decisions", []):
            for val in d.get("inherited_from", []):
                try:
                    inherited_ids.add(int(val))
                except (ValueError, TypeError):
                    pass
    missing_ids = confirmed_ids - inherited_ids
    if missing_ids:
        print(f"REMORA HARD ANCHOR VIOLATION WARNING: user_confirmed=1 IDs lost: {list(missing_ids)}.")
    return True
