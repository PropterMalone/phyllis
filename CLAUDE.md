# Phyllis — Claude Code Usage Optimizer

> Scheduler that puts deferrable Claude Code work into empty usage windows, with awareness of promos and peak hours.

Last verified: 2026-03-29

## Problem

Anthropic subscription plans have three rate-limit windows:
- **Session window**: ~5 hours, **rolling** from first message after previous window expires
- **Weekly all-models**: Resets Friday 3:00 PM (Karl's current plan)
- **Weekly Sonnet-only**: Resets Tuesday 6:00 PM

Heavy sessions (NineAngel runs, 3CB resolution, JeffWolf A/B batteries) can exhaust a window, blocking interactive work. Meanwhile, overnight and off-peak windows go unused.

### Rate limit nuances
- **Peak-hour reduction** (new March 2026): 5am-11am PT weekdays get reduced session limits; off-peak gets more headroom
- **Output tokens cost ~5x input** on the API — likely weighted similarly for subscription quota (output-heavy sessions like subagent batteries burn faster)
- **No API for remaining quota** on subscription plans — multiple GitHub issues requesting it, all closed. Deliberately opaque.
- **`/status`** command in Claude Code may show remaining allocation (needs testing)
- **Usage shared** across claude.ai and Claude Code — same pool

## Design

### Existing tools (don't rebuild)

- **`ccusage`** (`npx ccusage@latest`) — Community tool. Parses `~/.claude/projects/*/*.jsonl`, shows token usage by day/week/month. Has a statusline mode (`bun x ccusage statusline`). Active project (800+ issues).
- Community tools: `claude-code-limit-tracker`, `Claude-Code-Usage-Monitor`

### Phyllis's unique value: scheduling + awareness

1. **Statusline integration** — Feed window state into `~/.claude/statusline-command.sh`. Show "Window: ~35% used, resets in 4h12m" in every session. Uses ccusage data.

2. **Post-session accounting** — Hook or wrap-time summary: "This session used ~X tokens (Y% of your current window)." Calibrates intuition.

3. **Task queue** — Deferrable tasks with t-shirt size estimates (S/M/L/XL). Human tags the size. Flat JSON file. Prime candidates:
   - 3CB round resolution (~16 deck-plan agents + crosscheck + tiebreakers, weekly)
   - JeffWolf A/B battery (17+ sets × 2 modes)
   - NineAngel whole-project runs
   - NormalMen episode pipelines
   - Krolodex batch imports

4. **Scheduler** — Cron that checks window state and drains the queue via `claude -p` when headroom exists. Prefers:
   - Promo off-peak windows (free against weekly budget)
   - Regular off-peak hours (more headroom allocated)
   - Fresh windows with no recent interactive activity

5. **Promo awareness** — Config flag or scrape for active promotions. When active, aggressively schedule deferrable work into off-peak windows (that usage is free against weekly limits).

### What we skip

- Token estimation engine — human tags tasks with t-shirt sizes
- Rebuilding ccusage — use it as a dependency
- Extra usage ($) cost optimization — billing concern, not scheduling
- Scraping the desktop app usage pane — no programmatic access, use for manual calibration only

### Data sources

- **ccusage** — primary token accounting
- **Session JSONL files**: `~/.claude/projects/-home-karl-Projects-*//*.jsonl` — each assistant message has `usage` object. **Must walk `subagents/` subdirs too** or heavy sessions get massively undercounted.
- **history.jsonl**: `~/.claude/history.jsonl` — user messages with project path and session ID
- **Desktop app usage pane**: Manual calibration reference (% used + reset times)

### Promos

Anthropic runs periodic promotions (e.g., March 2026: 2x usage during off-peak hours, March 13-28). Key properties:
- Off-peak defined as outside 8am-2pm ET weekdays
- Promo usage **doesn't count toward weekly limits** — separate pool
- Applied automatically across Claude web, desktop, Code, Excel, PowerPoint
- Affects Free/Pro/Max/Team (not Enterprise)

### Key unknowns

- Exact weighting of input vs output vs cache tokens for subscription rate limiting
- Whether extra usage ($) consumption counts against the subscription window or is separate
- Exact token budget per window per plan tier (deliberately not published)
- How promos are announced — no API; support articles + UI changes are the signals
- Whether `/status` command gives usable remaining-quota data

## Build order

1. **Statusline** — integrate ccusage into existing statusline. Immediate daily value, no scheduler needed.
2. **Post-session hook** — token summary at wrap time. Builds intuition.
3. **Historical heatmap** — which projects, which times. Informs whether scheduler is even needed or just shifting habits is enough.
4. **Queue + scheduler** — the full system. Only build if 1-3 confirm the value.

## Tech stack

TypeScript + Node.js, CLI-first. No hosting (runs on Malone). ccusage as dependency for token parsing.

## Commands

TBD

## File structure

TBD
