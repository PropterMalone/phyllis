// pattern: functional-core
// Parse Anthropic's undocumented rate-limit headers from API responses

import type { RateLimitState } from "./scheduler.ts";

const HEADER_PREFIX = "anthropic-ratelimit-unified-";

// Per-window fields we look for (suffix after window name)
const WINDOW_SUFFIXES = [
	"-utilization",
	"-reset",
	"-status",
	"-surpassed-threshold",
] as const;

/** One rate-limit window as reported by Anthropic headers */
export interface RateLimitWindow {
	name: string; // "5h" | "7d" | "7d_sonnet" | dynamic
	utilization: number; // 0.0-1.0
	resetAt: number; // unix epoch seconds
	status: string; // e.g. "allowed"
	surpassedThreshold: boolean;
}

/** Parsed state from one API response's headers */
export interface ParsedRateLimitHeaders {
	representativeClaim: string;
	fallbackPercentage: number | null;
	overageDisabledReason: string | null;
	overageStatus: string | null;
	retryAfterS: number | null;
	windows: RateLimitWindow[];
}

/** Live state written to /tmp/phyllis-window-state.json */
export interface ProxyWindowState {
	capturedAt: string; // ISO 8601
	representativeClaim: string;
	windows: RateLimitWindow[];
	// Flattened convenience fields for scheduler
	fiveHourUtilization: number | null;
	sevenDayUtilization: number | null;
	fiveHourResetAt: number | null;
	sevenDayResetAt: number | null;
}

/** Transition events worth logging to calibration */
export type ProxyTransition =
	| { kind: "reset"; window: string; oldUtil: number; newUtil: number }
	| { kind: "threshold"; window: string; surpassed: boolean }
	| { kind: "rate-limited"; retryAfterS: number | null };

type HeaderMap = Record<string, string | string[] | undefined>;

function headerStr(headers: HeaderMap, key: string): string | undefined {
	const v = headers[key];
	if (Array.isArray(v)) return v[0];
	return v;
}

function headerNum(headers: HeaderMap, key: string): number | null {
	const s = headerStr(headers, key);
	if (s == null) return null;
	const n = Number(s);
	return Number.isNaN(n) ? null : n;
}

function headerBool(headers: HeaderMap, key: string): boolean {
	const s = headerStr(headers, key);
	return s === "true";
}

/**
 * Discover window names by scanning for *-utilization headers.
 * This handles unknown future windows automatically.
 */
function discoverWindowNames(headers: HeaderMap): string[] {
	const names: string[] = [];
	const suffix = "-utilization";
	for (const key of Object.keys(headers)) {
		if (!key.startsWith(HEADER_PREFIX)) continue;
		if (!key.endsWith(suffix)) continue;
		// Extract window name: between prefix and suffix
		const windowName = key.slice(HEADER_PREFIX.length, -suffix.length);
		// Skip top-level fields (no hyphen-separated window name)
		if (
			windowName.length > 0 &&
			!WINDOW_SUFFIXES.some((s) => s === `-${windowName}`)
		) {
			names.push(windowName);
		}
	}
	return names;
}

/** Parse rate-limit headers from an API response. Returns null if no relevant headers found. */
export function parseRateLimitHeaders(
	headers: HeaderMap,
): ParsedRateLimitHeaders | null {
	const claim = headerStr(headers, `${HEADER_PREFIX}representative-claim`);
	if (claim == null) return null;

	const windowNames = discoverWindowNames(headers);
	const windows: RateLimitWindow[] = [];

	for (const name of windowNames) {
		const prefix = `${HEADER_PREFIX}${name}`;
		const utilization = headerNum(headers, `${prefix}-utilization`);
		if (utilization == null) continue; // need at least utilization

		windows.push({
			name,
			utilization,
			resetAt: headerNum(headers, `${prefix}-reset`) ?? 0,
			status: headerStr(headers, `${prefix}-status`) ?? "unknown",
			surpassedThreshold: headerBool(headers, `${prefix}-surpassed-threshold`),
		});
	}

	return {
		representativeClaim: claim,
		fallbackPercentage: headerNum(
			headers,
			`${HEADER_PREFIX}fallback-percentage`,
		),
		overageDisabledReason:
			headerStr(headers, `${HEADER_PREFIX}overage-disabled-reason`) ?? null,
		overageStatus: headerStr(headers, `${HEADER_PREFIX}overage-status`) ?? null,
		retryAfterS: headerNum(headers, "retry-after"),
		windows,
	};
}

/** Build live state with flattened convenience fields */
export function buildLiveState(
	parsed: ParsedRateLimitHeaders,
	now?: string,
): ProxyWindowState {
	const fiveHour = parsed.windows.find((w) => w.name === "5h");
	const sevenDay = parsed.windows.find((w) => w.name === "7d");

	return {
		capturedAt: now ?? new Date().toISOString(),
		representativeClaim: parsed.representativeClaim,
		windows: parsed.windows,
		fiveHourUtilization: fiveHour?.utilization ?? null,
		sevenDayUtilization: sevenDay?.utilization ?? null,
		fiveHourResetAt: fiveHour?.resetAt ?? null,
		sevenDayResetAt: sevenDay?.resetAt ?? null,
	};
}

/** Detect meaningful transitions between consecutive states */
export function detectTransitions(
	previous: ProxyWindowState | null,
	current: ProxyWindowState,
): ProxyTransition[] {
	if (previous == null) return [];

	const transitions: ProxyTransition[] = [];

	for (const curWindow of current.windows) {
		const prevWindow = previous.windows.find((w) => w.name === curWindow.name);
		if (!prevWindow) continue;

		// Reset: utilization dropped by ≥10 percentage points
		const drop = prevWindow.utilization - curWindow.utilization;
		if (drop >= 0.1) {
			transitions.push({
				kind: "reset",
				window: curWindow.name,
				oldUtil: prevWindow.utilization,
				newUtil: curWindow.utilization,
			});
		}

		// Threshold flip
		if (prevWindow.surpassedThreshold !== curWindow.surpassedThreshold) {
			transitions.push({
				kind: "threshold",
				window: curWindow.name,
				surpassed: curWindow.surpassedThreshold,
			});
		}
	}

	return transitions;
}

/** Convert proxy state to scheduler-compatible RateLimitState (0-100 scale) */
export function toLiveRateLimitState(state: ProxyWindowState): RateLimitState {
	return {
		fiveHourPct: (state.fiveHourUtilization ?? 0) * 100,
		sevenDayPct: (state.sevenDayUtilization ?? 0) * 100,
	};
}
