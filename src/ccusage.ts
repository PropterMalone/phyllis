// pattern: imperative-shell

import { execFile } from "node:child_process";
import type { CcusageBlock, CcusageBlocksOutput } from "./types.ts";

export function parseCcusageOutput(stdout: string): CcusageBlock[] {
	const parsed: unknown = JSON.parse(stdout);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("blocks" in parsed) ||
		!Array.isArray((parsed as CcusageBlocksOutput).blocks)
	) {
		throw new Error("ccusage output missing blocks array");
	}
	const output = parsed as CcusageBlocksOutput;
	return output.blocks.filter((b) => !b.isGap);
}

export interface FetchBlocksOptions {
	// Injectable executor for testing — default shells out to npx ccusage
	execFn?: () => Promise<string>;
}

function defaultExec(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"npx",
			["ccusage@latest", "blocks", "--json", "--offline"],
			{ maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`ccusage failed: ${error.message}${stderr ? `\n${stderr}` : ""}`,
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

export async function fetchBlocks(
	options: FetchBlocksOptions = {},
): Promise<CcusageBlock[]> {
	const exec = options.execFn ?? defaultExec;
	const stdout = await exec();
	return parseCcusageOutput(stdout);
}
