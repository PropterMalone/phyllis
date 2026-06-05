// pattern: imperative-shell
// Append the current 5h/7d rate-limit meter readings to a history log so we can
// later derive WINDOW_WEEKLY_PCT = Δ7d% / Δ5h% over no-reset intervals (pure
// meter math, free of token/cost-weighting noise). Dedups on capturedAt.
//
// Run on a cron (every few minutes). Reads whichever window-state.json is
// freshest; the `phyllis proxy` process keeps it updated on each API response.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = process.env.PHYLLIS_HOME || join(homedir(), ".phyllis");
const CANDIDATES = [
	join(HOME, "state", "window-state.json"),
	"/tmp/phyllis-window-state.json",
];
const HISTORY = join(HOME, "state", "window-history.jsonl");

function readState(path) {
	try {
		const s = JSON.parse(readFileSync(path, "utf8"));
		if (!s.capturedAt || s.fiveHourUtilization == null) return null;
		return {
			capturedAt: s.capturedAt,
			five: s.fiveHourUtilization,
			seven: s.sevenDayUtilization ?? null,
			fiveResetAt: s.fiveHourResetAt ?? null,
			sevenResetAt: s.sevenDayResetAt ?? null,
		};
	} catch {
		return null;
	}
}

// Pick the freshest available state file
let best = null;
for (const p of CANDIDATES) {
	const s = readState(p);
	if (s && (!best || s.capturedAt > best.capturedAt)) best = s;
}
if (!best) {
	console.error("no readable window-state.json");
	process.exit(0); // non-fatal — nothing to sample
}

// Dedup: skip if last recorded row has the same capturedAt
let lastCaptured = null;
if (existsSync(HISTORY)) {
	try {
		const lines = readFileSync(HISTORY, "utf8").trim().split("\n");
		if (lines.length && lines[lines.length - 1]) {
			lastCaptured = JSON.parse(lines[lines.length - 1]).capturedAt;
		}
	} catch {
		/* ignore */
	}
}
if (best.capturedAt === lastCaptured) {
	process.exit(0); // no new reading since last sample
}

mkdirSync(dirname(HISTORY), { recursive: true });
appendFileSync(HISTORY, JSON.stringify(best) + "\n");
console.log(
	`sampled ${best.capturedAt}  5h=${(best.five * 100).toFixed(0)}%  7d=${best.seven != null ? (best.seven * 100).toFixed(0) + "%" : "?"}`,
);
