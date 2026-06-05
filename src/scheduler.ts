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
	reservation: DocketReservation | null; // Docket says the user expects to use Claude
	hoursUntilWeeklyReset: number | null; // null = unknown
}

// Don't schedule if weekly budget is above this threshold
const WEEKLY_BUDGET_THRESHOLD = 85;
// Don't schedule if window is above this threshold
const WINDOW_BUDGET_THRESHOLD = 80;
// Max per-window capacity as % of weekly budget. Burn-point math needs the
// ceiling (what a window *could* burn), not the average — using the average
// triggers "past burn point" too eagerly. old 22 was the PRE-Colossus-1
// per-window ceiling; empirical derivation 2026-05-30 (meter-decomposition +
// ccusage cost-ratio) put one full 5h window at ~11% of weekly, soft because
// ccusage undercounts subagent-heavy windows; 15 is a slightly conservative
// placeholder pending clean Δ7d/Δ5h data from scripts/sample-window-meters.mjs.
const WINDOW_WEEKLY_PCT = 15;

// Minimum unused weekly % to bother sending a burn-point alert.
export const MIN_BURN_FLOOR_PCT = 15;

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

	// Phyllis runs inside whatever 5h window is currently open (the user's
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

	// Docket reservations — the user plans to use Claude interactively
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

/**
 * Should we alert that we're past the burn point? Fail-closed: any missing
 * input or absent held task suppresses the alert. Only alerts when there's
 * enough unused budget to be worth spending (>= MIN_BURN_FLOOR_PCT) and we're
 * physically past the burn point.
 */
export function shouldAlertBurnPoint(args: {
	weeklyPct: number | null;
	hoursUntilReset: number | null;
	hasHeldTask: boolean;
}): boolean {
	if (args.weeklyPct == null) return false;
	if (args.hoursUntilReset == null) return false;
	if (!args.hasHeldTask) return false;
	const remainingPct = 100 - args.weeklyPct;
	if (remainingPct < MIN_BURN_FLOOR_PCT) return false;
	return isPastBurnPoint(args.weeklyPct, args.hoursUntilReset);
}

/**
 * Rate-limit the burn-point alert. Always alert on the first one of a weekly
 * cycle (new sevenDayResetAt) or when no prior alert exists; otherwise wait
 * for minIntervalMs to elapse before re-alerting within the same cycle.
 */
export function shouldSendAlertNow(args: {
	lastAlert: { sevenDayResetAt: number | null; atMs: number } | null;
	sevenDayResetAt: number | null;
	nowMs: number;
	minIntervalMs?: number;
}): boolean {
	const minIntervalMs = args.minIntervalMs ?? 6 * 60 * 60 * 1000;
	if (args.lastAlert == null) return true;
	// New weekly cycle → fresh alert. Only treat as new when BOTH epochs are
	// known and differ; a null on either side means "unknown reset" (stale or
	// flipped source), not a new cycle — fall through to the interval check so a
	// source flip can't masquerade as a new cycle and spam alerts.
	if (
		args.sevenDayResetAt != null &&
		args.lastAlert.sevenDayResetAt != null &&
		args.sevenDayResetAt !== args.lastAlert.sevenDayResetAt
	) {
		return true;
	}
	return args.nowMs - args.lastAlert.atMs >= minIntervalMs;
}

/** Human-readable Signal message for a past-burn-point alert. */
export function formatBurnPointAlert(args: {
	weeklyPct: number;
	fiveHourPct: number;
	hoursUntilReset: number;
	heldTaskName: string;
}): string {
	const remainingPct = 100 - args.weeklyPct;
	const windowsLeft = Math.floor(args.hoursUntilReset / 5);
	return [
		"🔥 Phyllis burn-point",
		`Weekly: ${args.weeklyPct}% used (${remainingPct}% unused, ~${windowsLeft} windows left before reset in ${Math.round(args.hoursUntilReset)}h)`,
		`5h window: ${args.fiveHourPct}% used`,
		`Held reserve ready: ${args.heldTaskName}`,
		"Review + fire with: phyllis fire-burn",
	].join("\n");
}
