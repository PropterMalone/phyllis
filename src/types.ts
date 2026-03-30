// pattern: functional-core

// What ccusage `blocks --json` returns per block
export interface CcusageBlock {
	id: string;
	startTime: string;
	endTime: string;
	actualEndTime: string | null;
	isActive: boolean;
	isGap: boolean;
	entries: number;
	tokenCounts: {
		inputTokens: number;
		outputTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	totalTokens: number;
	costUSD: number;
	models: string[];
	burnRate: {
		tokensPerMinute: number;
		costPerHour: number;
	} | null;
	projection: {
		totalTokens: number;
		totalCost: number;
		remainingMinutes: number;
	} | null;
}

export interface CcusageBlocksOutput {
	blocks: CcusageBlock[];
}

// What we write to calibration-log.jsonl
export interface CalibrationEntry {
	user_id: string;
	window_start: string;
	window_end: string;
	observed_at: string;
	tokens_consumed: number;
	cost_equiv: number;
	remaining_min: number | null;
	throttled: null; // can't detect from ccusage — always null for automated entries
	peak_hour: boolean;
	promo_active: boolean;
	model_mix: string[];
	source: "ccusage-harvest" | "ccusage-snapshot";
	notes: string;
}

// Known promo periods — add new ones as Anthropic announces them
export interface PromoRange {
	start: string; // ISO 8601
	end: string; // ISO 8601
	description: string;
}

export const KNOWN_PROMOS: PromoRange[] = [
	{
		start: "2026-03-13T00:00:00Z",
		end: "2026-03-28T23:59:59Z",
		description: "2x usage during off-peak hours",
	},
];
