# Phyllis

Claude Code usage optimizer. Schedules deferrable work into empty rate-limit windows on Anthropic subscription plans.

**Status: Alpha.** Actively developed. Looking for testers to help calibrate window capacities across plan tiers.

## Why

Anthropic subscription plans have rolling ~5h session windows and weekly caps. Heavy work (multi-agent code reviews, batch analysis, pipeline runs) can exhaust a window and block interactive use. Meanwhile, overnight and off-peak hours go unused.

Phyllis queues that heavy work and runs it automatically when there's headroom.

## What it does

- **Statusline** — shows block cost, time remaining, and rate-limit % in every Claude Code session
- **Session hooks** — captures per-session token usage automatically at session end
- **Task queue** — queue deferrable tasks with t-shirt size estimates (S/M/L/XL), run them via `claude -p` when the scheduler says go
- **Scheduler** — cron-driven, respects peak hours, calendar events, and weekly budget burn rate
- **Rate-limit proxy** — optional HTTP proxy captures Anthropic's undocumented `anthropic-ratelimit-unified-*` headers for precise window state
- **Overnight digest** — morning email summarizing what ran, with weekly budget health badge
- **Calibration data** — every session produces a data point for empirical window capacity analysis

## Quick start

```bash
# Prerequisites: Node.js 20+, Claude Code CLI, ccusage
npm install -g ccusage

# Install
git clone https://github.com/PropterMalone/phyllis.git
cd phyllis
npm install

# Initialize config directory
node --import tsx src/cli.ts init

# Install hooks + statusline into Claude Code
node --import tsx src/cli.ts setup
```

Set up a shell alias for convenience:

```bash
alias phyllis='node --import tsx /path/to/phyllis/src/cli.ts'
```

## Commands

| Command | Description |
|---------|-------------|
| `init` | Create `~/.phyllis/` config and directory structure |
| `setup` | Install hooks and statusline into Claude Code |
| `harvest` | Process completed ccusage blocks into calibration log |
| `snapshot` | Capture active block state with projection data |
| `analyze` | Day-by-hour usage heatmap + project breakdown |
| `weekly` | Weekly burn rate summary with health assessment |
| `queue list` | Show the task queue |
| `queue add` | Add a deferrable task (requires `--name`, `--size`, `--prompt`, `--dir`) |
| `queue done <name>` | Manually mark a task complete |
| `run` | Check window state and execute next queued task |
| `digest` | Send overnight summary email via Gmail |
| `proxy` | Start the rate-limit header capture proxy |

### Queuing a task

```bash
phyllis queue add \
  --name "Review api-service" \
  --size L \
  --prompt "Read ~/.claude/skills/angel/unattended.md and follow it exactly. PROJECT_DIR: ~/Projects/api-service REPORT_PATH: /tmp/angel-api-service.md PERSONAS: all 9" \
  --dir ~/Projects/api-service \
  --priority 10
```

Tasks run via `claude -p` in a fresh context. Write prompts that are self-contained: absolute paths, exact queries, explicit output locations.

### Scheduling via cron

```bash
# Check window state and run next task every 30 minutes
*/30 * * * * cd /path/to/phyllis && node --import tsx src/cli.ts run >> ~/.phyllis/scheduler.log 2>&1

# Morning digest at 7am
0 7 * * * cd /path/to/phyllis && node --import tsx src/cli.ts digest >> ~/.phyllis/digest.log 2>&1
```

## How it works

1. **ccusage** parses Claude Code's JSONL session logs for token and cost data
2. **SessionEnd hook** captures per-session usage delta when each Claude Code session ends
3. **StopFailure hook** records throttle events as high-value calibration data points
4. **Statusline** shows current block cost + time remaining in every session
5. **Scheduler** (`run`) checks whether the current window has headroom, then executes the highest-priority queued task via `claude -p`
6. **Rate-limit detection** in the runner catches throttled tasks and requeues them instead of marking them failed

## Configuration

Config lives at `~/.phyllis/config.json`, created by `phyllis init`.

```jsonc
{
  "home": "~/.phyllis",
  "userId": "karl",
  "logPath": "~/.phyllis/calibration-log.jsonl",
  "queuePath": "~/.phyllis/queue.json",
  "proxy": { "port": 7735 },
  "calendar": null,   // Google Calendar integration (optional)
  "notify": null       // Signal notifications (optional)
}
```

Override with environment variable: `PHYLLIS_HOME=/custom/path phyllis run`

## Data files

All in `~/.phyllis/`:

| File | Purpose |
|------|---------|
| `config.json` | Configuration |
| `calibration-log.jsonl` | Usage data points (tokens, cost, throttle events) |
| `queue.json` | Deferrable task queue |
| `state/window-state.json` | Proxy-captured window state |
| `state/rate-limits.json` | Rate-limit percentages from statusline |
| `task-logs/` | stdout/stderr from scheduled task runs |

## Optional: rate-limit proxy

The proxy sits between Claude Code and the Anthropic API, transparently capturing rate-limit headers that aren't otherwise exposed.

```bash
phyllis proxy  # listens on 127.0.0.1:7735

# Tell Claude Code to route through it:
export ANTHROPIC_BASE_URL=http://127.0.0.1:7735
```

Captures: utilization percentages, reset timestamps, 429 events. Writes live state to `~/.phyllis/state/window-state.json`.

## Development

```bash
npm run validate   # biome check + typecheck + vitest
npm run build      # tsc
npm test           # vitest only
```

## Contributing

File issues on GitHub. Calibration data contributions are especially welcome — aggregate data across users reveals window caps and rate patterns that no single user can determine alone.

## License

ISC
