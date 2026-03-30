#!/usr/bin/env node
// pattern: imperative-shell

import { resolve } from "node:path";
import { harvest, snapshot } from "./harvest.ts";

const DEFAULT_LOG_PATH = resolve(process.cwd(), "calibration-log.jsonl");

function usage(): never {
	console.error(`phyllis — calibration data harvester

Usage:
  phyllis harvest [--user <id>] [--log <path>] [--dry-run]
  phyllis snapshot [--user <id>] [--log <path>] [--dry-run]

Commands:
  harvest   Process completed blocks into calibration entries
  snapshot  Capture the active block with projection data

Options:
  --user <id>   User identifier (default: $USER or "unknown")
  --log <path>  Path to calibration-log.jsonl (default: ./calibration-log.jsonl)
  --dry-run     Print what would be appended without writing`);
	process.exit(1);
}

function parseArgs(argv: string[]): {
	command: "harvest" | "snapshot";
	userId: string;
	logPath: string;
	dryRun: boolean;
} {
	const args = argv.slice(2);
	const command = args[0];
	if (command !== "harvest" && command !== "snapshot") {
		usage();
	}

	let userId = process.env.USER ?? "unknown";
	let logPath = DEFAULT_LOG_PATH;
	let dryRun = false;

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
			default:
				console.error(`unknown option: ${args[i]}`);
				usage();
		}
	}

	return { command, userId, logPath, dryRun };
}

async function main(): Promise<void> {
	const { command, userId, logPath, dryRun } = parseArgs(process.argv);
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

main().catch((err) => {
	console.error(`fatal: ${err.message}`);
	process.exit(1);
});
