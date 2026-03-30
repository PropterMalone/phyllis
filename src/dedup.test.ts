import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filterNovelEntries, readExistingWindowStarts } from "./dedup.ts";
import type { CalibrationEntry } from "./types.ts";

const makeEntry = (windowStart: string): CalibrationEntry => ({
	user_id: "karl",
	window_start: windowStart,
	window_end: "2026-03-29T21:00:00.000Z",
	observed_at: "2026-03-29T18:00:00.000Z",
	tokens_consumed: 1000,
	cost_equiv: 1.0,
	remaining_min: null,
	throttled: null,
	peak_hour: false,
	promo_active: false,
	model_mix: ["claude-opus-4-6"],
	source: "ccusage-harvest",
	notes: "test",
});

describe("readExistingWindowStarts", () => {
	let tmpDir: string;

	it("returns empty set for nonexistent file", async () => {
		const starts = await readExistingWindowStarts("/nonexistent/path.jsonl");
		expect(starts.size).toBe(0);
	});

	it("extracts window_start values from JSONL", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "phyllis-test-"));
		const logPath = join(tmpDir, "log.jsonl");
		const lines = [
			JSON.stringify({
				window_start: "2026-03-29T16:00:00.000Z",
				user_id: "karl",
			}),
			JSON.stringify({
				window_start: "2026-03-30T17:00:00.000Z",
				user_id: "karl",
			}),
		].join("\n");
		await writeFile(logPath, lines);

		const starts = await readExistingWindowStarts(logPath);
		expect(starts).toEqual(
			new Set([
				"karl:2026-03-29T16:00:00.000Z",
				"karl:2026-03-30T17:00:00.000Z",
			]),
		);
		await rm(tmpDir, { recursive: true });
	});

	it("skips malformed lines gracefully", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "phyllis-test-"));
		const logPath = join(tmpDir, "log.jsonl");
		const lines = [
			JSON.stringify({
				window_start: "2026-03-29T16:00:00.000Z",
				user_id: "karl",
			}),
			"not valid json",
			"",
			JSON.stringify({
				window_start: "2026-03-30T17:00:00.000Z",
				user_id: "karl",
			}),
		].join("\n");
		await writeFile(logPath, lines);

		const starts = await readExistingWindowStarts(logPath);
		expect(starts.size).toBe(2);
		await rm(tmpDir, { recursive: true });
	});

	it("handles entries without user_id (legacy format)", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "phyllis-test-"));
		const logPath = join(tmpDir, "log.jsonl");
		const lines = [
			JSON.stringify({ window_start: "2026-03-29T16:00:00.000Z" }),
		].join("\n");
		await writeFile(logPath, lines);

		const starts = await readExistingWindowStarts(logPath);
		expect(starts).toEqual(new Set(["unknown:2026-03-29T16:00:00.000Z"]));
		await rm(tmpDir, { recursive: true });
	});
});

describe("filterNovelEntries", () => {
	it("returns all entries when log is empty", () => {
		const entries = [makeEntry("2026-03-29T16:00:00.000Z")];
		const novel = filterNovelEntries(entries, new Set());
		expect(novel).toHaveLength(1);
	});

	it("filters out entries with matching user_id:window_start", () => {
		const entries = [
			makeEntry("2026-03-29T16:00:00.000Z"),
			makeEntry("2026-03-30T17:00:00.000Z"),
		];
		const existing = new Set(["karl:2026-03-29T16:00:00.000Z"]);
		const novel = filterNovelEntries(entries, existing);
		expect(novel).toHaveLength(1);
		expect(novel[0].window_start).toBe("2026-03-30T17:00:00.000Z");
	});

	it("different users with same window_start are both kept", () => {
		const entry1 = makeEntry("2026-03-29T16:00:00.000Z");
		const entry2 = {
			...makeEntry("2026-03-29T16:00:00.000Z"),
			user_id: "alice",
		};
		const existing = new Set(["karl:2026-03-29T16:00:00.000Z"]);
		const novel = filterNovelEntries([entry1, entry2], existing);
		expect(novel).toHaveLength(1);
		expect(novel[0].user_id).toBe("alice");
	});
});
