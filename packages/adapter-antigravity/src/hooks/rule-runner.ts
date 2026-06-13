import { RuleEngine, Rule, Fact, IFactExtractor } from "@remora/core";
import { findPluginRoot } from "../bridge/paths";
import * as fs from "node:fs";
import * as path from "node:path";
import { info, error, isRotSensitiveFile } from "@remora/core";

export class AntigravityFactExtractor implements IFactExtractor {
  public extract(rawPayload: Record<string, any>): Fact {
    const toolCall = rawPayload["toolCall"] as Record<string, any> | undefined;
    const toolName = (toolCall?.["name"] as string) ?? "";
    const args = (toolCall?.["args"] as Record<string, any>) ?? {};

    // Determine sandbox escaped
    let isSandboxEscaped = false;
    if (toolName === "invoke_subagent") {
      const subagents = (args["Subagents"] as Array<Record<string, any>>) ?? [];
      for (const sub of subagents) {
        const ws = (sub["Workspace"] as string) ?? "inherit";
        if (ws !== "branch" && ws !== "share") {
          isSandboxEscaped = true;
          break;
        }
      }
    }

    // Determine sensitive log
    let isSensitiveLog = false;
    const absolutePath = (args["AbsolutePath"] as string) ?? "";
    if (absolutePath) {
      if (isRotSensitiveFile(absolutePath)) {
        isSensitiveLog = true;
      }
    }

    return {
      toolName,
      isSandboxEscaped,
      isSensitiveLog,
    };
  }
}

export class RuleRunner {
  private rules: Rule[] = [];
  private loaded = false;

  private loadRules(): void {
    if (this.loaded) return;
    try {
      const pluginRoot = findPluginRoot();
      const rulesPath = path.join(pluginRoot, "conf", "remora-rules.json");
      if (fs.existsSync(rulesPath)) {
        const raw = fs.readFileSync(rulesPath, "utf-8");
        const parsed = JSON.parse(raw);
        this.rules = parsed.rules || [];
      }
      this.loaded = true;
    } catch (e: any) {
      error(`[RuleRunner] failed to load rules: ${e.message}`);
    }
  }

  public runDarkRead(hookType: string, rawContext: Record<string, any>): void {
    try {
      this.loadRules();
      const extractor = new AntigravityFactExtractor();
      const facts = extractor.extract(rawContext);
      const engine = new RuleEngine();
      
      const filteredRules = this.rules.filter(r => r.hookType === hookType);
      const result = engine.evaluate(facts, filteredRules);
      
      info(`[RuleRunner DarkRead] hookType: ${hookType}, facts: ${JSON.stringify(facts)}, result: ${JSON.stringify(result)}`);
    } catch (e: any) {
      error(`[RuleRunner DarkRead] failed: ${e.message}`);
    }
  }
}

export const globalRuleRunner = new RuleRunner();
