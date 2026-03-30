#!/usr/bin/env bash
# Phyllis scheduler cron — check window state and execute next queued task
# Runs every 30 minutes via crontab

PHYLLIS_DIR="/home/karl/Projects/phyllis"
LOG="$PHYLLIS_DIR/scheduler.log"

cd "$PHYLLIS_DIR" || exit 1

# Harvest any completed blocks first (keeps calibration data fresh)
node --import tsx src/cli.ts harvest --log "$PHYLLIS_DIR/calibration-log.jsonl" >> "$LOG" 2>&1

# Try to schedule next task
node --import tsx src/cli.ts run --queue "$PHYLLIS_DIR/queue.json" --log "$PHYLLIS_DIR/calibration-log.jsonl" >> "$LOG" 2>&1

echo "---[$(date -Iseconds)]---" >> "$LOG"
