// pattern: functional-core

import type { CalibrationEntry } from "./types.ts";

export interface WeeklySummary {
	weekLabel: string; // "2026-W13"
	weekStart: string; // ISO date of Monday
	blocks: number;
	totalTokens: number;
	totalCost: number;
	avgCostPerBlock: number;
	peakBlocks: number;
	offPeakBlocks: number;
}

function getISOWeekLabel(date: Date): string {
	// ISO week: week containing Thursday determines the year
	const d = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	const weekNo = Math.ceil(
		((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
	);
	return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getWeekMonday(date: Date): string {
	const d = new Date(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
	);
	const day = d.getUTCDay() || 7; // Sun=7
	d.setUTCDate(d.getUTCDate() - day + 1);
	return d.toISOString().slice(0, 10);
}

// Legacy field handling
function getTokens(entry: Record<string, unknown>): number {
	return (
		(entry.tokens_consumed as number) ??
		(entry.tokens_consumed_at_obs as number) ??
		0
	);
}

function getCost(entry: Record<string, unknown>): number {
	return (
		(entry.cost_equiv as number) ?? (entry.cost_equiv_at_obs as number) ?? 0
	);
}

export function buildWeeklySummary(
	entries: CalibrationEntry[],
): WeeklySummary[] {
	if (entries.length === 0) return [];

	const weeks = new Map<string, WeeklySummary>();

	for (const entry of entries) {
		const date = new Date(entry.window_start);
		const label = getISOWeekLabel(date);
		const raw = entry as unknown as Record<string, unknown>;

		const week = weeks.get(label) ?? {
			weekLabel: label,
			weekStart: getWeekMonday(date),
			blocks: 0,
			totalTokens: 0,
			totalCost: 0,
			avgCostPerBlock: 0,
			peakBlocks: 0,
			offPeakBlocks: 0,
		};

		week.blocks += 1;
		week.totalTokens += getTokens(raw);
		week.totalCost += getCost(raw);
		if (entry.peak_hour) {
			week.peakBlocks += 1;
		} else {
			week.offPeakBlocks += 1;
		}
		weeks.set(label, week);
	}

	const result = Array.from(weeks.values()).sort((a, b) =>
		a.weekLabel.localeCompare(b.weekLabel),
	);

	for (const week of result) {
		week.avgCostPerBlock = week.blocks > 0 ? week.totalCost / week.blocks : 0;
	}

	return result;
}

export function renderWeeklySummary(weeks: WeeklySummary[]): string {
	const lines: string[] = [];

	const header = `${"Week".padEnd(10)} ${"Start".padEnd(12)} ${"Blocks".padStart(6)} ${"Cost".padStart(10)} ${"Tokens".padStart(14)} ${"Avg/Blk".padStart(9)} ${"Peak".padStart(5)} ${"OffPk".padStart(5)}`;
	lines.push(header);
	lines.push("-".repeat(header.length));

	let totalBlocks = 0;
	let totalCost = 0;
	let totalTokens = 0;

	for (const w of weeks) {
		totalBlocks += w.blocks;
		totalCost += w.totalCost;
		totalTokens += w.totalTokens;
		lines.push(
			`${w.weekLabel.padEnd(10)} ${w.weekStart.padEnd(12)} ${String(w.blocks).padStart(6)} ${`$${w.totalCost.toFixed(2)}`.padStart(10)} ${w.totalTokens.toLocaleString().padStart(14)} ${`$${w.avgCostPerBlock.toFixed(2)}`.padStart(9)} ${String(w.peakBlocks).padStart(5)} ${String(w.offPeakBlocks).padStart(5)}`,
		);
	}

	lines.push("-".repeat(header.length));
	lines.push(
		`${"Avg".padEnd(10)} ${"".padEnd(12)} ${String(Math.round(totalBlocks / weeks.length)).padStart(6)} ${`$${(totalCost / weeks.length).toFixed(2)}`.padStart(10)} ${Math.round(
			totalTokens / weeks.length,
		)
			.toLocaleString()
			.padStart(14)} ${`$${(totalCost / totalBlocks).toFixed(2)}`.padStart(9)}`,
	);

	return lines.join("\n");
}
