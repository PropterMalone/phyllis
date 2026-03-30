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

export interface SchedulerContext {
	activeBlock: CcusageBlock | null;
	nextTaskSize: TaskSize | null;
	currentHourUTC: number;
	currentDayUTC: number; // 0=Sun, 6=Sat
	isWeekday: boolean;
}

export type SchedulerDecision =
	| { decision: "schedule"; reason: string }
	| { decision: "no_tasks"; reason: string }
	| { decision: "window_active"; reason: string }
	| { decision: "window_expiring_soon"; reason: string }
	| { decision: "peak_hours"; reason: string }
	| { decision: "too_close_to_interactive"; reason: string };

// Peak hours: 5am-11am PT = 12:00-18:00 UTC on weekdays
const PEAK_START_UTC = 12;
const PEAK_END_UTC = 18;

// Interactive hours: 9am-10pm PT = 16:00-05:00 UTC (wraps midnight)
// If opening a new 5h window would expire during these hours on a weekday, defer
const INTERACTIVE_START_UTC = 16;
const INTERACTIVE_END_UTC = 5;

// Window duration
const WINDOW_HOURS = 5;

// How many minutes remaining before we consider a window "expiring soon"
const EXPIRY_THRESHOLD_MIN = 30;

function isInPeakHours(hourUTC: number, isWeekday: boolean): boolean {
	if (!isWeekday) return false;
	return hourUTC >= PEAK_START_UTC && hourUTC < PEAK_END_UTC;
}

function wouldExpireDuringInteractive(
	hourUTC: number,
	isWeekday: boolean,
): boolean {
	if (!isWeekday) return false;
	const expiryHour = (hourUTC + WINDOW_HOURS) % 24;
	// Interactive window wraps midnight: 16 UTC to 05 UTC
	if (INTERACTIVE_START_UTC > INTERACTIVE_END_UTC) {
		return (
			expiryHour >= INTERACTIVE_START_UTC || expiryHour < INTERACTIVE_END_UTC
		);
	}
	return (
		expiryHour >= INTERACTIVE_START_UTC && expiryHour < INTERACTIVE_END_UTC
	);
}

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

	// No active window — should we open one?
	if (isInPeakHours(ctx.currentHourUTC, ctx.isWeekday)) {
		return {
			decision: "peak_hours",
			reason: "peak hours (5am-11am PT weekdays) — reduced limits, defer",
		};
	}

	if (wouldExpireDuringInteractive(ctx.currentHourUTC, ctx.isWeekday)) {
		return {
			decision: "too_close_to_interactive",
			reason: `window opened now would expire during interactive hours — defer`,
		};
	}

	return {
		decision: "schedule",
		reason: "no active window, off-peak, won't conflict with interactive use",
	};
}
