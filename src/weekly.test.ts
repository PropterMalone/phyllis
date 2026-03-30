import { describe, expect, it } from "vitest";
import type { CalibrationEntry } from "./types.ts";
import { buildWeeklySummary, renderWeeklySummary } from "./weekly.ts";

const makeEntry = (
	windowStart: string,
	tokens: number,
	cost: number,
): CalibrationEntry => ({
	user_id: "karl",
	window_start: windowStart,
	window_end: "",
	observed_at: "",
	tokens_consumed: tokens,
	cost_equiv: cost,
	remaining_min: null,
	throttled: null,
	peak_hour: false,
	promo_active: false,
	model_mix: ["claude-opus-4-6"],
	source: "ccusage-harvest",
	notes: "",
});

describe("buildWeeklySummary", () => {
	it("groups entries by ISO week", () => {
		const entries = [
			// Week 13 (Mon Mar 23 - Sun Mar 29)
			makeEntry("2026-03-23T14:00:00.000Z", 1000, 10),
			makeEntry("2026-03-25T09:00:00.000Z", 2000, 20),
			// Week 14 (Mon Mar 30+)
			makeEntry("2026-03-30T14:00:00.000Z", 500, 5),
		];

		const weeks = buildWeeklySummary(entries);
		expect(weeks).toHaveLength(2);
		expect(weeks[0].blocks).toBe(2);
		expect(weeks[0].totalCost).toBe(30);
		expect(weeks[1].blocks).toBe(1);
		expect(weeks[1].totalCost).toBe(5);
	});

	it("sorts by week ascending", () => {
		const entries = [
			makeEntry("2026-03-30T14:00:00.000Z", 500, 5),
			makeEntry("2026-03-23T14:00:00.000Z", 1000, 10),
		];
		const weeks = buildWeeklySummary(entries);
		expect(weeks[0].weekLabel < weeks[1].weekLabel).toBe(true);
	});

	it("calculates average cost per block", () => {
		const entries = [
			makeEntry("2026-03-23T14:00:00.000Z", 1000, 10),
			makeEntry("2026-03-25T09:00:00.000Z", 2000, 30),
		];
		const weeks = buildWeeklySummary(entries);
		expect(weeks[0].avgCostPerBlock).toBe(20);
	});

	it("returns empty for no entries", () => {
		expect(buildWeeklySummary([])).toEqual([]);
	});

	it("tracks peak vs off-peak blocks", () => {
		const entries = [
			{ ...makeEntry("2026-03-23T14:00:00.000Z", 1000, 10), peak_hour: true },
			makeEntry("2026-03-23T22:00:00.000Z", 2000, 20),
		];
		const weeks = buildWeeklySummary(entries);
		expect(weeks[0].peakBlocks).toBe(1);
		expect(weeks[0].offPeakBlocks).toBe(1);
	});
});

describe("renderWeeklySummary", () => {
	it("produces a table with header, rows, and averages", () => {
		const entries = [
			makeEntry("2026-03-23T14:00:00.000Z", 10000000, 10),
			makeEntry("2026-03-30T14:00:00.000Z", 5000000, 5),
		];
		const weeks = buildWeeklySummary(entries);
		const output = renderWeeklySummary(weeks);
		expect(output).toContain("Week");
		expect(output).toContain("Avg");
	});
});
