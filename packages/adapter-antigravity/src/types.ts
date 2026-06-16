export interface AntigravityInjectStep {
    ephemeralMessage?: string;
    systemMessage?: string;
    decision?: string;
    decision_reason?: string;
    [key: string]: unknown;
}

export interface PreInvocationResponse {
    decision?: "allow" | "deny" | "fallback";
    decision_reason?: string;
    reason?: string;
    injectSteps?: AntigravityInjectStep[];
    terminationBehavior?: string;
    [key: string]: unknown;
}

export interface PreToolUseResponse {
    decision?: "allow" | "deny" | "fallback";
    decision_reason?: string;
    reason?: string;
    injectSteps?: AntigravityInjectStep[];
    [key: string]: unknown;
}

export type AntigravityHookResponse = PreInvocationResponse | PreToolUseResponse;

export interface DynamicRuleContext {
	rawContext: Record<string, unknown>;
	toolName: string;
	args: Record<string, unknown>;
	transcriptPath: string;
	convId: string;
	currentTurnIdx: number;
	isSub: boolean;
	isReadonlySub: boolean;
	isDeepDiverSub: boolean;
	isMergerSub: boolean;
	mode: string;
	subagentType: string | null;
}

export type DynamicRule = (
	ctx: DynamicRuleContext,
) => PreToolUseResponse | undefined;

export interface AntigravityHookContext {
    conversationId?: string;
    workspacePaths?: string[];
    transcriptPath?: string;
    cwd?: string;
    
    // PreInvocation specific
    last_msg?: string | Record<string, unknown>;
    initialNumSteps?: number;
    toolCallResult?: string | Record<string, unknown>;
    
    // PreToolUse specific
    toolCall?: {
        name?: string;
        args?: Record<string, unknown>;
    };
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    
    [key: string]: unknown;
}
