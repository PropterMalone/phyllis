import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { createCachedLookup, type LookupFn } from "./cached-lookup.ts";

// A scripted fake dns.lookup. Each answer is either an error or the verbatim
// callback args after `err` (e.g. ["1.2.3.4", 4] for all:false, or
// [[{address,family}]] for all:true).
type Answer = { err: NodeJS.ErrnoException } | { args: unknown[] };

function scriptedLookup(answers: Answer[]) {
	let i = 0;
	const calls: Array<{ hostname: string; options: unknown }> = [];
	const fn = (hostname: string, options: unknown, cb: unknown) => {
		calls.push({ hostname, options });
		const a = answers[Math.min(i, answers.length - 1)];
		i += 1;
		const callback = cb as (e: unknown, ...rest: unknown[]) => void;
		if ("err" in a) callback(a.err);
		else callback(null, ...a.args);
	};
	return { fn: fn as unknown as LookupFn, calls };
}

function eaiAgain() {
	return Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
		code: "EAI_AGAIN",
	}) as NodeJS.ErrnoException;
}

type Captured = { err: NodeJS.ErrnoException | null; rest: unknown[] };

function callLookup(
	lookup: LookupFn,
	host: string,
	options: unknown = {},
): Promise<Captured> {
	return new Promise((resolve) => {
		lookup(host, options, (err, ...rest) => resolve({ err, rest }));
	});
}

describe("createCachedLookup — all:false (scalar) shape", () => {
	it("resolves via the underlying lookup and returns address + family", async () => {
		const { fn } = scriptedLookup([{ args: ["1.2.3.4", 4] }]);
		const lookup = createCachedLookup({ _lookup: fn });
		const r = await callLookup(lookup, "api.anthropic.com");
		expect(r.err).toBeNull();
		expect(r.rest).toEqual(["1.2.3.4", 4]);
	});

	it("serves from cache within the TTL without re-querying", async () => {
		const { fn, calls } = scriptedLookup([{ args: ["1.2.3.4", 4] }]);
		let clock = 1000;
		const lookup = createCachedLookup({
			ttlMs: 30_000,
			_lookup: fn,
			_now: () => clock,
		});
		await callLookup(lookup, "api.anthropic.com");
		clock += 15_000;
		const r = await callLookup(lookup, "api.anthropic.com");
		expect(r.rest).toEqual(["1.2.3.4", 4]);
		expect(calls).toHaveLength(1);
	});

	it("re-queries after the TTL expires (IP rotation)", async () => {
		const { fn, calls } = scriptedLookup([
			{ args: ["1.2.3.4", 4] },
			{ args: ["5.6.7.8", 4] },
		]);
		let clock = 1000;
		const lookup = createCachedLookup({
			ttlMs: 30_000,
			_lookup: fn,
			_now: () => clock,
		});
		await callLookup(lookup, "api.anthropic.com");
		clock += 31_000;
		const r = await callLookup(lookup, "api.anthropic.com");
		expect(r.rest).toEqual(["5.6.7.8", 4]);
		expect(calls).toHaveLength(2);
	});

	it("serves the last-good address when a refresh fails (stale-on-error)", async () => {
		const { fn } = scriptedLookup([
			{ args: ["1.2.3.4", 4] },
			{ err: eaiAgain() },
		]);
		let clock = 1000;
		const lookup = createCachedLookup({
			ttlMs: 30_000,
			_lookup: fn,
			_now: () => clock,
		});
		await callLookup(lookup, "api.anthropic.com");
		clock += 31_000;
		const r = await callLookup(lookup, "api.anthropic.com");
		expect(r.err).toBeNull();
		expect(r.rest).toEqual(["1.2.3.4", 4]);
	});

	it("propagates the error when the first-ever lookup fails (no stale to fall back on)", async () => {
		const { fn } = scriptedLookup([{ err: eaiAgain() }]);
		const lookup = createCachedLookup({ _lookup: fn });
		const r = await callLookup(lookup, "api.anthropic.com");
		expect((r.err as NodeJS.ErrnoException)?.code).toBe("EAI_AGAIN");
	});

	it("backs off resolver retries while serving stale, then retries after the backoff", async () => {
		const { fn, calls } = scriptedLookup([
			{ args: ["1.2.3.4", 4] },
			{ err: eaiAgain() },
			{ args: ["9.9.9.9", 4] },
		]);
		let clock = 1000;
		const lookup = createCachedLookup({
			ttlMs: 30_000,
			_lookup: fn,
			_now: () => clock,
		});
		await callLookup(lookup, "api.anthropic.com"); // raw call 1
		clock += 31_000;
		await callLookup(lookup, "api.anthropic.com"); // raw call 2 (fails -> stale)
		expect(calls).toHaveLength(2);
		clock += 1_000; // within 5s backoff
		const stale = await callLookup(lookup, "api.anthropic.com"); // from backoff cache
		expect(stale.rest).toEqual(["1.2.3.4", 4]);
		expect(calls).toHaveLength(2);
		clock += 6_000; // past backoff
		const fresh = await callLookup(lookup, "api.anthropic.com"); // raw call 3 succeeds
		expect(fresh.rest).toEqual(["9.9.9.9", 4]);
		expect(calls).toHaveLength(3);
	});

	it("stops serving stale and surfaces the error after staleMaxAgeMs of continuous failure", async () => {
		const { fn } = scriptedLookup([
			{ args: ["1.2.3.4", 4] }, // populate
			{ err: eaiAgain() }, // every refresh thereafter fails
		]);
		let clock = 1000;
		const lookup = createCachedLookup({
			ttlMs: 30_000,
			staleMaxAgeMs: 120_000,
			_lookup: fn,
			_now: () => clock,
		});
		await callLookup(lookup, "api.anthropic.com");
		clock += 60_000; // within stale cap -> still serves stale
		const stale = await callLookup(lookup, "api.anthropic.com");
		expect(stale.err).toBeNull();
		expect(stale.rest).toEqual(["1.2.3.4", 4]);
		clock += 200_000; // now well past staleMaxAge since lastGood -> give up
		const dead = await callLookup(lookup, "api.anthropic.com");
		expect((dead.err as NodeJS.ErrnoException)?.code).toBe("EAI_AGAIN");
	});

	it("accepts the (hostname, callback) two-arg form", async () => {
		const { fn } = scriptedLookup([{ args: ["1.2.3.4", 4] }]);
		const lookup = createCachedLookup({ _lookup: fn });
		const r = await new Promise<Captured>((resolve) => {
			lookup(
				"api.anthropic.com",
				(err: NodeJS.ErrnoException | null, ...rest: unknown[]) =>
					resolve({ err, rest }),
			);
		});
		expect(r.rest).toEqual(["1.2.3.4", 4]);
	});
});

describe("createCachedLookup — all:true (array) shape, the production path", () => {
	const addrs: LookupAddress[] = [
		{ address: "1.2.3.4", family: 4 },
		{ address: "2606:4700::1", family: 6 },
	];

	it("caches and replays the address array (does NOT bypass the cache)", async () => {
		const { fn, calls } = scriptedLookup([{ args: [addrs] }]);
		let clock = 1000;
		const lookup = createCachedLookup({
			ttlMs: 30_000,
			_lookup: fn,
			_now: () => clock,
		});
		const first = await callLookup(lookup, "api.anthropic.com", { all: true });
		expect(first.err).toBeNull();
		expect(first.rest).toEqual([addrs]); // array shape preserved
		clock += 15_000;
		const second = await callLookup(lookup, "api.anthropic.com", { all: true });
		expect(second.rest).toEqual([addrs]);
		expect(calls).toHaveLength(1); // cached, not re-queried — the Critical-fix assertion
	});

	it("serves the last-good array when a refresh fails (stale-on-error, all:true)", async () => {
		const { fn } = scriptedLookup([{ args: [addrs] }, { err: eaiAgain() }]);
		let clock = 1000;
		const lookup = createCachedLookup({
			ttlMs: 30_000,
			_lookup: fn,
			_now: () => clock,
		});
		await callLookup(lookup, "api.anthropic.com", { all: true });
		clock += 31_000;
		const r = await callLookup(lookup, "api.anthropic.com", { all: true });
		expect(r.err).toBeNull();
		expect(r.rest).toEqual([addrs]);
	});

	it("keys all:true and all:false separately", async () => {
		const { fn, calls } = scriptedLookup([
			{ args: [addrs] }, // first call (all:true)
			{ args: ["1.2.3.4", 4] }, // second call (all:false) must not hit the array entry
		]);
		const lookup = createCachedLookup({ _lookup: fn });
		const a = await callLookup(lookup, "api.anthropic.com", { all: true });
		expect(a.rest).toEqual([addrs]);
		const b = await callLookup(lookup, "api.anthropic.com", { all: false });
		expect(b.rest).toEqual(["1.2.3.4", 4]);
		expect(calls).toHaveLength(2);
	});
});
