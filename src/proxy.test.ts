import { readFile, unlink } from "node:fs/promises";
import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetState, startProxy } from "./proxy.ts";
import type { ProxyWindowState } from "./proxy-headers.ts";
import type { CalibrationEntry } from "./types.ts";

const RATE_LIMIT_HEADERS: Record<string, string> = {
	"anthropic-ratelimit-unified-representative-claim": "five_hour",
	"anthropic-ratelimit-unified-5h-utilization": "0.42",
	"anthropic-ratelimit-unified-5h-reset": "1743696000",
	"anthropic-ratelimit-unified-5h-status": "allowed",
	"anthropic-ratelimit-unified-5h-surpassed-threshold": "false",
	"anthropic-ratelimit-unified-7d-utilization": "0.15",
	"anthropic-ratelimit-unified-7d-reset": "1744128000",
	"anthropic-ratelimit-unified-7d-status": "allowed",
	"anthropic-ratelimit-unified-7d-surpassed-threshold": "false",
};

function listenOnRandomPort(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			resolve(typeof addr === "object" && addr ? addr.port : 0);
		});
	});
}

function makeRequest(
	port: number,
	method: string,
	path: string,
	body?: string,
): Promise<{
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ hostname: "127.0.0.1", port, path, method },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString(),
					});
				});
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

describe("proxy integration", () => {
	let mockUpstream: Server;
	let mockPort: number;
	let proxyServer: Server;
	let proxyPort: number;
	let logPath: string;
	let statePath: string;

	beforeEach(async () => {
		_resetState();
		const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		logPath = join(tmpdir(), `phyllis-proxy-test-${suffix}.jsonl`);
		statePath = join(tmpdir(), `phyllis-proxy-test-${suffix}-state.json`);
	});

	afterEach(async () => {
		if (proxyServer)
			await new Promise<void>((r) => proxyServer.close(() => r()));
		if (mockUpstream)
			await new Promise<void>((r) => mockUpstream.close(() => r()));
		try {
			await unlink(logPath);
		} catch {}
		try {
			await unlink(statePath);
		} catch {}
	});

	async function setupMock(
		handler: (req: IncomingMessage, res: ServerResponse) => void,
	): Promise<void> {
		mockUpstream = createServer(handler);
		mockPort = await listenOnRandomPort(mockUpstream);
		proxyServer = startProxy({
			port: 0,
			logPath,
			statePath,
			_upstreamHost: "127.0.0.1",
			_upstreamPort: mockPort,
			_upstreamProtocol: "http",
		});
		proxyPort = await new Promise<number>((resolve) => {
			// Server may already be listening, check address
			const addr = proxyServer.address();
			if (addr && typeof addr === "object") {
				resolve(addr.port);
			} else {
				proxyServer.on("listening", () => {
					const a = proxyServer.address();
					resolve(typeof a === "object" && a ? a.port : 0);
				});
			}
		});
	}

	it("forwards requests and responses through the proxy", async () => {
		await setupMock((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
		});

		const result = await makeRequest(
			proxyPort,
			"POST",
			"/v1/messages",
			'{"test":true}',
		);
		expect(result.status).toBe(200);
		expect(result.body).toBe('{"ok":true}');
	});

	it("writes state file when rate-limit headers are present", async () => {
		await setupMock((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				...RATE_LIMIT_HEADERS,
			});
			res.end('{"ok":true}');
		});

		await makeRequest(proxyPort, "POST", "/v1/messages", "{}");
		// Give fire-and-forget write a moment
		await new Promise((r) => setTimeout(r, 100));

		const raw = await readFile(statePath, "utf-8");
		const state = JSON.parse(raw) as ProxyWindowState;
		expect(state.representativeClaim).toBe("five_hour");
		expect(state.fiveHourUtilization).toBe(0.42);
		expect(state.sevenDayUtilization).toBe(0.15);
		expect(state.fiveHourResetAt).toBe(1743696000);
		expect(state.sevenDayResetAt).toBe(1744128000);
		expect(state.windows).toHaveLength(2);
	});

	it("does not write state file when no rate-limit headers", async () => {
		await setupMock((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
		});

		await makeRequest(proxyPort, "POST", "/v1/messages", "{}");
		await new Promise((r) => setTimeout(r, 100));

		await expect(readFile(statePath, "utf-8")).rejects.toThrow();
	});

	it("logs calibration entry on 429", async () => {
		await setupMock((_req, res) => {
			res.writeHead(429, {
				"content-type": "application/json",
				"retry-after": "30",
				...RATE_LIMIT_HEADERS,
			});
			res.end('{"error":"rate_limited"}');
		});

		const result = await makeRequest(proxyPort, "POST", "/v1/messages", "{}");
		expect(result.status).toBe(429);

		await new Promise((r) => setTimeout(r, 100));

		const logContent = await readFile(logPath, "utf-8");
		const entry = JSON.parse(logContent.trim()) as CalibrationEntry;
		expect(entry.source).toBe("proxy-429");
		expect(entry.throttled).toBe(true);
		expect(entry.notes).toContain("retry after 30s");
	});

	it("logs calibration entry on window reset", async () => {
		// First request: high utilization
		await setupMock((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				...RATE_LIMIT_HEADERS,
				"anthropic-ratelimit-unified-5h-utilization": "0.85",
			});
			res.end('{"ok":true}');
		});

		await makeRequest(proxyPort, "POST", "/v1/messages", "{}");
		await new Promise((r) => setTimeout(r, 100));

		// Tear down and recreate mock with low utilization (simulating reset)
		await new Promise<void>((r) => mockUpstream.close(() => r()));
		await new Promise<void>((r) => proxyServer.close(() => r()));

		mockUpstream = createServer((_req, res) => {
			res.writeHead(200, {
				"content-type": "application/json",
				...RATE_LIMIT_HEADERS,
				"anthropic-ratelimit-unified-5h-utilization": "0.02",
			});
			res.end('{"ok":true}');
		});
		mockPort = await listenOnRandomPort(mockUpstream);
		// Don't reset state — we need previousState for transition detection
		proxyServer = startProxy({
			port: 0,
			logPath,
			statePath,
			_upstreamHost: "127.0.0.1",
			_upstreamPort: mockPort,
			_upstreamProtocol: "http",
		});
		const addr = proxyServer.address();
		proxyPort = typeof addr === "object" && addr ? addr.port : 0;
		if (!proxyPort) {
			await new Promise<void>((resolve) => {
				proxyServer.on("listening", () => {
					const a = proxyServer.address();
					proxyPort = typeof a === "object" && a ? a.port : 0;
					resolve();
				});
			});
		}

		await makeRequest(proxyPort, "POST", "/v1/messages", "{}");
		await new Promise((r) => setTimeout(r, 100));

		const logContent = await readFile(logPath, "utf-8");
		const entries = logContent
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as CalibrationEntry);
		const resetEntry = entries.find((e) => e.source === "proxy-reset");
		expect(resetEntry).toBeDefined();
		expect(resetEntry?.notes).toContain("5h window reset");
		expect(resetEntry?.notes).toContain("0.85");
		expect(resetEntry?.notes).toContain("0.02");
	});

	it("streams SSE responses without buffering", async () => {
		await setupMock((_req, res) => {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				...RATE_LIMIT_HEADERS,
			});
			// Simulate SSE chunks
			res.write("event: message_start\ndata: {}\n\n");
			setTimeout(() => {
				res.write("event: content_block_delta\ndata: {}\n\n");
				setTimeout(() => {
					res.write("event: message_stop\ndata: {}\n\n");
					res.end();
				}, 50);
			}, 50);
		});

		const result = await makeRequest(proxyPort, "POST", "/v1/messages", "{}");
		expect(result.status).toBe(200);
		expect(result.body).toContain("message_start");
		expect(result.body).toContain("content_block_delta");
		expect(result.body).toContain("message_stop");
	});

	it("returns 502 when upstream is unreachable", async () => {
		// Point proxy at a port nothing is listening on
		proxyServer = startProxy({
			port: 0,
			logPath,
			statePath,
			_upstreamHost: "127.0.0.1",
			_upstreamPort: 19999,
			_upstreamProtocol: "http",
		});
		await new Promise<void>((resolve) => {
			const addr = proxyServer.address();
			if (addr && typeof addr === "object") {
				proxyPort = addr.port;
				resolve();
			} else {
				proxyServer.on("listening", () => {
					const a = proxyServer.address();
					proxyPort = typeof a === "object" && a ? a.port : 0;
					resolve();
				});
			}
		});

		const result = await makeRequest(proxyPort, "POST", "/v1/messages", "{}");
		expect(result.status).toBe(502);
		expect(result.body).toContain("upstream connection failed");
	});
});
