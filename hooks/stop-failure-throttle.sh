#!/usr/bin/env bash
# Phyllis: detect rate limit events and annotate calibration log
# Installed by `phyllis setup`. Runs as a Claude Code StopFailure hook.

PHYLLIS_HOME="${PHYLLIS_HOME:-$HOME/.phyllis}"
LOG_PATH="$PHYLLIS_HOME/calibration-log.jsonl"
STATE_DIR="$PHYLLIS_HOME/state"

# Read hook input
input=$(cat)
error_type=$(echo "$input" | jq -r '.error // empty')

# Only act on rate limit events
if [ "$error_type" != "rate_limit" ]; then
  exit 0
fi

# Capture current block state from ccusage cache (fast, no subshell needed)
cache_file="/tmp/ccusage-block-cache"
block_json=""
if [ -f "$cache_file" ]; then
  block_json=$(cat "$cache_file")
fi

window_start=$(echo "$block_json" | jq -r '.blocks[0].startTime // empty')
tokens=$(echo "$block_json" | jq -r '.blocks[0].totalTokens // 0')
cost=$(echo "$block_json" | jq -r '.blocks[0].costUSD // 0')
models=$(echo "$block_json" | jq -c '.blocks[0].models // ["unknown"]')

# Read rate limit state
rl_cache="$STATE_DIR/rate-limits.json"
window_pct=""
if [ -f "$rl_cache" ]; then
  window_pct=$(jq -r '.five_hour.used_percentage // empty' "$rl_cache")
fi

now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

# Build calibration entry
entry=$(jq -n \
  --arg user_id "${USER:-unknown}" \
  --arg window_start "${window_start:-$now}" \
  --arg observed_at "$now" \
  --argjson tokens "${tokens:-0}" \
  --argjson cost "${cost:-0}" \
  --argjson models "${models:-[\"unknown\"]}" \
  --arg window_pct "${window_pct:-unknown}" \
  '{
    user_id: $user_id,
    window_start: $window_start,
    window_end: "",
    observed_at: $observed_at,
    tokens_consumed: $tokens,
    cost_equiv: $cost,
    remaining_min: 0,
    throttled: true,
    peak_hour: false,
    promo_active: false,
    model_mix: $models,
    source: "manual",
    notes: ("Rate limit hit detected by StopFailure hook. Window pct at throttle: " + $window_pct + "%")
  }')

echo "$entry" >> "$LOG_PATH"

# Output context back to the conversation
jq -n --arg msg "Rate limit detected — throttle data point captured to calibration log." \
  '{"additionalContext": $msg}'
