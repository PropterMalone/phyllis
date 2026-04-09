import { describe, expect, it } from "vitest";
import { buildThrottleEntry } from "./throttle.ts";
import type { CcusageBlock } from "./types.ts";

const makeBlock = (overrides: Partial<CcusageBlock> = {}): CcusageBlock => ({
	id: "2026-04-08T17:00:00.000Z",
	startTime: "2026-04-08T17:00:00.000Z",
	endTime: "2026-04-08T22:00:00.000Z",
	actualEndTime: null,
	isActive: true,
	isGap: false,
	entries: 50,
	tokenCounts: {
		inputTokens: 1000,
		outputTokens: 5000,
		cacheCreationInputTokens: 20000,
		cacheReadInputTokens: 100000,
	},
	totalTokens: 126000,
	costUSD: 45.5,
	models: ["claude-opus-4-6"],
	burnRate: null,
	projection: { totalTokens: 200000, totalCost: 80, remainingMinutes: 120 },
	...overrides,
});

describe("buildThrottleEntry", () => {
	it("builds entry from active block", () => {
		const result = buildThrottleEntry(
			[makeBlock()],
			"karl",
			{ fiveHourPct: 95, sevenDayPct: 79 },
		);
		expect(result).not.toBeNull();
		expect(result!.matched).toBe("active");
		expect(result!.entry.throttled).toBe(true);
		expect(result!.entry.cost_equiv).toBe(45.5);
		expect(result!.entry.tokens_consumed).toBe(126000);
		expect(result!.entry.source).toBe("manual");
		expect(result!.entry.rate_limits).toEqual({
			five_hour_pct: 95,
			seven_day_pct: 79,
		});
	});

	it("falls back to most recent completed block", () => {
		const completed = makeBlock({
			isActive: false,
			actualEndTime: "2026-04-08T22:00:00.000Z",
		});
		const result = buildThrottleEntry([completed], "karl", null);
		expect(result).not.toBeNull();
		expect(result!.matched).toBe("recent");
	});

	it("prefers active over recent", () => {
		const active = makeBlock({ id: "active" });
		const completed = makeBlock({
			id: "old",
			isActive: false,
			startTime: "2026-04-08T12:00:00.000Z",
		});
		const result = buildThrottleEntry([completed, active], "karl", null);
		expect(result!.entry.window_start).toBe("2026-04-08T17:00:00.000Z");
		expect(result!.matched).toBe("active");
	});

	it("skips gap blocks", () => {
		const gap = makeBlock({ isGap: true, isActive: false });
		const result = buildThrottleEntry([gap], "karl", null);
		expect(result).toBeNull();
	});

	it("returns null for empty blocks", () => {
		expect(buildThrottleEntry([], "karl", null)).toBeNull();
	});

	it("includes custom notes", () => {
		const result = buildThrottleEntry(
			[makeBlock()],
			"karl",
			null,
			"Hit 95% warning in 3cblue session",
		);
		expect(result!.entry.notes).toBe(
			"Hit 95% warning in 3cblue session",
		);
	});

	it("omits rate_limits when null", () => {
		const result = buildThrottleEntry([makeBlock()], "karl", null);
		expect(result!.entry.rate_limits).toBeUndefined();
	});

	it("detects peak hour correctly", () => {
		// 17:00 UTC = 10:00 PT = peak (weekday Tue)
		const peakBlock = makeBlock({
			startTime: "2026-04-07T17:00:00.000Z", // Tuesday
		});
		const result = buildThrottleEntry([peakBlock], "karl", null);
		expect(result!.entry.peak_hour).toBe(true);

		// 23:00 UTC = 16:00 PT = off-peak
		const offPeakBlock = makeBlock({
			startTime: "2026-04-07T23:00:00.000Z",
		});
		const result2 = buildThrottleEntry([offPeakBlock], "karl", null);
		expect(result2!.entry.peak_hour).toBe(false);
	});
});
