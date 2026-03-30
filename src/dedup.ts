// pattern: imperative-shell

import { readFile } from "node:fs/promises";
import type { CalibrationEntry } from "./types.ts";

// Dedup key: user_id:window_start — allows multiple users in same log
function dedupKey(userId: string, windowStart: string): string {
	return `${userId}:${windowStart}`;
}

export async function readExistingWindowStarts(
	logPath: string,
): Promise<Set<string>> {
	const keys = new Set<string>();
	let content: string;
	try {
		content = await readFile(logPath, "utf-8");
	} catch {
		return keys;
	}

	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as {
				window_start?: string;
				user_id?: string;
			};
			if (entry.window_start) {
				keys.add(dedupKey(entry.user_id ?? "unknown", entry.window_start));
			}
		} catch {
			// skip malformed lines
		}
	}
	return keys;
}

export function filterNovelEntries(
	entries: CalibrationEntry[],
	existing: Set<string>,
): CalibrationEntry[] {
	return entries.filter(
		(e) => !existing.has(dedupKey(e.user_id, e.window_start)),
	);
}
