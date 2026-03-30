import { describe, expect, it } from "vitest";
import type { CcusageSession } from "./analyze.ts";
import {
	buildHeatmap,
	buildProjectSummary,
	extractProject,
	renderHeatmap,
	renderProjectTable,
} from "./analyze.ts";
import type { CalibrationEntry } from "./types.ts";

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

describe("buildHeatmap", () => {
	it("aggregates entries into day×hour cells", () => {
		const entries = [
			// Monday 14:00 UTC
			makeEntry("2026-03-30T14:00:00.000Z", 1000, 10),
			// Another Monday 14:00 UTC (different week)
			makeEntry("2026-03-23T14:00:00.000Z", 2000, 20),
			// Tuesday 09:00 UTC
			makeEntry("2026-03-25T09:00:00.000Z", 500, 5),
		];

		const heatmap = buildHeatmap(entries);
		expect(heatmap.cells).toHaveLength(2); // Mon@14, Tue@9

		const monCell = heatmap.cells.find((c) => c.day === 1 && c.hour === 14);
		expect(monCell?.totalTokens).toBe(3000);
		expect(monCell?.totalCost).toBe(30);
		expect(monCell?.count).toBe(2);
	});

	it("returns zero maxes for empty input", () => {
		const heatmap = buildHeatmap([]);
		expect(heatmap.cells).toHaveLength(0);
		expect(heatmap.maxTokens).toBe(0);
		expect(heatmap.maxCost).toBe(0);
	});

	it("tracks max values correctly", () => {
		const entries = [
			makeEntry("2026-03-30T14:00:00.000Z", 5000, 50),
			makeEntry("2026-03-25T09:00:00.000Z", 1000, 10),
		];
		const heatmap = buildHeatmap(entries);
		expect(heatmap.maxTokens).toBe(5000);
		expect(heatmap.maxCost).toBe(50);
	});
});

describe("renderHeatmap", () => {
	it("produces 7 day rows plus header and legend", () => {
		const entries = [makeEntry("2026-03-30T14:00:00.000Z", 1000, 10)];
		const heatmap = buildHeatmap(entries);
		const output = renderHeatmap(heatmap);
		const lines = output.split("\n");

		// header + 7 days + blank + legend = 10
		expect(lines).toHaveLength(10);
		expect(lines[0]).toContain("UTC");
		expect(lines[1]).toMatch(/^Sun/);
		expect(lines[7]).toMatch(/^Sat/);
	});

	it("shows max intensity for the highest cell", () => {
		const entries = [makeEntry("2026-03-30T14:00:00.000Z", 1000, 10)];
		const heatmap = buildHeatmap(entries);
		const output = renderHeatmap(heatmap, "cost");
		// Monday row should contain the max block
		expect(output).toContain("█");
	});
});

describe("extractProject", () => {
	it("extracts project name from session ID", () => {
		expect(extractProject("-home-karl-Projects-3cblue")).toBe("3cblue");
	});

	it("handles nested project paths", () => {
		expect(extractProject("-home-karl-Projects-gsdat-jeffwolf")).toBe(
			"gsdat-jeffwolf",
		);
	});

	it("returns raw ID if no Projects match", () => {
		expect(extractProject("-home-karl")).toBe("-home-karl");
	});
});

describe("buildProjectSummary", () => {
	const sessions: CcusageSession[] = [
		{
			sessionId: "-home-karl-Projects-3cblue",
			totalTokens: 100000,
			totalCost: 50,
			lastActivity: "2026-03-30",
			modelsUsed: ["claude-opus-4-6"],
			projectPath: "",
		},
		{
			sessionId: "-home-karl-Projects-3cblue",
			totalTokens: 200000,
			totalCost: 100,
			lastActivity: "2026-03-29",
			modelsUsed: ["claude-opus-4-6"],
			projectPath: "",
		},
		{
			sessionId: "-home-karl-Projects-starcounter",
			totalTokens: 50000,
			totalCost: 25,
			lastActivity: "2026-03-28",
			modelsUsed: ["claude-sonnet-4-6"],
			projectPath: "",
		},
	];

	it("aggregates sessions by project", () => {
		const summaries = buildProjectSummary(sessions);
		expect(summaries).toHaveLength(2);
	});

	it("sorts by cost descending", () => {
		const summaries = buildProjectSummary(sessions);
		expect(summaries[0].project).toBe("3cblue");
		expect(summaries[0].totalCost).toBe(150);
		expect(summaries[0].sessions).toBe(2);
	});

	it("tracks last activity date", () => {
		const summaries = buildProjectSummary(sessions);
		expect(summaries[0].lastActivity).toBe("2026-03-30");
	});
});

describe("renderProjectTable", () => {
	it("includes header, data rows, and total", () => {
		const summaries = buildProjectSummary([
			{
				sessionId: "-home-karl-Projects-foo",
				totalTokens: 1000,
				totalCost: 10,
				lastActivity: "2026-03-30",
				modelsUsed: [],
				projectPath: "",
			},
		]);
		const output = renderProjectTable(summaries);
		expect(output).toContain("Project");
		expect(output).toContain("foo");
		expect(output).toContain("TOTAL");
		expect(output).toContain("10.00");
	});
});
