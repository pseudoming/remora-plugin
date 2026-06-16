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
