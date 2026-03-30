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
import { harvest, snapshot } from "./harvest.ts";
import type { CalibrationEntry } from "./types.ts";

const DEFAULT_LOG_PATH = resolve(process.cwd(), "calibration-log.jsonl");

function usage(): never {
	console.error(`phyllis — Claude Code usage optimizer

Usage:
  phyllis harvest [--user <id>] [--log <path>] [--dry-run]
  phyllis snapshot [--user <id>] [--log <path>] [--dry-run]
  phyllis analyze [--log <path>] [--metric <tokens|cost>]

Commands:
  harvest   Process completed blocks into calibration entries
  snapshot  Capture the active block with projection data
  analyze   Show usage heatmap and project breakdown

Options:
  --user <id>          User identifier (default: $USER or "unknown")
  --log <path>         Path to calibration-log.jsonl (default: ./calibration-log.jsonl)
  --dry-run            Print what would be appended without writing
  --metric <m>         Heatmap metric: tokens or cost (default: cost)`);
	process.exit(1);
}

type Command = "harvest" | "snapshot" | "analyze";

interface ParsedArgs {
	command: Command;
	userId: string;
	logPath: string;
	dryRun: boolean;
	metric: "tokens" | "cost";
}

function parseArgs(argv: string[]): ParsedArgs {
	const args = argv.slice(2);
	const command = args[0] as string;
	if (
		command !== "harvest" &&
		command !== "snapshot" &&
		command !== "analyze"
	) {
		usage();
	}

	let userId = process.env.USER ?? "unknown";
	let logPath = DEFAULT_LOG_PATH;
	let dryRun = false;
	let metric: "tokens" | "cost" = "cost";

	for (let i = 1; i < args.length; i++) {
		switch (args[i]) {
			case "--user":
				userId = args[++i];
				if (!userId) usage();
				break;
			case "--log":
				logPath = resolve(args[++i]);
				if (!logPath) usage();
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
			default:
				console.error(`unknown option: ${args[i]}`);
				usage();
		}
	}

	return { command: command as Command, userId, logPath, dryRun, metric };
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
				"npx",
				["ccusage@latest", "session", "--json", "--offline"],
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

async function main(): Promise<void> {
	const parsed = parseArgs(process.argv);

	if (parsed.command === "analyze") {
		await runAnalyze(parsed);
	} else {
		await runHarvestOrSnapshot(parsed);
	}
}

main().catch((err) => {
	console.error(`fatal: ${err.message}`);
	process.exit(1);
});
