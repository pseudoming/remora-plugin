import Database from "better-sqlite3";
import { getDecisionConfirmed, getConfirmedDecisionIds } from "./storage/decisions";

interface Decision {
  decision?: string;
  rationale?: string;
  inherited_from?: unknown[];
}

interface Topic {
  decisions?: Decision[];
}

/**
 * Calculate a confidence score (0-1) based on how many baseline files and actions
 * are covered by the output topics' decision text and confirmed decision IDs.
 */
export function calculateFactualConfidence(
  baselineFiles: string[],
  baselineActions: string[],
  outputTopics: Topic[],
  conn?: Database
): number {
  if (!baselineFiles.length && !baselineActions.length) {
    return 1.0;
  }

  let coveredFiles = 0;
  let coveredActions = 0;
  let decisionsText = "";

  for (const t of outputTopics) {
    for (const d of t.decisions ?? []) {
      decisionsText +=
        " " +
        (d.decision ?? "").toLowerCase() +
        " " +
        (d.rationale ?? "").toLowerCase();
    }
  }

  for (const f of baselineFiles) {
    if (decisionsText.includes(f.toLowerCase())) {
      coveredFiles += 1;
    }
  }

  for (const action of baselineActions) {
    if (action.startsWith("confirm:")) {
      const decId = action.split(":")[1];
      const decIdNum = parseInt(decId, 10);
      if (!isNaN(decIdNum)) {
        try {
          coveredActions += getDecisionConfirmed(decIdNum, conn) ? 1 : 0;
        } catch {
          // pass
        }
      }
    }
  }

  const totalItems = baselineFiles.length + baselineActions.length;
  const coveredItems = coveredFiles + coveredActions;
  return totalItems > 0 ? Math.min(1.0, coveredItems / totalItems) : 1.0;
}

/**
 * Validate that all confirmed decision IDs from the database are still present
 * in the new topics' `inherited_from` fields.
 *
 * Logs a warning if any confirmed IDs are missing (hard anchor violation).
 */
export function validateIdInheritance(
  projectUuid: string,
  newTopics: Topic[],
  conn?: Database
): boolean {
  const confirmedIds = getConfirmedDecisionIds(projectUuid, conn);
  if (!confirmedIds || confirmedIds.size === 0) {
    return true;
  }

  const inheritedIds = new Set<number>();
  for (const t of newTopics) {
    for (const d of t.decisions ?? []) {
      for (const val of d.inherited_from ?? []) {
        const num = parseInt(String(val), 10);
        if (!isNaN(num)) {
          inheritedIds.add(num);
        }
      }
    }
  }

  const missingIds = new Set(
    [...confirmedIds].filter((x) => !inheritedIds.has(x))
  );
  if (missingIds.size > 0) {
    console.log(
      `REMORA HARD ANCHOR VIOLATION WARNING: user_confirmed=1 IDs lost: ${[
        ...missingIds,
      ]}.`
    );
  }
  return true;
}
