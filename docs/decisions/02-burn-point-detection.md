---
id: 02-burn-point-detection
name: Burn-point detection — drop all gates when weekly budget exceeds physical capacity
date: 2026-04-30
status: active
supersedes: null
commits: [422f262, 680735b, 9f0ac32]
---

# Burn-point detection — drop gates when budget exceeds capacity

**Decision**: Phyllis computes a "burn point" before each scheduling decision: is the remaining weekly budget larger than what can physically be consumed in the time remaining before weekly reset, even running flat out? Formula: `burn_point = remaining_weekly_tokens > (hours_until_weekly_reset / 5) * WINDOW_WEEKLY_PCT_MAX * weekly_budget_tokens`. When `burn_point == true`, the scheduler drops all deferral gates (peak-hour exclusion, interactive-hour exclusion, busy-calendar gate) and fires tasks immediately. The constant `WINDOW_WEEKLY_PCT_MAX` is the empirically-observed maximum fraction of weekly budget a single 5-hour window can consume; tuned upward as calibration data accumulates.

**Why**: The default Phyllis posture is conservative — defer to off-peak, avoid interactive hours, respect calendar reservations. But once it's mathematically impossible to consume the rest of the weekly budget through the remaining windows, deferral has zero value (the unused budget evaporates at weekly reset). The right behavior flips: spend everything you can while you still can. The burn-point detector is the trigger that flips the posture. Without it, Phyllis would faithfully defer through the last 8 hours of the week and waste 30%+ of the weekly quota on a typical week.

**Rejected alternatives**:
- **Time-based override** ("if <12 hours to weekly reset, fire everything"). Rejected because it's wrong in both directions: if the queue is empty 12 hours out, there's nothing to fire; if the user burned heavily Monday-Wednesday and is at 80% by Thursday morning, 12 hours out from reset there's no headroom to fire flat-out anyway. The right trigger is the capacity-vs-budget ratio, not wall-clock distance to reset.
- **Fixed budget fraction threshold** ("if >50% budget remaining and <24h to reset, fire"). Rejected for the same reason — the binding constraint is `remaining_budget / (max_capacity * remaining_windows)`, not budget fraction alone.
- **Aggressive default posture** (no deferral gates at all, fire whenever the queue is non-empty). Rejected because it defeats the point of Phyllis — the value is *scheduling*, not *blind firing*. Burn-point is the explicit signal that the cost of deferral has gone to zero.

**Could-be-wrong-if**:
- `WINDOW_WEEKLY_PCT_MAX` is set too low (Phyllis under-detects the burn point), the burn-point fires later than it should, capacity wastes. Concrete signal: weekly resets land with significant unused weekly budget despite the queue having non-S tasks at the start of the week. Mitigation: the constant is tuned upward as calibration data shows higher single-window consumption; the 9f0ac32 commit already bumped it to the empirical max. Continue tuning as new data lands.
- `WINDOW_WEEKLY_PCT_MAX` is set too high (Phyllis over-detects the burn point), the burn-point fires when there's still real risk of hitting the weekly cap mid-burn. Concrete signal: weekly cap hit during a burn-point firing run, mid-week. Mitigation: if observed, halve the constant immediately and let calibration re-tune up.
- The formula treats all queued tasks as same-size, ignoring t-shirt sizes. A burn-point firing of 10 XL tasks consumes very differently from 10 S tasks. Concrete signal: burn-point firing runs that exit early on rate-limit suggest the formula underestimated XL impact; firing runs that drain the queue without consuming budget suggest it overestimated. Mitigation: incorporate per-size token estimates into the burn-point math when calibration has enough size-tagged data to back them out.

**How to apply**: Any new scheduling gate (e.g., a new "don't fire while batteries < 20%" constraint) must consult `burnPoint` and skip if true — the burn-point posture overrides all gates by design. When tuning `WINDOW_WEEKLY_PCT_MAX`, look at the maximum observed `weekly_pct_used_in_single_window` across the calibration log; that's the empirical answer. Never hardcode burn-point detection into the scheduler conditionals — keep it as a single computed boolean threaded through the decision graph so the override is auditable.
