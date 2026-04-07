#!/usr/bin/env bash
# Phyllis morning digest — email summary of overnight task runs
# Runs daily at 7:30am ET (11:30 UTC) via crontab

PHYLLIS_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="${PHYLLIS_HOME:-$HOME/.phyllis}/digest.log"

cd "$PHYLLIS_DIR" || exit 1

node --import tsx src/cli.ts digest >> "$LOG" 2>&1

echo "---[$(date -Iseconds)]---" >> "$LOG"
