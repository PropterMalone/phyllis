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
// Two granularities: block-level (from ccusage harvest) and session-level (from hooks)
export interface CalibrationEntry {
	user_id: string;
	session_id?: string; // present for session-level entries
	window_start: string;
	window_end: string;
	observed_at: string;
	tokens_consumed: number; // block-level total (legacy compat)
	cost_equiv: number; // block-level cost (legacy compat)
	remaining_min: number | null;
	throttled: null | boolean; // null = unknown (automated), true/false = manual observation
	peak_hour: boolean;
	promo_active: boolean;
	model_mix: string[];
	source:
		| "ccusage-harvest"
		| "ccusage-snapshot"
		| "session-end-hook"
		| "manual"
		| "proxy-reset"
		| "proxy-threshold"
		| "proxy-429";
	notes: string;

	// Block-level token breakdown
	token_breakdown?: {
		input: number;
		output: number;
		cache_creation: number;
		cache_read: number;
	};
	output_ratio?: number; // output / (input + output), 0-1
	cache_hit_rate?: number; // cache_read / (cache_read + input + cache_creation), 0-1

	// Session-level attribution (only for session-end-hook entries)
	session_tokens?: number;
	session_cost?: number;
	session_breakdown?: {
		input: number;
		output: number;
		cache_creation: number;
		cache_read: number;
	};

	// Rate limit state at time of observation
	rate_limits?: {
		five_hour_pct: number;
		seven_day_pct: number;
	};
}

// User profile — context for interpreting calibration data across users
export interface UserProfile {
	user_id: string;
	plan: "free" | "pro" | "max5" | "max20" | "team" | "enterprise";
	timezone: string; // IANA, e.g. "America/New_York"
	extra_usage_enabled: boolean;
	primary_model: string; // e.g. "claude-opus-4-6"

	// Access method
	primary_client:
		| "claude-code"
		| "claude-web"
		| "claude-desktop"
		| "vscode"
		| "jetbrains"
		| "cursor"
		| "windsurf"
		| "other";
	multiple_clients: boolean; // uses >1 client against same pool

	// Configuration overhead — affects token burn per interaction
	config_overhead?: {
		claude_md_lines: number; // total CLAUDE.md + rules file lines
		mcp_server_count: number;
		hook_count: number;
	};

	// Environment
	os?: "linux" | "macos" | "windows";
	region?: string; // rough geographic region, e.g. "us-east", "eu-west"

	notes?: string;
}

// Deferrable task for the scheduling queue
export type TaskSize = "S" | "M" | "L" | "XL";

export interface QueuedTask {
	id: string;
	name: string;
	description: string;
	size: TaskSize;
	prompt: string; // the actual prompt to pass to `claude -p`
	project_dir: string; // working directory for the task
	priority: number; // lower = higher priority
	created_at: string;
	status: "queued" | "running" | "done" | "failed";
	started_at?: string;
	completed_at?: string;
	result_summary?: string;
	preflight?: string;
}

// Calendar event representing a Phyllis-scheduled task
export interface PhyllisEvent {
	summary: string;
	startTime: string; // ISO 8601
	endTime: string; // ISO 8601
	description?: string;
	status: "running" | "done" | "failed";
	eventId?: string; // set after creation
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
