// pattern: functional-core
// Annotate a calibration entry as throttled — captures the data point
// that ccusage alone can't provide: "this window hit a cap"

import type { CalibrationEntry, CcusageBlock } from "./types.ts";

export interface ThrottleAnnotation {
	entry: CalibrationEntry;
	matched: "active" | "recent";
}

/**
 * Build a throttle calibration entry from the current/recent block.
 * If an active block exists, use it. Otherwise use the most recent completed block.
 */
export function buildThrottleEntry(
	blocks: CcusageBlock[],
	userId: string,
	rateLimits: { fiveHourPct: number; sevenDayPct: number } | null,
	notes?: string,
): ThrottleAnnotation | null {
	// Prefer active block, fall back to most recent
	const active = blocks.find((b) => b.isActive && !b.isGap);
	const recent =
		!active && blocks.length > 0
			? blocks
					.filter((b) => !b.isGap)
					.sort(
						(a, b) =>
							new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
					)[0]
			: null;

	const block = active ?? recent;
	if (!block) return null;

	const now = new Date().toISOString();
	const isPeak = checkPeakHour(new Date(block.startTime));

	const entry: CalibrationEntry = {
		user_id: userId,
		window_start: block.startTime,
		window_end: block.endTime,
		observed_at: now,
		tokens_consumed: block.totalTokens,
		cost_equiv: block.costUSD,
		remaining_min: block.projection?.remainingMinutes ?? null,
		throttled: true,
		peak_hour: isPeak,
		promo_active: false,
		model_mix: block.models,
		source: "manual",
		notes: notes ?? "Throttle annotated via CLI",
		token_breakdown: {
			input: block.tokenCounts.inputTokens,
			output: block.tokenCounts.outputTokens,
			cache_creation: block.tokenCounts.cacheCreationInputTokens,
			cache_read: block.tokenCounts.cacheReadInputTokens,
		},
		...(rateLimits && {
			rate_limits: {
				five_hour_pct: rateLimits.fiveHourPct,
				seven_day_pct: rateLimits.sevenDayPct,
			},
		}),
	};

	return { entry, matched: active ? "active" : "recent" };
}

function checkPeakHour(dt: Date): boolean {
	// Peak = 5am-11am PT (UTC-7) on weekdays
	const ptHour = (dt.getUTCHours() - 7 + 24) % 24;
	const day = dt.getUTCDay();
	return day >= 1 && day <= 5 && ptHour >= 5 && ptHour < 11;
}
