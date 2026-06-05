// pattern: functional-core (analysis)
// Derive WINDOW_WEEKLY_PCT from sampled meter history.
//
// For each pair of consecutive samples with NO 5h reset and NO 7d reset between
// them (resetAt unchanged) and a meaningful 5h rise, one full 5h window's share
// of the weekly budget is Δ7d% / Δ5h% × 100. We report the distribution plus an
// aggregate (Σ Δ7d / Σ Δ5h) which is robust to small noisy steps.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.PHYLLIS_HOME || join(homedir(), ".phyllis");
const HISTORY = join(HOME, "state", "window-history.jsonl");
const MIN_D5 = Number(process.argv[2] ?? 0.03); // ignore steps below this 5h rise (frac)

if (!existsSync(HISTORY)) {
	console.error(`no history yet at ${HISTORY} — sampler hasn't collected data`);
	process.exit(0);
}

const rows = readFileSync(HISTORY, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l))
	.filter((r) => r.seven != null)
	.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));

const ratios = [];
let sumD5 = 0;
let sumD7 = 0;
for (let i = 1; i < rows.length; i++) {
	const a = rows[i - 1];
	const b = rows[i];
	// Same windows on both sides (no reset crossed)
	if (a.fiveResetAt !== b.fiveResetAt) continue;
	if (a.sevenResetAt !== b.sevenResetAt) continue;
	const d5 = b.five - a.five;
	const d7 = b.seven - a.seven;
	if (d5 < MIN_D5 || d7 <= 0) continue; // need real consumption, both rising
	ratios.push((d7 / d5) * 100);
	sumD5 += d5;
	sumD7 += d7;
}

console.log(
	`samples: ${rows.length}  usable intervals: ${ratios.length}  (min Δ5h ${(MIN_D5 * 100).toFixed(0)}%)`,
);
if (ratios.length === 0) {
	console.log(
		"not enough consumption captured yet — let the sampler run across active use",
	);
	process.exit(0);
}
const sorted = [...ratios].sort((x, y) => x - y);
const pct = (p) =>
	sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
console.log(`\nWINDOW_WEEKLY_PCT (one full 5h window as %% of weekly):`);
console.log(
	`  per-interval:  median=${pct(0.5).toFixed(1)}  mean=${mean.toFixed(1)}  p25=${pct(0.25).toFixed(1)}  p75=${pct(0.75).toFixed(1)}`,
);
console.log(
	`  aggregate (ΣΔ7d/ΣΔ5h): ${((sumD7 / sumD5) * 100).toFixed(1)}   <-- most robust`,
);
console.log(
	`  => ~${(sumD5 > 0 ? sumD7 / sumD5 : 0) > 0 ? (100 / ((sumD7 / sumD5) * 100)).toFixed(1) : "?"} full windows fit in a weekly budget`,
);
