import { describe, expect, it } from "vitest";
import { blockToEntry, isPeakHour, isPromoActive } from "./derive.ts";
import type { CcusageBlock } from "./types.ts";

const baseBlock: CcusageBlock = {
	id: "2026-03-29T16:00:00.000Z",
	startTime: "2026-03-29T16:00:00.000Z",
	endTime: "2026-03-29T21:00:00.000Z",
	actualEndTime: "2026-03-29T18:33:02.432Z",
	isActive: false,
	isGap: false,
	entries: 323,
	tokenCounts: {
		inputTokens: 4688,
		outputTokens: 38346,
		cacheCreationInputTokens: 531092,
		cacheReadInputTokens: 38249059,
	},
	totalTokens: 38823185,
	costUSD: 23.43,
	models: ["claude-opus-4-6"],
	burnRate: null,
	projection: null,
};

describe("isPeakHour", () => {
	it("returns true for weekday 5am PT (12:00 UTC)", () => {
		// Monday 12:00 UTC = Monday 5:00 AM PT
		expect(isPeakHour("2026-03-30T12:00:00Z")).toBe(true);
	});

	it("returns true for weekday 10:59am PT (17:59 UTC)", () => {
		expect(isPeakHour("2026-03-30T17:59:00Z")).toBe(true);
	});

	it("returns false for weekday 11:00am PT (18:00 UTC)", () => {
		expect(isPeakHour("2026-03-30T18:00:00Z")).toBe(false);
	});

	it("returns false for weekday 4:59am PT (11:59 UTC)", () => {
		expect(isPeakHour("2026-03-30T11:59:00Z")).toBe(false);
	});

	it("returns false for weekend even during peak hours", () => {
		// Saturday 14:00 UTC = Saturday 7:00 AM PT (would be peak on weekday)
		expect(isPeakHour("2026-03-28T14:00:00Z")).toBe(false);
	});

	it("returns false for Sunday", () => {
		expect(isPeakHour("2026-03-29T14:00:00Z")).toBe(false);
	});
});

describe("isPromoActive", () => {
	const promos = [
		{
			start: "2026-03-13T00:00:00Z",
			end: "2026-03-28T23:59:59Z",
			description: "test promo",
		},
	];

	it("returns true when timestamp falls within a promo range", () => {
		expect(isPromoActive("2026-03-20T12:00:00Z", promos)).toBe(true);
	});

	it("returns true at promo start boundary", () => {
		expect(isPromoActive("2026-03-13T00:00:00Z", promos)).toBe(true);
	});

	it("returns false before promo starts", () => {
		expect(isPromoActive("2026-03-12T23:59:59Z", promos)).toBe(false);
	});

	it("returns false after promo ends", () => {
		expect(isPromoActive("2026-03-29T00:00:00Z", promos)).toBe(false);
	});

	it("returns false with empty promo list", () => {
		expect(isPromoActive("2026-03-20T12:00:00Z", [])).toBe(false);
	});
});

describe("blockToEntry", () => {
	it("converts a completed block to a calibration entry", () => {
		const entry = blockToEntry(baseBlock, "harvest", "karl");
		expect(entry).toEqual({
			user_id: "karl",
			window_start: "2026-03-29T16:00:00.000Z",
			window_end: "2026-03-29T21:00:00.000Z",
			observed_at: expect.any(String),
			tokens_consumed: 38823185,
			cost_equiv: 23.43,
			remaining_min: null,
			throttled: null,
			peak_hour: false,
			promo_active: false, // promo ended March 28
			model_mix: ["claude-opus-4-6"],
			source: "ccusage-harvest",
			notes: "Auto-harvested from ccusage. 323 entries.",
			token_breakdown: {
				input: 4688,
				output: 38346,
				cache_creation: 531092,
				cache_read: 38249059,
			},
			output_ratio: expect.closeTo(0.891, 2), // 38346 / (4688 + 38346)
			cache_hit_rate: expect.closeTo(0.986, 2), // 38249059 / (38249059 + 4688 + 531092)
		});
	});

	it("computes output_ratio and cache_hit_rate", () => {
		const entry = blockToEntry(baseBlock, "harvest", "karl");
		// output / (input + output) = 38346 / 43034
		expect(entry.output_ratio).toBeGreaterThan(0.8);
		// cache_read / (cache_read + input + cache_creation)
		expect(entry.cache_hit_rate).toBeGreaterThan(0.98);
	});

	it("sets peak_hour based on window start time", () => {
		const peakBlock: CcusageBlock = {
			...baseBlock,
			// Monday 14:00 UTC = Monday 7:00 AM PT = peak
			startTime: "2026-03-30T14:00:00.000Z",
		};
		const entry = blockToEntry(peakBlock, "harvest", "karl");
		expect(entry.peak_hour).toBe(true);
	});

	it("includes remaining_min for active block snapshots", () => {
		const activeBlock: CcusageBlock = {
			...baseBlock,
			isActive: true,
			projection: {
				totalTokens: 135225548,
				totalCost: 81.6,
				remainingMinutes: 207,
			},
		};
		const entry = blockToEntry(activeBlock, "snapshot", "karl");
		expect(entry.remaining_min).toBe(207);
		expect(entry.source).toBe("ccusage-snapshot");
	});

	it("uses user_id from argument", () => {
		const entry = blockToEntry(baseBlock, "harvest", "alice");
		expect(entry.user_id).toBe("alice");
	});

	it("promo_active is false after promo ends", () => {
		// Block starts March 29, promo ended March 28
		const entry = blockToEntry(baseBlock, "harvest", "karl");
		expect(entry.promo_active).toBe(false);
	});
});
