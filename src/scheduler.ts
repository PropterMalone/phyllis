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
	hoursUntilWeeklyReset: number | null; // null = unknown
}

// Don't schedule if weekly budget is above this threshold
const WEEKLY_BUDGET_THRESHOLD = 85;
// Don't schedule if window is above this threshold
const WINDOW_BUDGET_THRESHOLD = 80;
// Estimated per-window capacity as % of weekly budget (empirical)
const WINDOW_WEEKLY_PCT = 12;

/**
 * Are we past the burn point? Remaining weekly budget exceeds what can
 * physically be consumed in the remaining windows before weekly reset.
 * Once past burn point, all budget-based scheduling constraints drop.
 */
export function isPastBurnPoint(
	weeklyPct: number,
	hoursUntilReset: number,
): boolean {
	const remainingPct = 100 - weeklyPct;
	const remainingWindows = Math.floor(hoursUntilReset / 5);
	const maxBurnPct = remainingWindows * WINDOW_WEEKLY_PCT;
	return remainingPct > maxBurnPct;
}

export type SchedulerDecision =
	| { decision: "schedule"; reason: string }
	| { decision: "no_tasks"; reason: string }
	| { decision: "busy_now"; reason: string }
	| { decision: "weekly_budget_low"; reason: string }
	| { decision: "window_budget_low"; reason: string }
	| { decision: "reserved_heavy"; reason: string };

export function shouldSchedule(ctx: SchedulerContext): SchedulerDecision {
	if (ctx.nextTaskSize === null) {
		return { decision: "no_tasks", reason: "no queued tasks" };
	}

	// Phyllis runs inside whatever 5h window is currently open (Karl's
	// anchor script keeps one open continuously). Budget caps below bound
	// how much we consume; we don't gate on active-ness.

	// Check rate limit budgets
	if (ctx.rateLimits) {
		const burnPoint =
			ctx.hoursUntilWeeklyReset != null &&
			isPastBurnPoint(ctx.rateLimits.sevenDayPct, ctx.hoursUntilWeeklyReset);

		if (!burnPoint) {
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
		// Past burn point: skip all budget checks, fire freely
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

	return {
		decision: "schedule",
		reason: "budget healthy, calendar clear for the next 30min",
	};
}
