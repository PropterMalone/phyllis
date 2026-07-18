// pattern: imperative-shell
// Transparent HTTP proxy that captures Anthropic rate-limit headers

import { appendFile, writeFile } from "node:fs/promises";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { createCachedLookup, type LookupFn } from "./cached-lookup.ts";
import {
	buildLiveState,
	detectTransitions,
	type ProxyTransition,
	type ProxyWindowState,
	parseRateLimitHeaders,
} from "./proxy-headers.ts";
import type { CalibrationEntry } from "./types.ts";

const DEFAULT_UPSTREAM_HOST = "api.anthropic.com";

// Shared cached resolver: survives transient host-resolver EAI_AGAIN blips by
// reusing the last-good upstream IP instead of 502'ing. See cached-lookup.ts.
const cachedLookup: LookupFn = createCachedLookup();

export interface ProxyOptions {
	port: number;
	logPath: string;
	statePath: string; // where to write window state JSON
	// Testing: override upstream target
	_upstreamHost?: string;
	_upstreamPort?: number;
	_upstreamProtocol?: "http" | "https";
}

// Module-level state for transition detection (single-threaded, no races)
let previousState: ProxyWindowState | null = null;

// Per-user snapshot cadence tracking (proxy is single-tenant in practice,
// but key by user_id to keep the door open).
interface SnapshotMark {
	emittedAt: number; // epoch ms
	fiveHourPct: number;
	sevenDayPct: number;
}
const lastSnapshotByUser: Map<string, SnapshotMark> = new Map();

const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SNAPSHOT_DELTA_PP = 1; // percentage points

function transitionToCalibrationEntry(
	transition: ProxyTransition,
	state: ProxyWindowState,
): CalibrationEntry {
	const source =
		transition.kind === "reset"
			? ("proxy-reset" as const)
			: transition.kind === "threshold"
				? ("proxy-threshold" as const)
				: ("proxy-429" as const);

	const notes =
		transition.kind === "reset"
			? `${transition.window} window reset: ${transition.oldUtil.toFixed(2)} -> ${transition.newUtil.toFixed(2)}`
			: transition.kind === "threshold"
				? `${transition.window} threshold ${transition.surpassed ? "surpassed" : "cleared"}`
				: `rate limited${transition.retryAfterS != null ? ` (retry after ${transition.retryAfterS}s)` : ""}`;

	return {
		user_id: process.env.USER ?? "unknown",
		window_start: state.fiveHourResetAt
			? new Date((state.fiveHourResetAt - 5 * 3600) * 1000).toISOString()
			: state.capturedAt,
		window_end: state.fiveHourResetAt
			? new Date(state.fiveHourResetAt * 1000).toISOString()
			: state.capturedAt,
		observed_at: state.capturedAt,
		tokens_consumed: 0,
		cost_equiv: 0,
		remaining_min: state.fiveHourResetAt
			? Math.max(0, (state.fiveHourResetAt * 1000 - Date.now()) / 60000)
			: null,
		throttled: transition.kind === "rate-limited" ? true : null,
		peak_hour: false,
		promo_active: false,
		model_mix: [],
		source,
		notes,
		rate_limits: {
			five_hour_pct: (state.fiveHourUtilization ?? 0) * 100,
			seven_day_pct: (state.sevenDayUtilization ?? 0) * 100,
		},
	};
}

function snapshotEntry(
	state: ProxyWindowState,
	requestPath: string | undefined,
): CalibrationEntry {
	const fiveHourPct = Math.round((state.fiveHourUtilization ?? 0) * 100);
	const sevenDayPct = Math.round((state.sevenDayUtilization ?? 0) * 100);
	const bottleneck =
		(state.fiveHourUtilization ?? 0) >= (state.sevenDayUtilization ?? 0)
			? "five_hour"
			: "seven_day";

	// Best-effort model extraction from request path (e.g. /v1/messages?model=...).
	// Most Anthropic requests carry model in the JSON body, not the URL — leave empty
	// in that case; the calibration consumer treats missing model_mix as benign.
	const model_mix: string[] = [];
	if (requestPath) {
		const m = requestPath.match(/[?&]model=([^&]+)/);
		if (m) model_mix.push(decodeURIComponent(m[1]));
	}

	return {
		user_id: process.env.USER ?? "unknown",
		window_start: state.fiveHourResetAt
			? new Date((state.fiveHourResetAt - 5 * 3600) * 1000).toISOString()
			: state.capturedAt,
		window_end: state.fiveHourResetAt
			? new Date(state.fiveHourResetAt * 1000).toISOString()
			: state.capturedAt,
		observed_at: state.capturedAt,
		tokens_consumed: 0,
		cost_equiv: 0,
		remaining_min: state.fiveHourResetAt
			? Math.max(0, (state.fiveHourResetAt * 1000 - Date.now()) / 60000)
			: null,
		throttled: null,
		peak_hour: false,
		promo_active: false,
		model_mix,
		source: "proxy-snapshot",
		// Field name matches existing entries (slight misnomer — 7d not weekly, kept for compat).
		notes: `5h=${fiveHourPct}% 7d=${sevenDayPct}% bottleneck=${bottleneck}`,
		rate_limits: {
			five_hour_pct: fiveHourPct,
			seven_day_pct: sevenDayPct,
		},
	};
}

/**
 * Decide whether to emit a proxy-snapshot for this state.
 * Cadence: >=5min since last snapshot OR >=1pp change in 5h/7d utilization.
 */
function shouldEmitSnapshot(
	userId: string,
	state: ProxyWindowState,
	now: number,
): boolean {
	const fiveHourPct = (state.fiveHourUtilization ?? 0) * 100;
	const sevenDayPct = (state.sevenDayUtilization ?? 0) * 100;
	const prev = lastSnapshotByUser.get(userId);
	if (!prev) return true; // first observation always emits
	const elapsed = now - prev.emittedAt;
	if (elapsed >= SNAPSHOT_MIN_INTERVAL_MS) return true;
	if (Math.abs(fiveHourPct - prev.fiveHourPct) >= SNAPSHOT_DELTA_PP)
		return true;
	if (Math.abs(sevenDayPct - prev.sevenDayPct) >= SNAPSHOT_DELTA_PP)
		return true;
	return false;
}

async function persistState(
	state: ProxyWindowState,
	logPath: string,
	statePath: string,
	requestPath: string | undefined,
): Promise<void> {
	await writeFile(statePath, JSON.stringify(state, null, 2));

	const transitions = detectTransitions(previousState, state);
	previousState = state;

	if (transitions.length > 0) {
		const lines = transitions
			.map((t) => JSON.stringify(transitionToCalibrationEntry(t, state)))
			.join("\n");

		await appendFile(logPath, `${lines}\n`);
		for (const t of transitions) {
			const desc =
				t.kind === "reset"
					? `${t.window} reset: ${t.oldUtil.toFixed(2)} -> ${t.newUtil.toFixed(2)}`
					: t.kind === "threshold"
						? `${t.window} threshold ${t.surpassed ? "surpassed" : "cleared"}`
						: "rate limited";
			console.error(`[phyllis-proxy] transition: ${desc}`);
		}
		return; // transition emissions skip the snapshot for this response
	}

	// Snapshot path — emit per the 5-min / 1pp cadence rule.
	const userId = process.env.USER ?? "unknown";
	const now = Date.now();
	if (shouldEmitSnapshot(userId, state, now)) {
		const entry = snapshotEntry(state, requestPath);
		await appendFile(logPath, `${JSON.stringify(entry)}\n`);
		lastSnapshotByUser.set(userId, {
			emittedAt: now,
			fiveHourPct: (state.fiveHourUtilization ?? 0) * 100,
			sevenDayPct: (state.sevenDayUtilization ?? 0) * 100,
		});
	}
}

function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	logPath: string,
	statePath: string,
	upstreamHost: string,
	upstreamPort: number,
	useHttps: boolean,
): void {
	const { method, url, headers } = req;

	const upstreamHeaders = { ...headers, host: upstreamHost };
	delete upstreamHeaders.connection;

	const requestFn = useHttps ? httpsRequest : httpRequest;
	const upstreamReq = requestFn(
		{
			hostname: upstreamHost,
			port: upstreamPort,
			path: url,
			method,
			headers: upstreamHeaders,
			// Cached, blip-tolerant resolution (no-op for IP-literal hosts).
			// Cast: Node unions the all/non-all callback shapes into LookupFunction;
			// cachedLookup handles both at runtime.
			lookup: cachedLookup as unknown as LookupFunction,
		},
		(upstreamRes) => {
			const parsed = parseRateLimitHeaders(
				upstreamRes.headers as Record<string, string | string[] | undefined>,
			);

			if (parsed) {
				const state = buildLiveState(parsed);

				if (upstreamRes.statusCode === 429) {
					const transition: ProxyTransition = {
						kind: "rate-limited",
						retryAfterS: parsed.retryAfterS,
					};
					const entry = transitionToCalibrationEntry(transition, state);
					previousState = state;
					writeFile(statePath, JSON.stringify(state, null, 2)).catch(() => {});
					appendFile(logPath, `${JSON.stringify(entry)}\n`).catch(() => {});
					console.error(
						`[phyllis-proxy] 429 rate limited${parsed.retryAfterS != null ? ` (retry ${parsed.retryAfterS}s)` : ""}`,
					);
				} else {
					persistState(state, logPath, statePath, url).catch((err) => {
						console.error(
							`[phyllis-proxy] persist error: ${(err as Error).message}`,
						);
					});
				}
			}

			res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
			upstreamRes.pipe(res);
		},
	);

	upstreamReq.on("error", (err) => {
		console.error(`[phyllis-proxy] upstream error: ${err.message}`);
		if (!res.headersSent) {
			res.writeHead(502, { "content-type": "text/plain" });
		}
		res.end(`phyllis-proxy: upstream connection failed: ${err.message}`);
	});

	req.pipe(upstreamReq);
}

export function startProxy(
	options: ProxyOptions,
): ReturnType<typeof createServer> {
	const {
		port,
		logPath,
		statePath,
		_upstreamHost = DEFAULT_UPSTREAM_HOST,
		_upstreamPort = 443,
		_upstreamProtocol = "https",
	} = options;
	const useHttps = _upstreamProtocol === "https";

	const server = createServer((req, res) => {
		handleRequest(
			req,
			res,
			logPath,
			statePath,
			_upstreamHost,
			_upstreamPort,
			useHttps,
		);
	});

	server.listen(port, "127.0.0.1", () => {
		console.error(`[phyllis-proxy] listening on http://127.0.0.1:${port}`);
		console.error(`[phyllis-proxy] state file: ${statePath}`);
		// Pre-warm the resolver cache (matching the all:true shape real requests
		// use on Node ≥20's autoSelectFamily) so the first request already has a
		// last-good result to fall back on if the host resolver is mid-blip.
		if (isIP(_upstreamHost) === 0) {
			cachedLookup(_upstreamHost, { all: true }, (err) => {
				if (err)
					console.error(
						`[phyllis-proxy] DNS pre-warm failed: ${(err as Error).message}`,
					);
			});
		}
	});

	const shutdown = () => {
		console.error("[phyllis-proxy] shutting down");
		server.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	return server;
}

export function _resetState(): void {
	previousState = null;
	lastSnapshotByUser.clear();
}
