#!/usr/bin/env bash
# Phyllis scheduler cron — check window state and execute next queued task
# Runs every 30 minutes via crontab
# Paths are resolved from ~/.phyllis/config.json by the CLI

PHYLLIS_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${PHYLLIS_HOME:-$HOME/.phyllis}/scheduler.log"

cd "$PHYLLIS_DIR" || exit 1

# Single-instance lock. drainQueue can run for the length of a long task drain;
# without this, each :00/:30 tick starts a SECOND concurrent drain that grabs the
# next queued task and runs it in PARALLEL — the nested claude -p fanout that can
# exhaust the window and lose work. Non-blocking: if a prior drain still holds the
# lock, skip this tick. fd 9 releases automatically when this script exits.
exec 9>"${PHYLLIS_HOME:-$HOME/.phyllis}/cron.lock"
if ! flock -n 9; then
	echo "---[$(date -Iseconds)] skipped: prior cron drain still active---" >> "$LOG"
	exit 0
fi

# Harvest any completed blocks first (keeps calibration data fresh)
node --import tsx src/cli.ts harvest >> "$LOG" 2>&1

# Try to schedule next task
node --import tsx src/cli.ts run >> "$LOG" 2>&1

echo "---[$(date -Iseconds)]---" >> "$LOG"
