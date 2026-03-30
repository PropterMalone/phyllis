// pattern: functional-core

import type { CalibrationEntry } from "./types.ts";

export interface HeatmapCell {
	day: number; // 0=Sun, 6=Sat
	hour: number; // 0-23 UTC
	totalTokens: number;
	totalCost: number;
	count: number;
}

export interface HeatmapData {
	cells: HeatmapCell[];
	maxTokens: number;
	maxCost: number;
}

export interface ProjectSummary {
	project: string;
	totalTokens: number;
	totalCost: number;
	sessions: number;
	lastActivity: string;
}

export interface CcusageSession {
	sessionId: string;
	totalTokens: number;
	totalCost: number;
	lastActivity: string;
	modelsUsed: string[];
	projectPath: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Legacy manual entries used different field names — normalize
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

export function buildHeatmap(entries: CalibrationEntry[]): HeatmapData {
	const grid = new Map<string, HeatmapCell>();

	for (const entry of entries) {
		const date = new Date(entry.window_start);
		const day = date.getUTCDay();
		const hour = date.getUTCHours();
		const key = `${day}:${hour}`;

		const tokens = getTokens(entry as unknown as Record<string, unknown>);
		const cost = getCost(entry as unknown as Record<string, unknown>);

		const cell = grid.get(key) ?? {
			day,
			hour,
			totalTokens: 0,
			totalCost: 0,
			count: 0,
		};
		cell.totalTokens += tokens;
		cell.totalCost += cost;
		cell.count += 1;
		grid.set(key, cell);
	}

	const cells = Array.from(grid.values());
	return {
		cells,
		maxTokens: Math.max(0, ...cells.map((c) => c.totalTokens)),
		maxCost: Math.max(0, ...cells.map((c) => c.totalCost)),
	};
}

// Intensity blocks for terminal rendering
const BLOCKS = [" ", "░", "▒", "▓", "█"];

function intensityBlock(value: number, max: number): string {
	if (max === 0 || value === 0) return BLOCKS[0];
	const ratio = value / max;
	const index = Math.min(
		BLOCKS.length - 1,
		Math.ceil(ratio * (BLOCKS.length - 1)),
	);
	return BLOCKS[index];
}

export function renderHeatmap(
	data: HeatmapData,
	metric: "tokens" | "cost" = "cost",
): string {
	const lines: string[] = [];
	const getValue = (c: HeatmapCell) =>
		metric === "cost" ? c.totalCost : c.totalTokens;
	const max = metric === "cost" ? data.maxCost : data.maxTokens;

	// Header row: hours
	const hourLabels = Array.from({ length: 24 }, (_, h) =>
		String(h).padStart(2),
	);
	lines.push(`     ${hourLabels.join("")}  UTC`);

	// One row per day
	for (let day = 0; day < 7; day++) {
		let row = `${DAY_NAMES[day]}  `;
		for (let hour = 0; hour < 24; hour++) {
			const cell = data.cells.find((c) => c.day === day && c.hour === hour);
			const value = cell ? getValue(cell) : 0;
			row += `${intensityBlock(value, max)} `;
		}
		lines.push(row);
	}

	lines.push("");
	lines.push(
		`  ${BLOCKS[0]}=none ${BLOCKS[1]}=low ${BLOCKS[2]}=med ${BLOCKS[3]}=high ${BLOCKS[4]}=max`,
	);

	return lines.join("\n");
}

export function extractProject(sessionId: string): string {
	// sessionId looks like "-home-karl-Projects-3cblue" or "-home-karl-Projects-gsdat-jeffwolf"
	const match = sessionId.match(/-Projects-(.+)/);
	if (!match) return sessionId;
	return match[1];
}

export function buildProjectSummary(
	sessions: CcusageSession[],
): ProjectSummary[] {
	const projects = new Map<string, ProjectSummary>();

	for (const session of sessions) {
		const project = extractProject(session.sessionId);
		const existing = projects.get(project) ?? {
			project,
			totalTokens: 0,
			totalCost: 0,
			sessions: 0,
			lastActivity: "",
		};
		existing.totalTokens += session.totalTokens;
		existing.totalCost += session.totalCost;
		existing.sessions += 1;
		if (session.lastActivity > existing.lastActivity) {
			existing.lastActivity = session.lastActivity;
		}
		projects.set(project, existing);
	}

	return Array.from(projects.values()).sort(
		(a, b) => b.totalCost - a.totalCost,
	);
}

export function renderProjectTable(summaries: ProjectSummary[]): string {
	const lines: string[] = [];
	const header = `${"Project".padEnd(30)} ${"Cost".padStart(10)} ${"Tokens".padStart(14)} ${"Sessions".padStart(8)}  Last`;
	lines.push(header);
	lines.push("-".repeat(header.length + 12));

	let totalCost = 0;
	let totalTokens = 0;

	for (const s of summaries) {
		totalCost += s.totalCost;
		totalTokens += s.totalTokens;
		lines.push(
			`${s.project.padEnd(30)} ${`$${s.totalCost.toFixed(2).padStart(9)}`} ${s.totalTokens.toLocaleString().padStart(14)} ${String(s.sessions).padStart(8)}  ${s.lastActivity}`,
		);
	}

	lines.push("-".repeat(header.length + 12));
	lines.push(
		`${"TOTAL".padEnd(30)} ${`$${totalCost.toFixed(2).padStart(9)}`} ${totalTokens.toLocaleString().padStart(14)}`,
	);

	return lines.join("\n");
}
