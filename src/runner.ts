// pattern: imperative-shell
// Cron entry point: check window state, pick a task, run it via claude -p

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fetchBlocks } from "./ccusage.ts";
import {
	checkBusy,
	createEvent,
	getOrCreatePhyllisCalendar,
	updateEvent,
} from "./gcal.ts";
import { completeTask, failTask, nextTask, startTask } from "./queue.ts";
import {
	type DocketReservation,
	estimateBlockMinutes,
	type RateLimitState,
	type SchedulerContext,
	shouldSchedule,
} from "./scheduler.ts";
import type { PhyllisEvent } from "./types.ts";

export interface RunnerOptions {
	queuePath: string;
	logPath: string;
	dryRun?: boolean;
}

export interface RunnerResult {
	decision: string;
	reason: string;
	taskId?: string;
	taskName?: string;
	dryRun: boolean;
}

const RATE_LIMITS_CACHE = "/tmp/phyllis-rate-limits";
const DOCKET_RESERVATIONS = `${process.env.HOME ?? "/home/karl"}/.docket/reservations.json`;

async function readRateLimits(): Promise<RateLimitState | null> {
	try {
		const content = await readFile(RATE_LIMITS_CACHE, "utf-8");
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

async function readActiveReservation(): Promise<DocketReservation | null> {
	try {
		const content = await readFile(DOCKET_RESERVATIONS, "utf-8");
		const reservations = JSON.parse(content) as DocketReservation[];
		const now = new Date().toISOString();
		const fiveHoursLater = new Date(
			Date.now() + 5 * 60 * 60 * 1000,
		).toISOString();
		// Find any reservation that overlaps the next 5 hours
		return (
			reservations.find((r) => r.end > now && r.start < fiveHoursLater) ?? null
		);
	} catch {
		return null;
	}
}

async function getActiveBlock() {
	try {
		const blocks = await fetchBlocks();
		return blocks.find((b) => b.isActive) ?? null;
	} catch {
		return null;
	}
}

function runClaude(prompt: string, projectDir: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		// Nested Claude Code sessions need env cleanup
		delete env.CLAUDE_CODE;
		delete env.CLAUDECODE;

		execFile(
			"claude",
			["-p", prompt, "--output-format", "text"],
			{
				cwd: projectDir,
				maxBuffer: 50 * 1024 * 1024,
				timeout: 30 * 60 * 1000, // 30 min max
				env,
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(`claude -p failed: ${error.message}\n${stderr}`));
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export async function run(options: RunnerOptions): Promise<RunnerResult> {
	const { queuePath, dryRun = false } = options;

	const task = await nextTask(queuePath);
	const [activeBlock, rateLimits, reservation] = await Promise.all([
		getActiveBlock(),
		readRateLimits(),
		readActiveReservation(),
	]);

	// Calendar-aware scheduling
	let busyNow = false;
	let busyDuringWindow = false;
	try {
		const busy = await checkBusy();
		busyNow = busy.busyNow;
		busyDuringWindow = busy.busyDuringWindow;
	} catch {
		// If calendar is unavailable, don't block scheduling
	}

	const ctx: SchedulerContext = {
		activeBlock,
		nextTaskSize: task?.size ?? null,
		rateLimits,
		busyNow,
		busyDuringWindow,
		reservation,
	};

	const { decision, reason } = shouldSchedule(ctx);

	if (decision !== "schedule") {
		return { decision, reason, dryRun };
	}

	// We have a task and the scheduler says go
	if (!task) {
		return {
			decision: "no_tasks",
			reason: "scheduler approved but no task found",
			dryRun,
		};
	}

	if (dryRun) {
		return {
			decision: "schedule",
			reason,
			taskId: task.id,
			taskName: task.name,
			dryRun: true,
		};
	}

	// Mark task as running
	await startTask(queuePath, task.id);

	// Create calendar event
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
		const output = await runClaude(task.prompt, task.project_dir);
		const summary = output.slice(0, 500);
		await completeTask(queuePath, task.id, summary);

		// Update calendar event — mark done
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

		return {
			decision: "schedule",
			reason,
			taskId: task.id,
			taskName: task.name,
			dryRun: false,
		};
	} catch (err) {
		await failTask(queuePath, task.id, (err as Error).message.slice(0, 500));

		// Update calendar event — mark failed
		if (calendarId && eventId) {
			try {
				await updateEvent(calendarId, eventId, {
					status: "cancelled",
					description: `Failed: ${(err as Error).message.slice(0, 500)}`,
					endTime: new Date().toISOString(),
				});
			} catch {
				// non-fatal
			}
		}

		return {
			decision: "schedule",
			reason: `task failed: ${(err as Error).message.slice(0, 100)}`,
			taskId: task.id,
			taskName: task.name,
			dryRun: false,
		};
	}
}
