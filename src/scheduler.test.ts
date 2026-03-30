import { describe, expect, it } from "vitest";
import {
	estimateBlockMinutes,
	type SchedulerContext,
	shouldSchedule,
} from "./scheduler.ts";
import type { CcusageBlock } from "./types.ts";

const makeContext = (
	overrides: Partial<SchedulerContext> = {},
): SchedulerContext => ({
	activeBlock: null,
	nextTaskSize: null,
	currentHourUTC: 3,
	currentDayUTC: 1, // Monday
	isWeekday: true,
	rateLimits: null,
	...overrides,
});

const makeActiveBlock = (
	overrides: Partial<CcusageBlock> = {},
): CcusageBlock => ({
	id: "test",
	startTime: "2026-03-30T17:00:00.000Z",
	endTime: "2026-03-30T22:00:00.000Z",
	actualEndTime: null,
	isActive: true,
	isGap: false,
	entries: 10,
	tokenCounts: {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationInputTokens: 0,
		cacheReadInputTokens: 0,
	},
	totalTokens: 1000,
	costUSD: 1,
	models: ["claude-opus-4-6"],
	burnRate: null,
	projection: {
		totalTokens: 50000,
		totalCost: 30,
		remainingMinutes: 200,
	},
	...overrides,
});

describe("estimateBlockMinutes", () => {
	it("returns 60 for S tasks", () => {
		expect(estimateBlockMinutes("S")).toBe(60);
	});
	it("returns 120 for M tasks", () => {
		expect(estimateBlockMinutes("M")).toBe(120);
	});
	it("returns 180 for L tasks", () => {
		expect(estimateBlockMinutes("L")).toBe(180);
	});
	it("returns 240 for XL tasks", () => {
		expect(estimateBlockMinutes("XL")).toBe(240);
	});
});

describe("shouldSchedule", () => {
	it("returns 'no_tasks' when no task is queued", () => {
		const result = shouldSchedule(makeContext({ nextTaskSize: null }));
		expect(result.decision).toBe("no_tasks");
	});

	it("returns 'window_active' when a block is still active with plenty of time", () => {
		const result = shouldSchedule(
			makeContext({
				activeBlock: makeActiveBlock(),
				nextTaskSize: "M",
			}),
		);
		expect(result.decision).toBe("window_active");
	});

	it("returns 'schedule' when no active block and task is queued during off-peak", () => {
		const result = shouldSchedule(
			makeContext({
				activeBlock: null,
				nextTaskSize: "S",
				currentHourUTC: 3, // off-peak
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("returns 'peak_hours' during peak hours on weekdays", () => {
		const result = shouldSchedule(
			makeContext({
				activeBlock: null,
				nextTaskSize: "S",
				currentHourUTC: 14, // 7am PT = peak
				isWeekday: true,
			}),
		);
		expect(result.decision).toBe("peak_hours");
	});

	it("allows scheduling during peak hours on weekends", () => {
		const result = shouldSchedule(
			makeContext({
				activeBlock: null,
				nextTaskSize: "S",
				currentHourUTC: 14,
				isWeekday: false,
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("returns 'window_expiring_soon' when block expires soon and task fits in next window", () => {
		const result = shouldSchedule(
			makeContext({
				activeBlock: makeActiveBlock({
					projection: {
						totalTokens: 50000,
						totalCost: 30,
						remainingMinutes: 15,
					},
				}),
				nextTaskSize: "S",
				currentHourUTC: 3,
			}),
		);
		expect(result.decision).toBe("window_expiring_soon");
	});

	it("returns 'too_close_to_interactive' if window would expire during likely interactive hours", () => {
		// 3am UTC + 5h window = 8am UTC = 1am PT — not interactive, should schedule
		// But 11am UTC + 5h = 4pm UTC = 9am PT — that's during interactive hours
		const result = shouldSchedule(
			makeContext({
				activeBlock: null,
				nextTaskSize: "S",
				currentHourUTC: 11, // opening window at 11 UTC, expires at 16 UTC (9am PT)
				isWeekday: true,
			}),
		);
		// 16 UTC = 9am PT, which is during typical interactive hours (say 9am-10pm PT)
		expect(result.decision).toBe("too_close_to_interactive");
	});

	it("returns 'weekly_budget_low' when 7-day usage is above threshold", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				currentHourUTC: 3,
				rateLimits: { fiveHourPct: 0, sevenDayPct: 90 },
			}),
		);
		expect(result.decision).toBe("weekly_budget_low");
	});

	it("returns 'window_budget_low' when 5-hour usage is above threshold", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				currentHourUTC: 3,
				rateLimits: { fiveHourPct: 85, sevenDayPct: 30 },
			}),
		);
		expect(result.decision).toBe("window_budget_low");
	});

	it("schedules when rate limits are healthy", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				currentHourUTC: 3,
				rateLimits: { fiveHourPct: 10, sevenDayPct: 30 },
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("schedules when rate limit data is unavailable", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				currentHourUTC: 3,
				rateLimits: null,
			}),
		);
		expect(result.decision).toBe("schedule");
	});
});
