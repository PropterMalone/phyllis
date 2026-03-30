import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harvest, snapshot } from "./harvest.ts";
import type { CcusageBlock } from "./types.ts";

const completedBlock: CcusageBlock = {
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

const activeBlock: CcusageBlock = {
	...completedBlock,
	id: "2026-03-30T17:00:00.000Z",
	startTime: "2026-03-30T17:00:00.000Z",
	endTime: "2026-03-30T22:00:00.000Z",
	actualEndTime: null,
	isActive: true,
	entries: 100,
	totalTokens: 10000,
	costUSD: 1.5,
	projection: { totalTokens: 50000, totalCost: 7.5, remainingMinutes: 200 },
};

async function withTmpLog(
	fn: (logPath: string) => Promise<void>,
): Promise<void> {
	const tmpDir = await mkdtemp(join(tmpdir(), "phyllis-harvest-"));
	const logPath = join(tmpDir, "calibration-log.jsonl");
	try {
		await fn(logPath);
	} finally {
		await rm(tmpDir, { recursive: true });
	}
}

describe("harvest", () => {
	it("appends completed blocks to a new log file", async () => {
		await withTmpLog(async (logPath) => {
			const result = await harvest({
				logPath,
				userId: "karl",
				execFn: async () =>
					JSON.stringify({ blocks: [completedBlock, activeBlock] }),
			});

			expect(result.appended).toBe(1); // only completed block
			const content = await readFile(logPath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0]);
			expect(entry.user_id).toBe("karl");
			expect(entry.source).toBe("ccusage-harvest");
			expect(entry.window_start).toBe("2026-03-29T16:00:00.000Z");
		});
	});

	it("is idempotent — running twice produces no duplicates", async () => {
		await withTmpLog(async (logPath) => {
			const execFn = async () => JSON.stringify({ blocks: [completedBlock] });
			await harvest({ logPath, userId: "karl", execFn });
			const result = await harvest({ logPath, userId: "karl", execFn });

			expect(result.appended).toBe(0);
			const content = await readFile(logPath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(1);
		});
	});

	it("appends to existing log without overwriting", async () => {
		await withTmpLog(async (logPath) => {
			const existingLine = JSON.stringify({
				window_start: "2026-03-28T10:00:00.000Z",
				user_id: "karl",
				notes: "manual entry",
			});
			await writeFile(logPath, `${existingLine}\n`);

			await harvest({
				logPath,
				userId: "karl",
				execFn: async () => JSON.stringify({ blocks: [completedBlock] }),
			});

			const content = await readFile(logPath, "utf-8");
			const lines = content.trim().split("\n");
			expect(lines).toHaveLength(2);
			expect(JSON.parse(lines[0]).notes).toBe("manual entry");
		});
	});

	it("dry run returns count without writing", async () => {
		await withTmpLog(async (logPath) => {
			const result = await harvest({
				logPath,
				userId: "karl",
				dryRun: true,
				execFn: async () => JSON.stringify({ blocks: [completedBlock] }),
			});

			expect(result.appended).toBe(1);
			expect(result.dryRun).toBe(true);
			// File should not exist
			await expect(readFile(logPath, "utf-8")).rejects.toThrow();
		});
	});
});

describe("snapshot", () => {
	it("captures the active block with projection data", async () => {
		await withTmpLog(async (logPath) => {
			const result = await snapshot({
				logPath,
				userId: "karl",
				execFn: async () =>
					JSON.stringify({ blocks: [completedBlock, activeBlock] }),
			});

			expect(result.appended).toBe(1);
			const content = await readFile(logPath, "utf-8");
			const entry = JSON.parse(content.trim());
			expect(entry.source).toBe("ccusage-snapshot");
			expect(entry.remaining_min).toBe(200);
		});
	});

	it("returns 0 when no active block exists", async () => {
		await withTmpLog(async (logPath) => {
			const result = await snapshot({
				logPath,
				userId: "karl",
				execFn: async () => JSON.stringify({ blocks: [completedBlock] }),
			});
			expect(result.appended).toBe(0);
		});
	});
});
