import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addTask,
	completeTask,
	DEAD_LETTER_THRESHOLD,
	failTask,
	findTasksByPattern,
	listTasks,
	nextBurnPointTask,
	nextTask,
	requeueTask,
	retryTask,
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

	it("skips burn_point_only held tasks", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, {
				...baseTask,
				name: "held reserve",
				priority: 1,
				burn_point_only: true,
			});
			await addTask(queuePath, { ...baseTask, name: "normal", priority: 5 });

			const next = await nextTask(queuePath);
			expect(next?.name).toBe("normal");
		});
	});

	it("returns null when only burn_point_only tasks are queued", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, {
				...baseTask,
				name: "held reserve",
				burn_point_only: true,
			});

			const next = await nextTask(queuePath);
			expect(next).toBeNull();
		});
	});
});

describe("nextBurnPointTask", () => {
	it("returns the highest-priority burn_point_only task", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, {
				...baseTask,
				name: "held low",
				priority: 20,
				burn_point_only: true,
			});
			await addTask(queuePath, {
				...baseTask,
				name: "held high",
				priority: 2,
				burn_point_only: true,
			});
			await addTask(queuePath, { ...baseTask, name: "normal", priority: 1 });

			const next = await nextBurnPointTask(queuePath);
			expect(next?.name).toBe("held high");
		});
	});

	it("returns null when no burn_point_only tasks are queued", async () => {
		await withTmpQueue(async (queuePath) => {
			await addTask(queuePath, { ...baseTask, name: "normal" });

			const next = await nextBurnPointTask(queuePath);
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

describe("dead-letter queue", () => {
	it("increments failure_count on each fail", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await startTask(queuePath, t.id);
			const after1 = await failTask(queuePath, t.id, "first failure");
			expect(after1.failure_count).toBe(1);
			expect(after1.status).toBe("failed");
			expect(after1.failure_history).toHaveLength(1);
			expect(after1.failure_history?.[0].reason).toBe("first failure");

			await retryTask(queuePath, t.id, { preserveCount: true });
			await startTask(queuePath, t.id);
			const after2 = await failTask(queuePath, t.id, "second failure");
			expect(after2.failure_count).toBe(2);
			expect(after2.status).toBe("failed");
			expect(after2.failure_history).toHaveLength(2);
		});
	});

	it("promotes to dead status on Nth failure", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			for (let i = 0; i < DEAD_LETTER_THRESHOLD - 1; i++) {
				await startTask(queuePath, t.id);
				await failTask(queuePath, t.id, `failure ${i + 1}`);
				await retryTask(queuePath, t.id, { preserveCount: true });
			}
			await startTask(queuePath, t.id);
			const dead = await failTask(queuePath, t.id, "final failure");
			expect(dead.failure_count).toBe(DEAD_LETTER_THRESHOLD);
			expect(dead.status).toBe("dead");
		});
	});

	it("nextTask excludes dead tasks", async () => {
		await withTmpQueue(async (queuePath) => {
			const dying = await addTask(queuePath, {
				...baseTask,
				name: "dying",
				priority: 1,
			});
			await addTask(queuePath, { ...baseTask, name: "healthy", priority: 10 });

			// Drive `dying` to dead status
			for (let i = 0; i < DEAD_LETTER_THRESHOLD; i++) {
				await startTask(queuePath, dying.id);
				await failTask(queuePath, dying.id, `f${i}`);
				if (i < DEAD_LETTER_THRESHOLD - 1) {
					await retryTask(queuePath, dying.id, { preserveCount: true });
				}
			}

			const next = await nextTask(queuePath);
			expect(next?.name).toBe("healthy");
		});
	});

	it("retryTask without preserveCount resets failure_count", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await startTask(queuePath, t.id);
			await failTask(queuePath, t.id, "boom");
			const retried = await retryTask(queuePath, t.id);
			expect(retried.failure_count).toBe(0);
			expect(retried.status).toBe("queued");
		});
	});

	it("retryTask can revive a dead task", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			for (let i = 0; i < DEAD_LETTER_THRESHOLD; i++) {
				await startTask(queuePath, t.id);
				await failTask(queuePath, t.id, `f${i}`);
				if (i < DEAD_LETTER_THRESHOLD - 1) {
					await retryTask(queuePath, t.id, { preserveCount: true });
				}
			}
			const tasks = await listTasks(queuePath);
			expect(tasks[0].status).toBe("dead");

			const revived = await retryTask(queuePath, t.id);
			expect(revived.status).toBe("queued");
			expect(revived.failure_count).toBe(0);

			// And now it's pickable again
			const next = await nextTask(queuePath);
			expect(next?.id).toBe(t.id);
		});
	});

	it("trims failure_history to 10 entries", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			for (let i = 0; i < 12; i++) {
				await startTask(queuePath, t.id);
				await failTask(queuePath, t.id, `failure ${i}`);
				await retryTask(queuePath, t.id, { preserveCount: true });
			}
			const tasks = await listTasks(queuePath);
			expect(tasks[0].failure_history?.length).toBeLessThanOrEqual(10);
		});
	});
});

describe("cost metrics on completion", () => {
	it("persists tokens_used and cost_used when provided", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await startTask(queuePath, t.id);
			const done = await completeTask(queuePath, t.id, "ok", {
				tokens_used: 123456,
				cost_used: 4.56,
				five_hour_pct_delta: 12.5,
				seven_day_pct_delta: 3.2,
			});
			expect(done.tokens_used).toBe(123456);
			expect(done.cost_used).toBe(4.56);
			expect(done.five_hour_pct_delta).toBe(12.5);
			expect(done.seven_day_pct_delta).toBe(3.2);
		});
	});

	it("legacy completeTask without metrics still works", async () => {
		await withTmpQueue(async (queuePath) => {
			const t = await addTask(queuePath, baseTask);
			await startTask(queuePath, t.id);
			const done = await completeTask(queuePath, t.id, "ok");
			expect(done.status).toBe("done");
			expect(done.tokens_used).toBeUndefined();
		});
	});
});
