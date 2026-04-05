import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addTask,
	completeTask,
	failTask,
	findTasksByPattern,
	listTasks,
	nextTask,
	requeueTask,
	startTask,
} from "./queue.ts";

async function withTmpQueue(
	fn: (queuePath: string) => Promise<void>,
): Promise<void> {
	const tmpDir = await mkdtemp(join(tmpdir(), "phyllis-queue-"));
	const queuePath = join(tmpDir, "queue.json");
	try {
		await fn(queuePath);
	} finally {
		await rm(tmpDir, { recursive: true });
	}
}

const baseTask = {
	name: "NineAngel full run",
	description: "Run /angel --full on starcounter",
	size: "L" as const,
	prompt: "/angel --full",
	project_dir: "~/Projects/starcounter",
	priority: 10,
};

describe("addTask", () => {
	it("creates a new task in the queue", async () => {
		await withTmpQueue(async (queuePath) => {
			const task = await addTask(queuePath, baseTask);
			expect(task.id).toBeTruthy();
			expect(task.status).toBe("queued");
			expect(task.created_at).toBeTruthy();

			const tasks = await listTasks(queuePath);
			expect(tasks).toHaveLength(1);
			expect(tasks[0].name).toBe("NineAngel full run");
		});
	});

	it("appends to existing queue", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, baseTask);
			await addTask(queuePath, { ...baseTask, name: "3CB resolution" });

			const tasks = await listTasks(queuePath);
			expect(tasks).toHaveLength(2);
		});
	});

	it("generates unique IDs", async () => {
		await withTmpQueue(async (queuePath) => {
			const t1 = await addTask(queuePath, baseTask);
			const t2 = await addTask(queuePath, baseTask);
			expect(t1.id).not.toBe(t2.id);
		});
	});
});

describe("listTasks", () => {
	it("returns empty array for nonexistent file", async () => {
		const tasks = await listTasks("/nonexistent/queue.json");
		expect(tasks).toEqual([]);
	});

	it("filters by status", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await addTask(queuePath, { ...baseTask, name: "other" });
			await startTask(queuePath, t.id);

			const queued = await listTasks(queuePath, "queued");
			expect(queued).toHaveLength(1);
			expect(queued[0].name).toBe("other");

			const running = await listTasks(queuePath, "running");
			expect(running).toHaveLength(1);
			expect(running[0].name).toBe("NineAngel full run");
		});
	});
});

describe("nextTask", () => {
	it("returns the highest-priority queued task", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, { ...baseTask, priority: 20 });
			await addTask(queuePath, {
				...baseTask,
				name: "urgent",
				priority: 1,
			});

			const next = await nextTask(queuePath);
			expect(next?.name).toBe("urgent");
		});
	});

	it("returns null when no queued tasks", async () => {
		await withTmpQueue(async (queuePath) => {
			const next = await nextTask(queuePath);
			expect(next).toBeNull();
		});
	});

	it("skips running/done/failed tasks", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await startTask(queuePath, t.id);

			const next = await nextTask(queuePath);
			expect(next).toBeNull();
		});
	});
});

describe("task lifecycle", () => {
	it("transitions queued → running → done", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);

			const running = await startTask(queuePath, t.id);
			expect(running.status).toBe("running");
			expect(running.started_at).toBeTruthy();

			const done = await completeTask(
				queuePath,
				t.id,
				"Ran 9 personas, all passed",
			);
			expect(done.status).toBe("done");
			expect(done.completed_at).toBeTruthy();
			expect(done.result_summary).toBe("Ran 9 personas, all passed");
		});
	});

	it("transitions running → queued via requeue", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await startTask(queuePath, t.id);

			const requeued = await requeueTask(
				queuePath,
				t.id,
				"rate-limited — requeued for next window",
			);
			expect(requeued.status).toBe("queued");
			expect(requeued.started_at).toBeUndefined();
			expect(requeued.completed_at).toBeUndefined();
			expect(requeued.result_summary).toBe(
				"requeued: rate-limited — requeued for next window",
			);

			// Should be picked up by nextTask again
			const next = await nextTask(queuePath);
			expect(next?.id).toBe(t.id);
		});
	});

	it("transitions queued → running → failed", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await startTask(queuePath, t.id);

			const failed = await failTask(
				queuePath,
				t.id,
				"claude -p exited with code 1",
			);
			expect(failed.status).toBe("failed");
			expect(failed.completed_at).toBeTruthy();
			expect(failed.result_summary).toBe("claude -p exited with code 1");
		});
	});
});

describe("findTasksByPattern", () => {
	it("matches exact name", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, baseTask);
			const matches = await findTasksByPattern(queuePath, "NineAngel full run");
			expect(matches).toHaveLength(1);
			expect(matches[0].name).toBe("NineAngel full run");
		});
	});

	it("matches substring", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, baseTask);
			await addTask(queuePath, { ...baseTask, name: "3CB resolution" });
			const matches = await findTasksByPattern(queuePath, "angel");
			expect(matches).toHaveLength(1);
			expect(matches[0].name).toBe("NineAngel full run");
		});
	});

	it("matches case-insensitively", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, baseTask);
			const matches = await findTasksByPattern(queuePath, "nineangel");
			expect(matches).toHaveLength(1);
			expect(matches[0].name).toBe("NineAngel full run");
		});
	});

	it("returns empty array for no match", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, baseTask);
			const matches = await findTasksByPattern(queuePath, "nonexistent");
			expect(matches).toEqual([]);
		});
	});

	it("only returns queued tasks", async () => {
		await withTmpQueue(async (queuePath) => {
			const t1 = await addTask(queuePath, baseTask);
			await addTask(queuePath, {
				...baseTask,
				name: "NineAngel partial run",
			});
			await startTask(queuePath, t1.id);
			await completeTask(queuePath, t1.id, "done");

			const matches = await findTasksByPattern(queuePath, "angel");
			expect(matches).toHaveLength(1);
			expect(matches[0].name).toBe("NineAngel partial run");
		});
	});

	it("matches by exact task ID", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await addTask(queuePath, { ...baseTask, name: "other task" });
			const matches = await findTasksByPattern(queuePath, t.id);
			expect(matches).toHaveLength(1);
			expect(matches[0].id).toBe(t.id);
		});
	});
});
