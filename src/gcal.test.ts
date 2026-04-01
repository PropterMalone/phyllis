import { describe, expect, it } from "vitest";
import { fetchCalendarIds, parseFreeBusy, queryBusy } from "./gcal.ts";

const sampleFreeBusy = JSON.stringify({
	calendars: {
		"karl.s.kahn@gmail.com": {
			busy: [{ start: "2026-04-02T15:25:00Z", end: "2026-04-02T15:55:00Z" }],
		},
		"family@group.calendar.google.com": {
			busy: [{ start: "2026-04-02T23:45:00Z", end: "2026-04-03T00:00:00Z" }],
		},
		"stuff@group.calendar.google.com": {
			busy: [],
		},
	},
	kind: "calendar#freeBusy",
	timeMin: "2026-04-01T19:00:00.000Z",
	timeMax: "2026-04-03T19:00:00.000Z",
});

const sampleCalendarList = JSON.stringify({
	items: [
		{
			id: "karl.s.kahn@gmail.com",
			summary: "karl.s.kahn@gmail.com",
			accessRole: "owner",
		},
		{
			id: "family@group.calendar.google.com",
			summary: "Family",
			accessRole: "owner",
		},
		{
			id: "en.usa#holiday@group.v.calendar.google.com",
			summary: "Holidays in United States",
			accessRole: "reader",
		},
		{
			id: "tasks@import.calendar.google.com",
			summary: "Remember The Milk",
			accessRole: "reader",
		},
	],
});

describe("parseFreeBusy", () => {
	it("flattens busy slots from all calendars", () => {
		const slots = parseFreeBusy(sampleFreeBusy);
		expect(slots).toHaveLength(2);
	});

	it("sorts slots by start time", () => {
		const slots = parseFreeBusy(sampleFreeBusy);
		expect(slots[0].start).toBe("2026-04-02T15:25:00Z");
		expect(slots[1].start).toBe("2026-04-02T23:45:00Z");
	});

	it("returns empty array when nobody is busy", () => {
		const empty = JSON.stringify({
			calendars: { "a@b.com": { busy: [] } },
		});
		expect(parseFreeBusy(empty)).toHaveLength(0);
	});
});

describe("fetchCalendarIds", () => {
	it("returns non-holiday, non-import calendar IDs", async () => {
		const ids = await fetchCalendarIds(async () => sampleCalendarList);
		expect(ids).toContain("karl.s.kahn@gmail.com");
		expect(ids).toContain("family@group.calendar.google.com");
		expect(ids).not.toContain("en.usa#holiday@group.v.calendar.google.com");
		expect(ids).not.toContain("tasks@import.calendar.google.com");
	});
});

describe("queryBusy", () => {
	it("passes calendar IDs to freebusy query", async () => {
		let capturedArgs: string[] = [];
		const slots = await queryBusy(
			["cal1", "cal2"],
			"2026-04-01T00:00:00Z",
			"2026-04-01T05:00:00Z",
			async (args) => {
				capturedArgs = args;
				return JSON.stringify({
					calendars: {
						cal1: { busy: [] },
						cal2: {
							busy: [
								{
									start: "2026-04-01T02:00:00Z",
									end: "2026-04-01T03:00:00Z",
								},
							],
						},
					},
				});
			},
		);

		expect(capturedArgs[0]).toBe("freebusy");
		expect(capturedArgs[1]).toBe("query");
		const body = JSON.parse(capturedArgs[3]);
		expect(body.items).toHaveLength(2);
		expect(slots).toHaveLength(1);
	});
});
