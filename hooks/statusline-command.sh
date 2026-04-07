#!/usr/bin/env bash
# Phyllis: Claude Code status line
# Shows: context bar | block time remaining + cost | rate limit window % | model
# Installed by `phyllis setup`.

PHYLLIS_HOME="${PHYLLIS_HOME:-$HOME/.phyllis}"
STATE_DIR="$PHYLLIS_HOME/state"

input=$(cat)

# --- context window ---
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

# --- persist rate limit state for Phyllis ---
rl_json=$(echo "$input" | jq -c '.rate_limits // empty')
if [ -n "$rl_json" ] && [ "$rl_json" != "null" ]; then
  mkdir -p "$STATE_DIR"
  echo "$rl_json" > "$STATE_DIR/rate-limits.json"
fi

# --- model ---
model_name=$(echo "$input" | jq -r '.model.display_name // .model.id // "unknown"')

# --- progress bar (20 chars wide) ---
if [ -n "$used_pct" ]; then
  filled=$(awk -v p="$used_pct" 'BEGIN { printf "%d", int(p * 20 / 100 + 0.5) }')
  empty=$((20 - filled))
  bar=$(printf '%0.s#' $(seq 1 $filled 2>/dev/null) 2>/dev/null || true)
  pad=$(printf '%0.s.' $(seq 1 $empty 2>/dev/null) 2>/dev/null || true)
  bar_display="[${bar}${pad}] ${used_pct}%"
else
  bar_display="[--------------------] --%"
fi

# --- ccusage block info (cached, refreshed every 60s in background) ---
cache_file="/tmp/ccusage-block-cache"
cache_max_age=60
block_display=""

if [ -f "$cache_file" ]; then
  cache_age=$(( $(date +%s) - $(stat -c %Y "$cache_file" 2>/dev/null || echo 0) ))
  block_json=$(cat "$cache_file")

  remaining=$(echo "$block_json" | jq -r '.blocks[0].projection.remainingMinutes // empty')
  cost=$(echo "$block_json" | jq -r '.blocks[0].costUSD // empty')

  if [ -n "$remaining" ] && [ -n "$cost" ]; then
    hours=$((remaining / 60))
    mins=$((remaining % 60))
    cost_fmt=$(printf '$%.0f' "$cost")
    block_display="${cost_fmt} used | ${hours}h${mins}m left"
  fi

  # refresh in background if stale
  if [ "$cache_age" -ge "$cache_max_age" ]; then
    (ccusage blocks --active --json --offline 2>/dev/null > "$cache_file.tmp" && mv "$cache_file.tmp" "$cache_file") &
  fi
else
  # first run — create cache in background
  (ccusage blocks --active --json --offline 2>/dev/null > "$cache_file.tmp" && mv "$cache_file.tmp" "$cache_file") &
fi

# --- rate limit window % ---
window_display=""
rl_file="$STATE_DIR/rate-limits.json"
if [ -f "$rl_file" ]; then
  five_hr=$(jq -r '.five_hour.used_percentage // empty' "$rl_file" 2>/dev/null)
  if [ -n "$five_hr" ]; then
    window_display="W:${five_hr}%"
  fi
fi

# --- assemble ---
parts="$bar_display"
[ -n "$block_display" ] && parts="$parts  $block_display"
[ -n "$window_display" ] && parts="$parts  $window_display"
parts="$parts  $model_name"
printf '%s' "$parts"
