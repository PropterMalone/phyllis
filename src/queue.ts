// pattern: imperative-shell

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { QueuedTask, TaskSize } from "./types.ts";

export interface AddTaskInput {
	name: string;
	description: string;
	size: TaskSize;
	prompt: string;
	project_dir: string;
	priority: number;
	preflight?: string;
	burn_point_only?: boolean;
}

// After this many lifetime failures a task is auto-promoted to `dead`
// instead of being failed-and-retried. Prevents chronic failures from
// cycling through the queue forever.
export const DEAD_LETTER_THRESHOLD = 3;

export interface TaskCostMetrics {
	tokens_used?: number;
	cost_used?: number;
	five_hour_pct_delta?: number;
	seven_day_pct_delta?: number;
}

async function readQueue(queuePath: string): Promise<QueuedTask[]> {
	try {
		const content = await readFile(queuePath, "utf-8");
		return JSON.parse(content) as QueuedTask[];
	} catch {
		return [];
	}
}

async function writeQueue(
	queuePath: string,
	tasks: QueuedTask[],
): Promise<void> {
	await writeFile(queuePath, JSON.stringify(tasks, null, "\t"));
}

export async function findTasksByPattern(
	queuePath: string,
	pattern: string,
): Promise<QueuedTask[]> {
	const tasks = await listTasks(queuePath, "queued");
	const idMatch = tasks.filter((t) => t.id === pattern);
	if (idMatch.length > 0) return idMatch;
	const lower = pattern.toLowerCase();
	return tasks.filter((t) => t.name.toLowerCase().includes(lower));
}

export async function addTask(
	queuePath: string,
	input: AddTaskInput,
): Promise<QueuedTask> {
	const tasks = await readQueue(queuePath);
	const task: QueuedTask = {
		id: randomUUID(),
		name: input.name,
		description: input.description,
		size: input.size,
		prompt: input.prompt,
		project_dir: input.project_dir,
		priority: input.priority,
		created_at: new Date().toISOString(),
		status: "queued",
		...(input.preflight && { preflight: input.preflight }),
		...(input.burn_point_only && { burn_point_only: true }),
	};
	tasks.push(task);
	await writeQueue(queuePath, tasks);
	return task;
}

export async function listTasks(
	queuePath: string,
	status?: QueuedTask["status"],
): Promise<QueuedTask[]> {
	const tasks = await readQueue(queuePath);
	if (status) return tasks.filter((t) => t.status === status);
	return tasks;
}

export async function nextTask(queuePath: string): Promise<QueuedTask | null> {
	const queued = (await listTasks(queuePath, "queued")).filter(
		(t) => t.burn_point_only !== true,
	);
	if (queued.length === 0) return null;
	queued.sort((a, b) => a.priority - b.priority);
	return queued[0];
}

export async function nextBurnPointTask(
	queuePath: string,
): Promise<QueuedTask | null> {
	const queued = (await listTasks(queuePath, "queued")).filter(
		(t) => t.burn_point_only === true,
	);
	if (queued.length === 0) return null;
	// Exclude tasks that have already exceeded the dead-letter threshold
	// (defensive — failTask should already have promoted them to `dead`).
	const eligible = queued.filter(
		(t) => (t.failure_count ?? 0) < DEAD_LETTER_THRESHOLD,
	);
	if (eligible.length === 0) return null;
	eligible.sort((a, b) => a.priority - b.priority);
	return eligible[0];
}

function updateTask(
	tasks: QueuedTask[],
	id: string,
	updates: Partial<QueuedTask>,
): QueuedTask {
	const task = tasks.find((t) => t.id === id);
	if (!task) throw new Error(`task not found: ${id}`);
	Object.assign(task, updates);
	return task;
}

export async function startTask(
	queuePath: string,
	id: string,
): Promise<QueuedTask> {
	const tasks = await readQueue(queuePath);
	const task = updateTask(tasks, id, {
		status: "running",
		started_at: new Date().toISOString(),
	});
	await writeQueue(queuePath, tasks);
	return task;
}

export async function completeTask(
	queuePath: string,
	id: string,
	summary: string,
	metrics?: TaskCostMetrics,
): Promise<QueuedTask> {
	const tasks = await readQueue(queuePath);
	const task = updateTask(tasks, id, {
		status: "done",
		completed_at: new Date().toISOString(),
		result_summary: summary,
		...(metrics ?? {}),
	});
	await writeQueue(queuePath, tasks);
	return task;
}

export async function requeueTask(
	queuePath: string,
	id: string,
	reason: string,
): Promise<QueuedTask> {
	const tasks = await readQueue(queuePath);
	const task = updateTask(tasks, id, {
		status: "queued",
		started_at: undefined,
		completed_at: undefined,
		result_summary: `requeued: ${reason}`,
	});
	await writeQueue(queuePath, tasks);
	return task;
}

export async function failTask(
	queuePath: string,
	id: string,
	summary: string,
	metrics?: TaskCostMetrics,
): Promise<QueuedTask> {
	const tasks = await readQueue(queuePath);
	const existing = tasks.find((t) => t.id === id);
	const priorCount = existing?.failure_count ?? 0;
	const nextCount = priorCount + 1;
	const history = existing?.failure_history ?? [];
	history.push({ at: new Date().toISOString(), reason: summary.slice(0, 200) });
	// Trim history to last 10 entries — bounded growth
	const trimmedHistory = history.slice(-10);
	const newStatus: QueuedTask["status"] =
		nextCount >= DEAD_LETTER_THRESHOLD ? "dead" : "failed";

	const task = updateTask(tasks, id, {
		status: newStatus,
		completed_at: new Date().toISOString(),
		result_summary: summary,
		failure_count: nextCount,
		failure_history: trimmedHistory,
		...(metrics ?? {}),
	});
	await writeQueue(queuePath, tasks);
	return task;
}

/**
 * Mark a `failed` or `dead` task back to `queued`. Used for manual retries —
 * "I fixed the underlying problem, give it another shot." Resets failure_count
 * unless `preserveCount: true` is passed.
 */
export async function retryTask(
	queuePath: string,
	id: string,
	options: { preserveCount?: boolean } = {},
): Promise<QueuedTask> {
	const tasks = await readQueue(queuePath);
	const task = updateTask(tasks, id, {
		status: "queued",
		started_at: undefined,
		completed_at: undefined,
		result_summary: undefined,
		...(options.preserveCount ? {} : { failure_count: 0 }),
	});
	await writeQueue(queuePath, tasks);
	return task;
}
