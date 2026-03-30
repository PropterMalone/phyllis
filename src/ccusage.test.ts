import { describe, expect, it } from "vitest";
import { fetchBlocks, parseCcusageOutput } from "./ccusage.ts";

const sampleOutput = JSON.stringify({
	blocks: [
		{
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
		},
		{
			id: "gap-1",
			startTime: "2026-03-29T21:00:00.000Z",
			endTime: "2026-03-30T17:00:00.000Z",
			actualEndTime: null,
			isActive: false,
			isGap: true,
			entries: 0,
			tokenCounts: {
				inputTokens: 0,
				outputTokens: 0,
				cacheCreationInputTokens: 0,
				cacheReadInputTokens: 0,
			},
			totalTokens: 0,
			costUSD: 0,
			models: [],
			burnRate: null,
			projection: null,
		},
		{
			id: "2026-03-30T17:00:00.000Z",
			startTime: "2026-03-30T17:00:00.000Z",
			endTime: "2026-03-30T22:00:00.000Z",
			actualEndTime: null,
			isActive: true,
			isGap: false,
			entries: 100,
			tokenCounts: {
				inputTokens: 1000,
				outputTokens: 2000,
				cacheCreationInputTokens: 3000,
				cacheReadInputTokens: 4000,
			},
			totalTokens: 10000,
			costUSD: 1.5,
			models: ["claude-opus-4-6"],
			burnRate: { tokensPerMinute: 500, costPerHour: 10 },
			projection: {
				totalTokens: 50000,
				totalCost: 7.5,
				remainingMinutes: 200,
			},
		},
	],
});

describe("parseCcusageOutput", () => {
	it("parses valid JSON and filters out gap blocks", () => {
		const blocks = parseCcusageOutput(sampleOutput);
		expect(blocks).toHaveLength(2);
		expect(blocks.every((b) => !b.isGap)).toBe(true);
	});

	it("returns empty array for empty blocks", () => {
		const blocks = parseCcusageOutput(JSON.stringify({ blocks: [] }));
		expect(blocks).toEqual([]);
	});

	it("throws on invalid JSON", () => {
		expect(() => parseCcusageOutput("not json")).toThrow();
	});

	it("throws on missing blocks field", () => {
		expect(() => parseCcusageOutput(JSON.stringify({ foo: 1 }))).toThrow(
			"missing blocks",
		);
	});
});

describe("fetchBlocks", () => {
	it("calls ccusage with correct flags for recent blocks", async () => {
		const blocks = await fetchBlocks({
			execFn: async () => sampleOutput,
		});
		// Should get 2 non-gap blocks
		expect(blocks).toHaveLength(2);
	});

	it("propagates exec errors", async () => {
		await expect(
			fetchBlocks({
				execFn: async () => {
					throw new Error("ccusage not found");
				},
			}),
		).rejects.toThrow("ccusage not found");
	});
});
