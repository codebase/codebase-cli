export interface PlanOption {
	id: string;
	label: string;
	description?: string;
}

export interface PlanQuestion {
	id: string;
	question: string;
	options?: PlanOption[];
}

export interface QAPair {
	question: string;
	answer: string;
}

export interface PlanState {
	originalPrompt: string;
	qaHistory: QAPair[];
	currentQuestion?: PlanQuestion;
	plan?: string;
	done: boolean;
}

/** Special return value from parseAnswer when the user types "skip the rest, start". */
export const ANSWER_START_BUILDING = "__START_BUILDING__";
