#!/usr/bin/env node
// pattern: imperative-shell

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CcusageSession } from "./analyze.ts";
import {
	buildHeatmap,
	buildProjectSummary,
	renderHeatmap,
	renderProjectTable,
} from "./analyze.ts";
import {
	getOrCreatePhyllisCalendar,
	listUpcoming,
	loadConfig,
} from "./gcal.ts";
import { harvest, snapshot } from "./harvest.ts";
import { addTask, listTasks } from "./queue.ts";
import { run } from "./runner.ts";
import type { CalibrationEntry, TaskSize } from "./types.ts";
import { buildWeeklySummary, renderWeeklySummary } from "./weekly.ts";

const DEFAULT_LOG_PATH = resolve(process.cwd(), "calibration-log.jsonl");

function usage(): never {
	console.error(`phyllis — Claude Code usage optimizer

Usage:
  phyllis harvest [--user <id>] [--log <path>] [--dry-run]
  phyllis snapshot [--user <id>] [--log <path>] [--dry-run]
  phyllis analyze [--log <path>] [--metric <tokens|cost>]
  phyllis weekly [--log <path>]
  phyllis queue list [--queue <path>]
  phyllis queue add --name <n> --size <S|M|L|XL> --prompt <p> --dir <d> [--priority <n>]
  phyllis queue angel --dir <d> [--priority <n>] [--queue <path>]
  phyllis run [--queue <path>] [--dry-run]
  phyllis calendar setup
  phyllis calendar list [--hours <n>]

Commands:
  harvest   Process completed blocks into calibration entries
  snapshot  Capture the active block with projection data
  analyze   Show usage heatmap and project breakdown
  weekly    Show weekly summary with burn rate trends
  queue     Manage deferrable task queue
  run       Check window state and execute next queued task
  calendar  Manage Phyllis Google Calendar integration

Options:
  --user <id>          User identifier (default: $USER or "unknown")
  --log <path>         Path to calibration-log.jsonl (default: ./calibration-log.jsonl)
  --dry-run            Print what would be appended without writing
  --metric <m>         Heatmap metric: tokens or cost (default: cost)`);
	process.exit(1);
}

type Command =
	| "harvest"
	| "snapshot"
	| "analyze"
	| "weekly"
	| "queue"
	| "run"
	| "calendar";

const DEFAULT_QUEUE_PATH = resolve(process.cwd(), "queue.json");

interface ParsedArgs {
	command: Command;
	userId: string;
	logPath: string;
	queuePath: string;
	dryRun: boolean;
	metric: "tokens" | "cost";
	// queue add fields
	taskName?: string;
	taskSize?: TaskSize;
	taskPrompt?: string;
	taskDir?: string;
	taskPriority?: number;
	subcommand?: string;
	hours?: number;
}

const VALID_COMMANDS = new Set([
	"harvest",
	"snapshot",
	"analyze",
	"weekly",
	"queue",
	"run",
	"calendar",
]);

function parseArgs(argv: string[]): ParsedArgs {
	const args = argv.slice(2);
	const command = args[0] as string;
	if (!VALID_COMMANDS.has(command)) {
		usage();
	}

	let userId = process.env.USER ?? "unknown";
	let logPath = DEFAULT_LOG_PATH;
	let queuePath = DEFAULT_QUEUE_PATH;
	let dryRun = false;
	let metric: "tokens" | "cost" = "cost";
	let subcommand: string | undefined;
	let taskName: string | undefined;
	let taskSize: TaskSize | undefined;
	let taskPrompt: string | undefined;
	let taskDir: string | undefined;
	let taskPriority: number | undefined;
	let hours: number | undefined;

	// For "queue" and "calendar", first positional after command is the subcommand
	let startIdx = 1;
	if (
		(command === "queue" || command === "calendar") &&
		args[1] &&
		!args[1].startsWith("--")
	) {
		subcommand = args[1];
		startIdx = 2;
	}

	for (let i = startIdx; i < args.length; i++) {
		switch (args[i]) {
			case "--user":
				userId = args[++i];
				break;
			case "--log":
				logPath = resolve(args[++i]);
				break;
			case "--queue":
				queuePath = resolve(args[++i]);
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--metric": {
				const m = args[++i];
				if (m !== "tokens" && m !== "cost") usage();
				metric = m;
				break;
			}
			case "--name":
				taskName = args[++i];
				break;
			case "--size":
				taskSize = args[++i] as TaskSize;
				break;
			case "--prompt":
				taskPrompt = args[++i];
				break;
			case "--dir":
				taskDir = args[++i];
				break;
			case "--priority":
				taskPriority = Number(args[++i]);
				break;
			case "--hours":
				hours = Number(args[++i]);
				break;
			default:
				console.error(`unknown option: ${args[i]}`);
				usage();
		}
	}

	return {
		command: command as Command,
		userId,
		logPath,
		queuePath,
		dryRun,
		metric,
		subcommand,
		taskName,
		taskSize,
		taskPrompt,
		taskDir,
		taskPriority,
		hours,
	};
}

async function readCalibrationLog(
	logPath: string,
): Promise<CalibrationEntry[]> {
	const content = await readFile(logPath, "utf-8");
	const entries: CalibrationEntry[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as CalibrationEntry);
		} catch {
			// skip malformed
		}
	}
	return entries;
}

async function runHarvestOrSnapshot(parsed: ParsedArgs): Promise<void> {
	const { command, userId, logPath, dryRun } = parsed;
	const options = { logPath, userId, dryRun };

	const result =
		command === "harvest" ? await harvest(options) : await snapshot(options);

	if (result.appended === 0) {
		console.log(
			command === "snapshot"
				? "no active block found"
				: "no new blocks to harvest",
		);
		return;
	}

	const prefix = dryRun ? "[dry-run] would append" : "appended";
	console.log(`${prefix} ${result.appended} entries to ${logPath}`);

	for (const entry of result.entries) {
		console.log(
			`  ${entry.window_start} — ${entry.tokens_consumed.toLocaleString()} tokens, $${entry.cost_equiv.toFixed(2)}`,
		);
	}
}

async function runAnalyze(parsed: ParsedArgs): Promise<void> {
	const { logPath, metric } = parsed;

	// Heatmap from calibration data
	const entries = await readCalibrationLog(logPath);
	const heatmap = buildHeatmap(entries);

	console.log(`\n  Usage Heatmap (by ${metric}, ${entries.length} blocks)\n`);
	console.log(renderHeatmap(heatmap, metric));

	// Project breakdown from ccusage
	console.log("\n  Project Breakdown\n");
	try {
		const { execFile } = await import("node:child_process");
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				"ccusage",
				["session", "--json", "--offline"],
				{ maxBuffer: 10 * 1024 * 1024 },
				(error, stdout, _stderr) => {
					if (error) {
						reject(new Error(`ccusage failed: ${error.message}`));
						return;
					}
					resolve(stdout);
				},
			);
		});
		const data = JSON.parse(stdout) as {
			sessions: CcusageSession[];
		};
		const summaries = buildProjectSummary(data.sessions);
		console.log(renderProjectTable(summaries));
	} catch (err) {
		console.error(
			`  (project breakdown unavailable: ${(err as Error).message})`,
		);
	}
}

async function runWeekly(parsed: ParsedArgs): Promise<void> {
	const entries = await readCalibrationLog(parsed.logPath);
	const weeks = buildWeeklySummary(entries);
	console.log(`\n  Weekly Summary (${entries.length} blocks)\n`);
	console.log(renderWeeklySummary(weeks));
}

async function runQueue(parsed: ParsedArgs): Promise<void> {
	const { queuePath, subcommand } = parsed;

	if (subcommand === "list" || !subcommand) {
		const tasks = await listTasks(queuePath);
		if (tasks.length === 0) {
			console.log("queue is empty");
			return;
		}
		console.log(`\n  Task Queue (${tasks.length} tasks)\n`);
		for (const t of tasks) {
			const status =
				t.status === "queued"
					? " "
					: t.status === "running"
						? "▶"
						: t.status === "done"
							? "✓"
							: "✗";
			console.log(
				`  [${status}] ${t.name} (${t.size}, p${t.priority}) — ${t.status}`,
			);
		}
		return;
	}

	if (subcommand === "angel") {
		const { taskDir, taskPriority } = parsed;
		if (!taskDir) {
			console.error("queue angel requires --dir");
			process.exit(1);
		}
		const projectName = taskDir.split("/").pop() ?? "unknown";
		const reportPath = `/tmp/angel-${projectName.toLowerCase()}.md`;
		const prompt = `Read ~/.claude/skills/angel/unattended.md and follow it exactly.\nPROJECT_DIR: ${taskDir}\nREPORT_PATH: ${reportPath}\nPERSONAS: all 9`;
		const task = await addTask(queuePath, {
			name: `NineAngel: ${projectName} full review`,
			description: `NineAngel: ${projectName} full review`,
			size: "L" as TaskSize,
			prompt,
			project_dir: taskDir,
			priority: taskPriority ?? 20,
		});
		console.log(`queued: ${task.name} (${task.id})`);
		console.log(`  report → ${reportPath}`);
		return;
	}

	if (subcommand === "add") {
		const { taskName, taskSize, taskPrompt, taskDir, taskPriority } = parsed;
		if (!taskName || !taskSize || !taskPrompt || !taskDir) {
			console.error("queue add requires --name, --size, --prompt, and --dir");
			process.exit(1);
		}
		const task = await addTask(queuePath, {
			name: taskName,
			description: taskName,
			size: taskSize,
			prompt: taskPrompt,
			project_dir: taskDir,
			priority: taskPriority ?? 10,
		});
		console.log(`added task: ${task.name} (${task.id})`);
		return;
	}

	console.error(`unknown queue subcommand: ${subcommand}`);
	usage();
}

async function runCalendar(parsed: ParsedArgs): Promise<void> {
	const { subcommand } = parsed;

	if (subcommand === "setup") {
		const calendarId = await getOrCreatePhyllisCalendar();
		const config = await loadConfig();
		console.log(`Phyllis calendar ready: ${calendarId}`);
		console.log(
			`Tracking ${config?.calendarIds?.length ?? 0} calendars for freebusy`,
		);
		return;
	}

	if (subcommand === "list") {
		const config = await loadConfig();
		if (!config?.calendarId) {
			console.error("run 'phyllis calendar setup' first");
			process.exit(1);
		}
		const events = await listUpcoming(config.calendarId, parsed.hours ?? 24);
		if (events.length === 0) {
			console.log("no upcoming Phyllis events");
			return;
		}
		console.log(`\n  Phyllis Events (next ${parsed.hours ?? 24}h)\n`);
		for (const e of events) {
			const start = new Date(e.startTime).toLocaleString();
			const status =
				e.status === "running" ? "▶" : e.status === "done" ? "✓" : "✗";
			console.log(`  [${status}] ${e.summary} — ${start}`);
		}
		return;
	}

	console.error(`unknown calendar subcommand: ${subcommand ?? "(none)"}`);
	console.error("usage: phyllis calendar setup | phyllis calendar list");
	process.exit(1);
}

async function runScheduler(parsed: ParsedArgs): Promise<void> {
	const result = await run({
		queuePath: parsed.queuePath,
		logPath: parsed.logPath,
		dryRun: parsed.dryRun,
	});

	const prefix = result.dryRun ? "[dry-run] " : "";
	if (result.tasks.length === 0) {
		console.log(`${prefix}${result.decision}: ${result.reason}`);
	} else {
		for (const t of result.tasks) {
			const dur = Math.round(t.durationMs / 1000);
			const status = t.success ? "done" : "FAILED";
			const window =
				t.windowBefore && t.windowAfter
					? ` [5h: ${t.windowBefore.fiveHourPct ?? "?"}→${t.windowAfter.fiveHourPct ?? "?"}%, 7d: ${t.windowBefore.sevenDayPct ?? "?"}→${t.windowAfter.sevenDayPct ?? "?"}%]`
					: "";
			console.log(
				`${prefix}${status}: ${t.taskName} (${dur}s) — ${t.reason}${window}`,
			);
		}
		console.log(`${prefix}${result.reason}`);
	}
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv);

	switch (parsed.command) {
		case "analyze":
			await runAnalyze(parsed);
			break;
		case "weekly":
			await runWeekly(parsed);
			break;
		case "queue":
			await runQueue(parsed);
			break;
		case "calendar":
			await runCalendar(parsed);
			break;
		case "run":
			await runScheduler(parsed);
			break;
		default:
			await runHarvestOrSnapshot(parsed);
	}
}

main().catch((err) => {
	console.error(`fatal: ${err.message}`);
	process.exit(1);
});
