---
id: 03-calendar-as-scheduling-input
name: Google Calendar replaces hardcoded peak/interactive hours
date: 2026-04-22
status: active
supersedes: null
commits: [ec9a805, 4b5b886, e3bd5dd]
---

# Calendar as scheduling input

**Decision**: Phyllis reads all of the user's Google Calendars (via the `gws` CLI's freebusy endpoint) to decide when to schedule autonomous work, and writes to a dedicated "Phyllis" calendar to record what it ran. The previous hardcoded gates — "peak hours = 5am-11am PT weekdays" + "interactive hours = 9am-10pm PT" — are removed; the scheduler instead consults `busyNow` and `busyDuringWindow` booleans derived from actual calendar state. A `busyCheckCalendars` config override scopes which calendars count toward the busy signal (defaults to all). The runner additionally reads `~/.docket/reservations.json`: heavy reservations block non-S tasks, light reservations and S-size tasks proceed.

**Why**: Hardcoded peak/interactive hours encode the user's schedule at the moment they were written, which is wrong the moment his schedule changes (vacation, sick day, conference, kid's snow day, meeting moved from afternoon to morning). Phyllis was conservatively skipping windows when the user was actually away from the keyboard, and aggressively firing into windows when the user had just sat down to code. The calendar is the source-of-truth for "is the user interactive right now?" — it's what the user actually keeps current. Docket reservations layer on top because Docket is the planner that knows "this 4pm-7pm slot is reserved for a heavy Mediabot pipeline" before that work shows up on the calendar — a forward-looking signal the calendar doesn't yet have.

**Rejected alternatives**:
- **Keep the hardcoded peak/interactive constants.** Rejected per the reasoning above — wrong-on-day-one for any non-static schedule.
- **Read the user's keyboard activity directly** (X11 idle detection, screen-locked check). Rejected because it conflates "AFK" with "not working" — the user in a meeting at his desk is AFK-ish but not available to be interrupted by Phyllis output; the user walking the dog is fully AFK and Phyllis can fire freely. Calendar reflects intent; idle detection reflects mechanical presence.
- **Time-zone-only logic** (hour of day, with no calendar lookup). Rejected — see the hardcoded-hours rejection. Time-of-day is one input; calendar is the override.
- **Read calendars via direct Google API (not `gws`).** Rejected because `gws` is the existing project-wide Google primitive (CLAUDE.md mandate). Phyllis using it directly keeps one OAuth flow + one credential cache for all Google access.

**Could-be-wrong-if**:
- the user's calendar is stale (events not cancelled / events not added) and Phyllis makes decisions based on incorrect busy state. Concrete signal: Phyllis fires while the user is actually working, OR defers while the user is actually away. Mitigation: this is a the user-side discipline (keep calendar current); the alternative (Phyllis tries to be smarter than the calendar) is worse. `busyCheckCalendars` override lets the user exclude noisy calendars from the signal.
- The `gws` freebusy endpoint rate-limits or fails, leaving Phyllis with no busy signal. Concrete signal: scheduler logs show repeated calendar-read failures. Mitigation: fall back to a permissive default (treat as not-busy) and log loudly so the user notices; never fall back to the old hardcoded peak hours (that's the wrong-on-day-one trap).
- The "Phyllis" write-back calendar has unintended side effects — visible to people the user shares his calendar with, or generating notifications. Concrete signal: someone asks "what is Phyllis?" or the user gets a notification from his own calendar. Mitigation: the Phyllis calendar is a separate calendar (not the user's primary) and the write API uses no-notification mode; verify on setup.

**How to apply**: New scheduling decisions consult `context.busyNow` and `context.busyDuringWindow` from the scheduler input — not `new Date().getHours()`. New deferral rules that need to know "is the user available?" use the calendar booleans; new rules that need to know "what's coming up?" use Docket reservations. When adding a calendar-aware decision, propagate it through the same context object — don't read the calendar from inside a sub-function (the context already has it). When debugging "why did Phyllis defer at 2am?" check the calendar — there's probably a stale event blocking the window.
