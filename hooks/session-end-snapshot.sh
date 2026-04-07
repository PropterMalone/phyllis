#!/usr/bin/env bash
# Phyllis: auto-capture usage snapshot at session end
# Installed by `phyllis setup`. Runs as a Claude Code SessionEnd hook.

PHYLLIS_HOME="${PHYLLIS_HOME:-$HOME/.phyllis}"
LOG_PATH="$PHYLLIS_HOME/calibration-log.jsonl"
STATE_DIR="$PHYLLIS_HOME/state"

if [ ! -d "$PHYLLIS_HOME" ]; then
  exit 0
fi

# Read hook input for session_id
input=$(cat)
SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')

# Get current block state (refresh cache first)
ccusage blocks --active --json --offline 2>/dev/null > /tmp/ccusage-block-cache.tmp && \
  mv /tmp/ccusage-block-cache.tmp /tmp/ccusage-block-cache

CACHE="/tmp/ccusage-block-cache"
if [ ! -f "$CACHE" ]; then
  exit 0
fi

now_tokens=$(jq -r '.blocks[0].totalTokens // 0' "$CACHE")
now_cost=$(jq -r '.blocks[0].costUSD // 0' "$CACHE")
now_start=$(jq -r '.blocks[0].startTime // empty' "$CACHE")
now_end=$(jq -r '.blocks[0].endTime // empty' "$CACHE")
now_models=$(jq -c '.blocks[0].models // ["unknown"]' "$CACHE")
now_remaining=$(jq -r '.blocks[0].projection.remainingMinutes // empty' "$CACHE")
now_input=$(jq -r '.blocks[0].tokenCounts.inputTokens // 0' "$CACHE")
now_output=$(jq -r '.blocks[0].tokenCounts.outputTokens // 0' "$CACHE")
now_cache_create=$(jq -r '.blocks[0].tokenCounts.cacheCreationInputTokens // 0' "$CACHE")
now_cache_read=$(jq -r '.blocks[0].tokenCounts.cacheReadInputTokens // 0' "$CACHE")

# Try to compute per-session delta
START_FILE="$STATE_DIR/session-start-${SESSION_ID}"
session_tokens=""
session_cost=""
session_input=""
session_output=""
session_cache_create=""
session_cache_read=""

if [ -n "$SESSION_ID" ] && [ -f "$START_FILE" ]; then
  start_block_id=$(jq -r '.blocks[0].startTime // empty' "$START_FILE")
  # Only diff if same block (session didn't span a window boundary)
  if [ "$start_block_id" = "$now_start" ]; then
    start_tokens=$(jq -r '.blocks[0].totalTokens // 0' "$START_FILE")
    start_cost=$(jq -r '.blocks[0].costUSD // 0' "$START_FILE")
    start_input=$(jq -r '.blocks[0].tokenCounts.inputTokens // 0' "$START_FILE")
    start_output=$(jq -r '.blocks[0].tokenCounts.outputTokens // 0' "$START_FILE")
    start_cache_create=$(jq -r '.blocks[0].tokenCounts.cacheCreationInputTokens // 0' "$START_FILE")
    start_cache_read=$(jq -r '.blocks[0].tokenCounts.cacheReadInputTokens // 0' "$START_FILE")

    session_tokens=$(awk "BEGIN {printf \"%.0f\", $now_tokens - $start_tokens}")
    session_cost=$(awk "BEGIN {printf \"%.2f\", $now_cost - $start_cost}")
    session_input=$(awk "BEGIN {printf \"%.0f\", $now_input - $start_input}")
    session_output=$(awk "BEGIN {printf \"%.0f\", $now_output - $start_output}")
    session_cache_create=$(awk "BEGIN {printf \"%.0f\", $now_cache_create - $start_cache_create}")
    session_cache_read=$(awk "BEGIN {printf \"%.0f\", $now_cache_read - $start_cache_read}")
  fi
  rm -f "$START_FILE"
fi

# Read rate limit state
rl_cache="$STATE_DIR/rate-limits.json"
five_hr=$(jq -r '.five_hour.used_percentage // empty' "$rl_cache" 2>/dev/null)
seven_day=$(jq -r '.seven_day.used_percentage // empty' "$rl_cache" 2>/dev/null)

now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# Build entry — include both block-level and session-level data
jq -n \
  --arg user_id "${USER:-unknown}" \
  --arg session_id "${SESSION_ID:-unknown}" \
  --arg window_start "$now_start" \
  --arg window_end "$now_end" \
  --arg observed_at "$now" \
  --argjson block_tokens "${now_tokens}" \
  --argjson block_cost "${now_cost}" \
  --argjson remaining "${now_remaining:-null}" \
  --argjson models "$now_models" \
  --argjson block_input "${now_input}" \
  --argjson block_output "${now_output}" \
  --argjson block_cache_create "${now_cache_create}" \
  --argjson block_cache_read "${now_cache_read}" \
  --argjson session_tokens "${session_tokens:-null}" \
  --argjson session_cost "${session_cost:-null}" \
  --argjson session_input "${session_input:-null}" \
  --argjson session_output "${session_output:-null}" \
  --argjson session_cache_create "${session_cache_create:-null}" \
  --argjson session_cache_read "${session_cache_read:-null}" \
  --argjson five_hr_pct "${five_hr:-null}" \
  --argjson seven_day_pct "${seven_day:-null}" \
  '{
    user_id: $user_id,
    session_id: $session_id,
    window_start: $window_start,
    window_end: $window_end,
    observed_at: $observed_at,
    block_tokens: $block_tokens,
    block_cost: $block_cost,
    session_tokens: $session_tokens,
    session_cost: $session_cost,
    remaining_min: $remaining,
    throttled: null,
    model_mix: $models,
    source: "session-end-hook",
    block_breakdown: {
      input: $block_input,
      output: $block_output,
      cache_creation: $block_cache_create,
      cache_read: $block_cache_read
    },
    session_breakdown: (if $session_tokens != null then {
      input: $session_input,
      output: $session_output,
      cache_creation: $session_cache_create,
      cache_read: $session_cache_read
    } else null end),
    rate_limits: (if $five_hr_pct != null then {
      five_hour_pct: $five_hr_pct,
      seven_day_pct: $seven_day_pct
    } else null end)
  }' >> "$LOG_PATH"

exit 0
