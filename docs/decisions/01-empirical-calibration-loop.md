---
id: 01-empirical-calibration-loop
name: Empirical calibration loop instead of consuming a published quota API
date: 2026-03-30
status: active
supersedes: null
commits: [ab127c2, 6c67ca8, 4a259fb]
---

# Empirical calibration loop, not a published quota API

**Decision**: Phyllis treats the per-account weekly subscription quota as an **unknown to be measured**, not a number to query. The calibration pipeline harvests every observable signal — `ccusage` per-session token counts, desktop-app usage-pane percentages typed in manually, statusline cache from the rate-limit proxy (ADR 04), session JSONL totals (walking `subagents/` subdirs too), session-end hook reports — into `calibration-log.jsonl`. The scheduler reads recent rows to back out an empirical weekly budget: `inferred_weekly_tokens ≈ total_tokens_this_week / weekly_pct_used`. Every scheduling decision uses the latest empirical estimate, not a hardcoded constant.

**Why**: Anthropic does not publish a quota API for subscription plans. Multiple GitHub issues requesting one have been closed; the opacity is deliberate. Three pieces of evidence make this load-bearing for Phyllis: (1) the headline "5-hour window" is *rolling from the first message after the previous window expires*, not wall-clock; (2) the "weekly all-models" reset is account-specific (the user: Friday 3pm PT) and not exposed programmatically; (3) the actual per-window token cap differs by subscription tier *and* by peak-vs-off-peak (March 2026 peak-hour reduction). A scheduler that assumes hardcoded numbers is wrong the moment Anthropic changes a quota or the user upgrades a tier. Empirical calibration is the only robust shape — Phyllis learns the binding numbers from what actually happens and adjusts.

**Rejected alternatives**:
- **Read `/status` command output from Claude Code.** Rejected because (a) it's a TUI surface not designed for programmatic consumption (parsing risk), (b) it doesn't expose weekly budget directly, (c) Anthropic could change it without notice. The statusline cache (ADR 04) is the lower-friction path for what `/status` would surface.
- **Hardcoded "Max plan = X tokens/week" constant updated when tier changes.** Rejected because the published per-tier numbers are themselves approximations (the actual cap varies with peak hours, prompt cache hit rates, and apparent unpublished factors). Hardcoding fails silently the moment any of those drifts.
- **Conservative budget (assume the worst-case, schedule under it).** Rejected because the whole point of Phyllis is to *use* unused windows. A pessimistic budget leaves capacity on the table — exactly the failure mode Phyllis exists to prevent.
- **Skip calibration; let the runner detect 429s and adapt at runtime.** Already partially the case (ADR 05 — rate-limit requeue), but it's reactive, not predictive. Without empirical calibration, Phyllis can't decide "should I fire this XL task now or wait?" — it just fires and reverts. That's slow and noisy.

**Could-be-wrong-if**:
- The calibration is wrong by a large factor — empirical inference says budget is 2× actual, Phyllis fires too aggressively, hits the weekly cap mid-week. Concrete signal: `429` from the API earlier in the week than the inferred burn point predicted. Mitigation: every 429 is a calibration event; the harvester records it; the inference auto-corrects on the next window.
- The desktop-app percentage readout (the manual calibration anchor) becomes unavailable — Anthropic removes the pane, or its format changes. Concrete signal: manual snapshot entries stop landing in the log. Mitigation: rate-limit proxy headers (ADR 04) provide an alternate ground truth; reduce reliance on the manual path as the proxy data accumulates.
- Anthropic adds a quota API and the empirical loop becomes redundant + less accurate than the official source. Concrete signal: a documented API endpoint for remaining quota. Mitigation: switch to it; keep the calibration loop as a validation cross-check.

**How to apply**: Any scheduling decision that needs "how much budget is left" reads the latest calibration inference, not a hardcoded number. New data sources that reveal anything about quota state (a new statusline format, a new HTTP header, a new desktop-app pane) should be wired into the harvester so the calibration set grows. The calibration log file (`calibration-log.jsonl`) is append-only and never rewritten; deduplication is by composite key (user_id + window_start + source). When changing the inference formula in the scheduler, validate against the historical log first — a formula change that makes past decisions look wrong probably is.
