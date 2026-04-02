// pattern: functional-core
// The scheduler's decision logic — pure functions, no I/O

import type { CcusageBlock, TaskSize } from "./types.ts";

// T-shirt size to estimated block minutes
const SIZE_MINUTES: Record<TaskSize, number> = {
	S: 60,
	M: 120,
	L: 180,
	XL: 240,
};

export function estimateBlockMinutes(size: TaskSize): number {
	return SIZE_MINUTES[size];
}

export interface RateLimitState {
	fiveHourPct: number; // 0-100, from Anthropic's rate_limits
	sevenDayPct: number;
}

export interface DocketReservation {
	start: string; // ISO 8601
	end: string;
	intensity: "light" | "heavy";
}

export interface SchedulerContext {
	activeBlock: CcusageBlock | null;
	nextTaskSize: TaskSize | null;
	rateLimits: RateLimitState | null;
	busyNow: boolean; // any calendar event in the next 30min
	busyDuringWindow: boolean; // any calendar event in the next 5h
	reservation: DocketReservation | null; // Docket says Karl expects to use Claude
}

// Don't schedule if weekly budget is above this threshold
const WEEKLY_BUDGET_THRESHOLD = 85;
// Don't schedule if window is above this threshold
const WINDOW_BUDGET_THRESHOLD = 80;

export type SchedulerDecision =
	| { decision: "schedule"; reason: string }
	| { decision: "no_tasks"; reason: string }
	| { decision: "window_active"; reason: string }
	| { decision: "window_expiring_soon"; reason: string }
	| { decision: "busy_now"; reason: string }
	| { decision: "busy_during_window"; reason: string }
	| { decision: "weekly_budget_low"; reason: string }
	| { decision: "window_budget_low"; reason: string }
	| { decision: "reserved_heavy"; reason: string };

// How many minutes remaining before we consider a window "expiring soon"
const EXPIRY_THRESHOLD_MIN = 30;

export function shouldSchedule(ctx: SchedulerContext): SchedulerDecision {
	if (ctx.nextTaskSize === null) {
		return { decision: "no_tasks", reason: "no queued tasks" };
	}

	// If there's an active window with lots of time, don't open a new one
	if (ctx.activeBlock?.projection) {
		const remaining = ctx.activeBlock.projection.remainingMinutes;
		if (remaining > EXPIRY_THRESHOLD_MIN) {
			return {
				decision: "window_active",
				reason: `active window has ${remaining}min remaining`,
			};
		}
		// Window expiring soon — wait for it to expire, then chain
		return {
			decision: "window_expiring_soon",
			reason: `window expires in ${remaining}min — wait to chain`,
		};
	}

	// Check rate limit budgets before opening a new window
	if (ctx.rateLimits) {
		if (ctx.rateLimits.sevenDayPct >= WEEKLY_BUDGET_THRESHOLD) {
			return {
				decision: "weekly_budget_low",
				reason: `weekly budget at ${ctx.rateLimits.sevenDayPct}% — preserving for interactive use`,
			};
		}
		if (ctx.rateLimits.fiveHourPct >= WINDOW_BUDGET_THRESHOLD) {
			return {
				decision: "window_budget_low",
				reason: `window at ${ctx.rateLimits.fiveHourPct}% — too little headroom for deferrable work`,
			};
		}
	}

	// Docket reservations — Karl plans to use Claude interactively
	if (ctx.reservation?.intensity === "heavy" && ctx.nextTaskSize !== "S") {
		return {
			decision: "reserved_heavy",
			reason:
				"Docket reserved heavy interactive use — deferring non-small tasks",
		};
	}

	// Calendar-aware scheduling — replaces hardcoded peak/interactive hours
	if (ctx.busyNow) {
		return {
			decision: "busy_now",
			reason: "calendar shows busy in the next 30min — defer",
		};
	}

	if (ctx.busyDuringWindow) {
		return {
			decision: "busy_during_window",
			reason: "calendar shows events in the next 5h — window would conflict",
		};
	}

	return {
		decision: "schedule",
		reason: "no active window, calendar clear, budget healthy",
	};
}
