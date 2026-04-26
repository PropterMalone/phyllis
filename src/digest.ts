// pattern: functional-core + imperative-shell
// Overnight digest: collect completed tasks, parse logs, render HTML email, send via gws.

import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fetchBlocks } from "./ccusage.ts";
import { isPastBurnPoint } from "./scheduler.ts";
import type { CcusageBlock, QueuedTask } from "./types.ts";

const exec = promisify(execFile);

const TO_EMAIL = "karl.s.kahn@gmail.com";

// --- Pure: task log parsing ---

export interface ParsedTaskLog {
	tokensBefore: number | null;
	tokensAfter: number | null;
	costBefore: number | null;
	costAfter: number | null;
	stderr: string;
}

/** Parse a structured task log file for window delta + stderr */
export function parseTaskLog(content: string): ParsedTaskLog {
	const result: ParsedTaskLog = {
		tokensBefore: null,
		tokensAfter: null,
		costBefore: null,
		costAfter: null,
		stderr: "",
	};

	// Extract tokens line: "block tokens: 100000 → 200000" or "block tokens: ? → 200000"
	const tokensMatch = content.match(/block tokens:\s*(\?|\d+)\s*→\s*(\?|\d+)/);
	if (tokensMatch) {
		result.tokensBefore =
			tokensMatch[1] === "?" ? null : Number(tokensMatch[1]);
		result.tokensAfter = tokensMatch[2] === "?" ? null : Number(tokensMatch[2]);
	}

	// Extract cost line: "block cost: $1.50 → $3.00" or "block cost: $? → $2.74"
	const costMatch = content.match(
		/block cost:\s*\$(\?|[\d.]+)\s*→\s*\$(\?|[\d.]+)/,
	);
	if (costMatch) {
		result.costBefore = costMatch[1] === "?" ? null : Number(costMatch[1]);
		result.costAfter = costMatch[2] === "?" ? null : Number(costMatch[2]);
	}

	// Extract stderr section
	const stderrIdx = content.indexOf("---STDERR---");
	if (stderrIdx !== -1) {
		result.stderr = content.slice(stderrIdx + "---STDERR---".length).trim();
	}

	return result;
}

// --- Pure: digest data collection ---

export interface DigestEntry {
	task: QueuedTask;
	durationMin: number;
	tokensDelta: number | null;
	costDelta: number | null;
	stderr: string;
}

/** Filter tasks to those completed/failed after cutoff, sorted by started_at */
export function collectDigestEntries(
	tasks: QueuedTask[],
	cutoff: Date,
): DigestEntry[] {
	return tasks
		.filter((t) => {
			if (t.status !== "done" && t.status !== "failed") return false;
			if (!t.completed_at) return false;
			return new Date(t.completed_at) > cutoff;
		})
		.sort(
			(a, b) =>
				new Date(a.started_at ?? a.completed_at ?? "").getTime() -
				new Date(b.started_at ?? b.completed_at ?? "").getTime(),
		)
		.map((task) => ({
			task,
			durationMin: durationMinutes(task),
			tokensDelta: null,
			costDelta: null,
			stderr: "",
		}));
}

function durationMinutes(task: QueuedTask): number {
	if (!task.started_at || !task.completed_at) return 0;
	return (
		(new Date(task.completed_at).getTime() -
			new Date(task.started_at).getTime()) /
		60_000
	);
}

// --- Pure: formatting ---

export function formatSubject(done: number, failed: number, now: Date): string {
	const date = now.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
	const parts = [`${done} done`];
	if (failed > 0) parts.push(`${failed} failed`);
	return `Phyllis overnight — ${date}: ${parts.join(", ")}`;
}

// RFC 2047 encoded-word for non-ASCII subject headers.
// SMTP headers must be ASCII; the em dash in our subject was rendering as
// mojibake at receiving servers without this.
export function encodeSubjectHeader(subject: string): string {
	if (/^[\x20-\x7e]*$/.test(subject)) {
		return subject;
	}
	const encoded = Buffer.from(subject, "utf-8").toString("base64");
	return `=?UTF-8?B?${encoded}?=`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatDuration(min: number): string {
	if (min < 1) return "<1m";
	if (min < 60) return `${Math.round(min)}m`;
	const h = Math.floor(min / 60);
	const m = Math.round(min % 60);
	return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatCost(cost: number | null): string {
	if (cost === null) return "—";
	return `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number | null): string {
	if (tokens === null) return "—";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

// --- Pure: weekly budget ---

export interface RateLimitSnapshot {
	weeklyPct: number; // 0-100, from Anthropic's anthropic-ratelimit-unified-7d header
	weeklyResetAt: Date; // next reset (Anthropic-provided; not hardcoded — they've moved it)
}

export interface WeeklyBudget {
	resetTime: string; // ISO 8601 — next reset (from rate-limits.json when available)
	resetSource: "rate-limits" | "fallback"; // where resetTime came from
	hoursUntilReset: number;
	hoursElapsed: number;
	blocksSinceReset: number;
	tokensSinceReset: number;
	costSinceReset: number;
	windowsRemaining: number; // approximate 5h windows left before reset
	avgCostPerBlock: number; // average cost per session this week
	blocksPerDay: number; // burn rate in sessions/day
	sessionsAtCurrentRate: number; // estimated sessions remaining at current pace
	dayOfWeek: number; // 0=Sun through 6=Sat — day of digest
	healthLabel: "healthy" | "moderate" | "tight" | "critical";
	// Burn point: weekly cap is unreachable even if every remaining 5h window
	// were filled to its observed maximum. Past burn point = fire freely; the
	// 5h cap is the bottleneck, not the weekly cap.
	pastBurnPoint: boolean;
	burnPointNote: string;
	// Source-of-truth values used in the burn-point decision. Null if we had to
	// fall back (no rate-limits.json) — burn-point is then null/unknown.
	weeklyPct: number | null;
	maxBurnPct: number; // windowsRemaining × WINDOW_WEEKLY_PCT
}

/** Fallback only: most recent Friday 19:00 UTC. Used when rate-limits.json is
 * missing — Anthropic has moved the reset point with no warning, so trust the
 * live data over this hardcoded guess. */
export function lastWeeklyReset(now: Date): Date {
	const d = new Date(now);
	d.setUTCHours(19, 0, 0, 0);
	// Walk back to Friday
	while (d.getUTCDay() !== 5 || d > now) {
		d.setUTCDate(d.getUTCDate() - 1);
	}
	// If we landed on a Friday but the time hasn't passed yet, go back a week
	if (d > now) {
		d.setUTCDate(d.getUTCDate() - 7);
	}
	return d;
}

/** Assess budget health based on burn rate vs remaining capacity.
 * "healthy" = on pace or under for the week. "moderate" = trending high but fine.
 * "tight" = will likely run out if pace continues. "critical" = very little left. */
export function assessHealth(
	blocksPerDay: number,
	daysRemaining: number,
	windowsRemaining: number,
	_blocksSoFar: number,
): "healthy" | "moderate" | "tight" | "critical" {
	const projectedRemaining = blocksPerDay * daysRemaining;
	// If you'd use more sessions than windows remaining, that's tight
	if (windowsRemaining <= 2) return "critical";
	if (projectedRemaining > windowsRemaining * 0.9) return "tight";
	if (projectedRemaining > windowsRemaining * 0.6) return "moderate";
	return "healthy";
}

// Mirrors WINDOW_WEEKLY_PCT in scheduler.ts — kept in sync intentionally.
// This is the *ceiling* of how much one 5h window can consume as a fraction
// of the weekly budget, not the average. See scheduler.ts for the rationale.
const WINDOW_WEEKLY_PCT = 22;

export function computeWeeklyBudget(
	blocks: CcusageBlock[],
	now: Date,
	rateLimits: RateLimitSnapshot | null = null,
): WeeklyBudget {
	// Reset time: prefer Anthropic's live header (rate-limits.json). Fallback
	// to hardcoded Friday only when rate limits are unavailable — Anthropic
	// has moved the reset point with no warning, so the hardcoded value is
	// often wrong.
	let nextReset: Date;
	let resetSource: "rate-limits" | "fallback";
	if (rateLimits) {
		nextReset = rateLimits.weeklyResetAt;
		resetSource = "rate-limits";
	} else {
		const lastReset = lastWeeklyReset(now);
		nextReset = new Date(lastReset.getTime() + 7 * 24 * 60 * 60 * 1000);
		resetSource = "fallback";
	}
	const lastReset = new Date(nextReset.getTime() - 7 * 24 * 60 * 60 * 1000);
	const hoursUntilReset =
		(nextReset.getTime() - now.getTime()) / (60 * 60 * 1000);
	const hoursElapsed = (now.getTime() - lastReset.getTime()) / (60 * 60 * 1000);

	const sinceReset = blocks.filter(
		(b) => new Date(b.startTime) >= lastReset && !b.isGap,
	);

	const blockCount = sinceReset.length;
	const totalCost = sinceReset.reduce((s, b) => s + b.costUSD, 0);
	const daysElapsed = Math.max(hoursElapsed / 24, 0.25); // floor at 6h to avoid division spikes
	const blocksPerDay = blockCount / daysElapsed;
	const avgCostPerBlock = blockCount > 0 ? totalCost / blockCount : 0;
	const windowsRemaining = Math.floor(hoursUntilReset / 5);
	const daysRemaining = hoursUntilReset / 24;
	const sessionsAtCurrentRate = Math.round(blocksPerDay * daysRemaining);
	const maxBurnPct = windowsRemaining * WINDOW_WEEKLY_PCT;

	// Burn point: can the weekly cap still be reached if every remaining
	// 5h window were filled to its observed maximum?
	//   pastBurnPoint = (100 - weeklyPct) > windowsRemaining × WINDOW_WEEKLY_PCT
	// Without rate-limits.json we don't know weeklyPct → don't claim either way.
	const weeklyPct = rateLimits?.weeklyPct ?? null;
	const pastBurnPoint =
		weeklyPct !== null && isPastBurnPoint(weeklyPct, hoursUntilReset);

	let burnPointNote: string;
	if (weeklyPct === null) {
		burnPointNote =
			"no rate-limits.json. Run a session via the proxy to populate live state.";
	} else if (pastBurnPoint) {
		const remainingPct = 100 - weeklyPct;
		burnPointNote = `${remainingPct.toFixed(0)}% of weekly budget remains, but ${windowsRemaining} windows × ${WINDOW_WEEKLY_PCT}%/window can only burn ${maxBurnPct}%. Cap is unreachable — fire freely.`;
	} else {
		const remainingPct = 100 - weeklyPct;
		burnPointNote = `${remainingPct.toFixed(0)}% of weekly budget remains; ${windowsRemaining} windows × ${WINDOW_WEEKLY_PCT}%/window could burn up to ${maxBurnPct}%. The weekly cap is still the bottleneck.`;
	}

	return {
		resetTime: nextReset.toISOString(),
		resetSource,
		hoursUntilReset,
		hoursElapsed,
		blocksSinceReset: blockCount,
		tokensSinceReset: sinceReset.reduce((s, b) => s + b.totalTokens, 0),
		costSinceReset: totalCost,
		windowsRemaining,
		avgCostPerBlock,
		blocksPerDay,
		sessionsAtCurrentRate,
		dayOfWeek: now.getUTCDay(),
		healthLabel: assessHealth(
			blocksPerDay,
			daysRemaining,
			windowsRemaining,
			blockCount,
		),
		pastBurnPoint,
		burnPointNote,
		weeklyPct,
		maxBurnPct,
	};
}

const HEALTH_COLORS: Record<WeeklyBudget["healthLabel"], string> = {
	healthy: "#2d7d46",
	moderate: "#b8860b",
	tight: "#e67e22",
	critical: "#c0392b",
};

const HEALTH_LABELS: Record<WeeklyBudget["healthLabel"], string> = {
	healthy: "Healthy",
	moderate: "Moderate",
	tight: "Tight",
	critical: "Critical",
};

function formatBudgetHtml(budget: WeeklyBudget): string {
	const resetDate = new Date(budget.resetTime);
	const resetStr = resetDate.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone: "America/New_York",
	});
	const daysIn = Math.round((budget.hoursElapsed / 24) * 10) / 10;
	const daysLeft = Math.round((budget.hoursUntilReset / 24) * 10) / 10;
	const healthColor = HEALTH_COLORS[budget.healthLabel];
	const healthLabel = HEALTH_LABELS[budget.healthLabel];

	return `<div style="background:#f8f9fa;border:1px solid #ddd;border-radius:6px;padding:12px 16px;margin:16px 0">
<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
<strong style="font-size:15px">Weekly Budget</strong>
<span style="background:${healthColor};color:#fff;padding:2px 8px;border-radius:3px;font-size:12px;font-weight:bold">${healthLabel}</span>
<span style="color:#666;font-size:12px">Resets ${resetStr} ET</span>
</div>
<table style="border-collapse:collapse;font-size:13px;width:100%">
<tr style="border-bottom:1px solid #e0e0e0">
<td style="padding:4px 0;color:#666">Used so far</td>
<td style="padding:4px 12px;text-align:right">${budget.weeklyPct !== null ? `<strong>${budget.weeklyPct.toFixed(0)}%</strong> of weekly` : "—"}</td>
<td style="padding:4px 12px;text-align:right"><strong>${budget.blocksSinceReset}</strong> sessions</td>
<td style="padding:4px 12px;text-align:right"><strong>$${budget.costSinceReset.toFixed(2)}</strong></td>
<td style="padding:4px 0;color:#666">${daysIn}d in</td>
</tr>
<tr style="border-bottom:1px solid #e0e0e0">
<td style="padding:4px 0;color:#666">Burn rate</td>
<td style="padding:4px 12px;text-align:right"><strong>${budget.blocksPerDay.toFixed(1)}</strong> sessions/day</td>
<td style="padding:4px 12px;text-align:right"><strong>$${(budget.avgCostPerBlock).toFixed(2)}</strong>/session</td>
<td style="padding:4px 12px;text-align:right"><strong>$${(budget.blocksPerDay * budget.avgCostPerBlock).toFixed(2)}</strong>/day</td>
<td></td>
</tr>
<tr>
<td style="padding:4px 0;color:#666">Remaining</td>
<td style="padding:4px 12px;text-align:right"><strong>~${budget.windowsRemaining}</strong> windows</td>
<td style="padding:4px 12px;text-align:right"><strong>~${budget.sessionsAtCurrentRate}</strong> sessions at pace</td>
<td></td>
<td style="padding:4px 0;color:#666">${daysLeft}d left</td>
</tr>
</table>
${formatBurnPointBlock(budget)}
</div>`;
}

function formatBurnPointBlock(budget: WeeklyBudget): string {
	let bg: string;
	let label: string;
	let labelColor: string;
	if (budget.weeklyPct === null) {
		bg = "#f0f0f0";
		label = "Burn point unknown";
		labelColor = "#666";
	} else if (budget.pastBurnPoint) {
		bg = "#e8f5e9";
		label = "Past burn point";
		labelColor = "#2d7d46";
	} else {
		bg = "#fff3e0";
		label = "Budget-limited";
		labelColor = "#e67e22";
	}
	return `<div style="margin-top:8px;padding:6px 10px;background:${bg};border-radius:4px;font-size:12px">
<strong style="color:${labelColor}">${label}</strong> — ${escapeHtml(budget.burnPointNote)}
</div>`;
}

export function formatDigestHtml(
	entries: DigestEntry[],
	queuedRemaining: number,
	now: Date,
	budget?: WeeklyBudget | null,
): string {
	const date = now.toLocaleDateString("en-US", {
		weekday: "long",
		month: "short",
		day: "numeric",
	});

	if (entries.length === 0) {
		return `<!DOCTYPE html><html><body>
<h2>Phyllis Overnight Digest — ${date}</h2>
<p>Nothing ran overnight. ${queuedRemaining} tasks remaining in queue.</p>
${budget ? formatBudgetHtml(budget) : ""}
</body></html>`;
	}

	const done = entries.filter((e) => e.task.status === "done").length;
	const failed = entries.filter((e) => e.task.status === "failed").length;
	const totalMin = entries.reduce((s, e) => s + e.durationMin, 0);
	const totalCost = entries.reduce((s, e) => s + (e.costDelta ?? 0), 0);
	const totalTokens = entries.reduce((s, e) => s + (e.tokensDelta ?? 0), 0);
	const hasCostData = entries.some((e) => e.costDelta !== null);

	const rows = entries
		.map((e) => {
			const statusIcon = e.task.status === "done" ? "&#x2713;" : "&#x2717;";
			const statusColor = e.task.status === "done" ? "#2d7d46" : "#c0392b";
			const summary = escapeHtml(
				(e.task.result_summary ?? "").split("\n")[0].slice(0, 120),
			);
			const stderrNote =
				e.stderr && e.task.status === "failed"
					? `<br><span style="color:#c0392b;font-size:12px">${escapeHtml(e.stderr.split("\n")[0].slice(0, 100))}</span>`
					: "";

			return `<tr>
<td style="color:${statusColor};text-align:center">${statusIcon}</td>
<td><strong>${escapeHtml(e.task.name)}</strong><br>
<span style="color:#666;font-size:12px">${summary}${stderrNote}</span></td>
<td>${e.task.size}</td>
<td>${formatDuration(e.durationMin)}</td>
<td>${formatTokens(e.tokensDelta)}</td>
<td>${formatCost(e.costDelta)}</td>
</tr>`;
		})
		.join("\n");

	return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,system-ui,sans-serif;max-width:700px;margin:0 auto;padding:16px;color:#333">
<h2 style="margin-bottom:4px">Phyllis Overnight Digest</h2>
<p style="color:#666;margin-top:0">${date}</p>

<table style="border-collapse:collapse;width:100%;margin:16px 0">
<tr style="background:#f0f0f0">
<td style="padding:8px;font-weight:bold;text-align:center;width:30px"></td>
<td style="padding:8px;font-weight:bold">Task</td>
<td style="padding:8px;font-weight:bold;width:40px">Size</td>
<td style="padding:8px;font-weight:bold;width:60px">Time</td>
<td style="padding:8px;font-weight:bold;width:70px">Tokens</td>
<td style="padding:8px;font-weight:bold;width:60px">Cost</td>
</tr>
${rows}
</table>

<p style="color:#666;font-size:13px;border-top:1px solid #ddd;padding-top:12px">
<strong>${done} done</strong>${failed > 0 ? `, <span style="color:#c0392b"><strong>${failed} failed</strong></span>` : ""}
&nbsp;&middot;&nbsp; ${formatDuration(totalMin)} total
${hasCostData ? `&nbsp;&middot;&nbsp; ${formatTokens(totalTokens)} tokens &nbsp;&middot;&nbsp; ${formatCost(totalCost)}` : ""}
&nbsp;&middot;&nbsp; ${queuedRemaining} tasks remaining in queue
</p>
${budget ? formatBudgetHtml(budget) : ""}
</body>
</html>`;
}

// --- Imperative: rate-limits.json reader ---

// Reset times in rate-limits.json are Unix epoch seconds; in window-state.json
// they're ISO strings. Both are written by the proxy / statusline scripts.
// 10min staleness matches scheduler/runner — beyond that the data is unreliable.
const RATE_LIMITS_STALENESS_MS = 10 * 60 * 1000;

export async function readRateLimits(
	windowStatePath: string,
	rateLimitsPath: string,
): Promise<RateLimitSnapshot | null> {
	// Prefer proxy state (real-time, ISO timestamps)
	try {
		const content = await readFile(windowStatePath, "utf-8");
		const state = JSON.parse(content) as {
			capturedAt?: string;
			sevenDayUtilization?: number | null;
			sevenDayResetAt?: number | string | null;
		};
		if (
			state.capturedAt &&
			state.sevenDayUtilization != null &&
			state.sevenDayResetAt != null
		) {
			const age = Date.now() - new Date(state.capturedAt).getTime();
			if (age < RATE_LIMITS_STALENESS_MS) {
				return {
					weeklyPct: state.sevenDayUtilization * 100,
					weeklyResetAt:
						typeof state.sevenDayResetAt === "number"
							? new Date(state.sevenDayResetAt * 1000)
							: new Date(state.sevenDayResetAt),
				};
			}
		}
	} catch {
		// fall through to statusline file
	}

	// Fallback: statusline rate-limits.json (epoch-second resets)
	try {
		const { mtimeMs } = await stat(rateLimitsPath);
		if (Date.now() - mtimeMs > RATE_LIMITS_STALENESS_MS) return null;
		const content = await readFile(rateLimitsPath, "utf-8");
		const data = JSON.parse(content) as {
			seven_day?: { used_percentage?: number; resets_at?: number };
		};
		const pct = data.seven_day?.used_percentage;
		const resets = data.seven_day?.resets_at;
		if (pct == null || resets == null) return null;
		return {
			weeklyPct: pct,
			weeklyResetAt: new Date(resets * 1000),
		};
	} catch {
		return null;
	}
}

// --- Imperative: task log loading ---

/** Find and parse the task log file for a given task ID */
async function loadTaskLog(
	taskLogsDir: string,
	task: QueuedTask,
): Promise<ParsedTaskLog | null> {
	try {
		const files = await readdir(taskLogsDir);
		// Task logs are named: TIMESTAMP_taskname.log
		// Match by task name (sanitized) in filename
		const sanitized = task.name.replace(/[^a-zA-Z0-9]/g, "_");
		// Find the most recent log matching this task name
		const matches = files
			.filter((f) => f.includes(sanitized) && f.endsWith(".log"))
			.sort()
			.reverse();

		if (matches.length === 0) return null;

		const content = await readFile(join(taskLogsDir, matches[0]), "utf-8");
		return parseTaskLog(content);
	} catch {
		return null;
	}
}

/** Enrich digest entries with data from task log files */
export async function enrichFromLogs(
	entries: DigestEntry[],
	taskLogsDir: string,
): Promise<void> {
	for (const entry of entries) {
		const log = await loadTaskLog(taskLogsDir, entry.task);
		if (!log) continue;

		if (log.tokensAfter !== null && log.tokensBefore !== null) {
			entry.tokensDelta = log.tokensAfter - log.tokensBefore;
		} else if (log.tokensAfter !== null) {
			// No before snapshot — report absolute as best-effort
			entry.tokensDelta = log.tokensAfter;
		}

		if (log.costAfter !== null && log.costBefore !== null) {
			entry.costDelta = log.costAfter - log.costBefore;
		} else if (log.costAfter !== null) {
			entry.costDelta = log.costAfter;
		}

		entry.stderr = log.stderr;
	}
}

// --- Imperative: email ---

async function sendEmail(subject: string, htmlBody: string): Promise<void> {
	const message = [
		`To: ${TO_EMAIL}`,
		`Subject: ${encodeSubjectHeader(subject)}`,
		"MIME-Version: 1.0",
		'Content-Type: text/html; charset="UTF-8"',
		"",
		htmlBody,
	].join("\r\n");

	const raw = Buffer.from(message).toString("base64url");

	await exec("gws", [
		"gmail",
		"users",
		"messages",
		"send",
		"--params",
		JSON.stringify({ userId: "me" }),
		"--json",
		JSON.stringify({ raw }),
	]);
}

// --- Imperative: orchestration ---

export interface DigestOptions {
	queuePath: string;
	taskLogsDir: string;
	windowStatePath: string;
	rateLimitsPath: string;
	dryRun: boolean;
	cutoffHours: number;
}

export async function digest(options: DigestOptions): Promise<string> {
	const {
		queuePath,
		taskLogsDir,
		windowStatePath,
		rateLimitsPath,
		dryRun,
		cutoffHours,
	} = options;

	// Load queue
	let tasks: QueuedTask[];
	try {
		const content = await readFile(queuePath, "utf-8");
		tasks = JSON.parse(content) as QueuedTask[];
	} catch {
		tasks = [];
	}

	const now = new Date();
	const cutoff = new Date(now.getTime() - cutoffHours * 60 * 60 * 1000);

	// Collect and enrich entries
	const entries = collectDigestEntries(tasks, cutoff);
	await enrichFromLogs(entries, taskLogsDir);

	// Count remaining queued
	const queuedRemaining = tasks.filter((t) => t.status === "queued").length;

	// Weekly budget — rate-limits drive burn-point math, ccusage drives display
	let budget: WeeklyBudget | null = null;
	try {
		const [blocks, rateLimits] = await Promise.all([
			fetchBlocks(),
			readRateLimits(windowStatePath, rateLimitsPath),
		]);
		budget = computeWeeklyBudget(blocks, now, rateLimits);
	} catch {
		// Non-fatal — send digest without budget section
	}

	// Format
	const done = entries.filter((e) => e.task.status === "done").length;
	const failed = entries.filter((e) => e.task.status === "failed").length;
	const subject = formatSubject(done, failed, now);
	const html = formatDigestHtml(entries, queuedRemaining, now, budget);

	if (dryRun) {
		return html;
	}

	await sendEmail(subject, html);
	return subject;
}
