#!/usr/bin/env bash
# Phyllis scheduler cron — check window state and execute next queued task
# Runs every 30 minutes via crontab
# Paths are resolved from ~/.phyllis/config.json by the CLI

PHYLLIS_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${PHYLLIS_HOME:-$HOME/.phyllis}/scheduler.log"

cd "$PHYLLIS_DIR" || exit 1

# Harvest any completed blocks first (keeps calibration data fresh)
node --import tsx src/cli.ts harvest >> "$LOG" 2>&1

# Try to schedule next task
node --import tsx src/cli.ts run >> "$LOG" 2>&1

echo "---[$(date -Iseconds)]---" >> "$LOG"
