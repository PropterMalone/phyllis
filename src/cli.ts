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
	defaultConfig,
	initHome,
	loadConfig as loadPhyllisConfig,
	type PhyllisConfig,
	paths,
} from "./config.ts";
import { digest } from "./digest.ts";
import {
	getOrCreatePhyllisCalendar,
	listUpcoming,
	loadConfig,
} from "./gcal.ts";
import { harvest, snapshot } from "./harvest.ts";
import { startProxy } from "./proxy.ts";
import {
	addTask,
	completeTask,
	findTasksByPattern,
	listTasks,
} from "./queue.ts";
import { run } from "./runner.ts";
import { setup } from "./setup.ts";
import type { CalibrationEntry, TaskSize } from "./types.ts";
import { buildWeeklySummary, renderWeeklySummary } from "./weekly.ts";

function usage(): never {
	console.error(`phyllis — Claude Code usage optimizer

Usage:
  phyllis init
  phyllis setup [--force]
  phyllis harvest [--user <id>] [--log <path>] [--dry-run]
  phyllis snapshot [--user <id>] [--log <path>] [--dry-run]
  phyllis analyze [--log <path>] [--metric <tokens|cost>]
  phyllis weekly [--log <path>]
  phyllis queue list [--queue <path>]
  phyllis queue add --name <n> --size <S|M|L|XL> --prompt <p> --dir <d> [--priority <n>] [--preflight <cmd>]
  phyllis queue done <name-or-id>
  phyllis queue angel --dir <d> [--priority <n>] [--queue <path>]
  phyllis run [--queue <path>] [--dry-run]
  phyllis digest [--hours <n>] [--dry-run]
  phyllis proxy [--port 7735] [--log <path>]
  phyllis calendar setup
  phyllis calendar list [--hours <n>]

Commands:
  init      Create ~/.phyllis config and directory structure
  setup     Install hooks + statusline into Claude Code
  harvest   Process completed blocks into calibration entries
  snapshot  Capture the active block with projection data
  analyze   Show usage heatmap and project breakdown
  weekly    Show weekly summary with burn rate trends
  queue     Manage deferrable task queue
  run       Check window state and execute next queued task
  digest    Send overnight task summary email (default: last 18h)
  proxy     Start rate-limit header capture proxy
  calendar  Manage Phyllis Google Calendar integration

Options:
  --user <id>          User identifier (default: $USER or "unknown")
  --log <path>         Path to calibration-log.jsonl (default: ~/.phyllis/calibration-log.jsonl)
  --dry-run            Print what would be appended without writing
  --metric <m>         Heatmap metric: tokens or cost (default: cost)`);
	process.exit(1);
}

type Command =
	| "init"
	| "setup"
	| "harvest"
	| "snapshot"
	| "analyze"
	| "weekly"
	| "queue"
	| "run"
	| "digest"
	| "proxy"
	| "calendar";

interface ParsedArgs {
	command: Command;
	userId?: string;
	logPath?: string;
	queuePath?: string;
	dryRun: boolean;
	force: boolean;
	metric: "tokens" | "cost";
	// queue add fields
	taskName?: string;
	taskSize?: TaskSize;
	taskPrompt?: string;
	taskDir?: string;
	taskPriority?: number;
	taskPreflight?: string;
	subcommand?: string;
	taskPattern?: string;
	hours?: number;
	proxyPort?: number;
}

const VALID_COMMANDS = new Set([
	"init",
	"setup",
	"harvest",
	"snapshot",
	"analyze",
	"weekly",
	"queue",
	"run",
	"digest",
	"proxy",
	"calendar",
]);

function parseArgs(argv: string[]): ParsedArgs {
	const args = argv.slice(2);
	const command = args[0] as string;
	if (!VALID_COMMANDS.has(command)) {
		usage();
	}

	let userId: string | undefined;
	let logPath: string | undefined;
	let queuePath: string | undefined;
	let dryRun = false;
	let force = false;
	let metric: "tokens" | "cost" = "cost";
	let subcommand: string | undefined;
	let taskName: string | undefined;
	let taskSize: TaskSize | undefined;
	let taskPrompt: string | undefined;
	let taskDir: string | undefined;
	let taskPriority: number | undefined;
	let taskPreflight: string | undefined;
	let taskPattern: string | undefined;
	let hours: number | undefined;
	let proxyPort: number | undefined;

	// For "queue" and "calendar", first positional after command is the subcommand
	let startIdx = 1;
	if (
		(command === "queue" || command === "calendar") &&
		args[1] &&
		!args[1].startsWith("--")
	) {
		subcommand = args[1];
		startIdx = 2;
		// "queue done <pattern>" — capture the positional arg
		if (
			command === "queue" &&
			subcommand === "done" &&
			args[2] &&
			!args[2].startsWith("--")
		) {
			taskPattern = args[2];
			startIdx = 3;
		}
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
			case "--force":
				force = true;
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
			case "--preflight":
				taskPreflight = args[++i];
				break;
			case "--hours":
				hours = Number(args[++i]);
				break;
			case "--port":
				proxyPort = Number(args[++i]);
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
		force,
		metric,
		subcommand,
		taskName,
		taskSize,
		taskPrompt,
		taskDir,
		taskPriority,
		taskPreflight,
		taskPattern,
		hours,
		proxyPort,
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

async function runHarvestOrSnapshot(parsed: ResolvedArgs): Promise<void> {
	const command = parsed.command;
	const userId = parsed.resolvedUserId;
	const logPath = parsed.resolvedLogPath;
	const { dryRun } = parsed;
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

async function runAnalyze(parsed: ResolvedArgs): Promise<void> {
	const { metric } = parsed;
	const logPath = parsed.resolvedLogPath;

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

async function runWeekly(parsed: ResolvedArgs): Promise<void> {
	const entries = await readCalibrationLog(parsed.resolvedLogPath);
	const weeks = buildWeeklySummary(entries);
	console.log(`\n  Weekly Summary (${entries.length} blocks)\n`);
	console.log(renderWeeklySummary(weeks));
}

async function runQueue(parsed: ResolvedArgs): Promise<void> {
	const queuePath = parsed.resolvedQueuePath;
	const { subcommand } = parsed;

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

	if (subcommand === "done") {
		const pattern = parsed.taskPattern;
		if (!pattern) {
			console.error("queue done requires a task name or ID");
			process.exit(1);
		}
		const matches = await findTasksByPattern(queuePath, pattern);
		if (matches.length === 0) {
			console.error(`no queued task matching '${pattern}'`);
			process.exit(1);
		}
		if (matches.length > 1) {
			console.error(
				`multiple queued tasks match '${pattern}' — be more specific:`,
			);
			for (const t of matches) {
				console.error(`  ${t.name} (${t.id})`);
			}
			process.exit(1);
		}
		const task = matches[0];
		await completeTask(
			queuePath,
			task.id,
			"manually completed (interactive session)",
		);
		console.log(`done: ${task.name} (${task.id})`);
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
		const {
			taskName,
			taskSize,
			taskPrompt,
			taskDir,
			taskPriority,
			taskPreflight,
		} = parsed;
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
			preflight: taskPreflight,
		});
		console.log(`added task: ${task.name} (${task.id})`);
		return;
	}

	console.error(`unknown queue subcommand: ${subcommand}`);
	usage();
}

async function runCalendar(parsed: ResolvedArgs): Promise<void> {
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

async function runDigest(parsed: ResolvedArgs): Promise<void> {
	const p = paths(parsed.config);
	const result = await digest({
		queuePath: parsed.resolvedQueuePath,
		taskLogsDir: p.taskLogs,
		dryRun: parsed.dryRun,
		cutoffHours: parsed.hours ?? 18,
	});

	if (parsed.dryRun) {
		console.log(result);
	} else {
		console.log(`sent: ${result}`);
	}
}

async function runScheduler(parsed: ResolvedArgs): Promise<void> {
	const result = await run({
		queuePath: parsed.resolvedQueuePath,
		logPath: parsed.resolvedLogPath,
		dryRun: parsed.dryRun,
		config: parsed.config,
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

interface ResolvedArgs extends ParsedArgs {
	config: PhyllisConfig;
	resolvedLogPath: string;
	resolvedQueuePath: string;
	resolvedUserId: string;
}

async function resolveArgs(parsed: ParsedArgs): Promise<ResolvedArgs> {
	const config = await loadPhyllisConfig();
	return {
		...parsed,
		config,
		resolvedLogPath: parsed.logPath ?? config.logPath,
		resolvedQueuePath: parsed.queuePath ?? config.queuePath,
		resolvedUserId: parsed.userId ?? config.userId,
	};
}

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv);

	// init doesn't need config loading
	if (parsed.command === "init") {
		const config = defaultConfig();
		await initHome(config);
		console.log(`initialized ${config.home}`);
		console.log(`  config: ${config.home}/config.json`);
		console.log(`  log:    ${config.logPath}`);
		console.log(`  queue:  ${config.queuePath}`);
		return;
	}

	// setup doesn't need config loading either
	if (parsed.command === "setup") {
		const home = process.env.HOME ?? "";
		const phyllisHome = process.env.PHYLLIS_HOME ?? `${home}/.phyllis`;
		const claudeHome = `${home}/.claude`;
		// Find hooks source directory relative to this script
		const hooksSrcDir = new URL("../hooks", import.meta.url).pathname;
		const plan = await setup({
			phyllisHome,
			claudeHome,
			hooksSrcDir,
			force: parsed.force,
		});
		for (const w of plan.warnings) {
			console.log(`  warning: ${w}`);
		}
		console.log(`hooks installed to ${plan.hooksDir}`);
		for (const f of plan.hooksToCopy) {
			console.log(`  ${f}`);
		}
		console.log(`settings updated: ${plan.settingsPath}`);
		if (plan.statusLine) {
			console.log("  statusline: configured");
		}
		for (const h of plan.hooksToAdd) {
			console.log(`  ${h.event}: configured`);
		}
		return;
	}

	const resolved = await resolveArgs(parsed);

	switch (resolved.command) {
		case "analyze":
			await runAnalyze(resolved);
			break;
		case "weekly":
			await runWeekly(resolved);
			break;
		case "queue":
			await runQueue(resolved);
			break;
		case "calendar":
			await runCalendar(resolved);
			break;
		case "run":
			await runScheduler(resolved);
			break;
		case "digest":
			await runDigest(resolved);
			break;
		case "proxy": {
			const port = resolved.proxyPort ?? resolved.config.proxy.port;
			const p = paths(resolved.config);
			startProxy({
				port,
				logPath: resolved.resolvedLogPath,
				statePath: p.windowState,
			});
			console.log(`phyllis proxy listening on http://127.0.0.1:${port}`);
			console.log(`set ANTHROPIC_BASE_URL=http://127.0.0.1:${port}`);
			await new Promise(() => {});
			break;
		}
		default:
			await runHarvestOrSnapshot(resolved);
	}
}

main().catch((err) => {
	console.error(`fatal: ${err.message}`);
	process.exit(1);
});
