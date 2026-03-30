// pattern: functional-core

import {
	type CalibrationEntry,
	type CcusageBlock,
	KNOWN_PROMOS,
	type PromoRange,
} from "./types.ts";

// Peak hours: 5am-11am PT weekdays (12:00-18:00 UTC)
// PT is UTC-7 (PDT, which covers March-November)
const PEAK_START_UTC_HOUR = 12;
const PEAK_END_UTC_HOUR = 18;

export function isPeakHour(isoTimestamp: string): boolean {
	const date = new Date(isoTimestamp);
	const day = date.getUTCDay();
	// 0 = Sunday, 6 = Saturday
	if (day === 0 || day === 6) return false;

	const hour = date.getUTCHours();
	return hour >= PEAK_START_UTC_HOUR && hour < PEAK_END_UTC_HOUR;
}

export function isPromoActive(
	isoTimestamp: string,
	promos: PromoRange[],
): boolean {
	const ts = new Date(isoTimestamp).getTime();
	return promos.some((p) => {
		const start = new Date(p.start).getTime();
		const end = new Date(p.end).getTime();
		return ts >= start && ts <= end;
	});
}

function computeOutputRatio(tc: CcusageBlock["tokenCounts"]): number {
	const directIO = tc.inputTokens + tc.outputTokens;
	if (directIO === 0) return 0;
	return tc.outputTokens / directIO;
}

function computeCacheHitRate(tc: CcusageBlock["tokenCounts"]): number {
	const total =
		tc.cacheReadInputTokens + tc.inputTokens + tc.cacheCreationInputTokens;
	if (total === 0) return 0;
	return tc.cacheReadInputTokens / total;
}

export function blockToEntry(
	block: CcusageBlock,
	mode: "harvest" | "snapshot",
	userId: string,
): CalibrationEntry {
	const tc = block.tokenCounts;
	return {
		user_id: userId,
		window_start: block.startTime,
		window_end: block.endTime,
		observed_at: new Date().toISOString(),
		tokens_consumed: block.totalTokens,
		cost_equiv: block.costUSD,
		remaining_min: block.projection?.remainingMinutes ?? null,
		throttled: null,
		peak_hour: isPeakHour(block.startTime),
		promo_active: isPromoActive(block.startTime, KNOWN_PROMOS),
		model_mix: block.models,
		source: mode === "harvest" ? "ccusage-harvest" : "ccusage-snapshot",
		notes: `Auto-${mode === "harvest" ? "harvested from" : "snapshot from"} ccusage. ${block.entries} entries.`,
		token_breakdown: {
			input: tc.inputTokens,
			output: tc.outputTokens,
			cache_creation: tc.cacheCreationInputTokens,
			cache_read: tc.cacheReadInputTokens,
		},
		output_ratio: computeOutputRatio(tc),
		cache_hit_rate: computeCacheHitRate(tc),
	};
}
