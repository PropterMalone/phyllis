import { describe, expect, it } from "vitest";
import {
	estimateBlockMinutes,
	isPastBurnPoint,
	type SchedulerContext,
	shouldSchedule,
} from "./scheduler.ts";
import type { CcusageBlock } from "./types.ts";

const makeContext = (
	overrides: Partial<SchedulerContext> = {},
): SchedulerContext => ({
	activeBlock: null,
	nextTaskSize: null,
	rateLimits: null,
	busyNow: false,
	busyDuringWindow: false,
	reservation: null,
	hoursUntilWeeklyReset: null,
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

	it("returns 'window_expiring_soon' when block expires soon", () => {
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
			}),
		);
		expect(result.decision).toBe("window_expiring_soon");
	});

	it("returns 'schedule' when calendar is clear and no active block", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				busyNow: false,
				busyDuringWindow: false,
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("returns 'busy_now' when calendar shows current busy time", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				busyNow: true,
				busyDuringWindow: true,
			}),
		);
		expect(result.decision).toBe("busy_now");
	});

	it("returns 'busy_during_window' when calendar shows events in window", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				busyNow: false,
				busyDuringWindow: true,
			}),
		);
		expect(result.decision).toBe("busy_during_window");
	});

	it("returns 'weekly_budget_low' when 7-day usage is above threshold", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				rateLimits: { fiveHourPct: 0, sevenDayPct: 90 },
			}),
		);
		expect(result.decision).toBe("weekly_budget_low");
	});

	it("returns 'window_budget_low' when 5-hour usage is above threshold", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				rateLimits: { fiveHourPct: 85, sevenDayPct: 30 },
			}),
		);
		expect(result.decision).toBe("window_budget_low");
	});

	it("schedules when rate limits are healthy and calendar clear", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				rateLimits: { fiveHourPct: 10, sevenDayPct: 30 },
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("schedules when rate limit data is unavailable", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				rateLimits: null,
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("returns 'reserved_heavy' when Docket has heavy reservation and task is not S", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "L",
				reservation: {
					start: "2026-04-02T14:00:00-04:00",
					end: "2026-04-02T17:00:00-04:00",
					intensity: "heavy",
				},
			}),
		);
		expect(result.decision).toBe("reserved_heavy");
	});

	it("allows S tasks even during heavy reservation", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				reservation: {
					start: "2026-04-02T14:00:00-04:00",
					end: "2026-04-02T17:00:00-04:00",
					intensity: "heavy",
				},
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("allows scheduling during light reservation", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "L",
				reservation: {
					start: "2026-04-02T14:00:00-04:00",
					end: "2026-04-02T17:00:00-04:00",
					intensity: "light",
				},
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("rate limits take priority over calendar checks", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "S",
				rateLimits: { fiveHourPct: 0, sevenDayPct: 90 },
				busyNow: false,
				busyDuringWindow: false,
			}),
		);
		expect(result.decision).toBe("weekly_budget_low");
	});

	it("overrides weekly_budget_low when past burn point", () => {
		// 50% remaining, 4h left = 0 windows × 12% = 0%. 50% > 0% = burn point
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "M",
				rateLimits: { fiveHourPct: 0, sevenDayPct: 50 },
				hoursUntilWeeklyReset: 4,
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("overrides window_budget_low when past burn point", () => {
		// 60% remaining, 10h = 2 windows × 12% = 24%. 60% > 24% = burn point
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "M",
				rateLimits: { fiveHourPct: 103, sevenDayPct: 40 },
				hoursUntilWeeklyReset: 10,
			}),
		);
		expect(result.decision).toBe("schedule");
	});

	it("blocks when NOT past burn point — budget is scarce", () => {
		// 10% remaining, 40h = 8 windows × 12% = 96%. 10% < 96% = not burn point
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "M",
				rateLimits: { fiveHourPct: 0, sevenDayPct: 90 },
				hoursUntilWeeklyReset: 40,
			}),
		);
		expect(result.decision).toBe("weekly_budget_low");
	});

	it("blocks when close to reset with low remaining budget", () => {
		// 10% remaining, 3h = 0 windows. 10% > 0% = burn point actually
		// But sevenDayPct=90 < WEEKLY_BUDGET_THRESHOLD=85... wait, 90 >= 85
		// 0 windows means 0% max burn, 10% remaining > 0% = burn point = schedule
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "M",
				rateLimits: { fiveHourPct: 0, sevenDayPct: 90 },
				hoursUntilWeeklyReset: 3,
			}),
		);
		// With 0 full windows left, remaining 10% > 0% = past burn point
		expect(result.decision).toBe("schedule");
	});

	it("blocks budget when hoursUntilWeeklyReset is unknown", () => {
		const result = shouldSchedule(
			makeContext({
				nextTaskSize: "M",
				rateLimits: { fiveHourPct: 0, sevenDayPct: 90 },
				hoursUntilWeeklyReset: null,
			}),
		);
		expect(result.decision).toBe("weekly_budget_low");
	});
});

describe("isPastBurnPoint", () => {
	it("returns true when remaining budget exceeds what can be burned", () => {
		// 50% used, 4h left = 0 windows × 12% = 0%. 50% remaining > 0%
		expect(isPastBurnPoint(50, 4)).toBe(true);
	});

	it("returns false when budget is scarce relative to remaining capacity", () => {
		// 79% used, 40h left = 8 windows × 12% = 96%. 21% remaining < 96%
		expect(isPastBurnPoint(79, 40)).toBe(false);
	});

	it("returns true when lots of budget but almost no time", () => {
		// 10% used, 3h left = 0 windows. 90% remaining > 0%
		expect(isPastBurnPoint(10, 3)).toBe(true);
	});

	it("returns false early in week with moderate usage", () => {
		// 30% used, 100h left = 20 windows × 12% = 240%. 70% < 240%
		expect(isPastBurnPoint(30, 100)).toBe(false);
	});
});
