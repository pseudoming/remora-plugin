export interface Condition {
	fact: string;
	op: string;
	value: any;
}

export interface Action {
	type: string;
	reasonCode?: string;
	payload?: any;
	platformDirectives?: any;
}

export interface Rule {
	id: string;
	priority: number;
	hookType: string;
	conditions: Condition[];
	action: Action;
}

export type Fact = Record<string, any>;

export interface DecisionResult {
	status: "ALLOW" | "DENY" | "INJECT";
	reasonCode?: string;
	payload?: any;
	platformDirectives?: any;
}
