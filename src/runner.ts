// pattern: imperative-shell
// Cron entry point: check window state, pick a task, run it via claude -p

import { execFile } from "node:child_process";
import { fetchBlocks } from "./ccusage.ts";
import { completeTask, failTask, nextTask, startTask } from "./queue.ts";
import { type SchedulerContext, shouldSchedule } from "./scheduler.ts";

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
	const activeBlock = await getActiveBlock();

	const now = new Date();
	const ctx: SchedulerContext = {
		activeBlock,
		nextTaskSize: task?.size ?? null,
		currentHourUTC: now.getUTCHours(),
		currentDayUTC: now.getUTCDay(),
		isWeekday: now.getUTCDay() !== 0 && now.getUTCDay() !== 6,
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

	try {
		const output = await runClaude(task.prompt, task.project_dir);
		const summary = output.slice(0, 500); // first 500 chars as summary
		await completeTask(queuePath, task.id, summary);
		return {
			decision: "schedule",
			reason,
			taskId: task.id,
			taskName: task.name,
			dryRun: false,
		};
	} catch (err) {
		await failTask(queuePath, task.id, (err as Error).message.slice(0, 500));
		return {
			decision: "schedule",
			reason: `task failed: ${(err as Error).message.slice(0, 100)}`,
			taskId: task.id,
			taskName: task.name,
			dryRun: false,
		};
	}
}
