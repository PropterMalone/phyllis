import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultConfig,
	initHome,
	loadConfig,
	mergeConfig,
	type PhyllisConfig,
	paths,
	resolveHome,
	saveConfig,
} from "./config.ts";

function tmpHome(): string {
	return join(
		tmpdir(),
		`phyllis-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
}

describe("resolveHome", () => {
	const origHome = process.env.HOME;
	const origPhyllisHome = process.env.PHYLLIS_HOME;

	afterEach(() => {
		if (origHome) process.env.HOME = origHome;
		else delete process.env.HOME;
		if (origPhyllisHome) process.env.PHYLLIS_HOME = origPhyllisHome;
		else delete process.env.PHYLLIS_HOME;
	});

	it("uses PHYLLIS_HOME if set", () => {
		process.env.PHYLLIS_HOME = "/custom/path";
		expect(resolveHome()).toBe("/custom/path");
	});

	it("falls back to ~/.phyllis", () => {
		delete process.env.PHYLLIS_HOME;
		process.env.HOME = "/home/testuser";
		expect(resolveHome()).toBe("/home/testuser/.phyllis");
	});

	it("throws if neither PHYLLIS_HOME nor HOME is set", () => {
		delete process.env.PHYLLIS_HOME;
		delete process.env.HOME;
		expect(() => resolveHome()).toThrow("HOME environment variable");
	});
});

describe("defaultConfig", () => {
	it("builds config with all paths derived from home", () => {
		const config = defaultConfig("/test/.phyllis");
		expect(config.home).toBe("/test/.phyllis");
		expect(config.logPath).toBe("/test/.phyllis/calibration-log.jsonl");
		expect(config.queuePath).toBe("/test/.phyllis/queue.json");
		expect(config.proxy.port).toBe(7735);
		expect(config.calendar).toBeNull();
	});

	it("sets userId from USER env", () => {
		const config = defaultConfig("/test/.phyllis");
		expect(config.userId).toBe(process.env.USER ?? "unknown");
	});
});

describe("paths", () => {
	it("derives runtime paths from config", () => {
		const config = defaultConfig("/test/.phyllis");
		const p = paths(config);
		expect(p.windowState).toBe("/test/.phyllis/state/window-state.json");
		expect(p.rateLimits).toBe("/test/.phyllis/state/rate-limits.json");
		expect(p.taskLogs).toBe("/test/.phyllis/task-logs");
		expect(p.logPath).toBe("/test/.phyllis/calibration-log.jsonl");
		expect(p.queuePath).toBe("/test/.phyllis/queue.json");
	});
});

describe("mergeConfig", () => {
	it("preserves defaults for missing fields", () => {
		const defaults = defaultConfig("/test/.phyllis");
		const merged = mergeConfig(defaults, {});
		expect(merged).toEqual(defaults);
	});

	it("overrides with stored values", () => {
		const defaults = defaultConfig("/test/.phyllis");
		const merged = mergeConfig(defaults, {
			userId: "alice",
			proxy: { port: 9999 },
		});
		expect(merged.userId).toBe("alice");
		expect(merged.proxy.port).toBe(9999);
		expect(merged.logPath).toBe(defaults.logPath); // unchanged
	});

	it("allows setting calendar to non-null", () => {
		const defaults = defaultConfig("/test/.phyllis");
		const merged = mergeConfig(defaults, {
			calendar: { calendarId: "abc", calendarIds: ["abc", "def"] },
		});
		expect(merged.calendar).toEqual({
			calendarId: "abc",
			calendarIds: ["abc", "def"],
		});
	});

	it("allows explicitly setting calendar to null", () => {
		const defaults = defaultConfig("/test/.phyllis");
		const withCal = mergeConfig(defaults, {
			calendar: { calendarId: "abc", calendarIds: [] },
		});
		const withoutCal = mergeConfig(withCal, { calendar: null });
		expect(withoutCal.calendar).toBeNull();
	});

	it("allows explicitly setting docket to null", () => {
		const defaults = defaultConfig("/test/.phyllis");
		const merged = mergeConfig(defaults, { docket: null });
		expect(merged.docket).toBeNull();
	});
});

describe("saveConfig + loadConfig", () => {
	let home: string;

	afterEach(async () => {
		if (home) {
			try {
				await rm(home, { recursive: true });
			} catch {}
		}
	});

	it("round-trips config through save and load", async () => {
		home = tmpHome();
		const config = defaultConfig(home);
		config.userId = "testuser";
		config.proxy.port = 8888;

		await saveConfig(config);

		const origPhyllisHome = process.env.PHYLLIS_HOME;
		process.env.PHYLLIS_HOME = home;
		try {
			const loaded = await loadConfig();
			expect(loaded.userId).toBe("testuser");
			expect(loaded.proxy.port).toBe(8888);
			expect(loaded.home).toBe(home);
		} finally {
			if (origPhyllisHome) process.env.PHYLLIS_HOME = origPhyllisHome;
			else delete process.env.PHYLLIS_HOME;
		}
	});

	it("returns defaults when no config file exists", async () => {
		home = tmpHome();
		const origPhyllisHome = process.env.PHYLLIS_HOME;
		process.env.PHYLLIS_HOME = home;
		try {
			const loaded = await loadConfig();
			expect(loaded.home).toBe(home);
			expect(loaded.proxy.port).toBe(7735);
		} finally {
			if (origPhyllisHome) process.env.PHYLLIS_HOME = origPhyllisHome;
			else delete process.env.PHYLLIS_HOME;
		}
	});
});

describe("initHome", () => {
	let home: string;

	afterEach(async () => {
		if (home) {
			try {
				await rm(home, { recursive: true });
			} catch {}
		}
	});

	it("creates directory structure and config file", async () => {
		home = tmpHome();
		const config = defaultConfig(home);
		await initHome(config);

		const content = await readFile(join(home, "config.json"), "utf-8");
		const saved = JSON.parse(content) as PhyllisConfig;
		expect(saved.home).toBe(home);

		// Verify directories exist by writing to them
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(home, "state", "test"), "ok");
		await writeFile(join(home, "task-logs", "test"), "ok");
	});
});
