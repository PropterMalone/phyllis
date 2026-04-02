import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedTask, TaskSize } from "./types.ts";

// Mock all I/O dependencies before importing runner
vi.mock("./ccusage.ts");
vi.mock("./gcal.ts");
vi.mock("./queue.ts");
vi.mock("./scheduler.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./scheduler.ts")>();
	return { ...actual, shouldSchedule: vi.fn() };
});
vi.mock("node:child_process");

import { spawn } from "node:child_process";
import { fetchBlocks } from "./ccusage.ts";
import {
	checkBusy,
	createEvent,
	getOrCreatePhyllisCalendar,
	updateEvent,
} from "./gcal.ts";
import { completeTask, failTask, nextTask, startTask } from "./queue.ts";
import { run } from "./runner.ts";
import { shouldSchedule } from "./scheduler.ts";

const makeTask = (overrides: Partial<QueuedTask> = {}): QueuedTask => ({
	id: "task-1",
	name: "Test task",
	description: "A test task",
	size: "M" as TaskSize,
	prompt: "do the thing",
	project_dir: "/tmp/test-project",
	priority: 10,
	created_at: "2026-04-01T00:00:00Z",
	status: "queued",
	...overrides,
});

const defaultOpts = {
	queuePath: "/tmp/test-queue.json",
	logPath: "/tmp/test-log.jsonl",
};

function mockSpawnSucceeding() {
	const EventEmitter = require("node:events");
	const { PassThrough } = require("node:stream");
	vi.mocked(spawn).mockImplementation(() => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = vi.fn();
		process.nextTick(() => {
			child.stdout.write("task output");
			child.stdout.end();
			child.stderr.end();
			child.emit("close", 0);
		});
		return child as unknown as ReturnType<typeof spawn>;
	});
}

function mockSpawnFailing() {
	const EventEmitter = require("node:events");
	const { PassThrough } = require("node:stream");
	vi.mocked(spawn).mockImplementation(() => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = vi.fn();
		process.nextTick(() => {
			child.stderr.write("some error output");
			child.stderr.end();
			child.stdout.end();
			child.emit("close", 1);
		});
		return child as unknown as ReturnType<typeof spawn>;
	});
}

describe("runner", () => {
	beforeEach(() => {
		vi.resetAllMocks();

		// Re-establish all mock defaults after reset
		vi.mocked(fetchBlocks).mockResolvedValue([]);
		vi.mocked(checkBusy).mockResolvedValue({
			busyNow: false,
			busyDuringWindow: false,
		});
		vi.mocked(getOrCreatePhyllisCalendar).mockResolvedValue("cal-id");
		vi.mocked(createEvent).mockResolvedValue("event-id");
		vi.mocked(updateEvent).mockResolvedValue(undefined);
		vi.mocked(nextTask).mockResolvedValue(null);
		vi.mocked(startTask).mockResolvedValue(undefined as never);
		vi.mocked(completeTask).mockResolvedValue(undefined as never);
		vi.mocked(failTask).mockResolvedValue(undefined as never);
		vi.mocked(shouldSchedule).mockReturnValue({
			decision: "schedule",
			reason: "test",
		});
		mockSpawnSucceeding();
	});

	it("returns scheduler decision when not schedule", async () => {
		vi.mocked(nextTask).mockResolvedValue(null);
		vi.mocked(shouldSchedule).mockReturnValue({
			decision: "weekly_budget_low",
			reason: "weekly at 90%",
		});

		const result = await run(defaultOpts);
		expect(result.decision).toBe("weekly_budget_low");
		expect(result.tasks).toHaveLength(0);
		expect(startTask).not.toHaveBeenCalled();
	});

	it("runs task and completes successfully", async () => {
		vi.mocked(nextTask)
			.mockResolvedValueOnce(makeTask())
			.mockResolvedValue(null);

		const result = await run(defaultOpts);
		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].success).toBe(true);
		expect(result.tasks[0].taskName).toBe("Test task");
		expect(startTask).toHaveBeenCalledWith(defaultOpts.queuePath, "task-1");
		expect(completeTask).toHaveBeenCalled();
	});

	it("spawns claude with stdio ignore on stdin", async () => {
		vi.mocked(nextTask)
			.mockResolvedValueOnce(makeTask())
			.mockResolvedValue(null);

		await run(defaultOpts);

		expect(spawn).toHaveBeenCalledWith(
			"claude",
			["-p", "do the thing", "--output-format", "text"],
			expect.objectContaining({
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
	});

	it("drains multiple tasks within one invocation", async () => {
		const task1 = makeTask({ id: "t1", name: "First task" });
		const task2 = makeTask({ id: "t2", name: "Second task" });
		const task3 = makeTask({ id: "t3", name: "Third task" });

		vi.mocked(nextTask)
			.mockResolvedValueOnce(task1) // initial pick in run()
			.mockResolvedValueOnce(task2) // after t1 completes
			.mockResolvedValueOnce(task3) // after t2 completes
			.mockResolvedValue(null); // queue empty after t3

		const result = await run(defaultOpts);

		expect(result.tasks).toHaveLength(3);
		expect(result.tasks.every((t) => t.success)).toBe(true);
		expect(startTask).toHaveBeenCalledTimes(3);
		expect(completeTask).toHaveBeenCalledTimes(3);
		expect(result.reason).toBe("3 completed, 0 failed");
	});

	it("retries next task on failure and keeps draining", async () => {
		const task1 = makeTask({ id: "t1", name: "Failing task" });
		const task2 = makeTask({ id: "t2", name: "Succeeding task" });

		vi.mocked(nextTask)
			.mockResolvedValueOnce(task1)
			.mockResolvedValueOnce(task2)
			.mockResolvedValue(null);

		// First spawn fails, second succeeds
		const EventEmitter = require("node:events");
		const { PassThrough } = require("node:stream");
		let callCount = 0;
		vi.mocked(spawn).mockImplementation(() => {
			callCount++;
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = vi.fn();

			process.nextTick(() => {
				if (callCount === 1) {
					child.stderr.write("some error");
					child.stderr.end();
					child.stdout.end();
					child.emit("close", 1);
				} else {
					child.stdout.write("success output");
					child.stdout.end();
					child.stderr.end();
					child.emit("close", 0);
				}
			});

			return child as unknown as ReturnType<typeof spawn>;
		});

		const result = await run(defaultOpts);

		expect(result.tasks).toHaveLength(2);
		expect(result.tasks[0].success).toBe(false);
		expect(result.tasks[1].success).toBe(true);
		expect(failTask).toHaveBeenCalledWith(
			defaultOpts.queuePath,
			"t1",
			expect.any(String),
		);
		expect(completeTask).toHaveBeenCalledWith(
			defaultOpts.queuePath,
			"t2",
			expect.any(String),
		);
	});

	it("stops after MAX_CONSECUTIVE_FAILURES", async () => {
		vi.mocked(nextTask)
			.mockResolvedValueOnce(makeTask({ id: "t1", name: "fail 1" }))
			.mockResolvedValueOnce(makeTask({ id: "t2", name: "fail 2" }))
			.mockResolvedValueOnce(makeTask({ id: "t3", name: "fail 3" }))
			.mockResolvedValue(null);

		mockSpawnFailing();

		const result = await run(defaultOpts);

		// Should fail 3 tasks (MAX_CONSECUTIVE_FAILURES = 3), then stop
		expect(result.tasks).toHaveLength(3);
		expect(failTask).toHaveBeenCalledTimes(3);
		expect(startTask).toHaveBeenCalledTimes(3);
	});

	it("resets consecutive failure count on success", async () => {
		vi.mocked(nextTask)
			.mockResolvedValueOnce(makeTask({ id: "t1", name: "fail" }))
			.mockResolvedValueOnce(makeTask({ id: "t2", name: "fail" }))
			.mockResolvedValueOnce(makeTask({ id: "t3", name: "succeed" }))
			.mockResolvedValueOnce(makeTask({ id: "t4", name: "fail" }))
			.mockResolvedValueOnce(makeTask({ id: "t5", name: "fail" }))
			.mockResolvedValue(null);

		const EventEmitter = require("node:events");
		const { PassThrough } = require("node:stream");
		let callCount = 0;
		vi.mocked(spawn).mockImplementation(() => {
			callCount++;
			const child = new EventEmitter();
			child.stdout = new PassThrough();
			child.stderr = new PassThrough();
			child.kill = vi.fn();
			process.nextTick(() => {
				if (callCount === 3) {
					child.stdout.write("ok");
					child.stdout.end();
					child.stderr.end();
					child.emit("close", 0);
				} else {
					child.stderr.write("err");
					child.stderr.end();
					child.stdout.end();
					child.emit("close", 1);
				}
			});
			return child as unknown as ReturnType<typeof spawn>;
		});

		const result = await run(defaultOpts);

		// fail, fail, succeed (reset), fail, fail — 5 total
		expect(result.tasks).toHaveLength(5);
		expect(failTask).toHaveBeenCalledTimes(4);
		expect(completeTask).toHaveBeenCalledTimes(1);
	});

	it("stops when queue is empty", async () => {
		vi.mocked(nextTask)
			.mockResolvedValueOnce(makeTask({ id: "t1" }))
			.mockResolvedValue(null);

		const result = await run(defaultOpts);

		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].success).toBe(true);
	});

	it("stops draining when calendar becomes busy", async () => {
		vi.mocked(nextTask)
			.mockResolvedValueOnce(makeTask({ id: "t1" }))
			.mockResolvedValueOnce(makeTask({ id: "t2" }))
			.mockResolvedValue(null);

		// First checkBusy (in run()) is fine, second (in drain loop) says busy
		vi.mocked(checkBusy)
			.mockResolvedValueOnce({ busyNow: false, busyDuringWindow: false })
			.mockResolvedValueOnce({ busyNow: true, busyDuringWindow: true });

		const result = await run(defaultOpts);

		expect(result.tasks).toHaveLength(1);
		expect(result.tasks[0].taskId).toBe("t1");
	});

	it("dry run returns without executing", async () => {
		vi.mocked(nextTask).mockResolvedValueOnce(makeTask());

		const result = await run({ ...defaultOpts, dryRun: true });

		expect(result.dryRun).toBe(true);
		expect(result.tasks).toHaveLength(1);
		expect(spawn).not.toHaveBeenCalled();
		expect(startTask).not.toHaveBeenCalled();
	});
});
