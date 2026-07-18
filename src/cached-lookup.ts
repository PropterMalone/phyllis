// pattern: imperative-shell
// Cached DNS lookup with TTL refresh + stale-on-error fallback.
//
// Drop-in for the `lookup` option of http(s).request / net.connect. The proxy
// re-resolves its upstream (api.anthropic.com) on every request; Malone's host
// resolver intermittently returns EAI_AGAIN (router floods 64+ flaky IPv6
// RDNSS servers, systemd-resolved thrashes). Without caching, each blip that
// lands mid-request becomes a 502 the client sees. Here, once a host has
// resolved once, a transient failure reuses the last-good result instead of
// failing — bounded by an absolute stale cap so a permanently-dead record is
// not masked forever — and we back off resolver retries while serving stale so
// a thrash window is not hammered.
//
// Shape note: Node ≥20 defaults autoSelectFamily=true, so http(s).request calls
// this with `{ all: true }` and expects a LookupAddress[] back. We cache and
// replay the resolver's verbatim callback args, so both the all:true (array)
// and all:false (address+family) shapes round-trip correctly — caching the
// all:true path is the whole point, since that is what production actually uses.

import { type LookupAddress, lookup as nodeLookup } from "node:dns";

type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address?: string | LookupAddress[],
	family?: number,
) => void;

// Node calls a `lookup` either as (host, options, cb) or (host, cb); callback is
// always present (Hyper: an optional-callback type is a lie that hides a crash).
export interface LookupFn {
	(hostname: string, options: unknown, callback: LookupCallback): void;
	(hostname: string, callback: LookupCallback): void;
}

export interface CachedLookupOptions {
	/** How long a successful result stays fresh. Default 30s (under api.anthropic.com's likely DNS TTL). */
	ttlMs?: number;
	/** Absolute cap on serving a stale result through resolver failure. Default 10m. */
	staleMaxAgeMs?: number;
	/** Injectable dns.lookup for tests. */
	_lookup?: LookupFn;
	/** Injectable clock for tests. */
	_now?: () => number;
}

// Replayable callback args after `err`: [address, family] (all:false) or [addresses] (all:true).
type CbArgs = [string | LookupAddress[], number?];

interface CacheEntry {
	cbArgs: CbArgs;
	expiresAt: number;
	lastGoodAt: number; // when this entry was last refreshed from a successful lookup
}

// While serving stale (resolver is failing), retry the resolver at most this
// often instead of on every request — avoids hammering a thrashing resolver.
// 5s balances resolver-recovery latency against holding a stale entry too long.
const STALE_RETRY_BACKOFF_MS = 5_000;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_STALE_MAX_AGE_MS = 10 * 60_000;

export function createCachedLookup(opts: CachedLookupOptions = {}): LookupFn {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const staleMaxAgeMs = opts.staleMaxAgeMs ?? DEFAULT_STALE_MAX_AGE_MS;
	const raw = opts._lookup ?? (nodeLookup as unknown as LookupFn);
	const now = opts._now ?? Date.now;
	const cache = new Map<string, CacheEntry>();

	// Single impl serving both overloads; cast at return (TS can't infer an
	// impl with an optional-position callback satisfies the overload set).
	const lookup = (
		hostname: string,
		options: unknown,
		callback?: LookupCallback,
	): void => {
		const cb: LookupCallback =
			typeof options === "function"
				? (options as LookupCallback)
				: (callback as LookupCallback);
		const optObj =
			options && typeof options === "object"
				? (options as { family?: number; all?: boolean })
				: {};
		const family = optObj.family ?? 0;
		const wantsAll = optObj.all === true;
		// Key on the shape too: all:true callers get an array, all:false get a scalar.
		const key = `${hostname}|${family}|${wantsAll ? 1 : 0}`;
		const t = now();
		const hit = cache.get(key);

		if (hit && hit.expiresAt > t) {
			process.nextTick(cb, null, ...hit.cbArgs);
			return;
		}

		raw(hostname, optObj, (err, address, fam) => {
			if (!err && address != null) {
				const cbArgs: CbArgs = wantsAll ? [address] : [address, fam];
				cache.set(key, { cbArgs, expiresAt: t + ttlMs, lastGoodAt: t });
				cb(null, ...cbArgs);
				return;
			}
			// Stale-on-error: reuse last-good through a resolver blip — bounded by
			// staleMaxAgeMs so a permanently-dead record is not masked forever.
			if (hit && t - hit.lastGoodAt <= staleMaxAgeMs) {
				cache.set(key, {
					cbArgs: hit.cbArgs,
					expiresAt: t + Math.min(ttlMs, STALE_RETRY_BACKOFF_MS),
					lastGoodAt: hit.lastGoodAt,
				});
				cb(null, ...hit.cbArgs);
				return;
			}
			// No usable cache (cold, or stale past the cap): evict and surface the error.
			if (hit) cache.delete(key);
			cb(err ?? new Error("dns lookup failed"));
		});
	};

	return lookup as LookupFn;
}
