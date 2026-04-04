import { describe, expect, it } from "vitest";
import {
	buildLiveState,
	detectTransitions,
	type ProxyWindowState,
	parseRateLimitHeaders,
	toLiveRateLimitState,
} from "./proxy-headers.ts";

/** Helper: build a realistic set of Anthropic rate-limit headers */
function makeHeaders(
	overrides: Record<string, string> = {},
): Record<string, string> {
	return {
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"anthropic-ratelimit-unified-fallback-percentage": "0.5",
		"anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
		"anthropic-ratelimit-unified-overage-status": "disabled",
		"anthropic-ratelimit-unified-5h-utilization": "0.42",
		"anthropic-ratelimit-unified-5h-reset": "1743696000",
		"anthropic-ratelimit-unified-5h-status": "allowed",
		"anthropic-ratelimit-unified-5h-surpassed-threshold": "false",
		"anthropic-ratelimit-unified-7d-utilization": "0.15",
		"anthropic-ratelimit-unified-7d-reset": "1744128000",
		"anthropic-ratelimit-unified-7d-status": "allowed",
		"anthropic-ratelimit-unified-7d-surpassed-threshold": "false",
		"anthropic-ratelimit-unified-7d_sonnet-utilization": "0.08",
		"anthropic-ratelimit-unified-7d_sonnet-reset": "1744128000",
		"anthropic-ratelimit-unified-7d_sonnet-status": "allowed",
		"anthropic-ratelimit-unified-7d_sonnet-surpassed-threshold": "false",
		...overrides,
	};
}

describe("parseRateLimitHeaders", () => {
	it("parses a complete set of headers for 3 windows", () => {
		const result = parseRateLimitHeaders(makeHeaders());
		expect(result).not.toBeNull();
		expect(result?.representativeClaim).toBe("five_hour");
		expect(result?.fallbackPercentage).toBe(0.5);
		expect(result?.overageDisabledReason).toBe("out_of_credits");
		expect(result?.overageStatus).toBe("disabled");
		expect(result?.windows).toHaveLength(3);

		const fiveHour = result?.windows.find((w) => w.name === "5h");
		expect(fiveHour).toEqual({
			name: "5h",
			utilization: 0.42,
			resetAt: 1743696000,
			status: "allowed",
			surpassedThreshold: false,
		});

		const sevenDay = result?.windows.find((w) => w.name === "7d");
		expect(sevenDay?.utilization).toBe(0.15);

		const sonnet = result?.windows.find((w) => w.name === "7d_sonnet");
		expect(sonnet?.utilization).toBe(0.08);
	});

	it("returns null when no relevant headers present", () => {
		expect(parseRateLimitHeaders({})).toBeNull();
		expect(
			parseRateLimitHeaders({ "content-type": "application/json" }),
		).toBeNull();
	});

	it("returns null when representative-claim is missing", () => {
		const headers = makeHeaders();
		delete (headers as Record<string, string>)[
			"anthropic-ratelimit-unified-representative-claim"
		];
		expect(parseRateLimitHeaders(headers)).toBeNull();
	});

	it("handles partial windows (only some have utilization)", () => {
		const headers: Record<string, string> = {
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-5h-utilization": "0.55",
			"anthropic-ratelimit-unified-5h-status": "allowed",
			// 7d has no utilization header
			"anthropic-ratelimit-unified-7d-status": "allowed",
		};
		const result = parseRateLimitHeaders(headers);
		expect(result?.windows).toHaveLength(1);
		expect(result?.windows[0].name).toBe("5h");
	});

	it("handles array header values (Node.js duplicate headers)", () => {
		const headers: Record<string, string | string[]> = {
			"anthropic-ratelimit-unified-representative-claim": [
				"five_hour",
				"five_hour",
			],
			"anthropic-ratelimit-unified-5h-utilization": ["0.33"],
			"anthropic-ratelimit-unified-5h-reset": ["1743696000"],
			"anthropic-ratelimit-unified-5h-status": ["allowed"],
			"anthropic-ratelimit-unified-5h-surpassed-threshold": ["false"],
		};
		const result = parseRateLimitHeaders(headers);
		expect(result?.representativeClaim).toBe("five_hour");
		expect(result?.windows[0].utilization).toBe(0.33);
	});

	it("handles malformed utilization values gracefully", () => {
		const headers: Record<string, string> = {
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-5h-utilization": "not_a_number",
			"anthropic-ratelimit-unified-7d-utilization": "0.20",
			"anthropic-ratelimit-unified-7d-reset": "1744128000",
			"anthropic-ratelimit-unified-7d-status": "allowed",
			"anthropic-ratelimit-unified-7d-surpassed-threshold": "false",
		};
		const result = parseRateLimitHeaders(headers);
		// 5h skipped (malformed), 7d parsed
		expect(result?.windows).toHaveLength(1);
		expect(result?.windows[0].name).toBe("7d");
	});

	it("parses retry-after header", () => {
		const headers = makeHeaders({ "retry-after": "30" });
		const result = parseRateLimitHeaders(headers);
		expect(result?.retryAfterS).toBe(30);
	});

	it("handles surpassed-threshold true", () => {
		const headers = makeHeaders({
			"anthropic-ratelimit-unified-5h-surpassed-threshold": "true",
		});
		const result = parseRateLimitHeaders(headers);
		const fiveHour = result?.windows.find((w) => w.name === "5h");
		expect(fiveHour?.surpassedThreshold).toBe(true);
	});

	it("discovers unknown window names dynamically", () => {
		const headers: Record<string, string> = {
			"anthropic-ratelimit-unified-representative-claim": "future_window",
			"anthropic-ratelimit-unified-24h-utilization": "0.10",
			"anthropic-ratelimit-unified-24h-reset": "1750000000",
			"anthropic-ratelimit-unified-24h-status": "allowed",
			"anthropic-ratelimit-unified-24h-surpassed-threshold": "false",
		};
		const result = parseRateLimitHeaders(headers);
		expect(result?.windows).toHaveLength(1);
		expect(result?.windows[0].name).toBe("24h");
	});
});

describe("buildLiveState", () => {
	it("maps 5h and 7d windows to convenience fields", () => {
		const parsed = parseRateLimitHeaders(makeHeaders())!;
		const state = buildLiveState(parsed, "2026-04-03T14:00:00Z");

		expect(state.capturedAt).toBe("2026-04-03T14:00:00Z");
		expect(state.representativeClaim).toBe("five_hour");
		expect(state.fiveHourUtilization).toBe(0.42);
		expect(state.sevenDayUtilization).toBe(0.15);
		expect(state.fiveHourResetAt).toBe(1743696000);
		expect(state.sevenDayResetAt).toBe(1744128000);
		expect(state.windows).toHaveLength(3);
	});

	it("returns null convenience fields when windows are missing", () => {
		const headers: Record<string, string> = {
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-7d_sonnet-utilization": "0.05",
			"anthropic-ratelimit-unified-7d_sonnet-reset": "1744128000",
			"anthropic-ratelimit-unified-7d_sonnet-status": "allowed",
			"anthropic-ratelimit-unified-7d_sonnet-surpassed-threshold": "false",
		};
		const parsed = parseRateLimitHeaders(headers)!;
		const state = buildLiveState(parsed);

		expect(state.fiveHourUtilization).toBeNull();
		expect(state.sevenDayUtilization).toBeNull();
		expect(state.fiveHourResetAt).toBeNull();
		expect(state.sevenDayResetAt).toBeNull();
	});
});

describe("detectTransitions", () => {
	function makeState(
		overrides: Partial<ProxyWindowState> = {},
	): ProxyWindowState {
		return {
			capturedAt: "2026-04-03T14:00:00Z",
			representativeClaim: "five_hour",
			windows: [
				{
					name: "5h",
					utilization: 0.42,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: false,
				},
				{
					name: "7d",
					utilization: 0.15,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
			fiveHourUtilization: 0.42,
			sevenDayUtilization: 0.15,
			fiveHourResetAt: 1743696000,
			sevenDayResetAt: 1744128000,
			...overrides,
		};
	}

	it("returns empty array when previous is null (first request)", () => {
		expect(detectTransitions(null, makeState())).toEqual([]);
	});

	it("detects reset when utilization drops >= 0.10", () => {
		const prev = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.85,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: false,
				},
				{
					name: "7d",
					utilization: 0.15,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});
		const curr = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.02,
					resetAt: 1743714000,
					status: "allowed",
					surpassedThreshold: false,
				},
				{
					name: "7d",
					utilization: 0.15,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});

		const transitions = detectTransitions(prev, curr);
		expect(transitions).toEqual([
			{ kind: "reset", window: "5h", oldUtil: 0.85, newUtil: 0.02 },
		]);
	});

	it("does not emit reset for small utilization drops", () => {
		const prev = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.42,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: false,
				},
				{
					name: "7d",
					utilization: 0.15,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});
		const curr = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.37,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: false,
				},
				{
					name: "7d",
					utilization: 0.15,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});

		expect(detectTransitions(prev, curr)).toEqual([]);
	});

	it("detects threshold flip false -> true", () => {
		const prev = makeState();
		const curr = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.82,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: true,
				},
				{
					name: "7d",
					utilization: 0.15,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});

		const transitions = detectTransitions(prev, curr);
		expect(transitions).toEqual([
			{ kind: "threshold", window: "5h", surpassed: true },
		]);
	});

	it("detects threshold flip true -> false", () => {
		const prev = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.45,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: true,
				},
				{
					name: "7d",
					utilization: 0.15,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});
		const curr = makeState();

		const transitions = detectTransitions(prev, curr);
		expect(transitions).toEqual([
			{ kind: "threshold", window: "5h", surpassed: false },
		]);
	});

	it("detects multiple transitions in one update", () => {
		const prev = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.9,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: true,
				},
				{
					name: "7d",
					utilization: 0.8,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});
		const curr = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.02,
					resetAt: 1743714000,
					status: "allowed",
					surpassedThreshold: false,
				},
				{
					name: "7d",
					utilization: 0.6,
					resetAt: 1744128000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});

		const transitions = detectTransitions(prev, curr);
		expect(transitions).toHaveLength(3); // 5h reset + 5h threshold flip + 7d reset
		expect(transitions.filter((t) => t.kind === "reset")).toHaveLength(2);
		expect(transitions.filter((t) => t.kind === "threshold")).toHaveLength(1);
	});

	it("ignores windows not present in previous state", () => {
		const prev = makeState({
			windows: [
				{
					name: "5h",
					utilization: 0.42,
					resetAt: 1743696000,
					status: "allowed",
					surpassedThreshold: false,
				},
			],
		});
		const curr = makeState(); // has both 5h and 7d

		expect(detectTransitions(prev, curr)).toEqual([]);
	});
});

describe("toLiveRateLimitState", () => {
	it("converts 0-1 utilization to 0-100 percentage", () => {
		const state: ProxyWindowState = {
			capturedAt: "2026-04-03T14:00:00Z",
			representativeClaim: "five_hour",
			windows: [],
			fiveHourUtilization: 0.42,
			sevenDayUtilization: 0.15,
			fiveHourResetAt: 1743696000,
			sevenDayResetAt: 1744128000,
		};
		const result = toLiveRateLimitState(state);
		expect(result.fiveHourPct).toBeCloseTo(42);
		expect(result.sevenDayPct).toBeCloseTo(15);
	});

	it("treats null utilization as 0%", () => {
		const state: ProxyWindowState = {
			capturedAt: "2026-04-03T14:00:00Z",
			representativeClaim: "five_hour",
			windows: [],
			fiveHourUtilization: null,
			sevenDayUtilization: null,
			fiveHourResetAt: null,
			sevenDayResetAt: null,
		};
		const result = toLiveRateLimitState(state);
		expect(result.fiveHourPct).toBe(0);
		expect(result.sevenDayPct).toBe(0);
	});
});
