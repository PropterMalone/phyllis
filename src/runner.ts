// pattern: imperative-shell
// Cron entry point: check window state, drain queue within the current window

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchBlocks } from "./ccusage.ts";
import type { NotifyConfig, PhyllisConfig } from "./config.ts";
import { paths } from "./config.ts";
import {
	checkBusy,
	createEvent,
	getOrCreatePhyllisCalendar,
	updateEvent,
} from "./gcal.ts";
import { formatTaskNotification, sendNotification } from "./notify.ts";
import {
	completeTask,
	failTask,
	nextTask,
	requeueTask,
	startTask,
} from "./queue.ts";
import {
	type DocketReservation,
	estimateBlockMinutes,
	type RateLimitState,
	type SchedulerContext,
	shouldSchedule,
} from "./scheduler.ts";
import type { CcusageBlock, PhyllisEvent, TaskSize } from "./types.ts";

export interface RunnerOptions {
	queuePath: string;
	logPath: string;
	dryRun?: boolean;
	config: PhyllisConfig;
}

export interface WindowSnapshot {
	fiveHourPct: number | null;
	sevenDayPct: number | null;
	blockTokens: number | null;
	blockCost: number | null;
}

export interface TaskOutcome {
	taskId: string;
	taskName: string;
	success: boolean;
	durationMs: number;
	reason: string;
	windowBefore: WindowSnapshot | null;
	windowAfter: WindowSnapshot | null;
}

export interface RunnerResult {
	decision: string;
	reason: string;
	tasks: TaskOutcome[];
	dryRun: boolean;
}

// Proxy state older than this is considered stale — fall back to statusline data
const PROXY_STALENESS_MS = 10 * 60 * 1000;

// Scale timeout by task size — L/XL tasks (NineAngel batteries, 3CB resolution) need more time
export const SIZE_TIMEOUT_MS: Record<TaskSize, number> = {
	S: 15 * 60 * 1000, // 15 min
	M: 30 * 60 * 1000, // 30 min
	L: 60 * 60 * 1000, // 60 min
	XL: 120 * 60 * 1000, // 120 min
};

// Max consecutive failures before giving up for this invocation
const MAX_CONSECUTIVE_FAILURES = 3;

// Backoff after a failure — let rate limits clear before retrying
const FAILURE_BACKOFF_MS = 60 * 1000;

async function readRateLimits(
	windowStatePath: string,
	rateLimitsPath: string,
): Promise<RateLimitState | null> {
	// Prefer proxy state (real-time utilization from HTTP headers)
	try {
		const content = await readFile(windowStatePath, "utf-8");
		const state = JSON.parse(content) as {
			capturedAt?: string;
			fiveHourUtilization?: number | null;
			sevenDayUtilization?: number | null;
		};
		if (state.capturedAt) {
			const age = Date.now() - new Date(state.capturedAt).getTime();
			if (age < PROXY_STALENESS_MS && state.fiveHourUtilization != null) {
				return {
					fiveHourPct: state.fiveHourUtilization * 100,
					sevenDayPct: (state.sevenDayUtilization ?? 0) * 100,
				};
			}
		}
	} catch {
		// fall through to statusline file
	}

	// Fallback: statusline script's rate-limit file
	try {
		const { mtimeMs } = await stat(rateLimitsPath);
		const ageMs = Date.now() - mtimeMs;
		if (ageMs > PROXY_STALENESS_MS) return null; // stale data — ignore
		const content = await readFile(rateLimitsPath, "utf-8");
		const data = JSON.parse(content) as {
			five_hour?: { used_percentage?: number };
			seven_day?: { used_percentage?: number };
		};
		if (data.five_hour?.used_percentage == null) return null;
		return {
			fiveHourPct: data.five_hour.used_percentage,
			sevenDayPct: data.seven_day?.used_percentage ?? 0,
		};
	} catch {
		return null;
	}
}

async function getHoursUntilWeeklyReset(
	windowStatePath: string,
	rateLimitsPath: string,
): Promise<number | null> {
	// Try proxy state first
	try {
		const content = await readFile(windowStatePath, "utf-8");
		const state = JSON.parse(content) as {
			sevenDayResetAt?: string | null;
		};
		if (state.sevenDayResetAt) {
			const ms = new Date(state.sevenDayResetAt).getTime() - Date.now();
			if (ms > 0) return ms / (1000 * 60 * 60);
		}
	} catch {
		// fall through
	}
	// Fallback: rate-limits.json resets_at (epoch seconds)
	try {
		const content = await readFile(rateLimitsPath, "utf-8");
		const data = JSON.parse(content) as {
			seven_day?: { resets_at?: number };
		};
		if (data.seven_day?.resets_at) {
			const ms = data.seven_day.resets_at * 1000 - Date.now();
			if (ms > 0) return ms / (1000 * 60 * 60);
		}
	} catch {
		// fall through
	}
	return null;
}

async function readActiveReservation(
	reservationsPath: string,
): Promise<DocketReservation | null> {
	try {
		const content = await readFile(reservationsPath, "utf-8");
		const reservations = JSON.parse(content) as DocketReservation[];
		const now = new Date().toISOString();
		const fiveHoursLater = new Date(
			Date.now() + 5 * 60 * 60 * 1000,
		).toISOString();
		return (
			reservations.find((r) => r.end > now && r.start < fiveHoursLater) ?? null
		);
	} catch {
		return null;
	}
}

async function getActiveBlock(): Promise<CcusageBlock | null> {
	try {
		const blocks = await fetchBlocks();
		return blocks.find((b) => b.isActive) ?? null;
	} catch {
		return null;
	}
}

async function captureWindowSnapshot(
	windowStatePath: string,
	rateLimitsPath: string,
): Promise<WindowSnapshot> {
	const [limits, block] = await Promise.all([
		readRateLimits(windowStatePath, rateLimitsPath),
		getActiveBlock(),
	]);
	return {
		fiveHourPct: limits?.fiveHourPct ?? null,
		sevenDayPct: limits?.sevenDayPct ?? null,
		blockTokens: block?.totalTokens ?? null,
		blockCost: block?.costUSD ?? null,
	};
}

// Detect stderr that only contains hook failure messages, not real errors.
// Claude Code prints lines like:
//   SessionEnd hook [bash /path/to/hook.sh] failed: Hook cancelled
//   PreToolUse hook [...] failed: ...
export function isHookOnlyFailure(stderr: string): boolean {
	const lines = stderr
		.trim()
		.split("\n")
		.filter((l) => l.trim().length > 0);
	if (lines.length === 0) return false;
	return lines.every((line) => /hook\s+\[.*\]\s+failed:/i.test(line));
}

// Detect rate-limit / out-of-usage messages in claude -p output.
// These can appear in stdout (exit 0) or stderr (exit non-zero).
// When detected, the task should be requeued, not completed or failed.
const RATE_LIMIT_PATTERNS = [
	/out of (?:extra )?usage/i,
	/rate.?limit/i,
	/usage.?limit/i,
	/too many requests/i,
	/over(?:loaded|capacity)/i,
];

export function isRateLimitOutput(text: string): boolean {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

function runClaude(
	prompt: string,
	projectDir: string,
	size: TaskSize,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		delete env.CLAUDE_CODE;
		delete env.CLAUDECODE;

		const child: ChildProcess = spawn(
			"claude",
			["-p", prompt, "--output-format", "text"],
			{
				cwd: projectDir,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";
		const maxBuffer = 50 * 1024 * 1024;
		const timeout = SIZE_TIMEOUT_MS[size];

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(
				new Error(
					`claude -p timed out after ${timeout / 60000}min\n---STDERR---\n${stderr}`,
				),
			);
		}, timeout);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.length > maxBuffer) {
				child.kill("SIGTERM");
				reject(new Error("claude -p exceeded max output buffer"));
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				// Hook failures (e.g. SessionEnd timeout) cause non-zero exit even
				// when the actual work completed. If stdout has content and stderr
				// only contains hook failure messages, treat as success.
				if (stdout.length > 0 && isHookOnlyFailure(stderr)) {
					resolve({ stdout, stderr });
					return;
				}
				reject(
					new Error(
						`claude -p exited with code ${code}\n---STDERR---\n${stderr}`,
					),
				);
				return;
			}
			resolve({ stdout, stderr });
		});

		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new Error(`claude -p failed to start: ${err.message}`));
		});
	});
}

function formatWindowDelta(
	before: WindowSnapshot,
	after: WindowSnapshot,
): string {
	const fmt = (v: number | null) => (v != null ? String(v) : "?");
	const delta = (a: number | null, b: number | null) =>
		a != null && b != null ? `(+${(b - a).toFixed(1)})` : "";
	return [
		`5h window: ${fmt(before.fiveHourPct)}% → ${fmt(after.fiveHourPct)}% ${delta(before.fiveHourPct, after.fiveHourPct)}`,
		`7d window: ${fmt(before.sevenDayPct)}% → ${fmt(after.sevenDayPct)}% ${delta(before.sevenDayPct, after.sevenDayPct)}`,
		`block tokens: ${fmt(before.blockTokens)} → ${fmt(after.blockTokens)} ${delta(before.blockTokens, after.blockTokens)}`,
		`block cost: $${fmt(before.blockCost)} → $${fmt(after.blockCost)} ${delta(before.blockCost, after.blockCost)}`,
	].join("\n");
}

async function writeTaskLog(
	taskLogsDir: string,
	_taskId: string,
	taskName: string,
	content: string,
): Promise<void> {
	try {
		await mkdir(taskLogsDir, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const safeName = taskName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
		const filename = `${timestamp}_${safeName}.log`;
		await writeFile(join(taskLogsDir, filename), content);
	} catch {
		// Log writing is best-effort
	}
}

interface RuntimePaths {
	windowState: string;
	rateLimits: string;
	taskLogs: string;
	docketReservations: string | null;
	notify: NotifyConfig | null;
}

function runPreflight(command: string, projectDir: string): "skip" | "proceed" {
	try {
		execSync(command, {
			cwd: projectDir,
			timeout: 10_000,
			stdio: "ignore",
		});
		return "skip";
	} catch {
		return "proceed";
	}
}

async function executeTask(
	queuePath: string,
	task: {
		id: string;
		name: string;
		size: TaskSize;
		priority: number;
		description: string;
		prompt: string;
		project_dir: string;
		preflight?: string;
	},
	runtimePaths: RuntimePaths,
): Promise<TaskOutcome> {
	const startMs = Date.now();

	if (task.preflight) {
		const preflightResult = runPreflight(task.preflight, task.project_dir);
		if (preflightResult === "skip") {
			await completeTask(queuePath, task.id, "preflight: already completed");
			const durationMs = Date.now() - startMs;
			await writeTaskLog(
				runtimePaths.taskLogs,
				task.id,
				task.name,
				`TASK: ${task.name}\nSIZE: ${task.size}\nDIR: ${task.project_dir}\nDURATION: ${Math.round(durationMs / 1000)}s\nSTATUS: skipped (preflight)\n\n---PREFLIGHT---\n${task.preflight}\nResult: exit 0 — work already done`,
			);
			return {
				taskId: task.id,
				taskName: task.name,
				success: true,
				durationMs,
				reason: "preflight: already completed",
				windowBefore: null,
				windowAfter: null,
			};
		}
		await writeTaskLog(
			runtimePaths.taskLogs,
			task.id,
			task.name,
			`PREFLIGHT: ${task.preflight}\nResult: non-zero — proceeding with execution`,
		);
	}

	const windowBefore = await captureWindowSnapshot(
		runtimePaths.windowState,
		runtimePaths.rateLimits,
	);
	await startTask(queuePath, task.id);

	let calendarId: string | null = null;
	let eventId: string | null = null;
	try {
		calendarId = await getOrCreatePhyllisCalendar();
		const durationMin = estimateBlockMinutes(task.size);
		const now = new Date();
		const end = new Date(now.getTime() + durationMin * 60 * 1000);
		const event: PhyllisEvent = {
			summary: task.name,
			startTime: now.toISOString(),
			endTime: end.toISOString(),
			description: `Size: ${task.size}, Priority: ${task.priority}\n${task.description}`,
			status: "running",
		};
		eventId = await createEvent(calendarId, event);
	} catch {
		// Calendar write failure shouldn't block task execution
	}

	try {
		const { stdout, stderr } = await runClaude(
			task.prompt,
			task.project_dir,
			task.size,
		);
		const summary = stdout.slice(0, 500);
		const durationMs = Date.now() - startMs;
		const windowAfter = await captureWindowSnapshot(
			runtimePaths.windowState,
			runtimePaths.rateLimits,
		);

		// Rate-limit messages can arrive as "successful" output (exit 0).
		// Requeue the task instead of marking it done.
		if (isRateLimitOutput(stdout) || isRateLimitOutput(stderr)) {
			const rateLimitReason = "rate-limited — requeued for next window";
			await requeueTask(queuePath, task.id, rateLimitReason);
			await writeTaskLog(
				runtimePaths.taskLogs,
				task.id,
				task.name,
				`TASK: ${task.name}\nSIZE: ${task.size}\nDIR: ${task.project_dir}\nDURATION: ${Math.round(durationMs / 1000)}s\nSTATUS: requeued (rate-limited)\n\n---STDOUT---\n${stdout}\n\n---STDERR---\n${stderr}`,
			);
			return {
				taskId: task.id,
				taskName: task.name,
				success: false,
				durationMs,
				reason: "rate_limited",
				windowBefore,
				windowAfter,
			};
		}

		await completeTask(queuePath, task.id, summary);

		// Log full output with window consumption data
		await writeTaskLog(
			runtimePaths.taskLogs,
			task.id,
			task.name,
			`TASK: ${task.name}\nSIZE: ${task.size}\nDIR: ${task.project_dir}\nDURATION: ${Math.round(durationMs / 1000)}s\nSTATUS: done\n\n---WINDOW---\n${formatWindowDelta(windowBefore, windowAfter)}\n\n---PROMPT---\n${task.prompt}\n\n---STDOUT---\n${stdout}\n\n---STDERR---\n${stderr}`,
		);

		if (calendarId && eventId) {
			try {
				await updateEvent(calendarId, eventId, {
					status: "confirmed",
					description: `Done: ${summary}`,
					endTime: new Date().toISOString(),
				});
			} catch {
				// non-fatal
			}
		}

		if (runtimePaths.notify) {
			sendNotification(
				runtimePaths.notify,
				formatTaskNotification(task.name, true, durationMs, "completed"),
			);
		}

		return {
			taskId: task.id,
			taskName: task.name,
			success: true,
			durationMs,
			reason: "completed",
			windowBefore,
			windowAfter,
		};
	} catch (err) {
		const errMsg = (err as Error).message;
		const durationMs = Date.now() - startMs;
		const windowAfter = await captureWindowSnapshot(
			runtimePaths.windowState,
			runtimePaths.rateLimits,
		);
		const fastDeath = durationMs < 30_000;
		const rateLimited = isRateLimitOutput(errMsg);

		// Rate-limited tasks get requeued, not failed — they'll run in the next window.
		// Only requeue on explicit rate-limit text, not all fast deaths (which could be
		// config errors that would loop forever if blindly requeued).
		if (rateLimited) {
			await requeueTask(
				queuePath,
				task.id,
				"rate-limited — requeued for next window",
			);
		} else {
			await failTask(queuePath, task.id, errMsg.slice(0, 500));
		}

		const failReason = rateLimited
			? "rate_limited"
			: fastDeath
				? `fast failure (${Math.round(durationMs / 1000)}s) — likely rate-limited: ${errMsg.slice(0, 80)}`
				: `failed: ${errMsg.slice(0, 100)}`;

		// Log full error with window state for debugging
		await writeTaskLog(
			runtimePaths.taskLogs,
			task.id,
			task.name,
			`TASK: ${task.name}\nSIZE: ${task.size}\nDIR: ${task.project_dir}\nDURATION: ${Math.round(durationMs / 1000)}s\nSTATUS: failed${fastDeath ? " (FAST DEATH)" : ""}\n\n---WINDOW---\n${formatWindowDelta(windowBefore, windowAfter)}\n\n---PROMPT---\n${task.prompt}\n\n---ERROR---\n${errMsg}`,
		);

		if (calendarId && eventId) {
			try {
				await updateEvent(calendarId, eventId, {
					status: "cancelled",
					description: `Failed: ${errMsg.slice(0, 500)}`,
					endTime: new Date().toISOString(),
				});
			} catch {
				// non-fatal
			}
		}

		if (runtimePaths.notify && !rateLimited) {
			sendNotification(
				runtimePaths.notify,
				formatTaskNotification(task.name, false, durationMs, failReason),
			);
		}

		return {
			taskId: task.id,
			taskName: task.name,
			success: false,
			durationMs,
			reason: failReason,
			windowBefore,
			windowAfter,
		};
	}
}

export async function run(options: RunnerOptions): Promise<RunnerResult> {
	const { queuePath, dryRun = false, config } = options;
	const p = paths(config);
	const docketPath = config.docket?.reservationsPath ?? null;

	const runtimePaths: RuntimePaths = {
		windowState: p.windowState,
		rateLimits: p.rateLimits,
		taskLogs: p.taskLogs,
		docketReservations: docketPath,
		notify: config.notify ?? null,
	};

	const task = await nextTask(queuePath);
	const [activeBlock, rateLimits, reservation] = await Promise.all([
		getActiveBlock(),
		readRateLimits(p.windowState, p.rateLimits),
		docketPath ? readActiveReservation(docketPath) : Promise.resolve(null),
	]);

	let busyNow = false;
	let busyDuringWindow = false;
	try {
		const busy = await checkBusy();
		busyNow = busy.busyNow;
		busyDuringWindow = busy.busyDuringWindow;
	} catch {
		// If calendar is unavailable, don't block scheduling
	}

	const hoursUntilWeeklyReset = await getHoursUntilWeeklyReset(
		p.windowState,
		p.rateLimits,
	);

	const ctx: SchedulerContext = {
		activeBlock,
		nextTaskSize: task?.size ?? null,
		rateLimits,
		busyNow,
		busyDuringWindow,
		reservation,
		hoursUntilWeeklyReset,
	};

	const { decision, reason } = shouldSchedule(ctx);

	if (decision !== "schedule") {
		return { decision, reason, tasks: [], dryRun };
	}

	if (!task) {
		return {
			decision: "no_tasks",
			reason: "scheduler approved but no task found",
			tasks: [],
			dryRun,
		};
	}

	if (dryRun) {
		return {
			decision: "schedule",
			reason,
			tasks: [
				{
					taskId: task.id,
					taskName: task.name,
					success: false,
					durationMs: 0,
					reason: "dry run",
					windowBefore: null,
					windowAfter: null,
				},
			],
			dryRun: true,
		};
	}

	// Drain loop: keep running tasks while window has capacity
	return drainQueue(queuePath, task, runtimePaths);
}

async function drainQueue(
	queuePath: string,
	firstTask: Parameters<typeof executeTask>[1],
	runtimePaths: RuntimePaths,
): Promise<RunnerResult> {
	const outcomes: TaskOutcome[] = [];
	let currentTask: Parameters<typeof executeTask>[1] | null = firstTask;
	let consecutiveFailures = 0;

	while (currentTask) {
		const outcome = await executeTask(queuePath, currentTask, runtimePaths);
		outcomes.push(outcome);

		if (outcome.reason === "rate_limited") {
			// Rate-limited: stop immediately — task is already requeued,
			// next cron invocation will check window state before retrying
			break;
		}

		if (outcome.success) {
			consecutiveFailures = 0;
		} else {
			consecutiveFailures++;
			if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
				break;
			}
			// Back off before retrying — instant retries after failures
			// just burn through the failure budget without giving time to clear
			await new Promise((r) => setTimeout(r, FAILURE_BACKOFF_MS));
		}

		// Check if we should keep going
		const next = await nextTask(queuePath);
		if (!next) break;

		// Re-check scheduling constraints (calendar, reservations, budget)
		// Window crossing is fine — a new window just opens. But we should
		// respect calendar events and budget that may have changed.
		const [, limits, resv] = await Promise.all([
			getActiveBlock(),
			readRateLimits(runtimePaths.windowState, runtimePaths.rateLimits),
			runtimePaths.docketReservations
				? readActiveReservation(runtimePaths.docketReservations)
				: Promise.resolve(null),
		]);
		let busy = false;
		try {
			busy = (await checkBusy()).busyNow;
		} catch {
			// calendar unavailable, proceed
		}
		if (busy) break;
		if (resv?.intensity === "heavy" && next.size !== "S") break;
		if (limits && limits.sevenDayPct >= 85) {
			const hrs = await getHoursUntilWeeklyReset(
				runtimePaths.windowState,
				runtimePaths.rateLimits,
			);
			const { isPastBurnPoint } = await import("./scheduler.ts");
			if (hrs == null || !isPastBurnPoint(limits.sevenDayPct, hrs)) break;
		}

		currentTask = next;
	}

	const succeeded = outcomes.filter((o) => o.success).length;
	const failed = outcomes.filter((o) => !o.success).length;
	const reason =
		outcomes.length === 0
			? "no tasks executed"
			: `${succeeded} completed, ${failed} failed`;

	return { decision: "schedule", reason, tasks: outcomes, dryRun: false };
}
