// pattern: imperative-shell

import { appendFile } from "node:fs/promises";
import { fetchBlocks } from "./ccusage.ts";
import { filterNovelEntries, readExistingWindowStarts } from "./dedup.ts";
import { blockToEntry } from "./derive.ts";
import type { CalibrationEntry } from "./types.ts";

export interface HarvestOptions {
	logPath: string;
	userId: string;
	dryRun?: boolean;
	execFn?: () => Promise<string>;
}

export interface HarvestResult {
	appended: number;
	dryRun: boolean;
	entries: CalibrationEntry[];
}

export async function harvest(options: HarvestOptions): Promise<HarvestResult> {
	const { logPath, userId, dryRun = false, execFn } = options;

	const blocks = await fetchBlocks({ execFn });
	const completedBlocks = blocks.filter((b) => !b.isActive);
	const entries = completedBlocks.map((b) =>
		blockToEntry(b, "harvest", userId),
	);

	const existing = await readExistingWindowStarts(logPath);
	const novel = filterNovelEntries(entries, existing);

	if (!dryRun && novel.length > 0) {
		const lines = novel.map((e) => JSON.stringify(e)).join("\n");
		await appendFile(logPath, `${lines}\n`);
	}

	return { appended: novel.length, dryRun, entries: novel };
}

export async function snapshot(
	options: HarvestOptions,
): Promise<HarvestResult> {
	const { logPath, userId, dryRun = false, execFn } = options;

	const blocks = await fetchBlocks({ execFn });
	const activeBlock = blocks.find((b) => b.isActive);

	if (!activeBlock) {
		return { appended: 0, dryRun, entries: [] };
	}

	const entry = blockToEntry(activeBlock, "snapshot", userId);

	if (!dryRun) {
		await appendFile(logPath, `${JSON.stringify(entry)}\n`);
	}

	return { appended: 1, dryRun, entries: [entry] };
}
