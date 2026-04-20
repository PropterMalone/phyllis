// pattern: imperative-shell
// Google Calendar integration via gws CLI

import { execFile } from "node:child_process";
import {
	type CalendarConfig,
	loadConfig as loadMainConfig,
	saveConfig as saveMainConfig,
} from "./config.ts";
import type { PhyllisEvent } from "./types.ts";

export interface BusySlot {
	start: string;
	end: string;
}

interface FreeBusyResponse {
	calendars: Record<string, { busy: BusySlot[] }>;
}

interface CalendarListResponse {
	items: Array<{
		id: string;
		summary: string;
		accessRole: string;
	}>;
}

interface EventResponse {
	id: string;
	summary?: string;
	start?: { dateTime?: string };
	end?: { dateTime?: string };
	description?: string;
	status?: string;
}

interface EventListResponse {
	items?: EventResponse[];
}

// Skip holiday/import calendars — they don't represent real busy time
const SKIP_PATTERNS = [
	"#holiday@group.v.calendar.google.com",
	"@import.calendar.google.com",
];

export type GwsExecFn = (args: string[]) => Promise<string>;

function defaultExec(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"gws",
			["calendar", ...args],
			{ maxBuffer: 10 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(
						new Error(
							`gws calendar failed: ${error.message}${stderr ? `\n${stderr}` : ""}`,
						),
					);
					return;
				}
				resolve(stdout);
			},
		);
	});
}

// --- Config persistence (delegates to main config) ---

export async function loadConfig(): Promise<CalendarConfig | null> {
	const config = await loadMainConfig();
	return config.calendar;
}

export async function saveConfig(calendar: CalendarConfig): Promise<void> {
	const config = await loadMainConfig();
	config.calendar = calendar;
	await saveMainConfig(config);
}

// --- Calendar list ---

export async function fetchCalendarIds(
	exec: GwsExecFn = defaultExec,
): Promise<string[]> {
	const stdout = await exec(["calendarList", "list"]);
	const data = JSON.parse(stdout) as CalendarListResponse;
	return data.items
		.filter((c) => !SKIP_PATTERNS.some((p) => c.id.includes(p)))
		.map((c) => c.id);
}

// --- Freebusy ---

export function parseFreeBusy(stdout: string): BusySlot[] {
	const data = JSON.parse(stdout) as FreeBusyResponse;
	const slots: BusySlot[] = [];
	for (const cal of Object.values(data.calendars)) {
		slots.push(...cal.busy);
	}
	// Sort by start time and deduplicate overlaps
	slots.sort((a, b) => a.start.localeCompare(b.start));
	return slots;
}

export async function queryBusy(
	calendarIds: string[],
	from: string,
	to: string,
	exec: GwsExecFn = defaultExec,
): Promise<BusySlot[]> {
	const body = {
		timeMin: from,
		timeMax: to,
		items: calendarIds.map((id) => ({ id })),
	};
	const stdout = await exec([
		"freebusy",
		"query",
		"--json",
		JSON.stringify(body),
	]);
	return parseFreeBusy(stdout);
}

// --- Phyllis calendar CRUD ---

export async function createPhyllisCalendar(
	exec: GwsExecFn = defaultExec,
): Promise<string> {
	const body = {
		summary: "Phyllis",
		description: "Claude Code autonomous work scheduler",
		timeZone: "America/New_York",
	};
	const stdout = await exec([
		"calendars",
		"insert",
		"--json",
		JSON.stringify(body),
	]);
	const data = JSON.parse(stdout) as { id: string };
	return data.id;
}

export async function getOrCreatePhyllisCalendar(
	exec: GwsExecFn = defaultExec,
): Promise<string> {
	const config = await loadConfig();
	if (config?.calendarId) return config.calendarId;

	const calendarId = await createPhyllisCalendar(exec);
	const calendarIds = await fetchCalendarIds(exec);
	await saveConfig({
		calendarId,
		created: new Date().toISOString(),
		calendarIds,
		calendarIdsUpdated: new Date().toISOString(),
	});
	return calendarId;
}

// --- Event CRUD ---

export async function createEvent(
	calendarId: string,
	event: PhyllisEvent,
	exec: GwsExecFn = defaultExec,
): Promise<string> {
	const body = {
		summary: event.summary,
		description: event.description ?? "",
		start: { dateTime: event.startTime },
		end: { dateTime: event.endTime },
		status: event.status === "running" ? "tentative" : "confirmed",
	};
	const stdout = await exec([
		"events",
		"insert",
		"--params",
		JSON.stringify({ calendarId }),
		"--json",
		JSON.stringify(body),
	]);
	const data = JSON.parse(stdout) as EventResponse;
	return data.id;
}

export async function updateEvent(
	calendarId: string,
	eventId: string,
	updates: {
		status?: string;
		description?: string;
		endTime?: string;
	},
	exec: GwsExecFn = defaultExec,
): Promise<void> {
	const body: Record<string, unknown> = {};
	if (updates.status != null) body.status = updates.status;
	if (updates.description != null) body.description = updates.description;
	if (updates.endTime != null) body.end = { dateTime: updates.endTime };
	await exec([
		"events",
		"patch",
		"--params",
		JSON.stringify({ calendarId, eventId }),
		"--json",
		JSON.stringify(body),
	]);
}

export async function listUpcoming(
	calendarId: string,
	hours = 24,
	exec: GwsExecFn = defaultExec,
): Promise<PhyllisEvent[]> {
	const now = new Date().toISOString();
	const later = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
	const stdout = await exec([
		"events",
		"list",
		"--params",
		JSON.stringify({
			calendarId,
			timeMin: now,
			timeMax: later,
			maxResults: 20,
			orderBy: "startTime",
			singleEvents: true,
		}),
	]);
	const data = JSON.parse(stdout) as EventListResponse;
	if (!data.items) return [];
	return data.items.map((e) => ({
		summary: e.summary ?? "",
		startTime: e.start?.dateTime ?? "",
		endTime: e.end?.dateTime ?? "",
		description: e.description,
		status: e.status === "tentative" ? "running" : "done",
		eventId: e.id,
	}));
}

// --- High-level helpers for scheduler ---

export async function getCalendarIds(
	exec: GwsExecFn = defaultExec,
): Promise<string[]> {
	const config = await loadConfig();
	if (config?.calendarIds?.length) {
		// Refresh if stale (older than 24h)
		const age = config.calendarIdsUpdated
			? Date.now() - new Date(config.calendarIdsUpdated).getTime()
			: Number.POSITIVE_INFINITY;
		if (age < 24 * 60 * 60 * 1000) return config.calendarIds;
	}
	const ids = await fetchCalendarIds(exec);
	if (config) {
		config.calendarIds = ids;
		config.calendarIdsUpdated = new Date().toISOString();
		await saveConfig(config);
	}
	return ids;
}

export async function getBusyCheckCalendars(
	exec: GwsExecFn = defaultExec,
): Promise<string[]> {
	const config = await loadConfig();
	if (config?.busyCheckCalendars?.length) return config.busyCheckCalendars;
	// Fallback: use the full list. This over-blocks (includes holiday, school,
	// family, and self-tooling calendars) — set busyCheckCalendars explicitly
	// in config.json to just personal+work calendars.
	return getCalendarIds(exec);
}

export async function checkBusy(
	exec: GwsExecFn = defaultExec,
): Promise<{ busyNow: boolean; busyDuringWindow: boolean }> {
	const calendarIds = await getBusyCheckCalendars(exec);
	const now = new Date();
	const soon = new Date(now.getTime() + 30 * 60 * 1000); // +30min
	const windowEnd = new Date(now.getTime() + 5 * 60 * 60 * 1000); // +5h

	const slots = await queryBusy(
		calendarIds,
		now.toISOString(),
		windowEnd.toISOString(),
		exec,
	);

	const nowISO = now.toISOString();
	const soonISO = soon.toISOString();

	const busyNow = slots.some((s) => s.start < soonISO && s.end > nowISO);
	const busyDuringWindow = slots.length > 0;

	return { busyNow, busyDuringWindow };
}
