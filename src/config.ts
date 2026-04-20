// pattern: functional-core + imperative-shell
// Central configuration — all paths derive from here

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CalendarConfig {
	calendarId: string | null;
	calendarIds: string[];
	created?: string;
	calendarIdsUpdated?: string;
	/**
	 * Calendars consulted by checkBusy() to decide whether Karl is busy.
	 * When omitted, falls back to the full calendarIds list — which tends
	 * to over-block because it includes holiday/school/family calendars
	 * that aren't "Karl is unavailable" signals. Explicitly setting this
	 * to just the user's personal + work calendars is strongly preferred.
	 */
	busyCheckCalendars?: string[];
}

export interface NotifyConfig {
	/** signal-cli account phone number (e.g. "+13109803137") */
	signalAccount: string;
	/** Recipient phone number to notify */
	signalRecipient: string;
}

export interface PhyllisConfig {
	home: string;
	userId: string;
	logPath: string;
	queuePath: string;
	proxy: {
		port: number;
	};
	calendar: CalendarConfig | null;
	docket: {
		reservationsPath: string;
	} | null;
	notify: NotifyConfig | null;
}

/** Resolve the Phyllis home directory: PHYLLIS_HOME env → ~/.phyllis */
export function resolveHome(): string {
	if (process.env.PHYLLIS_HOME) return process.env.PHYLLIS_HOME;
	const home = process.env.HOME;
	if (!home) throw new Error("HOME environment variable is not set");
	return join(home, ".phyllis");
}

/** Build a config with all defaults filled in */
export function defaultConfig(home?: string): PhyllisConfig {
	const h = home ?? resolveHome();
	const userHome = process.env.HOME ?? "";
	return {
		home: h,
		userId: process.env.USER ?? "unknown",
		logPath: join(h, "calibration-log.jsonl"),
		queuePath: join(h, "queue.json"),
		proxy: { port: 7735 },
		calendar: null,
		docket: userHome
			? { reservationsPath: join(userHome, ".docket", "reservations.json") }
			: null,
		notify: null,
	};
}

/** Derived runtime paths — all modules use these instead of hardcoded constants */
export function paths(config: PhyllisConfig) {
	return {
		logPath: config.logPath,
		queuePath: config.queuePath,
		windowState: join(config.home, "state", "window-state.json"),
		rateLimits: join(config.home, "state", "rate-limits.json"),
		taskLogs: join(config.home, "task-logs"),
	};
}

const CONFIG_FILENAME = "config.json";

/** Load config from ~/.phyllis/config.json, merging with defaults */
export async function loadConfig(): Promise<PhyllisConfig> {
	const home = resolveHome();
	const defaults = defaultConfig(home);
	const configPath = join(home, CONFIG_FILENAME);

	try {
		const content = await readFile(configPath, "utf-8");
		const stored = JSON.parse(content) as Partial<PhyllisConfig>;
		return mergeConfig(defaults, stored);
	} catch {
		// No config file — return defaults
		return defaults;
	}
}

/** Merge stored config over defaults, preserving defaults for missing fields */
export function mergeConfig(
	defaults: PhyllisConfig,
	stored: Partial<PhyllisConfig>,
): PhyllisConfig {
	return {
		home: stored.home ?? defaults.home,
		userId: stored.userId ?? defaults.userId,
		logPath: stored.logPath ?? defaults.logPath,
		queuePath: stored.queuePath ?? defaults.queuePath,
		proxy: {
			port: stored.proxy?.port ?? defaults.proxy.port,
		},
		calendar:
			stored.calendar !== undefined ? stored.calendar : defaults.calendar,
		docket: stored.docket !== undefined ? stored.docket : defaults.docket,
		notify: stored.notify !== undefined ? stored.notify : defaults.notify,
	};
}

/** Save config to ~/.phyllis/config.json */
export async function saveConfig(config: PhyllisConfig): Promise<void> {
	await mkdir(config.home, { recursive: true });
	const configPath = join(config.home, CONFIG_FILENAME);
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Create the directory structure for a new Phyllis installation */
export async function initHome(config: PhyllisConfig): Promise<void> {
	const p = paths(config);
	await mkdir(config.home, { recursive: true });
	await mkdir(join(config.home, "state"), { recursive: true });
	await mkdir(p.taskLogs, { recursive: true });
	await saveConfig(config);
}
