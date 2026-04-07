// pattern: functional-core
import { describe, expect, it } from "vitest";
import {
	collectDigestEntries,
	computeWeeklyBudget,
	type DigestEntry,
	formatDigestHtml,
	formatSubject,
	lastWeeklyReset,
	parseTaskLog,
	type WeeklyBudget,
} from "./digest.ts";
import type { CcusageBlock, QueuedTask } from "./types.ts";

const NOW = new Date("2026-04-06T12:00:00Z");
const CUTOFF = new Date("2026-04-05T18:00:00Z");

function makeTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
	return {
		id: "abc-123",
		name: "NineAngel: feed-hub full review",
		description: "NineAngel: feed-hub full review",
		size: "L",
		prompt: "run the review",
		project_dir: "/home/karl/Projects/feed-hub",
		priority: 20,
		created_at: "2026-04-05T10:00:00Z",
		status: "done",
		started_at: "2026-04-06T03:00:00Z",
		completed_at: "2026-04-06T03:10:46Z",
		result_summary:
			"**Verdict: CHANGES RECOMMENDED** — 0 critical, 10 important",
		...overrides,
	};
}

describe("parseTaskLog", () => {
	it("extracts tokens and cost from window section", () => {
		const log = `TASK: feed-hub review
SIZE: M
DIR: /home/karl/Projects/feed-hub
DURATION: 611s
STATUS: done

---WINDOW---
5h window: ?% → ?%
7d window: ?% → ?%
block tokens: ? → 1590858
block cost: $? → $2.7378985000000005

---PROMPT---
run the review

---STDOUT---
done

---STDERR---
`;
		const result = parseTaskLog(log);
		expect(result.tokensBefore).toBeNull();
		expect(result.tokensAfter).toBe(1590858);
		expect(result.costBefore).toBeNull();
		expect(result.costAfter).toBeCloseTo(2.74, 1);
	});

	it("extracts deltas when both before and after exist", () => {
		const log = `TASK: test
SIZE: S
DIR: /tmp
DURATION: 60s
STATUS: done

---WINDOW---
5h window: 10% → 15%
7d window: 20% → 25%
block tokens: 100000 → 200000
block cost: $1.50 → $3.00

---PROMPT---
test

---STDOUT---
ok

---STDERR---
`;
		const result = parseTaskLog(log);
		expect(result.tokensBefore).toBe(100000);
		expect(result.tokensAfter).toBe(200000);
		expect(result.costBefore).toBeCloseTo(1.5);
		expect(result.costAfter).toBeCloseTo(3.0);
	});

	it("extracts stderr content", () => {
		const log = `TASK: test
SIZE: S
DIR: /tmp
DURATION: 60s
STATUS: done

---WINDOW---
block tokens: ? → 100
block cost: $? → $0.01

---PROMPT---
test

---STDOUT---
ok

---STDERR---
SessionEnd hook failed: Hook cancelled
Something else broke
`;
		const result = parseTaskLog(log);
		expect(result.stderr).toContain("Hook cancelled");
	});

	it("returns nulls for unparseable log", () => {
		const result = parseTaskLog("garbage");
		expect(result.tokensBefore).toBeNull();
		expect(result.tokensAfter).toBeNull();
		expect(result.costBefore).toBeNull();
		expect(result.costAfter).toBeNull();
		expect(result.stderr).toBe("");
	});
});

describe("collectDigestEntries", () => {
	it("includes tasks completed after cutoff", () => {
		const tasks = [
			makeTask({ completed_at: "2026-04-06T03:00:00Z", status: "done" }),
			makeTask({
				id: "old",
				completed_at: "2026-04-04T10:00:00Z",
				status: "done",
			}),
		];
		const entries = collectDigestEntries(tasks, CUTOFF);
		expect(entries).toHaveLength(1);
		expect(entries[0].task.id).toBe("abc-123");
	});

	it("includes failed tasks after cutoff", () => {
		const tasks = [
			makeTask({
				status: "failed",
				completed_at: "2026-04-06T01:00:00Z",
				result_summary: "timeout after 30m",
			}),
		];
		const entries = collectDigestEntries(tasks, CUTOFF);
		expect(entries).toHaveLength(1);
		expect(entries[0].task.status).toBe("failed");
	});

	it("excludes queued and running tasks", () => {
		const tasks = [
			makeTask({ status: "queued", completed_at: undefined }),
			makeTask({ status: "running", completed_at: undefined }),
		];
		const entries = collectDigestEntries(tasks, CUTOFF);
		expect(entries).toHaveLength(0);
	});

	it("sorts by started_at ascending", () => {
		const tasks = [
			makeTask({
				id: "b",
				name: "second",
				started_at: "2026-04-06T04:00:00Z",
				completed_at: "2026-04-06T05:00:00Z",
			}),
			makeTask({
				id: "a",
				name: "first",
				started_at: "2026-04-06T02:00:00Z",
				completed_at: "2026-04-06T03:00:00Z",
			}),
		];
		const entries = collectDigestEntries(tasks, CUTOFF);
		expect(entries[0].task.name).toBe("first");
		expect(entries[1].task.name).toBe("second");
	});
});

describe("formatSubject", () => {
	it("formats with done and failed counts", () => {
		const subject = formatSubject(5, 2, NOW);
		expect(subject).toBe("Phyllis overnight — Apr 6: 5 done, 2 failed");
	});

	it("omits failed when zero", () => {
		const subject = formatSubject(3, 0, NOW);
		expect(subject).toBe("Phyllis overnight — Apr 6: 3 done");
	});

	it("handles all-failed", () => {
		const subject = formatSubject(0, 2, NOW);
		expect(subject).toBe("Phyllis overnight — Apr 6: 0 done, 2 failed");
	});
});

describe("formatDigestHtml", () => {
	it("renders a complete digest with task table", () => {
		const entries: DigestEntry[] = [
			{
				task: makeTask(),
				durationMin: 10.8,
				tokensDelta: 90000,
				costDelta: 1.24,
				stderr: "",
			},
			{
				task: makeTask({
					id: "def-456",
					name: "3CB R8 re-eval",
					size: "M",
					status: "failed",
					result_summary: "timeout after 30m",
				}),
				durationMin: 30,
				tokensDelta: null,
				costDelta: null,
				stderr: "process timed out",
			},
		];
		const html = formatDigestHtml(entries, 3, NOW);

		// Contains header
		expect(html).toContain("Phyllis Overnight Digest");
		expect(html).toContain("Apr 6");

		// Contains summary stats
		expect(html).toContain("1 done");
		expect(html).toContain("1 failed");

		// Contains task names
		expect(html).toContain("NineAngel: feed-hub full review");
		expect(html).toContain("3CB R8 re-eval");

		// Contains result summary
		expect(html).toContain("CHANGES RECOMMENDED");

		// Contains failed task error
		expect(html).toContain("timeout after 30m");

		// Contains footer with queue remaining
		expect(html).toContain("3 tasks remaining");

		// Is valid-ish HTML
		expect(html).toContain("<html");
		expect(html).toContain("</html>");
	});

	it("renders empty digest when no tasks ran", () => {
		const html = formatDigestHtml([], 0, NOW);
		expect(html).toContain("Nothing ran overnight");
	});

	it("includes budget section with burn point when provided", () => {
		const budget: WeeklyBudget = {
			resetTime: "2026-04-10T19:00:00.000Z",
			hoursUntilReset: 103,
			hoursElapsed: 65,
			blocksSinceReset: 14,
			tokensSinceReset: 327_000_000,
			costSinceReset: 232.27,
			windowsRemaining: 20,
			avgCostPerBlock: 16.59,
			blocksPerDay: 5.2,
			sessionsAtCurrentRate: 22,
			dayOfWeek: 1,
			healthLabel: "moderate",
			pastBurnPoint: false,
			burnPointNote:
				"Budget-limited: projecting 22 sessions but only 20 windows remain.",
		};
		const html = formatDigestHtml([], 0, NOW, budget);
		expect(html).toContain("Weekly Budget");
		expect(html).toContain("14");
		expect(html).toContain("$232.27");
		expect(html).toContain("~20");
		expect(html).toContain("Moderate");
		expect(html).toContain("5.2");
		expect(html).toContain("Budget-limited");
	});

	it("shows past-burn-point when window-limited", () => {
		const budget: WeeklyBudget = {
			resetTime: "2026-04-10T19:00:00.000Z",
			hoursUntilReset: 103,
			hoursElapsed: 65,
			blocksSinceReset: 5,
			tokensSinceReset: 50_000_000,
			costSinceReset: 40.0,
			windowsRemaining: 20,
			avgCostPerBlock: 8.0,
			blocksPerDay: 1.8,
			sessionsAtCurrentRate: 8,
			dayOfWeek: 1,
			healthLabel: "healthy",
			pastBurnPoint: true,
			burnPointNote: "Past burn point: fire freely.",
		};
		const html = formatDigestHtml([], 0, NOW, budget);
		expect(html).toContain("Past burn point");
	});
});

function makeBlock(overrides: Partial<CcusageBlock> = {}): CcusageBlock {
	return {
		id: "block-1",
		startTime: "2026-04-05T00:00:00Z",
		endTime: "2026-04-05T05:00:00Z",
		actualEndTime: "2026-04-05T04:30:00Z",
		isActive: false,
		isGap: false,
		entries: 10,
		tokenCounts: {
			inputTokens: 100000,
			outputTokens: 50000,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		},
		totalTokens: 150000,
		costUSD: 5.0,
		models: ["claude-opus-4-6"],
		burnRate: null,
		projection: null,
		...overrides,
	};
}

describe("lastWeeklyReset", () => {
	it("finds most recent Friday 19:00 UTC", () => {
		// 2026-04-06 is a Monday
		const reset = lastWeeklyReset(new Date("2026-04-06T12:00:00Z"));
		expect(reset.toISOString()).toBe("2026-04-03T19:00:00.000Z");
	});

	it("returns current Friday if past 19:00 UTC on Friday", () => {
		const reset = lastWeeklyReset(new Date("2026-04-03T20:00:00Z"));
		expect(reset.toISOString()).toBe("2026-04-03T19:00:00.000Z");
	});

	it("returns previous Friday if before 19:00 UTC on Friday", () => {
		const reset = lastWeeklyReset(new Date("2026-04-03T18:00:00Z"));
		expect(reset.toISOString()).toBe("2026-03-27T19:00:00.000Z");
	});
});

describe("computeWeeklyBudget", () => {
	it("aggregates blocks since last reset with burn point", () => {
		const blocks = [
			makeBlock({
				startTime: "2026-04-01T00:00:00Z",
				totalTokens: 100000,
				costUSD: 1.0,
			}), // before reset
			makeBlock({
				startTime: "2026-04-04T00:00:00Z",
				totalTokens: 200000,
				costUSD: 2.0,
			}), // after reset
			makeBlock({
				startTime: "2026-04-05T10:00:00Z",
				totalTokens: 300000,
				costUSD: 3.0,
			}), // after reset
		];
		const budget = computeWeeklyBudget(
			blocks,
			new Date("2026-04-06T12:00:00Z"),
		);
		expect(budget.blocksSinceReset).toBe(2);
		expect(budget.tokensSinceReset).toBe(500000);
		expect(budget.costSinceReset).toBeCloseTo(5.0);
		expect(budget.hoursUntilReset).toBeCloseTo(103, 0);
		expect(budget.windowsRemaining).toBe(20);
		expect(budget.avgCostPerBlock).toBeCloseTo(2.5);
		expect(budget.blocksPerDay).toBeGreaterThan(0);
		// 2 blocks in ~2.7 days = ~0.74/day, ~3.2 projected vs 20 windows → past burn point
		expect(budget.pastBurnPoint).toBe(true);
		expect(budget.burnPointNote).toContain("Past burn point");
	});

	it("excludes gap blocks", () => {
		const blocks = [
			makeBlock({
				startTime: "2026-04-04T00:00:00Z",
				isGap: true,
				totalTokens: 999999,
			}),
			makeBlock({
				startTime: "2026-04-04T05:00:00Z",
				totalTokens: 100000,
				costUSD: 1.0,
			}),
		];
		const budget = computeWeeklyBudget(
			blocks,
			new Date("2026-04-06T12:00:00Z"),
		);
		expect(budget.blocksSinceReset).toBe(1);
		expect(budget.tokensSinceReset).toBe(100000);
	});
});
