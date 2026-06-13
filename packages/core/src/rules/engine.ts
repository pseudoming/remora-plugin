import { Rule, Fact, DecisionResult, Condition } from "./types";

export class RuleEngine {
  public evaluate(fact: Fact, rules: Rule[]): DecisionResult {
    // Sort rules by priority descending (higher priority evaluates first)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
      if (this.matchesRule(fact, rule)) {
        const action = rule.action;
        return {
          status: action.type.toUpperCase() as "ALLOW" | "DENY",
          reasonCode: action.reasonCode,
          payload: action.payload,
          platformDirectives: action.platformDirectives,
        };
      }
    }

    return { status: "ALLOW" };
  }

  private matchesRule(fact: Fact, rule: Rule): boolean {
    if (!rule.conditions || rule.conditions.length === 0) {
      return false;
    }
    return rule.conditions.every(cond => this.checkCondition(fact, cond));
  }

  private checkCondition(fact: Fact, cond: Condition): boolean {
    const val = fact[cond.fact];
    if (val === undefined) {
      return false;
    }

    switch (cond.op) {
      case "eq":
        return val === cond.value;
      case "neq":
        return val !== cond.value;
      case "contains":
        if (typeof val === "string" && typeof cond.value === "string") {
          return val.includes(cond.value);
        }
        return false;
      case "regex":
        if (typeof val === "string" && typeof cond.value === "string") {
          try {
            const re = new RegExp(cond.value);
            return re.test(val);
          } catch {
            return false;
          }
        }
        return false;
      case "gt":
        return val > cond.value;
      case "lt":
        return val < cond.value;
      default:
        return false;
    }
  }
}
