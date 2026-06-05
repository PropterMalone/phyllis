---
id: 05-rate-limit-detect-and-requeue
name: Detect rate-limit output and requeue tasks, not mark failed
date: 2026-04-15
status: active
supersedes: null
commits: [dcd6541, aafee73]
---

# Detect rate-limit output and requeue

**Decision**: When the runner sees rate-limit signal in a task's stdout/stderr ("out of extra usage", "rate limit", "you've hit your weekly limit", and similar variants), the task is **requeued** (status flipped back to `queued`), not marked `failed`. The drain loop breaks immediately on rate-limit detection — no more tasks are attempted in the current invocation. Signal notifications stay silent on rate-limit requeues (it's not an error to notify on); they fire only on real failures. The next scheduled run picks the requeued task back up when there's headroom.

**Why**: Rate-limit-out is not a failure — it's a "not now." Marking it `failed` requires manual review and re-queue; requeuing it auto-resumes when capacity returns. The drain-break-on-detection prevents Phyllis from hammering the API with a series of doomed tasks once the first one hits the wall (which would burn the rate-limit window further on retries and amplify the cooldown). Silent notifications on requeue keep the user's Signal thread useful for real failures — if every rate-limit requeue dinged, the user would mute the thread and miss actual failures.

**Rejected alternatives**:
- **Mark failed; require the user to re-queue.** Rejected — adds manual operator load every time Phyllis hits a quota wall, exactly the wrong shape (Phyllis should auto-recover).
- **Mark complete; let the user notice missing output.** Rejected — silently swallows the failure to produce useful output; impossible to distinguish from "task ran and produced no notable result."
- **Retry inline with backoff.** Rejected because the actual cooldown is minutes-to-hours (until the window resets), and Phyllis's process shouldn't sit blocked that long. Requeue + exit-the-run + let cron re-pick-up is the right shape — cron is the polling primitive.
- **Detect via response headers (proxy, ADR 04) instead of stdout strings.** Rejected as the primary detection because the proxy data is window-level, not per-task; a task can complete normally but be the one that pushes a window into 429 territory. Stdout/stderr is the per-task signal. The proxy data informs *next-task scheduling* (don't start an XL when window is at 95%); stdout detection is the in-flight gate.

**Could-be-wrong-if**:
- The string patterns for rate-limit detection drift — Anthropic changes the wording, or Claude Code reformats the message. Concrete signal: tasks fail with rate-limit-shaped stdout but get marked `failed` (not requeued). Mitigation: collect the new patterns when observed; the matcher is a single function (`isRateLimitOutput`) — easy to update. Add a calibration log entry on every match for the pattern that triggered, so drift is visible.
- A non-rate-limit failure produces stdout that happens to match the rate-limit pattern, getting silently requeued forever. Concrete signal: a task that never completes despite multiple runs. Mitigation: add a per-task requeue-count; if a task requeues N times (e.g., 3+) without ever completing, mark `failed` and notify — actual rate-limit auto-recovers within hours, persistent requeue is a sign of a real bug.
- Signal notification on real failure is suppressed by the silent-on-requeue gate getting too broad. Concrete signal: a task fails for a real reason and the user doesn't get a Signal ding. Mitigation: only the rate-limit code path is silent; explicit failure → explicit notify; tested.

**How to apply**: Any new failure mode that's structurally "try again later, not a real failure" follows the same shape — detect, requeue, log calibration event, exit drain loop, no notification. Real failures (broken hook, malformed task input, runtime error) always notify. The drain loop's exit-on-detect behavior is a safety property — never iterate to the next task after a rate-limit hit; let the next cron run start fresh. When adding a new task source (new queue type, new orchestrator), thread the same detection logic into its result handling — don't reinvent failure semantics per task source.
